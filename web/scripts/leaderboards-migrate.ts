import { Pool } from "pg";
import { leaderboardsSchema } from "../lib/leaderboards-schema";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL is required");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 10000,
});
try {
  await pool.query(leaderboardsSchema);
  console.log("Leaderboard database schema is up to date.");
} finally {
  await pool.end();
}
