// Public deployment checks. No sign-in emails or real captures are sent.
import assert from "node:assert/strict";
const base = process.env.SMOKE_URL ?? process.env.PUBLIC_URL;
if (!base) throw Error("Set SMOKE_URL to your Breadcrumb server URL");
const health = await fetch(base + "/healthz");
assert.equal(health.status, 200);
assert.equal((await health.json()).authConfigured, true);
const discovery = await fetch(base + "/.well-known/oauth-authorization-server/api/auth");
assert.equal(discovery.status, 200);
const metadata = await discovery.json();
assert.equal(metadata.issuer, base.replace(/\/$/, "") + "/api/auth");
assert.ok(metadata.code_challenge_methods_supported.includes("S256"));
assert.equal((await fetch(base + "/v1/account/summary")).status, 401);
assert.equal(
  (
    await fetch(base + "/v1/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
  ).status,
  401,
);
console.log("Live Better Auth discovery, health, and unauthenticated API checks passed.");
