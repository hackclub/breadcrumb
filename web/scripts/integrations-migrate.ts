import { platformDB, integrationsSchema } from "../lib/platform-db";
import { sharesSchema } from "../lib/screenshots";
const pool = platformDB();
try {
  await pool.query(integrationsSchema + sharesSchema);
  console.log("Integration database schema is up to date.");
} finally {
  await pool.end();
}
