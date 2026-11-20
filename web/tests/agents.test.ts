import { test, expect } from "bun:test";
import { MemoryStore } from "../lib/store";
import { R2AgentIndex } from "../lib/agents-r2";
import { validateAgentSnapshots, readAgentUsage, type AgentSnapshot } from "../lib/agents";
import { Service } from "../lib/service";
const hour = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
const snapshot: AgentSnapshot = {
  source: "a".repeat(32),
  hour,
  revision: 1,
  rows: [
    {
      provider: "codex",
      model: "gpt-5.4",
      project: "Example",
      input: 100,
      cacheRead: 200,
      cacheWrite: 0,
      cacheWrite1h: 0,
      output: 30,
      reasoning: 10,
      events: 2,
      sessions: 1,
    },
  ],
};
test("usage schema rejects chats, paths, duplicates and missing consent", () => {
  expect(validateAgentSnapshots({ consent: true, snapshots: [snapshot] })).toHaveLength(1);
  expect(
    validateAgentSnapshots({
      consent: true,
      snapshots: [{ ...snapshot, rows: [{ ...snapshot.rows[0], project: "Example café" }] }],
    }),
  ).toHaveLength(1);
  for (const raw of [
    { consent: false, snapshots: [snapshot] },
    { consent: true, snapshots: [{ ...snapshot, prompt: "PROMPT_SENTINEL" }] },
    {
      consent: true,
      snapshots: [{ ...snapshot, rows: [{ ...snapshot.rows[0], response: "RESPONSE_SENTINEL" }] }],
    },
    {
      consent: true,
      snapshots: [
        { ...snapshot, rows: [{ ...snapshot.rows[0], project: "/home/person/project" }] },
      ],
    },
    {
      consent: true,
      snapshots: [
        { ...snapshot, rows: [{ ...snapshot.rows[0], project: "C:\\Users\\person\\repo" }] },
      ],
    },
    { consent: true, snapshots: [{ ...snapshot, rows: [snapshot.rows[0], snapshot.rows[0]] }] },
    {
      consent: true,
      snapshots: [{ ...snapshot, rows: [{ ...snapshot.rows[0], reasoning: 999 }] }],
    },
  ])
    expect(() => validateAgentSnapshots(raw)).toThrow();
});
test("R2 hourly replacements are idempotent, revision ordered and isolated", async () => {
  class Paginated extends MemoryStore {
    override list(prefix: string, cursor = "", _limit = 100) {
      return super.list(prefix, cursor, 1);
    }
  }
  const store = new Paginated(),
    index = new R2AgentIndex(store);
  await index.writeAgents("one", [snapshot, snapshot]);
  await index.writeAgents("two", [{ ...snapshot, rows: [{ ...snapshot.rows[0], input: 999 }] }]);
  const newer = { ...snapshot, revision: 2, rows: [{ ...snapshot.rows[0], input: 400 }] };
  await index.writeAgents("one", [newer, snapshot]);
  let result = await readAgentUsage(index, "one", { range: 1, timeZone: "America/New_York" });
  expect(result.hours).toHaveLength(1);
  expect(result.hours[0].input).toBe(400);
  expect(JSON.stringify(result)).not.toContain("source");
  expect(JSON.stringify(result)).not.toContain("SENTINEL");
  await index.writeAgents("one", [{ ...newer, source: "b".repeat(32) }]);
  result = await readAgentUsage(index, "one", { range: 7 });
  expect(result.hours[0].input).toBe(800);
  await index.writeAgents("one", [{ ...newer, revision: 3, rows: [] }]);
  result = await readAgentUsage(index, "one", { range: 7 });
  expect(result.hours[0].input).toBe(400);
});
test("ingest requires a token-usage grant and never stores rejected content", async () => {
  const store = new MemoryStore(),
    identity = { id: "account", email: "synthetic@example.invalid" },
    service = new Service(
      store,
      { NODE_ENV: "test" },
      {
        session: async () => identity,
        upload: async () => identity,
        agents: async (req) =>
          req.headers.get("authorization") === "Bearer agents" ? identity : null,
      },
    );
  const request = (body: unknown, token = "agents") =>
    new Request("https://breadcrumb.example/v1/agents/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  expect(
    (await service.dispatch(request({ consent: true, snapshots: [snapshot] }, "captures"))).status,
  ).toBe(401);
  expect(
    (
      await service.dispatch(
        request({ consent: true, snapshots: [{ ...snapshot, tool: "TOOL_SENTINEL" }] }),
      )
    ).status,
  ).toBe(400);
  expect((await service.dispatch(request({ consent: true, snapshots: [snapshot] }))).status).toBe(
    200,
  );
  const keys = (await store.list("agents/")).keys;
  expect(keys).toHaveLength(1);
  for (const key of keys)
    expect(Buffer.from((await store.get(key))!).toString()).not.toContain("SENTINEL");
});
test("usage query validates range and zone", async () => {
  const index = new R2AgentIndex(new MemoryStore());
  await expect(readAgentUsage(index, "a", { range: 2 })).rejects.toMatchObject({ status: 400 });
  await expect(readAgentUsage(index, "a", { range: 7, timeZone: "invalid" })).rejects.toMatchObject(
    { status: 400 },
  );
});
