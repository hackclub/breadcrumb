// Synthetic only: full browser approval -> local Go engine -> corpus integration.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const attached = process.argv.includes("--attach");
const scratch = await mkdtemp(join(tmpdir(), "breadcrumb-e2e-"));
const artifacts = join(root, "test-results", "sync");
await mkdir(artifacts, { recursive: true });
const contextPath = attached ? "/tmp/breadcrumb-sync-browser.json" : join(scratch, "context.json");
let web: ReturnType<typeof Bun.spawn> | undefined,
  harness: ReturnType<typeof Bun.spawn> | undefined;
let context: { base: string; control: string; directory: string } | undefined;
const browser = await chromium.launch({ headless: true });
try {
  if (!attached) {
    const engine = join(scratch, process.platform === "win32" ? "engine.exe" : "engine");
    const build = Bun.spawn(["go", "build", "-o", engine, "./cmd/breadcrumb-engine"], {
      cwd: join(root, "engine"),
      stdout: "inherit",
      stderr: "inherit",
    });
    assert.equal(await build.exited, 0);
    web = Bun.spawn(["bun", "run", "start", "--port", "3000"], {
      cwd: join(root, "web"),
      stdout: "ignore",
      stderr: "inherit",
    });
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        ready = (await fetch("http://127.0.0.1:3000")).ok;
      } catch {}
      if (ready) break;
      await Bun.sleep(200);
    }
    assert.ok(ready, "Next.js did not start");
    harness = Bun.spawn(["bun", "web/scripts/desktop-sync-smoke.ts"], {
      cwd: root,
      env: { ...process.env, SMOKE_ENGINE: engine, SMOKE_CONTEXT_PATH: contextPath },
      stdout: "pipe",
      stderr: "inherit",
    });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await Bun.file(contextPath).exists()) break;
      await Bun.sleep(200);
    }
  }
  context = JSON.parse(await readFile(contextPath, "utf8"));
  const ctx = context!;
  async function control(path: string) {
    const response = await fetch(ctx.base + "/__test/" + path, {
      headers: { "x-test-key": ctx.control },
    });
    if (!response.ok) throw Error(await response.text());
    return response.json();
  }
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto(ctx.base);
  await page.getByLabel("Email address").fill("friend@example.com");
  await page.getByRole("button", { name: "Send sign-in link", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Check your inbox" }).waitFor();
  const { link } = await control("link");
  assert.ok(link);
  await page.goto(link);
  await page.getByRole("heading", { name: "Your synced history", exact: true }).waitFor();
  await page.getByText("0 captures", { exact: false }).waitFor();
  await page.screenshot({ path: join(artifacts, "empty.png"), fullPage: true });
  const flow = await control("start");
  assert.ok(flow.url);
  await page.goto(flow.url);
  await page.getByRole("button", { name: "Allow & start syncing", exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "approval.png"), fullPage: true });
  await page.getByRole("button", { name: "Allow & start syncing", exact: true }).click();
  await page.getByText("You’re signed in.", { exact: false }).waitFor();
  let state;
  for (let attempt = 0; attempt < 30; attempt++) {
    state = await control("state");
    if (state.sync.uploaded === 3) break;
    await Bun.sleep(1000);
  }
  assert.equal(state.sync.uploaded, 3, JSON.stringify(state.sync));
  assert.equal(state.sync.pending, 0);
  assert.equal(state.sync.email, "friend@example.com");
  const metrics = await control("metrics");
  assert.equal(metrics.captures, 3);
  assert.ok(metrics.chunks >= 3, "large capture did not use chunk uploads");
  await page.goto(ctx.base);
  await page.locator(".sync-count").filter({ hasText: "3 captures" }).waitFor();
  await page.screenshot({ path: join(artifacts, "synced.png"), fullPage: true });
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
  }
  await page.screenshot({ path: join(artifacts, "mobile.png"), fullPage: true });
  await control("expire");
  for (let attempt = 0; attempt < 15; attempt++) {
    state = await control("state");
    if ((await control("metrics")).refreshes >= 1 && state.sync.enabled) break;
    await Bun.sleep(1000);
  }
  assert.ok((await control("metrics")).refreshes >= 1, "OAuth refresh was not used after restart");
  assert.equal(state.sync.uploaded, 3);
  assert.equal((await control("metrics")).captures, 3);
  await control("toggle");
  for (let attempt = 0; attempt < 20; attempt++) {
    state = await control("state");
    if (state.sync.uploaded >= 4) break;
    await Bun.sleep(1000);
  }
  assert.ok(state.sync.uploaded >= 4, "new native-adapter capture did not sync");
  await control("disconnect");
  const count = (await control("metrics")).captures;
  await Bun.sleep(2000);
  assert.equal((await control("metrics")).captures, count);
  state = await control("state");
  assert.equal(state.connected, false);
  assert.equal(state.recording, true);
  await control("toggle");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("heading", { name: "Sign in to Breadcrumb", exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "sign-in.png"), fullPage: true });
  console.log(
    "Passed: Better Auth email sign-in, browser consent, native PKCE, chunked backlog sync, restart and OAuth refresh, new capture sync, sign-out, and 320px mobile layout.",
  );
} finally {
  await browser.close();
  harness?.kill();
  if (harness) await harness.exited;
  web?.kill();
  if (web) await web.exited;
  if (!attached && context?.directory)
    await rm(context.directory, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
}
