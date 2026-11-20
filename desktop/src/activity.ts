import { activity, shortActivity, timestamp, type Capture, type Session } from "./types";

export type TimedActivity = { label: string; seconds: number };
export type AppContext = { app: string; bundleID: string; seconds: number; captures: number };
export type TimelineEstimate = {
  seconds: number;
  activities: TimedActivity[];
  byCapture: Map<string, number>;
};

/** Non-overlapping cells around each observation. Pauses and missing samples stay gaps.
 * New captures carry their sampling interval; older captures use a one-minute ceiling.
 * Neighboring timestamps split cells at their midpoint, so event bursts add no extra time.
 */
export function estimateTimeline(
  observations: Capture[],
  now = timestamp(new Date()),
  start = -Infinity,
): TimelineEstimate {
  const sorted = observations
    .filter((row) => Number.isFinite(row.date) && row.date <= now)
    .slice()
    .sort((a, b) => a.date - b.date || a.id.localeCompare(b.id));
  const seenIDs = new Set<string>();
  const frames = sorted.filter((row, index) => {
    if (seenIDs.has(row.id)) return false;
    seenIDs.add(row.id);
    return index === 0 || row.date !== sorted[index - 1].date;
  });
  const byCapture = new Map<string, number>();
  const totals = new Map<string, number>();
  let seconds = 0;
  for (const [index, row] of frames.entries()) {
    const interval = row.sampleIntervalSeconds;
    const half =
      (interval && Number.isFinite(interval) && interval >= 15 ? Math.min(interval, 300) : 60) / 2;
    const previous = frames[index - 1];
    const next = frames[index + 1];
    const lower = Math.max(
      start,
      frames[0].date,
      row.date - half,
      previous ? (previous.date + row.date) / 2 : -Infinity,
    );
    const upper = Math.min(now, row.date + half, next ? (row.date + next.date) / 2 : Infinity);
    const duration = Math.max(0, upper - lower);
    byCapture.set(row.id, duration);
    if (!duration) continue;
    seconds += duration;
    const label = shortActivity(activity(row));
    totals.set(label, (totals.get(label) ?? 0) + duration);
  }
  return {
    seconds,
    byCapture,
    activities: [...totals]
      .map(([label, seconds]) => ({ label, seconds }))
      .sort((a, b) => b.seconds - a.seconds || a.label.localeCompare(b.label)),
  };
}

export function estimatedTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 min";
  if (seconds < 60) return "<1 min";
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `≈${hours}h${rest ? ` ${rest}m` : ""}` : `≈${minutes} min`;
}

export function appName(app: string, bundleID: string) {
  if (app === "Electron" && /slick|slack/i.test(bundleID)) return "Slick";
  return app || bundleID || "Unknown app";
}

export function sessionTitle(session: Session, records: Capture[]) {
  const title = session.title;
  const domain = title.toLowerCase();
  const sites: Record<string, string> = {
    "spotify.com": "Spotify",
    "github.com": "GitHub",
    "chatgpt.com": "ChatGPT",
    "claude.ai": "Claude",
    "youtube.com": "YouTube",
    "slack.com": "Slack",
    "notion.so": "Notion",
    "docs.google.com": "Google Docs",
  };
  for (const [host, name] of Object.entries(sites))
    if (domain === host || domain.endsWith("." + host)) return name;
  if (title === "Electron" && records.length) {
    const row = records.at(-1)!;
    return appName(row.app, row.bundleID);
  }
  return title || records.at(-1)?.app || "Untitled session";
}

export function sessionContext(
  session: Session,
  recordsByID: Map<string, Capture>,
  estimate: TimelineEstimate,
) {
  const records = [...new Set(session.ids)]
    .flatMap((id) => (recordsByID.has(id) ? [recordsByID.get(id)!] : []))
    .sort((a, b) => a.date - b.date);
  const focused = new Map<string, AppContext>();
  const alongside = new Map<string, AppContext>();
  const labels = new Map<string, number>();
  let seconds = 0;
  const add = (map: Map<string, AppContext>, app: string, bundleID: string, duration: number) => {
    const key = bundleID || app;
    const value = map.get(key) ?? {
      app: appName(app, bundleID),
      bundleID,
      seconds: 0,
      captures: 0,
    };
    value.seconds += duration;
    value.captures++;
    map.set(key, value);
  };
  for (const row of records) {
    const duration = estimate.byCapture.get(row.id) ?? 0;
    seconds += duration;
    add(focused, row.app, row.bundleID, duration);
    const label = shortActivity(activity(row));
    labels.set(label, (labels.get(label) ?? 0) + duration);
    const seen = new Set<string>();
    for (const window of row.visibleWindows ?? []) {
      const key = window.bundleID || window.app;
      if (
        window.focused ||
        window.bundleID === row.bundleID ||
        (!window.bundleID && window.app === row.app) ||
        seen.has(key)
      )
        continue;
      seen.add(key);
      add(alongside, window.app, window.bundleID ?? "", duration);
    }
  }
  const ordered = (map: Map<string, AppContext>) =>
    [...map.values()].sort(
      (a, b) => b.seconds - a.seconds || b.captures - a.captures || a.app.localeCompare(b.app),
    );
  const latest = records.at(-1);
  const windowTitle = (latest?.windowTitle || "").replace(
    /\s[-–—|]\s(?:Helium|Google Chrome|Chromium|Microsoft Edge|Mozilla Firefox|Safari)(?:\s[-–—|]\s.*)?$/i,
    "",
  );
  return {
    title: sessionTitle(session, records),
    seconds,
    focused: ordered(focused),
    alongside: ordered(alongside),
    windowTitle,
    activity: [...labels].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Other apps",
    captures: records.length,
  };
}
