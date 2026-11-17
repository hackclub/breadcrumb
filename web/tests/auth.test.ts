import { test } from "bun:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { memoryAuth } from "./support/memory-auth";
import { createAuthAccess } from "../lib/auth";
const root = "https://breadcrumb.example";
async function fixture() {
  let link = "";
  const auth = memoryAuth({
    baseURL: root,
    env: { NODE_ENV: "test", ALLOWED_EMAILS: "friend@example.com" },
    send: async (_email, url) => {
      link = url;
    },
  });
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    auth.handler(
      new Request(root + "/api/auth" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { Origin: root, "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const sent = await call("/sign-in/magic-link", {
    email: "friend@example.com",
    callbackURL: root + "/",
  });
  assert.equal(sent.status, 200, await sent.text());
  assert.ok(link);
  const verified = await auth.handler(new Request(link));
  assert.equal(verified.status, 302);
  const cookie = verified.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.ok(cookie);
  return { auth, call, cookie, link };
}
async function authorize(f: Awaited<ReturnType<typeof fixture>>, allow = true) {
  const verifier = randomBytes(32).toString("base64url"),
    state = randomBytes(32).toString("hex"),
    redirect = "http://127.0.0.1:49187/callback";
  const registered = await f.call("/oauth2/register", {
    client_name: "Breadcrumb Desktop",
    application_type: "native",
    token_endpoint_auth_method: "none",
    redirect_uris: [redirect],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "email offline_access captures:sync",
    resources: [root + "/v1"],
  });
  assert.equal(registered.status, 201, await registered.clone().text());
  const client = await registered.json();
  const query = new URLSearchParams({
    client_id: client.client_id,
    response_type: "code",
    redirect_uri: redirect,
    scope: "email offline_access captures:sync",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: root + "/v1",
    prompt: "consent",
  });
  const response = await f.call("/oauth2/authorize?" + query, undefined, {
    Cookie: f.cookie,
    Accept: "text/html",
  });
  assert.equal(response.status, 302, await response.clone().text());
  const consentURL = new URL(response.headers.get("location")!, root);
  const accepted = await f.call(
    "/oauth2/consent",
    { accept: allow, oauth_query: consentURL.search.slice(1) },
    { Cookie: f.cookie },
  );
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const result = await accepted.json();
  const callback = new URL(result.url);
  assert.equal(callback.origin, "http://127.0.0.1:49187");
  assert.equal(callback.searchParams.get("state"), state);
  assert.equal(callback.searchParams.get("iss"), root + "/api/auth");
  const exchange = (override: Record<string, string> = {}) =>
    f.auth.handler(
      new Request(root + "/api/auth/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          code: callback.searchParams.get("code") ?? "",
          code_verifier: verifier,
          redirect_uri: redirect,
          resource: root + "/v1",
          ...override,
        }),
      }),
    );
  return { callback, exchange, client };
}
test("Better Auth owns email verification, sessions, logout, and origin checks", async () => {
  const f = await fixture();
  const session = await f.auth.api.getSession({ headers: new Headers({ Cookie: f.cookie }) });
  assert.equal(session?.user.email, "friend@example.com");
  assert.equal(session?.user.emailVerified, true);
  const replay = await f.auth.handler(new Request(f.link));
  assert.notEqual(replay.headers.get("location"), root + "/");
  assert.equal(
    (await f.call("/sign-out", {}, { Cookie: f.cookie, Origin: "https://evil.example" })).status,
    403,
  );
  assert.equal((await f.call("/sign-out", {}, { Cookie: f.cookie })).status, 200);
  assert.equal(await f.auth.api.getSession({ headers: new Headers({ Cookie: f.cookie }) }), null);
});
test("Better Auth handles native consent, PKCE, replay protection, scoped tokens and refresh rotation", async () => {
  const f = await fixture(),
    flow = await authorize(f);
  const wrong = await flow.exchange({ code_verifier: "wrong" });
  assert.equal(wrong.status, 400);
  const tokenResponse = await flow.exchange();
  assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
  const token = await tokenResponse.json();
  assert.ok(token.access_token);
  assert.ok(token.refresh_token);
  assert.equal(token.email, "friend@example.com");
  const access = createAuthAccess(() => f.auth, {
    NODE_ENV: "test",
    ALLOWED_EMAILS: "friend@example.com",
  });
  const identity = await access.upload(
    new Request(root + "/v1/ingest", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    }),
  );
  assert.equal(identity?.email, "friend@example.com");
  assert.equal(
    await access.upload(
      new Request(root + "/v1/ingest", { headers: { Authorization: "Bearer invalid" } }),
    ),
    null,
  );
  const refresh = () =>
    f.auth.handler(
      new Request(root + "/api/auth/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: flow.client.client_id,
          refresh_token: token.refresh_token,
        }),
      }),
    );
  const renewed = await refresh();
  assert.equal(renewed.status, 200, await renewed.clone().text());
  const next = await renewed.json();
  assert.ok(next.refresh_token);
  assert.notEqual(next.refresh_token, token.refresh_token);
  assert.equal((await refresh()).status, 400);
  assert.equal((await flow.exchange()).status, 400);
});
test("Better Auth rejects denied and tampered desktop requests", async () => {
  const f = await fixture(),
    denied = await authorize(f, false);
  assert.equal(denied.callback.searchParams.get("error"), "access_denied");
  assert.equal((await denied.exchange()).status, 400);
  assert.equal(
    (
      await f.call(
        "/oauth2/consent",
        { accept: true, oauth_query: "client_id=evil&sig=forged" },
        { Cookie: f.cookie },
      )
    ).status,
    400,
  );
});
