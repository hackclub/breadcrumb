import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  PostgresAnalytics,
  ClickHouseAnalytics,
  type AnalyticsIndex,
  analyticsIndex,
} from "../lib/analytics";
import { MemoryStore } from "../lib/store";
import { recordSynced, syncedSummary, syncSample } from "../lib/sync";
import { Service } from "../lib/service";
import { REFERENCE } from "../lib/insights";
const pgURL = process.env.ANALYTICS_TEST_POSTGRES_URL;
const chURL = process.env.ANALYTICS_TEST_CLICKHOUSE_URL;
if (!pgURL || !chURL) throw Error("Local PostgreSQL and ClickHouse test URLs are required");
for (const value of [pgURL, chURL])
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname))
    throw Error("Analytics tests require local disposable databases");
if (new URL(pgURL).pathname !== "/breadcrumb_analytics_test")
  throw Error("Use the disposable breadcrumb_analytics_test database");
const suffix = randomUUID().replaceAll("-", "");
const schema = "test_" + suffix;
const password = process.env.ANALYTICS_TEST_CLICKHOUSE_PASSWORD ?? "";
const user = process.env.ANALYTICS_TEST_CLICKHOUSE_USER ?? "default";
const factories = [
  { name: "PostgreSQL", open: () => new PostgresAnalytics(pgURL, schema) },
  { name: "ClickHouse", open: () => new ClickHouseAnalytics(chURL, user, password, schema) },
];
const day0 = Math.floor(Date.now() / 86400000) * 86400 - 80 * 86400 - REFERENCE;
const records = Array.from({ length: 65 }, (_, i) => ({
  id: randomUUID(),
  date: day0 + i * 86400 + 43200,
  app: i % 2 ? "Helium" : "Editor",
  bundleID: i % 2 ? "net.imput.helium" : "editor",
  windowTitle: "Synthetic",
  context: { project: "Demo '); DROP TABLE samples; --" },
}));
records.push(
  { ...records[0], id: randomUUID(), date: day0 + 86390 },
  { ...records[1], id: randomUUID(), date: day0 + 86405 },
  { ...records[0], id: randomUUID(), date: records[0].date, app: "Tied timestamp" },
);
records.push({
  ...records[0],
  id: randomUUID(),
  date: records[0].date + 180,
  app: "界".repeat(199) + "😀",
});
const receivedAt = new Date().toISOString();
const reference = new MemoryStore();
for (const r of records) await recordSynced(reference, "alice", r, receivedAt);
async function pages(store: MemoryStore, index?: AnalyticsIndex, zone = "UTC") {
  const result = [];
  let cursor = "";
  do {
    const page = await syncedSummary(store, "alice", cursor, zone, index);
    result.push(page.days);
    cursor = page.nextCursor;
  } while (cursor);
  return result;
}
assert.throws(() => analyticsIndex({ NODE_ENV: "test", ANALYTICS_BACKEND: "invalid" }));
assert.throws(() => new ClickHouseAnalytics(chURL, user, password, "invalid; DROP DATABASE test"));
for (const factory of factories) {
  let index: AnalyticsIndex = factory.open();
  try {
    await index.migrate();
    await index.migrate();
    const batch = records.map((r) => syncSample("alice", r, receivedAt));
    await index.write(batch);
    await index.write(batch); // Network replay must not add time.
    await index.write([syncSample("bob", { ...records[0], id: randomUUID() }, receivedAt)]);
    await index.close();
    index = factory.open(); // Data survives a new connection.
    for (const zone of ["UTC", "America/New_York", "Asia/Kathmandu"])
      assert.deepEqual(
        await pages(reference, index, zone),
        await pages(reference, undefined, zone),
      );
    assert.equal((await index.page("bob", "", 60)).days.length, 1);
    assert.equal((await index.page("alice' OR 1=1 --", "", 60)).days.length, 0);
    assert.equal((await index.read("nobody", "1970-01-01", "9999-12-31")).size, 0);
    const store = new MemoryStore(),
      env = { NODE_ENV: "test" as const, PUBLIC_URL: "https://breadcrumb.example" };
    const access = {
      session: async (req: Request) =>
        req.headers.get("authorization") === "Bearer test"
          ? { id: "retry-user", email: "test@example.invalid" }
          : null,
      upload: async (req: Request) =>
        req.headers.get("authorization") === "Bearer test"
          ? { id: "retry-user", email: "test@example.invalid" }
          : null,
    };
    let fail = true;
    const unreliable: AnalyticsIndex = {
      key: index.key,
      write: async (rows) => {
        if (fail) {
          fail = false;
          throw Error("Synthetic outage");
        }
        await index.write(rows);
      },
      page: (...args) => index.page(...args),
      read: (...args) => index.read(...args),
      migrate: () => index.migrate(),
      close: async () => {},
    };
    const service = new Service(store, env, access, unreliable);
    const raw = {
      schemaVersion: 1,
      consent: true,
      record: { ...records[0], id: randomUUID() },
      payload: { tree: [{ role: "window", label: "Synthetic", depth: 0 }] },
    };
    const upload = () =>
      new Request(env.PUBLIC_URL + "/v1/ingest", {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify(raw),
      });
    assert.equal((await service.dispatch(upload())).status, 503);
    assert.equal((await store.list("captures/retry-user/")).keys.length, 1);
    const attempts = await Promise.all(Array.from({ length: 4 }, () => service.dispatch(upload())));
    assert(attempts.every((r) => r.status === 200));
    const summaryReq = (cursor = "") =>
      new Request(env.PUBLIC_URL + "/v1/account/summary?cursor=" + encodeURIComponent(cursor), {
        headers: { authorization: "Bearer test" },
      });
    const summary = await (await service.dispatch(summaryReq())).json();
    assert.equal(
      summary.days.reduce((n: number, d: { captures: number }) => n + d.captures, 0),
      1,
    );
    assert.equal((await service.dispatch(summaryReq("not-a-date"))).status, 400);
    assert.equal(
      (await service.dispatch(new Request(env.PUBLIC_URL + "/v1/account/summary"))).status,
      401,
    );
    // A completed legacy index must not suppress a new backend's backfill.
    const backfillAccess = {
      session: async () => ({ id: "backfill-user", email: "test@example.invalid" }),
      upload: async () => ({ id: "backfill-user", email: "test@example.invalid" }),
    };
    const legacy = new Service(store, env, backfillAccess);
    const backfillRaw = { ...raw, record: { ...raw.record, id: randomUUID() } };
    assert.equal(
      (await legacy.ingest(backfillRaw, { id: "backfill-user", email: "test@example.invalid" }))
        .status,
      201,
    );
    const indexRequest = () =>
      new Request(env.PUBLIC_URL + "/v1/account/index", {
        method: "POST",
        headers: { origin: env.PUBLIC_URL },
      });
    assert.equal((await legacy.dispatch(indexRequest())).status, 200);
    const target = new Service(store, env, backfillAccess, index);
    assert.equal((await target.dispatch(indexRequest())).status, 200);
    assert.equal((await target.dispatch(indexRequest())).status, 200);
    const loaded = await (
      await target.dispatch(new Request(env.PUBLIC_URL + "/v1/account/summary"))
    ).json();
    assert.equal(
      loaded.days.reduce((n: number, d: { captures: number }) => n + d.captures, 0),
      1,
    );
    console.log(
      `${factory.name}: time accounting, pagination, retries, backfill, persistence and account isolation passed.`,
    );
  } finally {
    await index.close();
  }
}
const cleanup = new Pool({ connectionString: pgURL, max: 1 });
await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
await cleanup.end();
const response = await fetch(chURL, {
  method: "POST",
  headers: { "X-ClickHouse-User": user, "X-ClickHouse-Key": password },
  body: `DROP DATABASE \`${schema}\``,
});
assert(response.ok);
console.log("Analytics parity checks passed; test data removed.");
