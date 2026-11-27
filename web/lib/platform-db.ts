import { Pool } from "pg";
import { attachDatabasePool } from "@vercel/functions";
import { devicesSchema } from "./devices";
const pools = new Map<string, Pool>();
function poolSize(value: string | undefined, fallback: number) {
  const max = !value?.trim() ? fallback : Number(value);
  if (!Number.isInteger(max) || max < 1 || max > 20)
    throw Error("Database pool size must be between 1 and 20");
  return max;
}
export function createDatabasePool(
  connectionString: string,
  options: { searchPath?: string; max?: number } = {},
) {
  if (options.searchPath && !/^[a-z_][a-z0-9_]*$/.test(options.searchPath))
    throw Error("Invalid database schema");
  const pool = new Pool({
    connectionString,
    max:
      options.max ??
      poolSize(
        options.searchPath ? process.env.DB_AUTH_POOL_MAX : process.env.DB_POOL_MAX,
        options.searchPath ? 2 : 3,
      ),
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 5000,
    maxLifetimeSeconds: 300,
    statement_timeout: 15000,
    query_timeout: 20000,
    lock_timeout: 5000,
    idle_in_transaction_session_timeout: 10000,
    keepAlive: true,
    application_name: "breadcrumb",
    ...(options.searchPath ? { options: `-c search_path=${options.searchPath}` } : {}),
  });
  pool.on("error", () => console.error("Database idle connection failed"));
  if (process.env.VERCEL) attachDatabasePool(pool);
  return pool;
}
export function databasePool(searchPath?: string) {
  const url = (searchPath ? process.env.AUTH_DATABASE_URL : undefined) || process.env.DATABASE_URL;
  if (!url) throw Error("Database is not configured");
  const key = JSON.stringify([url, searchPath]);
  let pool = pools.get(key);
  if (!pool) {
    pool = createDatabasePool(url, { searchPath });
    pools.set(key, pool);
  }
  return pool;
}
export function platformDB() {
  return databasePool();
}
export const integrationsSchema = `CREATE SCHEMA IF NOT EXISTS breadcrumb_integrations;
CREATE TABLE IF NOT EXISTS breadcrumb_integrations.limits (
  id text PRIMARY KEY, started_at timestamptz NOT NULL, requests integer NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_consent_live_access ON breadcrumb_auth."oauthConsent" ("userId","clientId") INCLUDE (scopes,resources);
ALTER TABLE breadcrumb_integrations.limits SET (fillfactor=75,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_scale_factor=0.05);
${devicesSchema}`;
export async function requestQuota(id: string, db: Pick<Pool, "query"> = platformDB()) {
  // A finite row per authenticated principal/client; no attacker-controlled IP rows.
  const result = await db.query<{ requests: number; retry: number }>(
    `INSERT INTO breadcrumb_integrations.limits(id,started_at,requests) VALUES($1,now(),1)
    ON CONFLICT(id) DO UPDATE SET requests=CASE WHEN breadcrumb_integrations.limits.started_at < now()-interval '60 seconds' THEN 1 ELSE breadcrumb_integrations.limits.requests+1 END,
    started_at=CASE WHEN breadcrumb_integrations.limits.started_at < now()-interval '60 seconds' THEN now() ELSE breadcrumb_integrations.limits.started_at END
    WHERE breadcrumb_integrations.limits.requests<=120 OR breadcrumb_integrations.limits.started_at < now()-interval '60 seconds'
    RETURNING requests, greatest(1,ceil(extract(epoch FROM started_at+interval '60 seconds'-now())))::int AS retry`,
    [id],
  );
  if (!result.rows[0]) return { remaining: 0, retry: 60, allowed: false };
  const { requests, retry } = result.rows[0];
  return { remaining: Math.max(0, 120 - requests), retry, allowed: requests <= 120 };
}
