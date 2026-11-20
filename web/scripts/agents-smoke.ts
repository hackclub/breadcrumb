import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresAnalytics, ClickHouseAnalytics } from "../lib/analytics";
import { MemoryStore } from "../lib/store";
import { R2AgentIndex } from "../lib/agents-r2";
import { readAgentUsage, type AgentIndex, type AgentSnapshot } from "../lib/agents";
const pg = process.env.ANALYTICS_TEST_POSTGRES_URL,
  ch = process.env.ANALYTICS_TEST_CLICKHOUSE_URL;
if (!pg || !ch) throw Error("Disposable local PostgreSQL and ClickHouse URLs are required");
for (const u of [pg, ch])
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(u).hostname))
    throw Error("Only disposable local databases are permitted");
if (new URL(pg).pathname !== "/breadcrumb_analytics_test")
  throw Error("Use breadcrumb_analytics_test");
const name = "agents_" + randomUUID().replaceAll("-", "");
const postgres = new PostgresAnalytics(pg, name),
  clickhouse = new ClickHouseAnalytics(
    ch,
    process.env.ANALYTICS_TEST_CLICKHOUSE_USER ?? "default",
    process.env.ANALYTICS_TEST_CLICKHOUSE_PASSWORD ?? "",
    name,
  );
const indexes: { name: string; index: AgentIndex }[] = [
  { name: "R2", index: new R2AgentIndex(new MemoryStore()) },
  { name: "PostgreSQL", index: postgres },
  { name: "ClickHouse", index: clickhouse },
];
const now = Date.now(),
  hour = new Date(Math.floor(now / 3600000) * 3600000).toISOString(),
  oldHour = new Date(Date.parse(hour) - 86400000).toISOString();
const snapshot: AgentSnapshot = {
  source: "a".repeat(32),
  hour,
  revision: 1,
  rows: [
    {
      provider: "claude",
      model: "claude-sonnet-4-6",
      project: "Example",
      input: 100,
      cacheRead: 200,
      cacheWrite: 40,
      cacheWrite1h: 10,
      output: 30,
      reasoning: 5,
      events: 2,
      sessions: 1,
    },
  ],
};
try {
  await postgres.migrate();
  await clickhouse.migrate();
  let reference: Awaited<ReturnType<typeof readAgentUsage>> | undefined;
  for (const { name, index } of indexes) {
    await index.writeAgents("owner", [snapshot, { ...snapshot, hour: oldHour }]);
    await index.writeAgents("other", [
      { ...snapshot, rows: [{ ...snapshot.rows[0], input: 99999 }] },
    ]);
    await index.writeAgents("owner", [snapshot]);
    const next = {
      ...snapshot,
      revision: 2,
      rows: [{ ...snapshot.rows[0], input: 400, model: "unknown" }],
    };
    await index.writeAgents("owner", [next]);
    await index.writeAgents("owner", [snapshot]);
    await index.writeAgents("owner", [{ ...next, source: "b".repeat(32) }]);
    const result = await readAgentUsage(
      index,
      "owner",
      { range: 7, timeZone: "America/New_York" },
      now,
    );
    assert.equal(result.hours.length, 2);
    assert.equal(result.hours.find((h) => h.hour === hour)?.input, 800);
    assert(!JSON.stringify(result).includes("source"));
    reference ??= result;
    assert.deepEqual(result, reference);
    await index.writeAgents("owner", [{ ...next, revision: 3, rows: [] }]);
    const removed = await readAgentUsage(index, "owner", { range: 7 }, now);
    assert.equal(removed.hours.find((h) => h.hour === hour)?.input, 400);
    assert.equal((await index.readAgents("owner", hour, hour)).length, 2);
    console.log(
      `${name}: token totals, idempotency, stale revisions, dimension replacement, empty snapshots, source merging and account isolation passed.`,
    );
  }
} finally {
  await postgres.close();
  await clickhouse.close();
}
