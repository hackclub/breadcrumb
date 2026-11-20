import { z } from "zod";
import { analyticsIndex, type AnalyticsIndex, type SampleDay } from "./analytics";
import type { Store } from "./store";
import { summarize, type InsightDay } from "./insights";
import { APIProblem } from "./api-http";
import type { DataPrincipal } from "./data-access";

const date = z.iso.date();
export const activityQuery = z
  .object({
    from: date.optional(),
    to: date.optional(),
    timeZone: z.string().max(100).default("UTC"),
    cursor: date.optional(),
    limit: z.coerce.number().int().min(1).max(31).default(7),
  })
  .strict();
export const dayOffset = (day: string, offset: number) =>
  new Date(Date.parse(day + "T12:00:00Z") + offset * 86400000).toISOString().slice(0, 10);
export async function readActivity(
  store: Store,
  principal: DataPrincipal,
  input: unknown,
  index: AnalyticsIndex | undefined = analyticsIndex(),
) {
  const parsed = activityQuery.safeParse(input);
  if (!parsed.success)
    throw new APIProblem(
      400,
      "invalid_query",
      "Invalid activity range, limit, cursor, or time zone.",
      "Use ISO dates and a limit between 1 and 31; see /openapi.json.",
    );
  const { limit, timeZone } = parsed.data;
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format();
  } catch {
    throw new APIProblem(
      400,
      "invalid_time_zone",
      "Unknown IANA time zone.",
      "Use an IANA time zone such as America/New_York or UTC.",
    );
  }
  const to = parsed.data.to ?? new Date().toISOString().slice(0, 10),
    from = parsed.data.from ?? dayOffset(to, -6);
  if (from > to || Date.parse(to) - Date.parse(from) > 365 * 86400000)
    throw new APIProblem(
      400,
      "invalid_range",
      "Choose a range of up to 366 days.",
      "Set from before to, then paginate with nextCursor.",
    );
  const start = parsed.data.cursor ?? from;
  if (start < from || start > to)
    throw new APIProblem(
      400,
      "invalid_cursor",
      "Cursor is outside this range.",
      "Keep from, to and timeZone unchanged while paginating.",
    );
  const end = dayOffset(
    start,
    Math.min(limit - 1, Math.round((Date.parse(to) - Date.parse(start)) / 86400000)),
  );
  const source = new Map<string, SampleDay>();
  let historyStart: number | undefined;
  if (index) {
    historyStart = (await index.page(principal.participant, "", 1)).historyStart ?? undefined;
    for (const [key, value] of await index.read(
      principal.participant,
      dayOffset(start, -1),
      dayOffset(end, 1),
    ))
      source.set(key, value);
  } else {
    const keys: string[] = [];
    for (let day = dayOffset(start, -1); day <= dayOffset(end, 1); day = dayOffset(day, 1))
      keys.push(day);
    for (let n = 0; n < keys.length; n += 5)
      await Promise.all(
        keys.slice(n, n + 5).map(async (day) => {
          const raw = await store.get(`sync/days/${principal.participant}/${day}.json`);
          if (raw) source.set(day, JSON.parse(Buffer.from(raw).toString()));
        }),
      );
  }
  if (!index) {
    const first = (await store.list(`sync/days/${principal.participant}/`, "", 1)).keys[0];
    if (first) {
      const key = first.split("/").at(-1)!.slice(0, -5);
      const raw = source.has(key) ? null : await store.get(first);
      const firstDay =
        source.get(key) ??
        (raw ? (JSON.parse(Buffer.from(raw).toString()) as SampleDay) : undefined);
      if (firstDay) historyStart = Math.min(...Object.values(firstDay.samples).map((s) => s.date));
    }
  }
  const days = [];
  for (let day = start; day <= end; day = dayOffset(day, 1)) {
    const nearby = [-1, 0, 1].flatMap((offset) => {
      const value = source.get(dayOffset(day, offset));
      return value ? [value] : [];
    });
    const value = summarize(
      nearby.flatMap((d) =>
        Object.entries(d.samples)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, v]) => v),
      ),
      day,
      undefined,
      timeZone,
      historyStart,
    );
    const apps = principal.scopes.includes("apps:read"),
      projects = principal.scopes.includes("projects:read");
    const breakdown = (row: Pick<InsightDay, "seconds" | "apps" | "activities" | "projects">) => ({
      seconds: row.seconds,
      ...(apps ? { apps: row.apps } : {}),
      ...(projects ? { projects: row.projects } : {}),
    });
    days.push({
      day,
      seconds: value.seconds,
      hours: value.hours,
      hourly: value.hourly.map((hour, index) => ({ hour: index, ...breakdown(hour) })),
      ...(apps ? { apps: value.apps } : {}),
      ...(projects ? { projects: value.projects } : {}),
    });
  }
  return {
    from,
    to,
    timeZone,
    days,
    nextCursor: end < to ? dayOffset(end, 1) : "",
    measure: "observed_time",
    description:
      "Estimated sampled coverage. Overlap counts once. This is not verified attention or productive work.",
  };
}
