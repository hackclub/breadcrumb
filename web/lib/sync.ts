import { classifyActivity } from "./activities";
import type { Store } from "./store";
import { summarize, calendarClock, REFERENCE, type Sample } from "./insights";
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
const dayOffset = (day: string, offset: number) =>
  new Date(Date.parse(day + "T12:00:00Z") + offset * 86400000).toISOString().slice(0, 10);
export async function syncedSummary(
  store: Store,
  participant: string,
  cursor: string,
  timeZone = "UTC",
) {
  const prefix = `sync/days/${participant}/`;
  const page = await store.list(prefix, cursor, 60);
  if (!page.keys.length) return { days: [], nextCursor: page.cursor, timeZone };
  const dateOf = (key: string) => key.split("/").at(-1)!.slice(0, -5);
  // UTC remains the storage partition. Read neighboring partitions so local
  // midnight and page boundaries never truncate a day's samples.
  const keys = [
    ...new Set([
      ...page.keys,
      prefix + dayOffset(dateOf(page.keys[0]), -1) + ".json",
      prefix + dayOffset(dateOf(page.keys.at(-1)!), 1) + ".json",
    ]),
  ];
  const source = new Map<string, Day>();
  for (let offset = 0; offset < keys.length; offset += 5) {
    await Promise.all(
      keys.slice(offset, offset + 5).map(async (key) => {
        const raw = await store.get(key);
        if (raw) source.set(dateOf(key), JSON.parse(Buffer.from(raw).toString()));
      }),
    );
  }
  const firstKey = cursor ? (await store.list(prefix, "", 1)).keys[0] : page.keys[0];
  const firstDay =
    source.get(dateOf(firstKey)) ??
    (JSON.parse(Buffer.from((await store.get(firstKey))!).toString()) as Day);
  const historyStart = Math.min(...Object.values(firstDay.samples).map((sample) => sample.date));
  const clock = calendarClock(timeZone);
  const wanted = new Set<string>();
  for (const key of page.keys)
    for (const sample of Object.values(source.get(dateOf(key))?.samples ?? {})) {
      const half = Math.min(300, Math.max(15, sample.interval || 60)) / 2;
      for (const offset of [-half, 0, half]) wanted.add(clock(sample.date + offset).day);
    }
  const days = [...wanted].sort().flatMap((day) => {
    const nearby = [-1, 0, 1].flatMap((offset) => {
      const value = source.get(dayOffset(day, offset));
      return value ? [value] : [];
    });
    const value = summarize(
      nearby.flatMap((d) => Object.values(d.samples)),
      day,
      undefined,
      timeZone,
      historyStart,
    );
    if (!value.seconds && !value.captures) return [];
    return [
      {
        day,
        ...value,
        lastSynced:
          nearby
            .map((d) => d.updatedAt)
            .sort()
            .at(-1) ?? "",
      },
    ];
  });
  return { days, nextCursor: page.cursor, timeZone };
}
