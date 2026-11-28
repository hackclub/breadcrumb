// Real PostgreSQL checks for opt-in publication, rankings and revocation.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresLeaderboards, LeaderboardError } from "../lib/leaderboards";
import { leaderboardsSchema } from "../lib/leaderboards-schema";
import { profilesSchema } from "../lib/profiles-schema";
import { MemoryStore } from "../lib/store";
import { recordSynced, syncedSummary } from "../lib/sync";
import { REFERENCE } from "../lib/insights";
const connection = process.env.LEADERBOARD_TEST_DATABASE_URL;
if (!connection) throw Error("LEADERBOARD_TEST_DATABASE_URL is required");
const url = new URL(connection);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  url.pathname !== "/breadcrumb_leaderboards_test"
)
  throw Error("Use a disposable local database named breadcrumb_leaderboards_test");
const pool = new Pool({ connectionString: connection, max: 8, connectionTimeoutMillis: 5000 });
const prefix = randomUUID().replaceAll("-", "").slice(0, 12);
const ids = Array.from({ length: 5 }, (_, i) => `leaderboard_${prefix}_${i}`);
const emails = ids.map((id) => `${id}@example.invalid`);
const participants = emails.map((email) => createHash("sha256").update(email).digest("hex"));
const now = new Date("2026-11-20T18:00:00Z");
const repo = new PostgresLeaderboards(pool, () => now);
const day = (date: string, seconds: number, captures = 10, stamp = "2026-11-20T17:00:00Z") => ({
  day: date,
  seconds,
  captures,
  lastSynced: stamp,
  apps: [
    { name: "Helium", seconds: seconds / 2 },
    { name: "Helium", id: "net.imput.helium", seconds: seconds / 2 },
  ],
});
const rejects = (promise: Promise<unknown>, status: number) =>
  assert.rejects(
    promise,
    (error: unknown) => error instanceof LeaderboardError && error.status === status,
  );
