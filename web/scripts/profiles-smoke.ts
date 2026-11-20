// Real PostgreSQL reservation/privacy invariants. Uses a dedicated disposable local DB only.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { AvatarAPI, cleanupAvatarObjects } from "../lib/profile-avatars";
import { MemoryStore } from "../lib/store";
import { Pool } from "pg";
import {
  ProfileAPI,
  PostgresProfiles,
  ProfileError,
  profilePatch,
  publicProfile,
} from "../lib/profiles";
import { profilesSchema } from "../lib/profiles-schema";
import { appSeed } from "../lib/apps";
import { memoryAuth } from "./support/memory-auth";
const connection = process.env.PROFILE_TEST_DATABASE_URL;
if (!connection) throw Error("PROFILE_TEST_DATABASE_URL is required");
const url = new URL(connection);
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
  url.pathname !== "/breadcrumb_profiles_test"
)
  throw Error("Use a disposable local database named breadcrumb_profiles_test");
const pool = new Pool({ connectionString: connection, max: 8, connectionTimeoutMillis: 5000 });
const repo = new PostgresProfiles(pool),
  prefix = "profile_smoke_" + randomUUID().replaceAll("-", "");
const ids = Array.from({ length: 5 }, (_, i) => `${prefix}_${i}`);
const name = "test_" + randomUUID().slice(0, 8);
try {
  // Minimal Better Auth identity fixture; the real auth flow has its own E2E test.
  await pool.query(
    'CREATE SCHEMA IF NOT EXISTS breadcrumb_auth; CREATE TABLE IF NOT EXISTS breadcrumb_auth."user" (id text PRIMARY KEY)',
  );
  await pool.query(profilesSchema);
  for (const id of ids)
    await pool.query('INSERT INTO breadcrumb_auth."user" (id) VALUES ($1)', [id]);
  const outcomes = await Promise.allSettled(
    ids
      .slice(0, 2)
      .map((id) => repo.save(id, profilePatch({ username: name.toUpperCase() }, appSeed))),
  );
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = outcomes.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof ProfileError && rejected.reason.status === 409);
  const winner = outcomes[0].status === "fulfilled" ? ids[0] : ids[1];
  const loser = winner === ids[0] ? ids[1] : ids[0];
  assert.equal(await repo.get(loser), null);
  const before = await repo.get(winner);
  await assert.rejects(
    repo.save(loser, { username: name, bio: "hijacked" }),
    (error) => error instanceof ProfileError && error.status === 409,
  );
  assert.deepEqual(await repo.get(winner), before);

  const claims = await Promise.allSettled([
    repo.save(ids[2], { username: name + "a" }),
    repo.save(ids[2], { username: name + "b" }),
  ]);
  assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
  const immutable = claims.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(immutable.reason instanceof ProfileError && immutable.reason.status === 409);
  await Promise.all([
    repo.save(winner, { visibility: "private" }),
    ...Array.from({ length: 5 }, (_, i) => repo.save(winner, { bio: `Edit ${i}` })),
  ]);
  const privateProfile = await repo.get(winner);
  assert.equal(privateProfile!.visibility, "private");
  assert.equal(await repo.find(name), null);
  assert.equal(publicProfile(privateProfile, appSeed), null);
  await repo.save(winner, { visibility: "public", shareApps: true, apps: [appSeed[0].id] });
  assert.deepEqual(
    publicProfile(await repo.find(name), appSeed)!.apps!.map((app) => app.id),
    [appSeed[0].id],
  );
  await repo.save(winner, { shareApps: false });
  assert.equal("apps" in publicProfile(await repo.find(name), appSeed)!, false);
  // Exercise the same verified Better Auth session boundary as the route handlers.
  const origin = "https://profiles.example";
  let link = "";
  const auth = memoryAuth({
    baseURL: origin,
    env: { NODE_ENV: "test" },
    send: async (_email, url) => {
      link = url;
    },
  });
  const sent = await auth.handler(
    new Request(origin + "/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "profile-test@example.com", callbackURL: origin + "/profile" }),
    }),
  );
  assert.equal(sent.status, 200);
  const signed = await auth.handler(new Request(link));
  assert.equal(signed.status, 302);
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  assert.ok(session?.user.emailVerified);
  ids.push(session.user.id);
  await pool.query('INSERT INTO breadcrumb_auth."user" (id) VALUES ($1)', [session.user.id]);
  const api = new ProfileAPI(
    repo,
    (request) => auth.api.getSession({ headers: request.headers }),
    async () => appSeed,
    { PUBLIC_URL: origin, NODE_ENV: "test" },
  );
  const request = (body?: unknown, authenticated = true, requestOrigin = origin) =>
    new Request(origin + "/api/profile", {
      method: body ? "PATCH" : "GET",
      headers: {
        Origin: requestOrigin,
        "Content-Type": "application/json",
        ...(authenticated ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  assert.equal((await api.handle(request(undefined, false), "owner")).status, 401);
  assert.equal(
    (await api.handle(request({ username: name + "c" }, true, "https://attacker.example"), "owner"))
      .status,
    403,
  );
  assert.equal(
    (
      await api.handle(
        request({ username: name + "c", shareApps: true, apps: [appSeed[0].id] }),
        "owner",
      )
    ).status,
    200,
  );
  const sharedResponse = await api.handle(request(undefined, false), "public", name + "c");
  assert.equal(sharedResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(
    (await sharedResponse.json()).profile.apps.map((app: { id: string }) => app.id),
    [appSeed[0].id],
  );
  assert.equal((await api.handle(request({ visibility: "private" }), "owner")).status, 200);
  assert.equal((await api.handle(request(undefined, false), "public", name + "c")).status, 404);
  const avatarStore = new MemoryStore();
  const png = await sharp({ create: { width: 24, height: 36, channels: 3, background: "#345678" } })
    .png()
    .toBuffer();
  const avatars = new AvatarAPI(
    repo,
    () => avatarStore,
    (req) => auth.api.getSession({ headers: req.headers }),
    { PUBLIC_URL: origin, NODE_ENV: "test" },
    async () => new Response(png),
  );
  const uploadRequest = () => {
    const form = new FormData();
    form.set("avatar", new File([png], "synthetic.png", { type: "image/png" }));
    return new Request(origin + "/api/profile/avatar", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
      body: form,
    });
  };
  const uploaded = await avatars.handle(uploadRequest());
  assert.equal(uploaded.status, 200);
  assert.equal((await uploaded.json()).profile.avatarMode, "upload");
  assert.equal(avatarStore.data.size, 1);
  const descriptor = await repo.avatar(session.user.id);
  assert.ok(descriptor?.key);
  const firstKey = descriptor.key;
  await avatars.handle(uploadRequest());
  assert.equal(avatarStore.data.has(firstKey), false);
  assert.equal(avatarStore.data.size, 1);
  const links = { githubUrl: "https://github.com/example", websiteUrl: "https://example.com/" };
  const gravatar = await api.handle(
    request({ ...links, avatarMode: "gravatar", visibility: "public" }),
    "owner",
  );
  assert.equal(gravatar.status, 200);
  const gravatarProfile = (await gravatar.json()).profile;
  assert.equal(gravatarProfile.githubUrl, links.githubUrl);
  assert.equal(gravatarProfile.websiteUrl, links.websiteUrl);
  assert.equal(gravatarProfile.avatarMode, "gravatar");
  const expectedHash = createHash("sha256").update("profile-test@example.com").digest("hex");
  assert.equal((await repo.avatar(session.user.id))!.hash, expectedHash);
  assert.ok(!JSON.stringify(gravatarProfile).includes(expectedHash));
  await cleanupAvatarObjects(repo, avatarStore);
  assert.equal(avatarStore.data.size, 0);
  const avatarResponse = await avatars.handle(request(undefined, false), name + "c");
  assert.equal(avatarResponse.status, 200);
  assert.equal(
    (await sharp(Buffer.from(await avatarResponse.arrayBuffer())).metadata()).format,
    "webp",
  );
  await api.handle(request({ visibility: "private" }), "owner");
  assert.equal((await avatars.handle(request(undefined, false), name + "c")).status, 404);
  assert.equal((await avatars.handle(request())).status, 200);
  await avatars.handle(uploadRequest());
  assert.equal(avatarStore.data.size, 1);
  const photo = await repo.avatar(session.user.id);
  await pool.query('DELETE FROM breadcrumb_auth."user" WHERE id=$1', [session.user.id]);
  assert.ok((await repo.avatarGarbage()).includes(photo!.key!));
  await cleanupAvatarObjects(repo, avatarStore);
  assert.equal(avatarStore.data.size, 0);
  for (let i = 0; i < 60; i++) await repo.limit(ids[3]);
  await assert.rejects(
    repo.limit(ids[3]),
    (error) => error instanceof ProfileError && error.status === 429,
  );
  await pool.query('DELETE FROM breadcrumb_auth."user" WHERE id=$1', [winner]);
  assert.equal(await repo.get(winner), null);
  assert.equal(await repo.available(name), true);
  console.log(
    "Passed: concurrent username claims, immutable reservations, ownership isolation, privacy-preserving partial edits, app opt-in, durable throttling, account deletion cleanup, real Better Auth cookie authorization, private-profile revocation, canonical avatar uploads, Gravatar opt-in hashing, links, image gating and account-deletion object cleanup.",
  );
} finally {
  await pool.query('DELETE FROM breadcrumb_auth."user" WHERE id=ANY($1)', [ids]);
  await pool.end();
}
