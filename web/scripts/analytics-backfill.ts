import { parseArgs } from "node:util";
import { analyticsIndex, type IndexedSample } from "../lib/analytics";
import type { AgentSnapshot } from "../lib/agents";
import { sha } from "../lib/service";
import { R2Store } from "../lib/store";
import { syncSample } from "../lib/sync";
// Copies captures and coding-agent usage from R2 into the configured analytics backend. Safe to
// re-run: writes are idempotent. After a complete pass, --mark-indexed records each account as
// indexed so its first dashboard visit does not re-read every capture from R2.
const { values } = parseArgs({
  options: { cursor: { type: "string" }, "mark-indexed": { type: "boolean" } },
});
const index = analyticsIndex();
if (!index) throw Error("Choose postgres or clickhouse with ANALYTICS_BACKEND first");
const store = new R2Store();
const participants = new Set<string>();
async function each(prefix: string, cursor: string, visit: (keys: string[]) => Promise<void>) {
  do {
    const page = await store.list(prefix, cursor, 100);
    await visit(page.keys);
    cursor = page.cursor;
    if (cursor) console.log(JSON.stringify({ prefix, nextCursor: cursor }));
  } while (cursor);
}
async function read<T>(keys: string[]) {
  const out: [string, T][] = [];
  for (let i = 0; i < keys.length; i += 5)
    await Promise.all(
      keys.slice(i, i + 5).map(async (key) => {
        const raw = await store.get(key);
        if (raw) out.push([key, JSON.parse(Buffer.from(raw).toString()) as T]);
      }),
    );
  return out;
}
try {
  let samples = 0;
  await each("captures/", values.cursor ?? "", async (keys) => {
    const entries = await read<{
      participant: string;
      receivedAt: string;
      upload: { record: Parameters<typeof syncSample>[1] };
    }>(keys);
    const rows: IndexedSample[] = entries.map(([, e]) => {
      participants.add(e.participant);
      return syncSample(e.participant, e.upload.record, e.receivedAt);
    });
    await index.write(rows);
    samples += rows.length;
  });
  let snapshots = 0;
  await each("agents/v1/", "", async (keys) => {
    const byParticipant = new Map<string, AgentSnapshot[]>();
    for (const [key, snapshot] of await read<AgentSnapshot>(keys)) {
      const participant = key.split("/")[2];
      if (participant)
        byParticipant.set(participant, [...(byParticipant.get(participant) ?? []), snapshot]);
    }
    for (const [participant, list] of byParticipant) {
      await index.writeAgents(participant, list);
      snapshots += list.length;
    }
  });
  if (values["mark-indexed"] && !values.cursor) {
    const suffix = `-${index.key}-${sha(process.env.ANALYTICS_INDEX_VERSION || "1").slice(0, 8)}`;
    for (const participant of participants)
      await store.update(`sync/migrations/insights-v4${suffix}/${participant}.json`, () =>
        Buffer.from(JSON.stringify({ cursor: "", done: true })),
      );
  }
  console.log(JSON.stringify({ samples, snapshots, accounts: participants.size }));
} finally {
  await index.close();
}
