import { test, expect } from "bun:test";
import { estimateTimeline, estimatedTime, sessionContext } from "../src/activity";
import type { Capture, Session } from "../src/types";
const row = (date: number, extra: Partial<Capture> = {}): Capture => ({
  id: String(date),
  date,
  app: "Editor",
  bundleID: "test.editor",
  windowTitle: "Project",
  classification: { activity: "Coding", reason: "test" },
  ...extra,
});
test("regular samples estimate elapsed time without counting capture events as minutes", () => {
  expect(estimateTimeline([row(0), row(60), row(120)], 180).seconds).toBe(150);
  expect(estimateTimeline([row(0), row(5), row(10)], 10).seconds).toBe(10);
});
test("sleep gaps are excluded and configured cadence is respected", () => {
  expect(estimateTimeline([row(0), row(3600)], 3630).seconds).toBe(90);
  expect(
    estimateTimeline(
      [row(0, { sampleIntervalSeconds: 120 }), row(120, { sampleIntervalSeconds: 120 })],
      180,
    ).seconds,
  ).toBe(180);
});
test("range boundary clips cells while duplicate and future observations add no time", () => {
  const rows = [row(0), row(60), row(60, { id: "duplicate" }), row(120), row(300)];
  expect(estimateTimeline(rows, 150, 45).seconds).toBe(105);
  expect(estimateTimeline([], 150).seconds).toBe(0);
});
test("manual corrections override category estimates", () => {
  const value = estimateTimeline([row(0), row(60, { correction: "Reading" })], 90);
  expect(value.activities).toEqual([
    { label: "Reading", seconds: 60 },
    { label: "Coding", seconds: 30 },
  ]);
  expect(estimatedTime(3600)).toBe("≈1h");
  expect(estimatedTime(20)).toBe("<1 min");
});
test("sessions distinguish alongside context without inflating focus time", () => {
  const rows = [
    row(0),
    row(60, {
      visibleWindows: [
        { windowID: 1, app: "Music", bundleID: "test.music", title: "Song", focused: false },
        { windowID: 2, app: "Music", bundleID: "test.music", title: "Playlist", focused: false },
      ],
    }),
  ];
  const session: Session = {
    id: "s",
    title: "xpui.app.spotify.com",
    start: 0,
    end: 60,
    ids: ["0", "60"],
    activities: [],
  };
  const details = sessionContext(
    session,
    new Map(rows.map((r) => [r.id, r])),
    estimateTimeline(rows, 90),
  );
  expect(details.title).toBe("Spotify");
  expect(details.seconds).toBe(90);
  expect(details.focused).toHaveLength(1);
  expect(details.alongside).toHaveLength(1);
  expect(details.alongside[0].seconds).toBe(60);
});
