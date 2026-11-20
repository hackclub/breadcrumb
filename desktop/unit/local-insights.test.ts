import { expect, test } from "bun:test";
import { localInsights } from "../src/local-insights";
import { summarize, REFERENCE } from "../../web/lib/insights";

test("local history matches portal accounting across midnight, time zones and duplicates", () => {
  const boundary = Date.parse("2026-11-19T05:00:00Z") / 1000 - REFERENCE;
  const records = [
    {
      id: "a",
      date: boundary - 10,
      sampleIntervalSeconds: 60,
      app: "GitHub Desktop",
      bundleID: "GitHub Desktop",
      windowTitle: "Changes",
      context: { project: "Demo" },
    },
    {
      id: "b",
      date: boundary + 5,
      sampleIntervalSeconds: 60,
      app: "VLC",
      bundleID: "org.videolan.vlc",
      windowTitle: "Media",
    },
  ];
  for (const zone of ["UTC", "America/New_York", "Asia/Kathmandu"]) {
    const days = localInsights([...records, records[0]], zone, boundary + 20);
    const samples = records.map((row, i) => ({
      date: row.date,
      interval: 60,
      app: row.app,
      appID: row.bundleID,
      activity: i ? "Video" : "Version control",
      project: row.context?.project,
    }));
    for (const day of days)
      expect(day).toEqual({
        day: day.day,
        lastSynced: "",
        ...summarize(samples, day.day, boundary + 20, zone),
      });
    expect(days.reduce((n, d) => n + d.seconds, 0)).toBe(30);
    expect(days.reduce((n, d) => n + d.captures, 0)).toBe(2);
  }
});

test("empty history works offline and long gaps stay uncounted", () => {
  expect(localInsights([], "UTC")).toEqual([]);
  const start = Date.parse("2026-11-19T12:00:00Z") / 1000 - REFERENCE;
  const rows = [0, 86400].map((offset, i) => ({
    id: String(i),
    date: start + offset,
    app: "Editor",
    bundleID: "editor",
    windowTitle: "Demo",
    classification: { activity: "Coding", reason: "Context" },
  }));
  expect(localInsights(rows, "UTC", start + 86430).reduce((n, d) => n + d.seconds, 0)).toBe(90);
});

test("simultaneous captures choose the same app regardless of input order", () => {
  const date = Date.parse("2026-11-19T12:00:00Z") / 1000 - REFERENCE;
  const rows = ["z", "a"].map((id) => ({
    id,
    date,
    app: id === "a" ? "Editor" : "Browser",
    bundleID: id,
    windowTitle: "Synthetic",
  }));
  expect(localInsights(rows, "UTC", date + 60)).toEqual(
    localInsights([...rows].reverse(), "UTC", date + 60),
  );
  expect(localInsights(rows, "UTC", date + 60)[0].apps?.[0].name).toBe("Editor");
});
