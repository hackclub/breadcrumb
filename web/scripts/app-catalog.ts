import { Pool } from "pg";
import { appSeed } from "../lib/apps";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL is required");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 10000,
});
try {
  await pool.query("BEGIN");
  await pool.query("CREATE SCHEMA IF NOT EXISTS breadcrumb_catalog");
  await pool.query(`CREATE TABLE IF NOT EXISTS breadcrumb_catalog.apps (
    id text PRIMARY KEY, name text NOT NULL, aliases text[] NOT NULL,
    icon text NOT NULL, source text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const app of appSeed)
    await pool.query(
      `INSERT INTO breadcrumb_catalog.apps (id,name,aliases,icon,source)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET name=excluded.name, aliases=excluded.aliases,
    icon=excluded.icon,source=excluded.source,updated_at=now()`,
      [app.id, app.name, app.aliases, app.icon, app.source],
    );
  await pool.query("COMMIT");
  console.log(`App catalog seeded with ${appSeed.length} apps.`);
} catch (error) {
  await pool.query("ROLLBACK");
  throw error;
} finally {
  await pool.end();
}
