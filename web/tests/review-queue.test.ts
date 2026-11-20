import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { Service, sha } from "../lib/service";
import { MemoryStore } from "../lib/store";

const encoded = (value: unknown) => Buffer.from(JSON.stringify(value));
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const env = {
  NODE_ENV: "test" as const,
  ENABLE_AI_REVIEWS: "true",
  AI_GATEWAY_API_KEY: "synthetic-key",
  AI_GATEWAY_MODEL: "synthetic-model",
};
class QueueStore extends MemoryStore {
  pages: string[] = [];
  async list(prefix: string, cursor = "", limit = 100) {
    if (prefix === "review/items/") this.pages.push(cursor);
    return super.list(prefix, cursor, limit);
  }
}
async function fixture(completed: number, store = new QueueStore()) {
  const service = new Service(store, env);
  // Pick a real capture key that sorts late, then seed completed jobs ahead of it.
  const victimKey = Array.from(
    { length: 128 },
    (_, i) => `captures/later-contributor/${uuid(i)}.json`,
  )
    .sort((a, b) => sha(a).localeCompare(sha(b)))
    .at(-1)!;
  const victim = sha(victimKey);
  async function enqueue(key: string, done: boolean) {
    const participant = key.split("/")[1];
    const entry = {
      participant,
      receivedAt: "2026-11-19T00:00:00.000Z",
      digest: "synthetic",
      upload: {
        schemaVersion: 1 as const,
        consent: true as const,
        record: {
          id: key.split("/").at(-1)!.slice(0, -5),
          date: 1,
          app: "Editor",
          bundleID: "editor",
          windowTitle: participant,
        },
        payload: { jpeg: "", tree: [{ role: "Window", label: "Synthetic", depth: 0 }] },
      },
    };
    await store.create(key, encoded(entry));
    await service.enqueue(entry, key);
    if (done)
      await store.create(`review/results/${sha(key)}.json`, encoded({ summary: "Completed" }));
  }
  for (let i = 0, count = 0; count < completed; i++) {
    const key = `captures/early-uploader/${uuid(i)}.json`;
    if (sha(key) < victim) {
      await enqueue(key, true);
      count++;
    }
  }
  await enqueue(victimKey, false);
  store.pages = [];
  return { service, store, victim };
}
function gateway() {
  const request = Object.assign(
    async (...[url, init]: Parameters<typeof fetch>) => {
      assert.equal(String(url), "https://ai-gateway.vercel.sh/v1/chat/completions");
      const request = JSON.parse(String(init?.body));
      const evidence = JSON.parse(request.messages[1].content[0].text);
      assert.equal(evidence.record.windowTitle, "later-contributor");
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                summary: "Synthetic editor",
                session: "Synthetic project",
                labels: [
                  { activity: "Coding", role: "focused", evidence: "Editor", confidence: "high" },
                ],
                flags: [],
              }),
            },
          },
        ],
      });
    },
    { preconnect: fetch.preconnect },
  );
  return spyOn(globalThis, "fetch").mockImplementation(request);
}

test("cron reviews another contributor beyond a completed first page", async () => {
  const { service, store, victim } = await fixture(30);
  const manual = await service.claim("manual");
  assert.equal(manual.job, null);
  assert.ok("nextCursor" in manual && manual.nextCursor);
  const fetch = gateway();
  try {
    assert.deepEqual(await service.runReview(), { status: "reviewed", job: victim });
    assert.ok(await store.get(`review/results/${victim}.json`));
    assert.equal(fetch.mock.calls.length, 1);
  } finally {
    fetch.mockRestore();
  }
});

test("bounded scans resume durably in a new serverless instance and wrap at queue end", async () => {
  const { service, store, victim } = await fixture(150);
  const fetch = gateway();
  try {
    const first = await service.runReview();
    assert.equal(first.status, "scanning");
    assert.equal(store.pages.length, 4);
    assert.equal(fetch.mock.calls.length, 0);
    assert.deepEqual(await new Service(store, env).runReview(), {
      status: "reviewed",
      job: victim,
    });
    assert.notEqual(store.pages[4], "");
    assert.equal(fetch.mock.calls.length, 1);
    const count = store.pages.length;
    await new Service(store, env).runReview();
    assert.equal(store.pages[count], "");
    assert.equal((await new Service(store, env).runReview()).status, "empty");
  } finally {
    fetch.mockRestore();
  }
});

test("an overlapping stale cron cannot rewind a newer scan checkpoint", async () => {
  let resume!: () => void, paused!: () => void;
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    paused = resolve;
  });
  class DelayedStore extends QueueStore {
    pause = true;
    async update(key: string, transform: (value: Uint8Array | null) => Uint8Array | null) {
      if (key.startsWith("review/cursors/") && this.pause) {
        this.pause = false;
        paused();
        await released;
      }
      return super.update(key, transform);
    }
  }
  const { service, store, victim } = await fixture(150, new DelayedStore());
  const fetch = gateway();
  const stale = service.runReview();
  try {
    await waiting;
    assert.equal((await new Service(store, env).runReview()).status, "scanning");
    assert.deepEqual(await new Service(store, env).runReview(), {
      status: "reviewed",
      job: victim,
    });
    const key = (await store.list("review/cursors/")).keys[0];
    const checkpoint = await store.get(key);
    resume();
    await stale;
    assert.deepEqual(await store.get(key), checkpoint);
    assert.equal(fetch.mock.calls.length, 1);
  } finally {
    resume();
    await stale;
    fetch.mockRestore();
  }
});
