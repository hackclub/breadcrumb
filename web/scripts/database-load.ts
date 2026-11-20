// Reproducible synthetic load check; refuses non-local and non-test databases.
import { randomBytes } from "node:crypto";
import { getMigrations } from "better-auth/db/migration";
import { authOptions } from "../lib/auth";
import { platformDB, databasePool, integrationsSchema, requestQuota } from "../lib/platform-db";
import { sharesSchema } from "../lib/screenshots";
import assert from "node:assert/strict";
const connection = process.env.DATABASE_LOAD_TEST_URL;
if (!connection) throw Error("DATABASE_LOAD_TEST_URL is required");
const url = new URL(connection);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  url.pathname !== "/breadcrumb_database_load_test"
)
  throw Error("Use a disposable local breadcrumb_database_load_test database");
process.env.DATABASE_URL = connection;
process.env.AUTH_DATABASE_URL = connection;
process.env.DB_POOL_MAX = "3";
process.env.DB_AUTH_POOL_MAX = "2";
const pool = platformDB(),
  auth = databasePool("breadcrumb_auth"),
  prefix = "dbload_" + randomBytes(5).toString("hex"),
  users = 15488,
  clients = 8;
const user = (n: number) => `${prefix}_user_${n}`,
  client = (n: number) => `${prefix}_client_${n}`;
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
async function timing(fn: () => Promise<unknown>, count = 30) {
  const times: number[] = [];
  for (let i = 0; i < count + 5; i++) {
    const start = performance.now();
    await fn();
    if (i >= 5) times.push(performance.now() - start);
  }
  return { medianMs: percentile(times, 0.5), p95Ms: percentile(times, 0.95) };
}
async function plan(sql: string, args: unknown[]) {
  return (await pool.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + sql, args)).rows[0][
    "QUERY PLAN"
  ][0];
}
try {
  await pool.query("CREATE SCHEMA IF NOT EXISTS breadcrumb_auth");
  await (
    await getMigrations(
      authOptions({
        database: auth,
        baseURL: "https://breadcrumb.example",
        secret: randomBytes(48).toString("hex"),
        send: async () => {},
      }),
    )
  ).runMigrations();
  await pool.query(integrationsSchema + sharesSchema);
  await pool.query(
    `INSERT INTO breadcrumb_auth."user"(id,name,email,"emailVerified","createdAt","updatedAt") SELECT $1||'_user_'||n,'Load fixture',$1||n||'@example.invalid',true,now(),now() FROM generate_series(1,$2) n`,
    [prefix, users],
  );
  await pool.query(
    `INSERT INTO breadcrumb_auth."oauthClient"(id,"clientId","redirectUris") SELECT $1||'_client_'||n,$1||'_client_'||n,'["https://client.example/callback"]'::jsonb FROM generate_series(1,$2) n`,
    [prefix, clients],
  );
  await pool.query(
    `INSERT INTO breadcrumb_auth."oauthConsent"(id,"clientId","userId",scopes,resources,"createdAt","updatedAt") SELECT $1||'_grant_'||u||'_'||c,$1||'_client_'||c,$1||'_user_'||u,'["time:read","apps:read"]'::jsonb,'["https://breadcrumb.example/api/v1"]'::jsonb,now(),now() FROM generate_series(1,$2) u CROSS JOIN generate_series(1,$3) c`,
    [prefix, users, clients],
  );
  await pool.query(
    `INSERT INTO breadcrumb_integrations.shares(id,secret_hash,owner_id,participant,capture_id,expires_at) SELECT $1||'_share_'||n,repeat('0',64),$1||'_user_1',repeat('a',64),'00000000-0000-4000-8000-000000000001',CASE WHEN n<=50000 THEN now()-interval '1 day' ELSE now()+interval '1 day' END FROM generate_series(1,50030) n`,
    [prefix],
  );
  await pool.query('VACUUM ANALYZE breadcrumb_auth."oauthConsent"');
  await pool.query('VACUUM ANALYZE breadcrumb_auth."user"');
  await pool.query("VACUUM ANALYZE breadcrumb_integrations.shares");
  const grantSQL =
    'SELECT scopes,resources FROM breadcrumb_auth."oauthConsent" WHERE "userId"=$1 AND "clientId"=$2';
  const shareSQL =
    "SELECT count(*) FROM breadcrumb_integrations.shares WHERE owner_id=$1 AND expires_at>now()";
  await pool.query("DROP INDEX breadcrumb_auth.oauth_consent_live_access");
  await pool.query("DROP INDEX breadcrumb_integrations.shares_owner_expiry");
  const before = {
    grant: await timing(() => pool.query(grantSQL, [user(1), client(1)])),
    activeShares: await timing(() => pool.query(shareSQL, [user(1)])),
  };
  await pool.query(integrationsSchema + sharesSchema);
  const after = {
    grant: await timing(() => pool.query(grantSQL, [user(1), client(1)])),
    activeShares: await timing(() => pool.query(shareSQL, [user(1)])),
  };
  const plans = {
    grant: await plan(grantSQL, [user(1), client(1)]),
    activeShares: await plan(shareSQL, [user(1)]),
  };
  const locked = await pool.connect();
  let rejectedWrites = 0;
  try {
    await locked.query("BEGIN");
    await locked.query(
      "INSERT INTO breadcrumb_integrations.limits(id,started_at,requests) VALUES($1,now(),120)",
      [prefix + "_quota"],
    );
    assert.equal((await requestQuota(prefix + "_quota", locked)).allowed, false);
    const updates = async () =>
      Number(
        (
          await locked.query(
            "SELECT n_tup_upd FROM pg_stat_xact_user_tables WHERE schemaname='breadcrumb_integrations' AND relname='limits'",
          )
        ).rows[0].n_tup_upd,
      );
    const old = await updates();
    for (let i = 0; i < 100; i++)
      assert.equal((await requestQuota(prefix + "_quota", locked)).allowed, false);
    rejectedWrites = (await updates()) - old;
    assert.equal(rejectedWrites, 0);
    await locked.query("COMMIT");
  } catch (error) {
    await locked.query("ROLLBACK");
    throw error;
  } finally {
    locked.release();
  }
  const latencies: number[] = [];
  const start = performance.now();
  await Promise.all(
    Array.from({ length: 16 }, async (_, worker) => {
      for (let n = 0; n < 50; n++) {
        const u = user(worker * 50 + n + 1),
          begin = performance.now();
        await Promise.all([
          auth.query('SELECT email,"emailVerified" FROM "user" WHERE id=$1', [u]),
          auth.query(
            'SELECT scopes,resources FROM "oauthConsent" WHERE "userId"=$1 AND "clientId"=$2',
            [u, client(1)],
          ),
        ]);
        assert.ok((await requestQuota(u + ":" + client(1))).allowed);
        latencies.push(performance.now() - begin);
      }
    }),
  );
  const concurrent = {
    requests: latencies.length,
    workers: 16,
    durationMs: performance.now() - start,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    appConnections: pool.totalCount,
    authConnections: auth.totalCount,
  };
  assert.ok(pool.totalCount <= 3 && auth.totalCount <= 2);
  console.log(
    JSON.stringify(
      {
        users,
        consents: users * clients,
        shareLinks: 50030,
        before,
        after,
        rejectedWrites,
        concurrent,
        plans,
      },
      null,
      2,
    ),
  );
} finally {
  await pool.query('DELETE FROM breadcrumb_auth."user" WHERE id LIKE $1', [prefix + "_user_%"]);
  await pool.query('DELETE FROM breadcrumb_auth."oauthClient" WHERE id LIKE $1', [
    prefix + "_client_%",
  ]);
  await pool.query("DELETE FROM breadcrumb_integrations.limits WHERE id LIKE $1", [prefix + "%"]);
  await auth.end();
  await pool.end();
}
