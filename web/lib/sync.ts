import { classifyActivity } from "./activities";
import type { Store } from "./store";
import { summarize, calendarClock, REFERENCE } from "./insights";
import type {
  AnalyticsIndex,
  CachedSummary,
  IndexedSample,
  SampleDay as Day,
  SummaryRollups,
} from "./analytics";
export function syncSample(
  participant: string,
  record: { id: string; date: number; sampleIntervalSeconds?: unknown; [key: string]: unknown },
  receivedAt: string,
): IndexedSample {
  const date = new Date((record.date + REFERENCE) * 1000);
  if (!Number.isFinite(date.getTime())) throw Error("Invalid capture date");
  const clean = (value: unknown) =>
    typeof value === "string" ? value.slice(0, 200).toWellFormed() : undefined;
  const context = record.context as { project?: unknown } | undefined;
  return {
    participant,
    id: record.id,
    receivedAt,
    sample: {
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
    },
  };
}
export async function recordSynced(
  store: Store,
  participant: string,
  record: { id: string; date: number; sampleIntervalSeconds?: unknown; [key: string]: unknown },
  receivedAt: string,
  index?: AnalyticsIndex,
) {
  const row = syncSample(participant, record, receivedAt);
  if (index) return index.write([row]);
  const day = new Date((record.date + REFERENCE) * 1000).toISOString().slice(0, 10);
  await store.update(`sync/days/${participant}/${day}.json`, (current) => {
    const value: Day = current
      ? JSON.parse(Buffer.from(current).toString())
      : { samples: {}, updatedAt: receivedAt };
    if (JSON.stringify(value.samples[record.id]) === JSON.stringify(row.sample)) return null;
    value.samples[record.id] = row.sample;
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
  index?: AnalyticsIndex,
) {
  const prefix = `sync/days/${participant}/`;
  const dateOf = (key: string) => key.split("/").at(-1)!.slice(0, -5);
  let page: { keys: string[]; cursor: string },
    source: Map<string, Day>,
    historyStart: number | undefined;
  if (index) {
    if (cursor && !/^\d{4}-\d{2}-\d{2}$/.test(cursor)) throw Error("Invalid analytics cursor");
    if (hasRollups(index)) return rolledUpSummary(index, participant, cursor, timeZone);
    const value = await index.page(participant, cursor, 60);
    page = { keys: value.days.map((day) => prefix + day + ".json"), cursor: value.nextCursor };
    if (!page.keys.length) return { days: [], nextCursor: page.cursor, timeZone };
    source = await index.read(
      participant,
      dayOffset(value.days[0], -1),
      dayOffset(value.days.at(-1)!, 1),
    );
    historyStart = value.historyStart ?? undefined;
  } else {
    page = await store.list(prefix, cursor, 60);
    if (!page.keys.length) return { days: [], nextCursor: page.cursor, timeZone };
    // UTC remains the storage partition. Read neighboring partitions so local
    // midnight and page boundaries never truncate a day's samples.
    const keys = [
      ...new Set([
        ...page.keys,
        prefix + dayOffset(dateOf(page.keys[0]), -1) + ".json",
        prefix + dayOffset(dateOf(page.keys.at(-1)!), 1) + ".json",
      ]),
    ];
    source = new Map<string, Day>();
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
    historyStart = Math.min(...Object.values(firstDay.samples).map((sample) => sample.date));
  }
  const clock = calendarClock(timeZone);
  const wanted = new Set<string>();
  for (const key of page.keys)
    for (const sample of Object.values(source.get(dateOf(key))?.samples ?? {})) {
      const half = Math.min(300, Math.max(15, sample.interval || 60)) / 2;
      for (const offset of [-half, 0, half]) wanted.add(clock(sample.date + offset).day);
    }
  return {
    days: summarizeDays(source, [...wanted], timeZone, historyStart),
    nextCursor: page.cursor,
    timeZone,
  };
}

type DaySummary = ReturnType<typeof summarize> & { day: string; lastSynced: string };
/** Local days are summarized from their own UTC partition and both neighbors. */
function summarizeDays(
  source: Map<string, Day>,
  wanted: string[],
  timeZone: string,
  historyStart: number | undefined,
  now?: number,
): DaySummary[] {
  return [...wanted].sort().flatMap((day) => {
    const nearby = [-1, 0, 1].flatMap((offset) => {
      const value = source.get(dayOffset(day, offset));
      return value ? [value] : [];
    });
    const value = summarize(
      nearby.flatMap((d) =>
        Object.entries(d.samples)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, sample]) => sample),
      ),
      day,
      now,
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
}
const PAGE_DAYS = 60;
// A sample can extend at most 150 seconds past its timestamp; afterwards its day stops changing.
const SETTLE_SECONDS = 300;
function hasRollups(index: AnalyticsIndex): index is AnalyticsIndex & SummaryRollups {
  return Boolean(index.sourceDays && index.readSummaries && index.writeSummaries);
}
/**
 * Serves finished day summaries from rollups and recomputes only days whose source partitions
 * changed. Pages and cursors match the uncached path exactly.
 */
async function rolledUpSummary(
  index: AnalyticsIndex & SummaryRollups,
  participant: string,
  cursor: string,
  timeZone: string,
) {
  const sources = await index.sourceDays(participant);
  const after = sources.filter((source) => source.day > cursor);
  const page = after.slice(0, PAGE_DAYS);
  const nextCursor = after.length > PAGE_DAYS ? page[PAGE_DAYS - 1].day : "";
  if (!page.length) return { days: [], nextCursor, timeZone };
  const historyStart = Math.min(...sources.map((source) => source.first));
  const byDay = new Map(sources.map((source) => [source.day, source]));
  const clock = calendarClock(timeZone);
  const wanted = new Set<string>();
  for (const source of page) {
    const end = clock(source.end).day;
    for (let day = clock(source.start).day; day <= end; day = dayOffset(day, 1)) wanted.add(day);
  }
  const now = Date.now() / 1000 - REFERENCE;
  const stamps = new Map<string, { stamp: string; settled: boolean }>();
  for (const day of wanted) {
    const nearby = [-1, 0, 1].map((offset) => byDay.get(dayOffset(day, offset)));
    stamps.set(day, {
      stamp: [...nearby.map((source) => source?.revision ?? "0"), historyStart].join(":"),
      settled: nearby.every((source) => !source || source.last + SETTLE_SECONDS < now),
    });
  }
  const cached = await index.readSummaries(participant, timeZone, [...wanted]);
  const stale = [...wanted].filter((day) => cached.get(day)?.stamp !== stamps.get(day)!.stamp);
  const fresh = new Map<string, DaySummary>();
  if (stale.length) {
    stale.sort();
    const source = await index.read(
      participant,
      dayOffset(stale[0], -1),
      dayOffset(stale.at(-1)!, 1),
    );
    for (const day of summarizeDays(source, stale, timeZone, historyStart, now))
      fresh.set(day.day, day);
    const rows: CachedSummary[] = stale
      .filter((day) => stamps.get(day)!.settled)
      .map((day) => ({ day, stamp: stamps.get(day)!.stamp, summary: fresh.get(day) ?? null }));
    // A cache write failure must not fail the request; the next read recomputes.
    await index.writeSummaries(participant, timeZone, rows).catch(() => {
      console.error("Could not store dashboard summary rollups");
    });
  }
  const days = [...wanted].sort().flatMap((day) => {
    const value = fresh.get(day) ?? (stale.includes(day) ? null : cached.get(day)?.summary);
    return value ? [value as DaySummary] : [];
  });
  return { days, nextCursor, timeZone };
}
