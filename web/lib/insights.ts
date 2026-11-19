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
export function summarize(samples: Sample[], day: string, now = Date.now() / 1000 - REFERENCE) {
  const start = Date.parse(day + "T00:00:00Z") / 1000 - REFERENCE;
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
  for (const [index, sample] of sorted.entries()) {
    const hour = Math.floor((sample.date - start) / 3600);
    if (hour >= 0 && hour < 24) counts[hour]++;
    const half = Math.min(300, Math.max(15, sample.interval || 60)) / 2;
    const previous = sorted[index - 1],
      next = sorted[index + 1];
    const lower = Math.max(
      start,
      sorted[0].date,
      sample.date - half,
      previous ? (previous.date + sample.date) / 2 : -Infinity,
    );
    const upper = Math.min(
      start + 86400,
      now,
      sample.date + half,
      next ? (sample.date + next.date) / 2 : Infinity,
    );
    const duration = Math.max(0, upper - lower);
    if (duration) {
      seconds += duration;
      record(totals, sample, duration);
      for (
        let hour = Math.floor((lower - start) / 3600);
        hour < 24 && start + hour * 3600 < upper;
        hour++
      ) {
        const part = Math.max(
          0,
          Math.min(upper, start + (hour + 1) * 3600) - Math.max(lower, start + hour * 3600),
        );
        hours[hour] += part;
        record(hourly[hour], sample, part);
      }
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
