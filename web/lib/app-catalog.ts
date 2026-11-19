import { Pool } from "pg";
import { appSeed, type AppEntry } from "./apps";
let pool: Pool | undefined;
export async function appCatalog(): Promise<AppEntry[]> {
  if (!process.env.DATABASE_URL) return appSeed;
  pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  });
  try {
    const result = await pool.query<AppEntry>(
      "SELECT id, name, aliases, icon, source FROM breadcrumb_catalog.apps ORDER BY name",
    );
    return result.rows.length ? result.rows : appSeed;
  } catch {
    // Bundled entries keep icons available during first-time setup or DB outages.
    return appSeed;
  }
}
