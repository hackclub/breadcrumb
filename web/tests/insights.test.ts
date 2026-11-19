import { test, expect } from "bun:test";
import { summarize, REFERENCE } from "../lib/insights";
import { appSeed, findApp } from "../lib/apps";

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
