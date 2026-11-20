import { platformDB } from "./platform-db";
import { appSeed, type AppEntry } from "./apps";
export async function appCatalog(): Promise<AppEntry[]> {
  if (!process.env.DATABASE_URL) return appSeed;
  try {
    const result = await platformDB().query<AppEntry>(
      "SELECT id, name, aliases, icon, source FROM breadcrumb_catalog.apps ORDER BY name",
    );
    return result.rows.length ? result.rows : appSeed;
  } catch {
    // Bundled entries keep icons available during first-time setup or DB outages.
    return appSeed;
  }
}
