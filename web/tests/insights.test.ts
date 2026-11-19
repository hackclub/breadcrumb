import { test, expect } from "bun:test";
import { summarize, REFERENCE } from "../lib/insights";
import { appSeed, findApp, mergeApps } from "../lib/apps";

test("hourly app changes split overlapping samples and preserve daily totals", () => {
  const boundary = Date.parse("2026-11-18T13:00:00Z") / 1000 - REFERENCE;
  const result = summarize(
    [
      {
        date: boundary - 10,
        interval: 60,
        app: "Editor",
        appID: "editor",
        activity: "Coding",
        project: "A",
      },
      {
        date: boundary + 5,
        interval: 60,
        app: "Assistant",
        appID: "assistant",
        activity: "AI",
        project: "B",
      },
    ],
    "2026-11-18",
    boundary + 20,
  );
  expect(result.seconds).toBe(30);
  expect(result.apps.find((row) => row.id === "editor")?.seconds).toBe(7.5);
  expect(result.hours[12]).toBe(10);
  expect(result.hours[13]).toBe(20);
  expect(result.hourly[13].apps[0].name).toBe("Assistant");
  expect(result.hourly.reduce((sum, hour) => sum + hour.captures, 0)).toBe(2);
});

test("app identifiers resolve aliases without treating every Electron app as Slick", () => {
  expect(findApp(appSeed, "Electron", "dev.slick.byoe.handoff")?.name).toBe("Slick");
  expect(findApp(appSeed, "code.EXE")?.id).toBe("vscode");
  expect(findApp(appSeed, "Electron")).toBeUndefined();
});

test("legacy names and bundle IDs produce one app row without changing total time", () => {
  const rows = [
    { name: "Helium", id: "net.imput.helium", seconds: 145 * 60 },
    { name: "Helium", seconds: 70 * 60 },
    { name: "Slick", id: "dev.slick.byoe.handoff", seconds: 75 * 60 },
    { name: "Slick", seconds: 32 * 60 },
    { name: "Ghostty", id: "com.mitchellh.ghostty", seconds: 16 * 60 },
    { name: "Ghostty", seconds: 13 * 60 },
  ];
  const merged = mergeApps(rows);
  expect(merged.map((row) => [row.id, row.seconds])).toEqual([
    ["helium", 215 * 60],
    ["slick", 107 * 60],
    ["ghostty", 29 * 60],
  ]);
  expect(merged.reduce((sum, row) => sum + row.seconds, 0)).toBe(
    rows.reduce((sum, row) => sum + row.seconds, 0),
  );
  expect(
    mergeApps([
      { name: "Electron", id: "custom.one", seconds: 10 },
      { name: "Electron", id: "custom.two", seconds: 20 },
    ]),
  ).toHaveLength(2);
});

test("activity drilldowns preserve focused time across apps, projects and legacy labels", () => {
  const date = Date.parse("2026-11-18T13:00:00Z") / 1000 - REFERENCE;
  const result = summarize(
    [
      { date, interval: 60, app: "Browser", activity: "Messaging interface", project: "A" },
      { date: date + 60, interval: 60, app: "Slick", activity: "Messaging", project: "B" },
    ],
    "2026-11-18",
    date + 90,
  );
  expect(result.activities).toEqual([{ name: "Messaging", seconds: 90 }]);
  const detail = result.activityDetails.Messaging;
  expect(detail.seconds).toBe(result.seconds);
  expect(detail.apps.reduce((n, row) => n + row.seconds, 0)).toBe(result.seconds);
  expect(detail.projects.reduce((n, row) => n + row.seconds, 0)).toBe(result.seconds);
});
