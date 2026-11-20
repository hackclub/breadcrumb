import { z } from "zod";
import { APIProblem } from "./api-http";
export const agentName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:@+-]{0,199}$/);
const token = z.number().int().min(0).max(1e12);
export const agentRow = z
  .object({
    provider: agentName,
    model: agentName,
    project: z
      .string()
      .max(200)
      .refine((s) => s !== "." && s !== ".." && !/[\\/:\p{Cc}]/u.test(s)),
    input: token,
    cacheRead: token,
    cacheWrite: token,
    cacheWrite1h: token,
    output: token,
    reasoning: token,
    events: token,
    sessions: token,
  })
  .strict()
  .refine((r) => r.cacheWrite1h <= r.cacheWrite && r.reasoning <= r.output);
export type AgentRow = z.infer<typeof agentRow>;
export const agentSnapshot = z
  .object({
    source: z.string().regex(/^[a-f0-9]{32}$/),
    hour: z.iso
      .datetime()
      .refine((s) => Date.parse(s) % 3600000 === 0)
      .transform((s) => new Date(s).toISOString()),
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    rows: z.array(agentRow).max(500),
  })
  .strict()
  .refine(
    (s) =>
      new Set(s.rows.map((r) => JSON.stringify([r.provider, r.model, r.project]))).size ===
      s.rows.length,
  );
export type AgentSnapshot = z.infer<typeof agentSnapshot>;
export interface AgentIndex {
  writeAgents(participant: string, snapshots: AgentSnapshot[]): Promise<void>;
  readAgents(participant: string, from: string, to: string): Promise<AgentSnapshot[]>;
}
export const agentUsageQuery = z
  .object({
    range: z.coerce
      .number()
      .pipe(z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]))
      .default(7),
    timeZone: z.string().max(100).default("UTC"),
  })
  .strict();
export function validateAgentSnapshots(raw: unknown, now = Date.now()) {
  const parsed = z
    .object({ consent: z.literal(true), snapshots: z.array(agentSnapshot).min(1).max(24) })
    .strict()
    .safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.snapshots.some(
      (s) => Date.parse(s.hour) < now - 93 * 86400000 || Date.parse(s.hour) > now + 300000,
    )
  )
    throw new APIProblem(
      400,
      "invalid_agent_usage",
      "Expected hourly usage aggregates with explicit consent.",
      "Send usage numbers and project names only; chats and paths are not accepted.",
    );
  return parsed.data.snapshots;
}
export async function readAgentUsage(
  index: AgentIndex,
  participant: string,
  query: unknown,
  now = Date.now(),
) {
  const parsed = agentUsageQuery.safeParse(query);
  if (!parsed.success)
    throw new APIProblem(
      400,
      "invalid_query",
      "Invalid coding-agent range.",
      "Use range=1,7,30,90 and an IANA timeZone.",
    );
  const { range, timeZone } = parsed.data;
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format();
  } catch {
    throw new APIProblem(400, "invalid_time_zone", "Unknown time zone.", "Use an IANA time zone.");
  }
  const from = new Date(Math.floor((now - range * 86400000) / 3600000) * 3600000).toISOString(),
    to = new Date(now).toISOString();
  const snapshots = await index.readAgents(participant, from, to),
    hours = new Map<string, AgentRow & { hour: string }>();
  for (const s of snapshots)
    for (const r of s.rows) {
      const key = JSON.stringify([s.hour, r.provider, r.model, r.project]),
        h = hours.get(key) ?? {
          ...r,
          hour: s.hour,
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite1h: 0,
          output: 0,
          reasoning: 0,
          events: 0,
          sessions: 0,
        };
      for (const k of [
        "input",
        "cacheRead",
        "cacheWrite",
        "cacheWrite1h",
        "output",
        "reasoning",
        "events",
        "sessions",
      ] as const)
        h[k] += r[k];
      hours.set(key, h);
    }
  return {
    hours: [...hours.values()].sort(
      (a, b) =>
        a.hour.localeCompare(b.hour) ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model) ||
        a.project.localeCompare(b.project),
    ),
    timeZone,
    range,
    sessionsCount: "started",
    estimate: "API estimate",
    precision: "hour",
  };
}
