import { describe, expect, test } from "bun:test";
import { buildTime, streak, weekly, STREAK_SECONDS } from "../lib/momentum";
import type { InsightDay } from "../lib/insights";

const day = (date: string, rows: [string, number][], projects: [string, number][] = []) =>
  ({
    day: date,
    seconds: rows.reduce((sum, [, seconds]) => sum + seconds, 0),
    captures: 1,
    lastSynced: "",
    activities: rows.map(([name, seconds]) => ({ name, seconds })),
    projects: projects.map(([name, seconds]) => ({ name, seconds })),
  }) satisfies InsightDay;

describe("build time", () => {
  test("counts making and AI collaboration, not entertainment or messaging", () => {
    expect(
      buildTime(
        day("2026-11-20", [
          ["Coding", 600],
          ["AI collaboration", 300],
          ["AI assistant page", 60],
          ["Video", 900],
          ["Messaging", 120],
          ["Unclassified", 50],
        ]),
      ),
    ).toEqual({ build: 960, ai: 360 });
  });
});

describe("streak", () => {
  const enough = STREAK_SECONDS;
  test("an unfinished today keeps yesterday's streak alive", () => {
    const days = [
      day("2026-11-17", [["Coding", enough]]),
      day("2026-11-18", [["Coding", enough]]),
      day("2026-11-19", [["Testing", enough]]),
      day("2026-11-20", [["Coding", enough - 1]]),
    ];
    expect(streak(days, "2026-11-20")).toEqual({ current: 3, best: 3, today: false });
  });
  test("a missed day ends the streak, and the best run is kept", () => {
    const days = [
      day("2026-11-10", [["Coding", enough]]),
      day("2026-11-11", [["Coding", enough]]),
      day("2026-11-12", [["Coding", enough]]),
      day("2026-11-18", [["Video", enough * 4]]),
      day("2026-11-20", [["Design", enough]]),
    ];
    expect(streak(days, "2026-11-20")).toEqual({ current: 1, best: 3, today: true });
  });
  test("counts across month boundaries", () => {
    const days = [day("2026-10-31", [["Coding", enough]]), day("2026-11-01", [["Coding", enough]])];
    expect(streak(days, "2026-11-01").current).toBe(2);
  });
});

describe("weekly recap", () => {
  test("compares the last seven days with the seven before", () => {
    const value = weekly(
      [
        day("2026-11-06", [["Coding", 9999]]),
        day("2026-11-10", [["Coding", 1000]]),
        day(
          "2026-11-14",
          [
            ["Coding", 3000],
            ["AI collaboration", 1000],
          ],
          [["Breadcrumb", 4000]],
        ),
        day("2026-11-20", [["Writing", 2000]], [["Unassigned", 2000]]),
        day("2026-11-21", [["Coding", 9999]]),
      ],
      "2026-11-20",
    );
    expect(value).toEqual({
      build: 6000,
      ai: 1000,
      previous: 1000,
      days: 2,
      change: 5000,
      best: { day: "2026-11-14", seconds: 4000 },
      project: { name: "Breadcrumb", seconds: 4000 },
    });
  });
});
