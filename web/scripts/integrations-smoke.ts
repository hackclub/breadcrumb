import { betterAuth } from "better-auth";
// Synthetic data only. This script refuses non-loopback or non-test databases.
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";
import { testUtils } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import { authOptions, createAuthAccess, participantID, type BreadcrumbAuth } from "../lib/auth";
import { Service } from "../lib/service";
import { integrationsSchema } from "../lib/platform-db";
import { sharesSchema, Screenshots } from "../lib/screenshots";
import { MemoryStore } from "../lib/store";
import { integrationsAPI } from "../lib/integrations-api";
import { recordSynced } from "../lib/sync";
import { profilesSchema } from "../lib/profiles-schema";
import { leaderboardsSchema } from "../lib/leaderboards-schema";
const connection = process.env.INTEGRATIONS_TEST_DATABASE_URL;
if (!connection) throw Error("INTEGRATIONS_TEST_DATABASE_URL is required");
const url = new URL(connection);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  url.pathname !== "/breadcrumb_api_test"
)
  throw Error("Use a disposable local breadcrumb_api_test database");
process.env.DATABASE_URL = connection;
process.env.AUTH_DATABASE_URL = connection;
process.env.ALLOWED_EMAILS = "";
process.env.PUBLIC_URL = "https://breadcrumb.example";
process.env.BETTER_AUTH_SECRET = randomBytes(48).toString("hex");
const pool = new Pool({ connectionString: connection, max: 3 });
const authPool = new Pool({
  connectionString: connection,
  options: "-c search_path=breadcrumb_auth",
  max: 2,
});
const root = process.env.PUBLIC_URL;
const store = new MemoryStore();
const options = authOptions({
  database: authPool,
  baseURL: root,
  secret: process.env.BETTER_AUTH_SECRET,
  env: { NODE_ENV: "test" },
  send: async () => {},
});
// Registers several clients from one address, so the per-path auth limiter would trip.
const auth = betterAuth({
  ...options,
  rateLimit: { enabled: false },
  plugins: [...options.plugins, testUtils()],
});
const registeredClients: string[] = [];
const ids = [
  "api_smoke_" + randomBytes(8).toString("hex"),
  "api_smoke_" + randomBytes(8).toString("hex"),
];
try {
  await pool.query("CREATE SCHEMA IF NOT EXISTS breadcrumb_auth");
  await (await getMigrations({ ...auth.options, rateLimit: options.rateLimit })).runMigrations();
  await pool.query(profilesSchema + integrationsSchema + sharesSchema + leaderboardsSchema);
  const { test } = await auth.$context;
  const cookies: string[] = [];
  for (const id of ids) {
    await test.saveUser(
      test.createUser({
        id,
        email: id + "@example.invalid",
        emailVerified: true,
        name: "API fixture",
      }),
    );
    const values = await test.getCookies({ userId: id });
    cookies.push(values.map((c) => `${c.name}=${c.value}`).join("; "));
  }
  const participant = participantID(ids[0] + "@example.invalid"),
    captureId = randomUUID(),
    ref = createHash("sha256").update("synthetic-image").digest("hex"),
    date = Date.parse("2026-01-02T12:00:00Z") / 1000 - 978307200;
  const record = {
    id: captureId,
    date,
    app: "Editor",
    bundleID: "app.editor",
    windowTitle: "Never shared metadata",
    context: { project: "Synthetic" },
  };
  await store.create(
    `captures/${participant}/${captureId}.json`,
    Buffer.from(
      JSON.stringify({
        participant,
        upload: { record, payload: { jpegRef: ref, tree: [{ label: "Never share this" }] } },
      }),
    ),
  );
  await store.create(`images/${participant}/${ref}.jpg`, Buffer.from("synthetic-image"));
  await recordSynced(store, participant, record, "2026-01-02T12:05:00Z");
  const call = (path: string, method = "GET", body?: unknown, owner = 0, origin = root) =>
    integrationsAPI(
      new Request(root + "/api/v1/" + path, {
        method,
        headers: { Cookie: cookies[owner], Origin: origin, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      store,
    );
  const listed = await call("screenshots");
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).entries[0].id, captureId);
  assert.equal((await call(`screenshots/${captureId}/image`, "GET", undefined, 1)).status, 404);
  const own = await call(`screenshots/${captureId}/image`);
  assert.equal(await own.text(), "synthetic-image");
  assert.match(own.headers.get("Cache-Control")!, /no-store/);
  assert.equal(
    (await call("shares", "POST", { captureId }, 0, "https://other.example")).status,
    403,
  );
  const created = await call("shares", "POST", { captureId, expiresInHours: 1 });
  assert.equal(created.status, 200);
  const link = await created.json(),
    token = link.url.split("/s/")[1],
    images = new Screenshots(store, pool);
  assert.equal(await (await images.shared(token)).text(), "synthetic-image");
  assert.equal((await call("shares", "DELETE", { id: link.id }, 1)).status, 200);
  await images.resolve(token); // Another account cannot revoke this share.
  const stored = await pool.query(
    "SELECT secret_hash FROM breadcrumb_integrations.shares WHERE id=$1",
    [link.id],
  );
  assert.notEqual(stored.rows[0].secret_hash, token.split(".")[1]);
  await assert.rejects(images.resolve(token.slice(0, -1) + (token.endsWith("a") ? "b" : "a")));
  await call("shares", "DELETE", { id: link.id });
  await assert.rejects(images.shared(token));
  const expired = await (await call("shares", "POST", { captureId })).json();
  await pool.query(
    "UPDATE breadcrumb_integrations.shares SET expires_at=now()-interval '1 second' WHERE id=$1",
    [expired.id],
  );
  await assert.rejects(images.resolve(expired.url.split("/s/")[1]));
  const requestAuth = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    auth.handler(
      new Request(root + "/api/auth" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { Origin: root, "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  // Registers a native client and completes consent with PKCE, like the desktop app and MCP clients.
  async function connect(scope: string, resource: string, name = "Integration fixture") {
    const registered = await requestAuth("/oauth2/register", {
      client_name: name,
      application_type: "native",
      token_endpoint_auth_method: "none",
      redirect_uris: ["http://127.0.0.1:49201/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope,
      resources: [resource],
    });
    assert.equal(registered.status, 201);
    const client = await registered.json();
    registeredClients.push(client.client_id);
    const verifier = randomBytes(32).toString("base64url");
    const start = await requestAuth(
      "/oauth2/authorize?" +
        new URLSearchParams({
          client_id: client.client_id,
          response_type: "code",
          redirect_uri: client.redirect_uris[0],
          scope,
          resource,
          prompt: "consent",
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
        }),
      undefined,
      { Cookie: cookies[0], Accept: "text/html" },
    );
    const consent = new URL(start.headers.get("location")!, root);
    const approved = await requestAuth(
      "/oauth2/consent",
      { accept: true, oauth_query: consent.search.slice(1) },
      { Cookie: cookies[0] },
    );
    const callback = new URL((await approved.json()).url);
    const exchanged = await auth.handler(
      new Request(root + "/api/auth/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          redirect_uri: client.redirect_uris[0],
          resource,
          code: callback.searchParams.get("code")!,
          code_verifier: verifier,
        }),
      }),
    );
    assert.equal(exchanged.status, 200, `${scope} ${resource}: ${await exchanged.clone().text()}`);
    return { clientId: client.client_id as string, token: await exchanged.json() };
  }
  const oauthClient = await connect("time:read", root + "/api/v1");
  const accessToken = oauthClient.token.access_token;
  const read = (path: string) =>
    integrationsAPI(
      new Request(root + "/api/v1/" + path, {
        headers: { Authorization: "Bearer " + accessToken },
      }),
      store,
    );
  const scoped = await read("activity?from=2026-01-02&to=2026-01-02");
  assert.equal(scoped.status, 200);
  const activity = await scoped.json();
  assert.ok(activity.days[0].seconds > 0);
  assert.equal(activity.days[0].apps, undefined);
  assert.equal(activity.days[0].projects, undefined);
  assert.equal((await read("screenshots")).status, 403);
  const grants = await auth.api.getOAuthConsents({ headers: new Headers({ Cookie: cookies[0] }) });
  await call("connections", "DELETE", {
    id: grants.find((g) => g.clientId === oauthClient.clientId)!.id,
  });
  assert.equal((await read("activity")).status, 401);
  // Desktop devices: a new sign-in on the same device replaces its older sync connections.
  const service = new Service(
    store,
    process.env,
    createAuthAccess(() => auth as unknown as BreadcrumbAuth),
    undefined,
    undefined,
    pool,
  );
  const register = (token: string, body: unknown) =>
    service.dispatch(
      new Request(root + "/v1/device", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const sync = "email offline_access captures:sync agents:sync";
  const laptop = { deviceId: "device-" + randomUUID(), platform: "darwin-arm64", version: "0.2.9" };
  const oldDesktop = await connect(sync, root + "/v1", "Breadcrumb Desktop");
  const oldUsage = await connect("email offline_access agents:sync", root + "/v1", "Token Usage");
  const otherDevice = await connect(sync, root + "/v1", "Breadcrumb Desktop");
  const mcp = await connect("time:read", root + "/mcp", "MCP fixture");
  assert.equal((await register(accessToken, { ...laptop, name: "Laptop" })).status, 401);
  assert.equal((await register(oldDesktop.token.access_token, { name: "Laptop" })).status, 400);
  const first = await register(oldDesktop.token.access_token, {
    ...laptop,
    name: " Echo's\u0007  Laptop ",
  });
  assert.deepEqual(await first.json(), { replaced: 0 });
  assert.deepEqual(
    await (
      await register(otherDevice.token.access_token, {
        ...laptop,
        deviceId: "device-" + randomUUID(),
        name: "Desktop",
        platform: "windows-amd64",
      })
    ).json(),
    { replaced: 0 },
  );
  const current = await connect(sync, root + "/v1", "Breadcrumb Desktop");
  const replacing = await register(current.token.access_token, {
    ...laptop,
    name: "Laptop",
    replaces: [oldUsage.clientId, mcp.clientId],
  });
  assert.deepEqual(await replacing.json(), { replaced: 2 });
  const listedConnections = (await (await call("connections")).json()).entries as {
    clientId: string;
    device: { name: string; platform: string; version: string } | null;
    lastUsed: string | null;
  }[];
  const byClient = new Map(listedConnections.map((entry) => [entry.clientId, entry]));
  assert.equal(byClient.has(oldDesktop.clientId), false);
  assert.equal(byClient.has(oldUsage.clientId), false);
  assert.ok(byClient.has(mcp.clientId), "Device registration never removes app connections");
  assert.deepEqual(byClient.get(current.clientId)!.device, {
    name: "Laptop",
    platform: "darwin-arm64",
    version: "0.2.9",
  });
  assert.equal(byClient.get(otherDevice.clientId)!.device!.name, "Desktop");
  assert.ok(Date.now() - Date.parse(byClient.get(current.clientId)!.lastUsed!) < 60_000);
  assert.equal(byClient.get(mcp.clientId)!.device, null);
  assert.equal(
    (await register(oldDesktop.token.access_token, { ...laptop, name: "Laptop" })).status,
    401,
  );
  const renewed = await auth.handler(
    new Request(root + "/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: oldDesktop.clientId,
        refresh_token: oldDesktop.token.refresh_token,
        resource: root + "/v1",
      }),
    }),
  );
  assert.ok(renewed.status >= 400, "A replaced connection cannot renew access");
  const defaults = await (await call("leaderboard/preferences")).json();
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.shareApps, false);
  await pool.query("UPDATE breadcrumb_integrations.limits SET requests=120 WHERE id=$1", [
    ids[0] + ":browser",
  ]);
  const limited = await call("shares");
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get("Retry-After"));
  console.log(
    "Passed: database-backed sessions and scoped OAuth/PKCE, live withdrawal, screenshot ownership, hashed share secrets, expiry, one sync connection per device, cross-owner/revocation, CSRF, default leaderboard settings and durable quotas.",
  );
} finally {
  await pool.query('DELETE FROM breadcrumb_auth."user" WHERE id=ANY($1)', [ids]);
  await pool.query("DELETE FROM breadcrumb_integrations.limits WHERE id=ANY($1)", [
    ids.map((id) => id + ":browser"),
  ]);
  await pool.query('DELETE FROM breadcrumb_auth."oauthClient" WHERE "clientId"=ANY($1)', [
    registeredClients,
  ]);
  await authPool.end();
  await pool.end();
}
process.exit(0);
