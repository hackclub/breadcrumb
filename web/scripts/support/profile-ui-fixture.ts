import { betterAuth } from "better-auth";
// Only for UI tests against a disposable local PostgreSQL database.
import { testUtils } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import { authOptions } from "../../lib/auth";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { PostgresProfiles, type Profile } from "../../lib/profiles";
import { profilesSchema } from "../../lib/profiles-schema";
import { PostgresLeaderboards } from "../../lib/leaderboards";
import { leaderboardsSchema } from "../../lib/leaderboards-schema";
import type { AppEntry } from "../../lib/apps";

export async function profileUIFixture(connection: string, baseURL: string, secret: string) {
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
  await pool.query("CREATE SCHEMA IF NOT EXISTS breadcrumb_auth");
  const authPool = new Pool({
    connectionString: connection,
    options: "-c search_path=breadcrumb_auth",
    max: 2,
  });
  const options = authOptions({ database: authPool, baseURL, secret, send: async () => {} });
  const auth = betterAuth({ ...options, plugins: [...options.plugins, testUtils()] });
  await (await getMigrations(auth.options)).runMigrations();
  const { test } = await auth.$context;
  async function ensureOwner(owner: string) {
    if (owners.has(owner)) return;
    if (!owner.startsWith("profile_ui_")) throw Error("Invalid UI fixture owner");
    await test.saveUser(
      test.createUser({
        id: owner,
        email: `${owner}@example.invalid`,
        emailVerified: true,
        name: "Preview",
      }),
    );
    owners.add(owner);
  }
  await pool.query(profilesSchema);
  await pool.query(leaderboardsSchema);
  const leaderboards = new PostgresLeaderboards(pool);
  return {
    /** Shares two hours today, all in one app, the way a synced desktop would. */
    async share(owner: string, app: AppEntry) {
      await ensureOwner(owner);
      const participant = createHash("sha256").update(`${owner}@example.invalid`).digest("hex");
      await leaderboards.ensureParticipant(participant, owner);
      await leaderboards.savePreferences(owner, participant, { shareApps: true });
      const now = new Date();
      await leaderboards.write(participant, [
        {
          day: now.toISOString().slice(0, 10),
          seconds: 7200,
          captures: 120,
          lastSynced: now.toISOString(),
          apps: [{ name: app.name, id: app.id, seconds: 7200 }],
        },
      ]);
    },
    async cookies(owner: string) {
      await ensureOwner(owner);
      return test.getCookies({ userId: owner });
    },
    async save(owner: string, profile: Profile) {
      await ensureOwner(owner);
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
      await authPool.end();
      await pool.end();
    },
  };
}
