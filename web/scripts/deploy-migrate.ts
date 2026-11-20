// Opt-in deployment step. Ordinary local/preview builds never contact the database.
if (process.env.BREADCRUMB_APPLY_MIGRATIONS === "1") {
  const { platformDB, integrationsSchema } = await import("../lib/platform-db");
  const { sharesSchema } = await import("../lib/screenshots");
  const { leaderboardsSchema } = await import("../lib/leaderboards-schema");
  const pool = platformDB(),
    client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(72684291)");
    await client.query(integrationsSchema + sharesSchema + leaderboardsSchema);
    await client.query("COMMIT");
    console.log("Integration and leaderboard database migrations complete.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
export {};
