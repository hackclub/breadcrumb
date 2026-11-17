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
  const token = "test-upload-token";
  const session = "test-session";
  const identity = { id: sha("friend@example.com"), email: "friend@example.com" };
  const env = {
    NODE_ENV: "test" as const,
    PUBLIC_URL: root,
    ALLOWED_EMAILS: identity.email,
    REVIEW_AGENT_TOKENS: JSON.stringify({ test: "a".repeat(64) }),
  };
  // Corpus tests inject an auth boundary; real Better Auth flows live in auth.test.ts.
  const service = new Service(store, env, {
    session: async (req) =>
      req.headers.get("cookie") === session
        ? identity
        : req.headers.get("cookie") === "another-session"
          ? { ...identity, id: sha("different-id") }
          : null,
    upload: async (req) =>
      req.headers.get("authorization") === "Bearer " + token ? identity : null,
  });
  return { store, service, token, session };
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
test("cross-origin account writes and invalid capture payloads are rejected", async () => {
  const { service, token, session } = await fixture();
  assert.equal(
    (
      await service.dispatch(
        req("/v1/account/index", {}, undefined, {
          Cookie: session,
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

test("synced history counts concurrent uploads once and excludes overlapping time and gaps", async () => {
  const { service, token, session } = await fixture();
  const date = Date.now() / 1000 - 978307200 - 7200;
  const captures = Array.from({ length: 8 }, (_, index) => ({
    ...upload,
    record: {
      ...upload.record,
      id: `12345678-1234-1234-1234-${String(index).padStart(12, "0")}`,
      date: date + (index < 6 ? index : 3600 + index),
      sampleIntervalSeconds: 60,
    },
  }));
  const results = await Promise.all(
    captures.map((capture) => service.dispatch(req("/v1/ingest", capture, token))),
  );
  assert.ok(results.every((result) => result.status === 201));
  await service.dispatch(req("/v1/ingest", captures[0], token));
  const headers = { Cookie: session };
  const summary = await (
    await service.dispatch(req("/v1/account/summary", undefined, undefined, headers))
  ).json();
  assert.equal(
    summary.days.reduce((sum: number, day: { captures: number }) => sum + day.captures, 0),
    8,
  );
  const seconds = summary.days.reduce(
    (sum: number, day: { seconds: number }) => sum + day.seconds,
    0,
  );
  assert.ok(seconds < 150 && seconds > 50);
  assert.equal((await service.dispatch(req("/v1/account/summary"))).status, 401);
  const another = "another-session";
  assert.equal(
    (
      await (
        await service.dispatch(
          req("/v1/account/summary", undefined, undefined, {
            Cookie: another,
          }),
        )
      ).json()
    ).days.length,
    0,
  );
});
