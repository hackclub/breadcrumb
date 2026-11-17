import { getMigrations } from "better-auth/db/migration";
import { getAuth } from "../lib/auth";
import { Pool } from "pg";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL is required");
const bootstrap = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 10000,
});
await bootstrap.query('CREATE SCHEMA IF NOT EXISTS "breadcrumb_auth"');
await bootstrap.end();
const migration = await getMigrations(getAuth().options);
await migration.runMigrations();
console.log("Better Auth database schema is up to date.");
process.exit(0);
