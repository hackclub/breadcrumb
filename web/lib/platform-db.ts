import { Pool } from "pg";
let pool: Pool | undefined;
export function platformDB() {
  if (!process.env.DATABASE_URL) throw Error("Database is not configured");
  return (pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  }));
}
export const integrationsSchema = `CREATE SCHEMA IF NOT EXISTS breadcrumb_integrations;
CREATE TABLE IF NOT EXISTS breadcrumb_integrations.limits (
  id text PRIMARY KEY, started_at timestamptz NOT NULL, requests integer NOT NULL
);`;
export async function requestQuota(id: string) {
  // A finite row per authenticated principal/client; no attacker-controlled IP rows.
  const result = await platformDB().query<{ requests: number; retry: number }>(
    `INSERT INTO breadcrumb_integrations.limits(id,started_at,requests) VALUES($1,now(),1)
    ON CONFLICT(id) DO UPDATE SET requests=CASE WHEN breadcrumb_integrations.limits.started_at < now()-interval '60 seconds' THEN 1 ELSE breadcrumb_integrations.limits.requests+1 END,
    started_at=CASE WHEN breadcrumb_integrations.limits.started_at < now()-interval '60 seconds' THEN now() ELSE breadcrumb_integrations.limits.started_at END
    RETURNING requests, greatest(1,ceil(extract(epoch FROM started_at+interval '60 seconds'-now())))::int AS retry`,
    [id],
  );
  const { requests, retry } = result.rows[0];
  return { remaining: Math.max(0, 120 - requests), retry, allowed: requests <= 120 };
}
