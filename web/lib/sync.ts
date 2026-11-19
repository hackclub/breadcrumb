import { classifyActivity } from "./activities";
import type { Store } from "./store";
import { summarize, REFERENCE, type Sample } from "./insights";
type Day = { samples: Record<string, Sample>; updatedAt: string };
export async function recordSynced(
  store: Store,
  participant: string,
  record: { id: string; date: number; sampleIntervalSeconds?: unknown; [key: string]: unknown },
  receivedAt: string,
) {
  const date = new Date((record.date + REFERENCE) * 1000);
  if (!Number.isFinite(date.getTime())) throw Error("Invalid capture date");
  const day = date.toISOString().slice(0, 10);
  await store.update(`sync/days/${participant}/${day}.json`, (current) => {
    const value: Day = current
      ? JSON.parse(Buffer.from(current).toString())
      : { samples: {}, updatedAt: receivedAt };
    const clean = (value: unknown) => (typeof value === "string" ? value.slice(0, 200) : undefined);
    const context = record.context as { project?: unknown } | undefined;
    const sample: Sample = {
      date: record.date,
      app: clean(record.app),
      appID: clean(record.bundleID),
      activity: classifyActivity(record),
      project: clean(context?.project),
      interval:
        typeof record.sampleIntervalSeconds === "number" &&
        Number.isFinite(record.sampleIntervalSeconds)
          ? Math.min(300, Math.max(15, record.sampleIntervalSeconds))
          : 60,
    };
    if (JSON.stringify(value.samples[record.id]) === JSON.stringify(sample)) return null;
    value.samples[record.id] = sample;
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
          ...summarize(Object.values(value.samples), day),
          lastSynced: value.updatedAt,
        };
      }),
    );
    days.push(...batch.filter((value) => value !== null));
  }
  return { days, nextCursor: page.cursor };
}
