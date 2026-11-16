import { test } from "bun:test";
import assert from "node:assert/strict";
import { Service, sha } from "../lib/service";
import { MemoryStore } from "../lib/store";
const root = "https://breadcrumb.example";
const upload = {
  schemaVersion: 1,
  consent: true,
  record: {
    id: "12345678-1234-1234-1234-123456789abc",
    date: 123,
    app: "Editor",
    bundleID: "example.editor",
    windowTitle: "Synthetic",
  },
  payload: {
    jpeg: "AQID",
    tree: [{ role: "AXWindow", label: "Synthetic", depth: 0 }],
    screenText: "Synthetic editor",
  },
};
async function fixture() {
  const store = new MemoryStore();
  let link = "";
  const env = {
    NODE_ENV: "test" as const,
    PUBLIC_URL: root,
    ALLOWED_EMAILS: "friend@example.com",
    REVIEW_AGENT_TOKENS: JSON.stringify({ test: "a".repeat(64) }),
  };
  const service = new Service(store, env, async (_email, url) => {
    link = url;
  });
  const token = await service.issue({
    id: sha("friend@example.com"),
    email: "friend@example.com",
    kind: "upload",
    expires: new Date(Date.now() + 3600000).toISOString(),
  });
  return { store, service, token, link: () => link };
}
function req(path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  return new Request(root + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: root,
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
test("magic links are one-time, sessions mint/revoke upload tokens", async () => {
  const { service, link } = await fixture();
  assert.equal(
    (await service.dispatch(req("/auth/login", { email: "stranger@example.com" }))).status,
    202,
  );
  assert.equal(link(), "");
  assert.equal(
    (await service.dispatch(req("/auth/login", { email: "friend@example.com" }))).status,
    202,
  );
  const token = link().split("#login=")[1];
  assert.ok(token);
  const response = await service.dispatch(req("/auth/verify", { token }));
  assert.equal(response.status, 204);
  assert.equal((await service.dispatch(req("/auth/verify", { token }))).status, 401);
  const Cookie = response.headers.get("set-cookie")!.split(";")[0];
  assert.equal(
    (await service.dispatch(req("/auth/me", undefined, undefined, { Cookie }))).status,
    200,
  );
  const minted = await service.dispatch(req("/auth/token", {}, undefined, { Cookie }));
  const credential = await minted.json();
  assert.equal((await service.dispatch(req("/auth/revoke", {}, credential.token))).status, 204);
  assert.equal((await service.dispatch(req("/v1/ingest", upload, credential.token))).status, 401);
  assert.equal(
    (await service.dispatch(req("/auth/logout", {}, undefined, { Cookie }))).status,
    204,
  );
  assert.equal(
    (await service.dispatch(req("/auth/me", undefined, undefined, { Cookie }))).status,
    401,
  );
});
test("ingest preserves context, scopes contributor, and handles retries/conflicts", async () => {
  const { service, store, token } = await fixture();
  assert.equal((await service.dispatch(req("/v1/ingest", upload))).status, 401);
  assert.equal((await service.dispatch(req("/v1/ingest", upload, token))).status, 201);
  assert.equal((await service.dispatch(req("/v1/ingest", upload, token))).status, 200);
  assert.equal(
    (
      await service.dispatch(
        req(
          "/v1/ingest",
          { ...upload, record: { ...upload.record, windowTitle: "changed" } },
          token,
        ),
      )
    ).status,
    409,
  );
  const entries = await store.list("captures/");
  assert.equal(entries.keys.length, 1);
  assert.deepEqual(
    JSON.parse(Buffer.from((await store.get(entries.keys[0]))!).toString()).upload.payload,
    upload.payload,
  );
});
test("cross-origin auth and invalid capture payloads are rejected", async () => {
  const { service, token } = await fixture();
  assert.equal(
    (
      await service.dispatch(
        req("/auth/login", { email: "friend@example.com" }, undefined, {
          Origin: "https://elsewhere.example",
        }),
      )
    ).status,
    403,
  );
  for (const value of [
    { ...upload, consent: false },
    { ...upload, payload: { ...upload.payload, jpeg: "not-base64" } },
    { ...upload, record: { ...upload.record, id: "../../x" } },
  ])
    assert.equal((await service.dispatch(req("/v1/ingest", value, token))).status, 400);
});
test("chunked upload survives retries and cannot be completed by another user", async () => {
  const { service, token } = await fixture();
  const payload = Buffer.from(JSON.stringify(upload.payload));
  const start = await service.dispatch(
    req(
      "/v1/uploads/start",
      {
        schemaVersion: 1,
        consent: true,
        record: upload.record,
        size: payload.length,
        sha256: sha(payload),
      },
      token,
    ),
  );
  assert.equal(start.status, 200);
  const pending = await start.json();
  assert.equal(
    (await service.dispatch(req("/v1/uploads/complete", { uploadId: pending.uploadId }, token)))
      .status,
    409,
  );
  const part = () =>
    new Request(root + "/v1/uploads/chunk?index=0", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "X-Upload-ID": pending.uploadId },
      body: payload,
    });
  assert.equal((await service.dispatch(part())).status, 204);
  assert.equal((await service.dispatch(part())).status, 204);
  assert.equal(
    (await service.dispatch(req("/v1/uploads/complete", { uploadId: pending.uploadId }, token)))
      .status,
    201,
  );
  assert.equal(
    (await service.dispatch(req("/v1/uploads/complete", { uploadId: pending.uploadId }, token)))
      .status,
    200,
  );
});
test("agent claims are exclusive and evidence-backed results are immutable", async () => {
  const { service, token } = await fixture();
  await service.dispatch(req("/v1/ingest", upload, token));
  assert.equal((await service.dispatch(req("/v1/review/claim", {}, token))).status, 401);
  const claims = await Promise.all([
    service.dispatch(req("/v1/review/claim", {}, "a".repeat(64))),
    service.dispatch(req("/v1/review/claim", {}, "a".repeat(64))),
  ]);
  const jobs = await Promise.all(claims.map((r) => r.json()));
  assert.equal(jobs.filter((j) => j.job).length, 1);
  const j = jobs.find((j) => j.job);
  assert.ok(j.captureURL);
  assert.equal(j.capture.upload.payload, undefined);
  const result = {
    job: j.job,
    lease: j.lease,
    generation: j.generation,
    model: "synthetic",
    version: "test",
    summary: "Editor and side video",
    session: "Project",
    labels: [
      { activity: "Coding", role: "focused", evidence: "Editor", confidence: "high" },
      {
        activity: "YouTube page",
        role: "alongside",
        evidence: "Side window visible; playback unknown",
        confidence: "medium",
      },
    ],
    flags: ["playback-unverified"],
  };
  assert.equal(
    (await service.dispatch(req("/v1/review/submit", result, "a".repeat(64)))).status,
    201,
  );
  assert.equal(
    (await service.dispatch(req("/v1/review/submit", result, "a".repeat(64)))).status,
    409,
  );
  assert.equal(
    (await (await service.dispatch(req("/v1/review/claim", {}, "a".repeat(64)))).json()).job,
    null,
  );
});

test("native-size capture validation handles multi-megabyte base64 without regex stack overflow", async () => {
  const { service, token } = await fixture();
  const large = {
    ...upload,
    record: { ...upload.record, id: "22345678-1234-1234-1234-123456789abc" },
    payload: { ...upload.payload, jpeg: Buffer.alloc(4 * 1024 * 1024, 17).toString("base64") },
  };
  const payload = Buffer.from(JSON.stringify(large.payload));
  const pending = await (
    await service.dispatch(
      req(
        "/v1/uploads/start",
        {
          schemaVersion: 1,
          consent: true,
          record: large.record,
          size: payload.length,
          sha256: sha(payload),
        },
        token,
      ),
    )
  ).json();
  for (let offset = 0, index = 0; offset < payload.length; offset += pending.chunkSize, index++) {
    const r = await service.dispatch(
      new Request(root + "/v1/uploads/chunk?index=" + index, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "X-Upload-ID": pending.uploadId },
        body: payload.subarray(offset, offset + pending.chunkSize),
      }),
    );
    assert.equal(r.status, 204);
  }
  const response = await service.dispatch(
    req("/v1/uploads/complete", { uploadId: pending.uploadId }, token),
  );
  assert.equal(response.status, 201, await response.text());
});
