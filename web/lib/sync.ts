import type { Store } from "./store";
const REFERENCE = 978307200;
type Sample = { date: number; interval: number };
type Day = { samples: Record<string, Sample>; updatedAt: string };
export function sampledSeconds(
  samples: Sample[],
  day: string,
  now = Date.now() / 1000 - REFERENCE,
) {
  const start = Date.parse(day + "T00:00:00Z") / 1000 - REFERENCE;
  const sorted = samples.filter((s) => s.date <= now).sort((a, b) => a.date - b.date);
  let end = start,
    seconds = 0;
  for (const sample of sorted) {
    const half = Math.min(300, Math.max(15, sample.interval || 60)) / 2;
    const lower = Math.max(start, sorted[0].date, sample.date - half);
    const upper = Math.min(start + 86400, now, sample.date + half);
    if (upper > Math.max(end, lower)) seconds += upper - Math.max(end, lower);
    end = Math.max(end, upper);
  }
  return seconds;
}
export async function recordSynced(
  store: Store,
  participant: string,
  record: { id: string; date: number; sampleIntervalSeconds?: unknown },
  receivedAt: string,
) {
  const date = new Date((record.date + REFERENCE) * 1000);
  if (!Number.isFinite(date.getTime())) throw Error("Invalid capture date");
  const day = date.toISOString().slice(0, 10);
  await store.update(`sync/days/${participant}/${day}.json`, (current) => {
    const value: Day = current
      ? JSON.parse(Buffer.from(current).toString())
      : { samples: {}, updatedAt: receivedAt };
    if (value.samples[record.id]) return null;
    value.samples[record.id] = {
      date: record.date,
      interval:
        typeof record.sampleIntervalSeconds === "number" &&
        Number.isFinite(record.sampleIntervalSeconds)
          ? Math.min(300, Math.max(15, record.sampleIntervalSeconds))
          : 60,
    };
    value.updatedAt = [value.updatedAt, receivedAt].sort().at(-1)!;
    return Buffer.from(JSON.stringify(value));
  });
}
export async function syncedSummary(store: Store, participant: string, cursor: string) {
  const page = await store.list(`sync/days/${participant}/`, cursor, 60);
  const days = [];
  for (let offset = 0; offset < page.keys.length; offset += 5) {
    const batch = await Promise.all(
      page.keys.slice(offset, offset + 5).map(async (key) => {
        const raw = await store.get(key);
        if (!raw) return null;
        const value: Day = JSON.parse(Buffer.from(raw).toString());
        const day = key.split("/").at(-1)!.slice(0, -5);
        return {
          day,
          captures: Object.keys(value.samples).length,
          seconds: sampledSeconds(Object.values(value.samples), day),
          lastSynced: value.updatedAt,
        };
      }),
    );
    days.push(...batch.filter((value) => value !== null));
  }
  return { days, nextCursor: page.cursor };
}
