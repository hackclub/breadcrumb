import { activityName } from "./activities";
export type Sample = {
  date: number;
  interval: number;
  app?: string;
  appID?: string;
  activity?: string;
  project?: string;
};
export type Breakdown = { name: string; seconds: number; id?: string }[];
export type HourInsight = {
  seconds: number;
  captures: number;
  apps: Breakdown;
  activities: Breakdown;
  projects: Breakdown;
};
export type ActivityDetail = { seconds: number; apps: Breakdown; projects: Breakdown };
export type InsightDay = {
  activityDetails?: Record<string, ActivityDetail>;
  firstCapture?: number;
  lastCapture?: number;
  day: string;
  seconds: number;
  captures: number;
  lastSynced: string;
  apps?: Breakdown;
  activities?: Breakdown;
  projects?: Breakdown;
  hours?: number[];
  hourly?: HourInsight[];
};
export const REFERENCE = 978307200;
function bucket() {
  return {
    apps: new Map<string, number>(),
    activities: new Map<string, number>(),
    projects: new Map<string, number>(),
  };
}
export function calendarClock(timeZone = "UTC") {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const exact = (date: number) => {
    const parts = Object.fromEntries(
      format.formatToParts(new Date((date + REFERENCE) * 1000)).map((p) => [p.type, p.value]),
    );
    return {
      day: `${parts.year}-${parts.month}-${parts.day}`,
      hour: Number(parts.hour),
      minute: Number(parts.minute),
      second: Number(parts.second),
    };
  };
  // Whole-second UTC offset at an instant, from the zone's own calendar fields.
  const offset = (date: number) => {
    const at = Math.floor(date);
    const local = exact(at);
    const [year, month, day] = local.day.split("-").map(Number);
    return (
      Date.UTC(year, month - 1, day, local.hour, local.minute, local.second) / 1000 -
      (at + REFERENCE)
    );
  };
  // Offsets only change at transitions. If both ends of a 15-minute bucket agree, no transition
  // falls inside it, so local fields follow from plain UTC arithmetic. Otherwise ask Intl.
  const buckets = new Map<number, number | null>();
  return (date: number) => {
    const bucket = Math.floor(date / 900);
    let shift = buckets.get(bucket);
    if (shift === undefined) {
      const start = offset(bucket * 900),
        end = offset(bucket * 900 + 899);
      shift = start === end ? start : null;
      if (buckets.size > 50000) buckets.clear();
      buckets.set(bucket, shift);
    }
    if (shift === null) return exact(date);
    const local = new Date((date + REFERENCE + shift) * 1000);
    return {
      day: local.toISOString().slice(0, 10),
      hour: local.getUTCHours(),
      minute: local.getUTCMinutes(),
      second: local.getUTCSeconds(),
    };
  };
}
export function summarize(
  samples: Sample[],
  day: string,
  now = Date.now() / 1000 - REFERENCE,
  timeZone = "UTC",
  historyStart?: number,
) {
  const clock = calendarClock(timeZone);
  const sorted = samples
    .filter((s) => Number.isFinite(s.date) && s.date <= now)
    .sort((a, b) => a.date - b.date);
  const totals = bucket(),
    hourly = Array.from({ length: 24 }, bucket),
    appNames = new Map<string, string>(),
    details = new Map<
      string,
      { seconds: number; apps: Map<string, number>; projects: Map<string, number> }
    >();
  const hours = Array<number>(24).fill(0),
    counts = Array<number>(24).fill(0);
  const add = (map: Map<string, number>, name: string, seconds: number) =>
    map.set(name, (map.get(name) ?? 0) + seconds);
  const record = (target: ReturnType<typeof bucket>, sample: Sample, seconds: number) => {
    const app = sample.appID || sample.app || "Unknown app";
    appNames.set(app, sample.app || sample.appID || "Unknown app");
    add(target.apps, app, seconds);
    const activity = activityName(sample.activity);
    add(target.activities, activity, seconds);
    if (target === totals) {
      const detail = details.get(activity) ?? { seconds: 0, apps: new Map(), projects: new Map() };
      detail.seconds += seconds;
      add(detail.apps, app, seconds);
      add(detail.projects, sample.project || "Unassigned", seconds);
      details.set(activity, detail);
    }
    add(target.projects, sample.project || "Unassigned", seconds);
  };
  let seconds = 0;
  let firstCapture: number | undefined, lastCapture: number | undefined;
  for (const [index, sample] of sorted.entries()) {
    const stamp = clock(sample.date);
    if (stamp.day === day) {
      counts[stamp.hour]++;
      firstCapture ??= sample.date;
      lastCapture = sample.date;
    }
    const half = Math.min(300, Math.max(15, sample.interval || 60)) / 2;
    const previous = sorted[index - 1],
      next = sorted[index + 1];
    const lower = Math.max(
      historyStart ?? sorted[0].date,
      sample.date - half,
      previous ? (previous.date + sample.date) / 2 : -Infinity,
    );
    const upper = Math.min(
      now,
      sample.date + half,
      next ? (sample.date + next.date) / 2 : Infinity,
    );
    // Split at actual local-hour boundaries. Repeated DST hours combine in one
    // cell, while elapsed seconds remain counted once. Half-hour zones work too.
    for (let cursor = lower; cursor < upper;) {
      const part = clock(cursor);
      const boundary = Math.floor(cursor) + 3600 - part.minute * 60 - part.second;
      const end = Math.min(upper, Math.max(cursor + 0.001, boundary));
      if (part.day === day) {
        const duration = end - cursor;
        seconds += duration;
        hours[part.hour] += duration;
        record(totals, sample, duration);
        record(hourly[part.hour], sample, duration);
      }
      cursor = end;
    }
  }
  const rows = (map: Map<string, number>): Breakdown =>
    [...map]
      .map(([name, seconds]) => ({ name, seconds }))
      .sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name));
  const breakdown = (value: ReturnType<typeof bucket>) => ({
    apps: rows(value.apps).map((row) => ({
      ...row,
      id: row.name,
      name: appNames.get(row.name) || row.name,
    })),
    activities: rows(value.activities),
    projects: rows(value.projects),
  });
  return {
    seconds,
    firstCapture,
    lastCapture,
    captures: counts.reduce((n, count) => n + count, 0),
    ...breakdown(totals),
    activityDetails: Object.fromEntries(
      [...details].map(([name, detail]) => [
        name,
        {
          seconds: detail.seconds,
          apps: rows(detail.apps).map((row) => ({
            ...row,
            id: row.name,
            name: appNames.get(row.name) || row.name,
          })),
          projects: rows(detail.projects),
        },
      ]),
    ),
    hours,
    hourly: hourly.map((value, index) => ({
      seconds: hours[index],
      captures: counts[index],
      ...breakdown(value),
    })),
  };
}
export function duration(seconds: number) {
  if (seconds < 60) return seconds > 0 ? "<1 min" : "0 min";
  const minutes = Math.round(seconds / 60),
    hours = Math.floor(minutes / 60);
  return hours ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}` : `${minutes} min`;
}
