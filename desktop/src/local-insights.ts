import {
  calendarClock,
  summarize,
  REFERENCE,
  type InsightDay,
  type Sample,
} from "../../web/lib/insights";
import { classifyActivity } from "../../web/lib/activities";
import type { Capture } from "./types";

/** Use the portal's time accounting on local records, including midnight neighbors. */
export function localInsights(
  records: Capture[],
  timeZone: string,
  now = Date.now() / 1000 - REFERENCE,
): InsightDay[] {
  const clock = calendarClock(timeZone);
  const ids = new Set<string>();
  const dates = new Set<number>();
  const samples: Sample[] = records
    .filter((row) => {
      if (!Number.isFinite(row.date) || row.date > now || ids.has(row.id)) return false;
      ids.add(row.id);
      return true;
    })
    .sort((a, b) => a.date - b.date || a.id.localeCompare(b.id))
    .filter((row) => {
      if (dates.has(row.date)) return false;
      dates.add(row.date);
      return true;
    })
    .map((row) => ({
      date: row.date,
      interval: row.sampleIntervalSeconds ?? 60,
      app: row.app,
      appID: row.bundleID,
      activity: classifyActivity(row),
      project: row.context?.project,
    }));
  const stamps = samples.map((sample) => clock(sample.date).day);
  const keys = new Set<string>();
  for (const sample of samples) {
    const half = Math.min(300, Math.max(15, sample.interval || 60)) / 2;
    keys.add(clock(Math.max(samples[0].date, sample.date - half)).day);
    keys.add(clock(sample.date).day);
    keys.add(clock(Math.min(now, sample.date + half)).day);
  }
  const lower = (day: string, inclusive: boolean) => {
    let left = 0,
      right = stamps.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (stamps[middle] < day || (!inclusive && stamps[middle] === day)) left = middle + 1;
      else right = middle;
    }
    return left;
  };
  return [...keys].sort().map((day) => ({
    day,
    lastSynced: "",
    ...summarize(
      samples.slice(Math.max(0, lower(day, true) - 1), lower(day, false) + 1),
      day,
      now,
      timeZone,
      samples[0]?.date,
    ),
  }));
}