try {
  await pool.query(
    'CREATE SCHEMA IF NOT EXISTS breadcrumb_auth; CREATE TABLE IF NOT EXISTS breadcrumb_auth."user" (id text PRIMARY KEY,email text NOT NULL UNIQUE)',
  );
  await pool.query('ALTER TABLE breadcrumb_auth."user" ADD COLUMN IF NOT EXISTS email text');
  await pool.query(profilesSchema);
  await pool.query(leaderboardsSchema);
  for (const [i, id] of ids.entries())
    await pool.query('INSERT INTO breadcrumb_auth."user" (id,email) VALUES ($1,$2)', [
      id,
      emails[i],
    ]);
  for (const [i, id] of ids.slice(0, 4).entries())
    await pool.query(
      `INSERT INTO breadcrumb_profiles.profiles (owner_id,username,display_name,share_apps) VALUES ($1,$2,$3,true)`,
      [id, `${prefix}_${i}`, `Person ${i}`],
    );
  assert.deepEqual(await repo.preferences(ids[0]), {
    enabled: true,
    shareApps: false,
    profileReady: true,
  });
  await repo.write(participants[0], [day("2026-11-20", 100)]);
  assert.equal(
    (await repo.leaderboard({ range: "all" })).entries.length,
    1,
    "Public profiles are included by default",
  );
  await rejects(repo.savePreferences(ids[4], participants[4], { enabled: true }), 409);
  await rejects(repo.savePreferences(ids[0], participants[1], { enabled: false }), 400);
  await rejects(
    repo.savePreferences(ids[0], participants[0], { enabled: true, unknown: true }),
    400,
  );
  for (let i = 0; i < 4; i++)
    await repo.savePreferences(ids[i], participants[i], { enabled: true });
  await repo.write(participants[0], [
    day("2026-11-20", 200),
    day("2026-11-14", 100),
    day("2026-11-13", 700),
    day("2026-10-01", 1000),
  ]);
  await repo.write(participants[1], [day("2026-11-20", 300)]);
  await repo.write(participants[2], [day("2026-11-20", 100)]);
  await repo.write(participants[3], [day("2026-11-20", 50)]);
  let list = await repo.leaderboard({ range: "7", limit: 1 });
  assert.equal(list.entries.length, 1);
  assert.equal(list.entries[0].username, `${prefix}_0`);
  assert.equal(list.entries[0].seconds, 300);
  assert.equal(
    list.entries[0].apps,
    undefined,
    "Curated public apps do not publish measured usage",
  );
  assert.ok(list.nextCursor);
  const second = await repo.leaderboard({ range: "7", limit: 1, cursor: list.nextCursor });
  assert.equal(second.entries[0].username, `${prefix}_1`);
  assert.equal(second.entries[0].rank, 2);
  await rejects(repo.leaderboard({ range: "30", cursor: list.nextCursor }), 400);
  await rejects(repo.leaderboard({ cursor: "not-json" }), 400);
  await rejects(repo.leaderboard({ limit: 51 }), 400);
  await rejects(repo.leaderboard({ range: "forever" }), 400);
  assert.equal((await repo.leaderboard({ range: "30" })).entries[0].seconds, 1000);
  assert.equal((await repo.leaderboard({ range: "all" })).entries[0].seconds, 2000);
  await repo.savePreferences(ids[0], participants[0], { shareApps: true });
  list = await repo.leaderboard({ range: "all" });
  assert.deepEqual(list.entries[0].apps, [{ name: "Helium", id: "helium", seconds: 2000 }]);
  assert.deepEqual(await repo.profileStats(`${prefix}_0`), {
    days: [
      { day: "2026-11-14", seconds: 100 },
      ...["15", "16", "17", "18", "19"].map((d) => ({ day: `2026-11-${d}`, seconds: 0 })),
      { day: "2026-11-20", seconds: 200 },
    ],
    weekSeconds: 300,
    totalSeconds: 2000,
    apps: [{ name: "Helium", id: "helium", seconds: 300 }],
  });
  assert.equal(await repo.profileStats(`${prefix}_9`), null, "Unknown usernames have no stats");
  const retryBefore = await pool.query(
    `SELECT d.xmin::text AS day_version,p.xmin::text AS totals_version
    FROM breadcrumb_leaderboards.days d JOIN breadcrumb_leaderboards.preferences p USING(participant)
    WHERE participant=$1 AND day='2026-11-20'`,
    [participants[0]],
  );
  await repo.write(participants[0], [day("2026-11-20", 200)]);
  assert.equal(
    (await repo.leaderboard({ range: "all" })).entries[0].seconds,
    2000,
    "Retries replace snapshots rather than adding time",
  );
  const retryAfter = await pool.query(
    `SELECT d.xmin::text AS day_version,p.xmin::text AS totals_version
    FROM breadcrumb_leaderboards.days d JOIN breadcrumb_leaderboards.preferences p USING(participant)
    WHERE participant=$1 AND day='2026-11-20'`,
    [participants[0]],
  );
  assert.deepEqual(
    retryAfter.rows,
    retryBefore.rows,
    "Identical retries do not rewrite daily or total rows",
  );
  await repo.write(participants[0], [day("2026-11-20", 500, 20, "2026-11-20T17:01:00Z")]);
  await repo.write(participants[0], [day("2026-11-20", 200, 10, "2026-11-20T17:00:00Z")]);
  await repo.write(participants[0], [day("2026-11-20", 250, 11, "2026-11-20T17:01:00Z")]);
  assert.equal(
    (await repo.leaderboard({ range: "all" })).entries[0].seconds,
    2300,
    "Older and incomplete same-timestamp snapshots do not overwrite newer results",
  );
  await pool.query(
    `UPDATE breadcrumb_profiles.profiles SET visibility='private' WHERE owner_id=$1`,
    [ids[0]],
  );
  assert.equal(
    (await repo.leaderboard({ range: "all" })).entries.some((x) => x.username === `${prefix}_0`),
    false,
  );
  await rejects(repo.savePreferences(ids[0], participants[0], { enabled: true }), 409);
  assert.equal(await repo.profileStats(`${prefix}_0`), null, "Private profiles show no stats");
  await pool.query(
    `UPDATE breadcrumb_profiles.profiles SET visibility='public' WHERE owner_id=$1`,
    [ids[0]],
  );
  await repo.savePreferences(ids[0], participants[0], { shareApps: false });
  assert.equal((await repo.leaderboard({ range: "all" })).entries[0].apps, undefined);
  assert.equal(
    (await repo.profileStats(`${prefix}_0`))?.apps,
    undefined,
    "Profiles show apps only when app usage is shared",
  );
  await Promise.all([
    repo.write(participants[0], [day("2026-11-20", 600, 25, "2026-11-20T17:02:00Z")]),
    repo.savePreferences(ids[0], participants[0], { enabled: false }),
  ]);
  await repo.write(participants[0], [day("2026-11-20", 700, 30, "2026-11-20T17:03:00Z")]);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM breadcrumb_leaderboards.days WHERE participant=$1",
        [participants[0]],
      )
    ).rows[0].count,
    0,
  );
  assert.equal(
    (await repo.leaderboard({ range: "all" })).entries.some((x) => x.username === `${prefix}_0`),
    false,
  );
  assert.equal(
    await repo.profileStats(`${prefix}_0`),
    null,
    "Leaving the leaderboard hides profile stats",
  );
  const store = new MemoryStore();
  const sample = {
    id: randomUUID(),
    date: Date.parse("2026-11-19T23:59:50Z") / 1000 - REFERENCE,
    app: "Editor",
    bundleID: "editor",
    windowTitle: "Synthetic",
    sampleIntervalSeconds: 60,
  };
  await recordSynced(store, participants[2], sample, now.toISOString());
  await recordSynced(
    store,
    participants[2],
    { ...sample, id: randomUUID(), date: sample.date + 20 },
    now.toISOString(),
  );
  const expected = await syncedSummary(store, participants[2], "", "UTC");
  await repo.refreshDays(participants[2], store, ["2026-11-19", "2026-11-20"]);
  let total = (await repo.leaderboard({ range: "all" })).entries.find(
    (x) => x.username === `${prefix}_2`,
  )!.seconds;
  assert.equal(
    total,
    expected.days.reduce((sum, x) => sum + x.seconds, 0),
    "Neighboring UTC days preserve midnight coverage",
  );
  await repo.refresh(participants[2], store);
  total = (await repo.leaderboard({ range: "all" })).entries.find(
    (x) => x.username === `${prefix}_2`,
  )!.seconds;
  assert.equal(
    total,
    expected.days.reduce((sum, x) => sum + x.seconds, 0),
  );
  const sparseStore = new MemoryStore();
  for (const stamp of ["2026-10-01T12:00:00Z", "2026-11-20T12:00:00Z"])
    await recordSynced(
      sparseStore,
      participants[3],
      {
        ...sample,
        id: randomUUID(),
        date: Date.parse(stamp) / 1000 - REFERENCE,
      },
      now.toISOString(),
    );
  const sparseExpected = (await syncedSummary(sparseStore, participants[3], "", "UTC")).days.find(
    (day) => day.day === "2026-11-20",
  )!;
  assert.equal(sparseExpected.seconds, 60);
  await repo.refreshDays(participants[3], sparseStore, ["2026-11-20"]);
  const sparseActual = (await repo.leaderboard({ range: "7" })).entries.find(
    (entry) => entry.username === `${prefix}_3`,
  )!;
  assert.equal(
    sparseActual.seconds,
    sparseExpected.seconds,
    "A day after a long gap retains its leading half-window using the global history start",
  );
  await pool.query('DELETE FROM breadcrumb_auth."user" WHERE id=$1', [ids[2]]);
  assert.equal(
    (await repo.leaderboard({ range: "all" })).entries.some((x) => x.username === `${prefix}_2`),
    false,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM breadcrumb_leaderboards.days WHERE participant=$1",
        [participants[2]],
      )
    ).rows[0].count,
    0,
  );
  console.log(
    "Leaderboard PostgreSQL checks passed: default participation, explicit app sharing, window boundaries, pagination, retries, UTC neighbors and immediate privacy withdrawal.",
  );
} finally {
  await pool.query('DELETE FROM breadcrumb_auth."user" WHERE id=ANY($1::text[])', [ids]);
  await pool.end();
}
