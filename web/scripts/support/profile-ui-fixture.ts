// Only for UI tests against a disposable local PostgreSQL database.
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { PostgresProfiles, type Profile } from "../../lib/profiles";
import { profilesSchema } from "../../lib/profiles-schema";

export async function profileUIFixture(connection: string) {
  const url = new URL(connection);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/breadcrumb_profiles_test"
  )
    throw Error("Profile UI tests require the disposable local breadcrumb_profiles_test database");
  const pool = new Pool({ connectionString: connection, max: 2, connectionTimeoutMillis: 5000 });
  const repo = new PostgresProfiles(pool);
  const owners = new Set<string>();
  const key = (owner: string) =>
    `profile-avatars/${createHash("sha256").update(owner).digest("hex")}/00000000-0000-4000-8000-000000000001.webp`;
  await pool.query(
    'CREATE SCHEMA IF NOT EXISTS breadcrumb_auth; CREATE TABLE IF NOT EXISTS breadcrumb_auth."user" (id text PRIMARY KEY)',
  );
  await pool.query(profilesSchema);
  return {
    async save(owner: string, profile: Profile) {
      if (!owners.has(owner)) {
        if (!owner.startsWith("profile_ui_")) throw Error("Invalid UI fixture owner");
        await pool.query('INSERT INTO breadcrumb_auth."user" (id) VALUES ($1)', [owner]);
        owners.add(owner);
      }
      await repo.save(
        owner,
        {
          username: profile.username,
          displayName: profile.displayName,
          bio: profile.bio,
          visibility: profile.visibility,
          shareApps: profile.shareApps,
          apps: profile.apps,
          githubUrl: profile.githubUrl,
          websiteUrl: profile.websiteUrl,
          ...(profile.avatarMode !== "upload" ? { avatarMode: profile.avatarMode } : {}),
        },
        profile.avatarMode === "gravatar" ? "a".repeat(64) : undefined,
      );
      if (profile.avatarMode === "upload") await repo.uploadAvatar(owner, key(owner));
    },
    async close() {
      for (const owner of owners) {
        await pool.query('DELETE FROM breadcrumb_auth."user" WHERE id=$1', [owner]);
        await pool.query("DELETE FROM breadcrumb_profiles.avatar_garbage WHERE key=$1", [
          key(owner),
        ]);
      }
      await pool.end();
    },
  };
}
