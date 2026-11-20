import { activityName, buildActivities } from "./activities";
import type { InsightDay } from "./insights";

/** A day joins a streak once it reaches this much build time. */
export const STREAK_SECONDS = 15 * 60;
const DAY = 86400000;

const shift = (day: string, offset: number) =>
  new Date(Date.parse(day + "T12:00:00Z") + offset * DAY).toISOString().slice(0, 10);

/** Build and AI-collaboration seconds for one day, from its activity breakdown. */
export function buildTime(day: Pick<InsightDay, "activities">) {
  let build = 0,
    ai = 0;
  for (const row of day.activities ?? []) {
    const name = activityName(row.name);
    if (!buildActivities.has(name)) continue;
    build += row.seconds;
    if (name === "AI collaboration") ai += row.seconds;
  }
  return { build, ai };
}

/**
 * Consecutive days reaching STREAK_SECONDS of build time. Today still in progress does
 * not break the current streak; it extends it once it reaches the threshold.
 */
export function streak(days: InsightDay[], today: string) {
  const reached = new Set(
    days.filter((day) => buildTime(day).build >= STREAK_SECONDS).map((day) => day.day),
  );
  let current = 0;
  for (let day = reached.has(today) ? today : shift(today, -1); reached.has(day);) {
    current++;
    day = shift(day, -1);
  }
  let best = 0,
    run = 0,
    previous = "";
  for (const day of [...reached].sort()) {
    run = previous && shift(previous, 1) === day ? run + 1 : 1;
    best = Math.max(best, run);
    previous = day;
  }
  return { current, best, today: reached.has(today) };
}

/** The last seven days, including today, compared with the seven before them. */
export function weekly(days: InsightDay[], today: string) {
  const start = shift(today, -6),
    previousStart = shift(today, -13);
  let build = 0,
    ai = 0,
    previous = 0,
    active = 0,
    best: { day: string; seconds: number } | null = null;
  const projects = new Map<string, number>();
  for (const day of days) {
    if (day.day > today || day.day < previousStart) continue;
    const time = buildTime(day);
    if (day.day < start) {
      previous += time.build;
      continue;
    }
    build += time.build;
    ai += time.ai;
    if (time.build > 0) active++;
    if (time.build > 0 && (!best || time.build > best.seconds))
      best = { day: day.day, seconds: time.build };
    for (const project of day.projects ?? [])
      if (project.name !== "Unassigned")
        projects.set(project.name, (projects.get(project.name) ?? 0) + project.seconds);
  }
  const top = [...projects].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return {
    build,
    ai,
    previous,
    days: active,
    change: build - previous,
    best,
    project: top ? { name: top[0], seconds: top[1] } : null,
  };
}
