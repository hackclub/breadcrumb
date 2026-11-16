import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { R2Store } from "../lib/store";
import { sha } from "../lib/service";
const base = process.env.SMOKE_URL ?? "https://breadcrumb.hackclub.dev";
const email = "breadcrumb-e2e@example.invalid",
  participant = sha(email),
  store = new R2Store();
const contextPath = "/tmp/breadcrumb-live-smoke.json";
type Context = { keys: string[]; ids: string[]; browserLink: string };
const context: Context = process.argv.includes("--cleanup")
  ? JSON.parse(await readFile(contextPath, "utf8"))
  : { keys: [], ids: [], browserLink: "" };
async function cleanup() {
  for (const key of context.keys) await store.remove(key);
  for (const id of context.ids) {
    const captureKey = `captures/${participant}/${id}.json`,
      job = sha(captureKey);
    await store.remove(captureKey);
    await store.remove(`review/items/${job}.json`);
    await store.remove(`review/results/${job}.json`);
    const claims = await store.list(`review/claims/${job}/`);
    for (const key of claims.keys) await store.remove(key);
  }
  let page = await store.list("auth/credentials/");
  for (;;) {
    for (const key of page.keys) {
      const raw = await store.get(key);
      if (raw && JSON.parse(Buffer.from(raw).toString()).email === email) await store.remove(key);
    }
    if (!page.cursor) break;
    page = await store.list("auth/credentials/", page.cursor);
  }
  console.log("Synthetic production objects removed.");
}
process.on("exit", () => writeFileSync(contextPath, JSON.stringify(context), { mode: 0o600 }));
if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}
async function seed(kind: string) {
  const token = randomBytes(32).toString("hex");
  const key = `auth/credentials/${sha(token)}.json`;
  await store.create(
    key,
    Buffer.from(
      JSON.stringify({
        id: participant,
        email,
        kind,
        expires: new Date(Date.now() + 15 * 60000).toISOString(),
      }),
    ),
  );
  context.keys.push(key);
  return token;
}
async function request(path: string, body?: unknown, token?: string, cookie?: string) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response;
}
const health = await request("/healthz");
assert.equal(health.status, 200);
assert.equal((await request("/api/cron/review")).status, 401);
const login = await seed("login");
const verified = await request("/auth/verify", { token: login });
assert.equal(verified.status, 204, await verified.text());
context.keys.push(`auth/used/${sha(login)}.json`);
const cookie = verified.headers.get("set-cookie")!.split(";")[0];
assert.equal((await request("/auth/verify", { token: login })).status, 401);
assert.equal((await request("/auth/me", undefined, undefined, cookie)).status, 200);
const minted = await request("/auth/token", {}, undefined, cookie);
assert.equal(minted.status, 200);
const { token } = await minted.json();
context.keys.push(`auth/credentials/${sha(token)}.json`);
const id = randomUUID();
context.ids.push(id);
const record = {
  id,
  date: Date.now() / 1000 - 978307200,
  app: "Synthetic browser",
  bundleID: "example.synthetic",
  windowTitle: "Synthetic AI conversation",
  context: { domain: "chatgpt.com" },
  visibleWindows: [
    {
      windowID: 2,
      app: "Synthetic browser",
      bundleID: "example.synthetic",
      title: "Synthetic video - YouTube",
      focused: false,
      visibleFraction: 0.35,
    },
  ],
};
const bundle = {
  schemaVersion: 1,
  consent: true,
  record,
  payload: {
    jpeg: (await readFile("/tmp/breadcrumb-synthetic-small.jpg")).toString("base64"),
    tree: [{ role: "AXWindow", label: "Synthetic AI conversation", depth: 0 }],
    screenText:
      "Synthetic fixture. AI conversation focused, YouTube page visible alongside. Playback unverified.",
  },
};
assert.equal((await request("/v1/ingest", bundle)).status, 401);
const accepted = await request("/v1/ingest", bundle, token);
assert.equal(accepted.status, 201, await accepted.text());
assert.equal((await request("/v1/ingest", bundle, token)).status, 200);
assert.equal(
  (await request("/v1/ingest", { ...bundle, record: { ...record, windowTitle: "changed" } }, token))
    .status,
  409,
);
// Large native-resolution images use requests smaller than the Vercel body limit.
const largeID = randomUUID();
context.ids.push(largeID);
const payload = Buffer.from(
  JSON.stringify({
    ...bundle.payload,
    jpeg: (await readFile("/tmp/breadcrumb-synthetic-large.jpg")).toString("base64"),
  }),
);
assert.ok(payload.length > 4 * 1024 * 1024 && payload.length < 12 * 1024 * 1024);
const started = await request(
  "/v1/uploads/start",
  {
    schemaVersion: 1,
    consent: true,
    record: { ...record, id: largeID },
    size: payload.length,
    sha256: sha(payload),
  },
  token,
);
assert.equal(started.status, 200);
const pending = await started.json();
const prefix = `incoming/${sha(pending.uploadId)}/`;
context.keys.push(prefix + "manifest.json");
for (let offset = 0, index = 0; offset < payload.length; offset += pending.chunkSize, index++) {
  const response = await fetch(base + "/v1/uploads/chunk?index=" + index, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "X-Upload-ID": pending.uploadId },
    body: payload.subarray(offset, offset + pending.chunkSize),
  });
  assert.equal(response.status, 204, await response.text());
  context.keys.push(prefix + index);
}
const completed = await request("/v1/uploads/complete", { uploadId: pending.uploadId }, token);
assert.equal(completed.status, 201, await completed.text());
assert.equal(
  (await request("/v1/uploads/complete", { uploadId: pending.uploadId }, token)).status,
  200,
);
// Do not spend model tokens on the large random-image transport fixture.
const largeKey = `captures/${participant}/${largeID}.json`;
await store.remove(`review/items/${sha(largeKey)}.json`);
console.log(
  "Production auth, scoped tokens, ingest, conflict handling, and chunked upload passed.",
);
const reviewed = await fetch(base + "/api/cron/review", {
  headers: { Authorization: "Bearer " + process.env.CRON_SECRET },
});
assert.equal(reviewed.status, 200, await reviewed.clone().text());
console.log("Production Gateway review:", await reviewed.text());
const resultRaw = await store.get(
  `review/results/${sha(`captures/${participant}/${id}.json`)}.json`,
);
assert.ok(resultRaw);
const result = JSON.parse(Buffer.from(resultRaw!).toString());
assert.equal(result.model, process.env.AI_GATEWAY_MODEL);
assert.ok(result.labels.some((l: { role: string }) => l.role === "focused"));
console.log("Real model result stored in R2, with provenance.");
const browserLogin = await seed("login");
context.keys.push(`auth/used/${sha(browserLogin)}.json`);
context.browserLink = base + "/#login=" + browserLogin;
await writeFile(contextPath, JSON.stringify(context), { mode: 0o600 });
console.log("Browser fixture ready (URL saved privately for browser verification).");
