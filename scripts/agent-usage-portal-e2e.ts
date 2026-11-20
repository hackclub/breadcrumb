import { chromium, expect } from "@playwright/test";
import { createServer, type AddressInfo } from "node:net";
const socket = createServer();
await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = (socket.address() as AddressInfo).port;
await new Promise<void>((resolve) => socket.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const server = Bun.spawn(["bun", "run", "--cwd", "web", "start", "--port", String(port)], {
  env: {
    ...process.env,
    DATABASE_URL: "postgres://synthetic@127.0.0.1:1/unavailable",
    AUTH_DATABASE_URL: "postgres://synthetic@127.0.0.1:1/unavailable",
    ANALYTICS_BACKEND: "r2",
  },
  stdout: "ignore",
  stderr: "ignore",
});
const browser = await chromium.launch();
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(origin + "/icon.svg")).ok) break;
    } catch {}
    await Bun.sleep(100);
  }
  for (const width of [1280, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      timezoneId: "America/New_York",
    });
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: "synthetic-layout",
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
      },
    ]);
    const page = await context.newPage();
    await page.addInitScript(() => {
      (window as any).__shifts = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as any)
          if (!e.hadRecentInput)
            (window as any).__shifts.push({
              value: e.value,
              sources: e.sources?.map((s: any) => ({
                node: s.node?.outerHTML?.slice(0, 180),
                from: s.previousRect,
                to: s.currentRect,
              })),
            });
      }).observe({ type: "layout-shift", buffered: true });
    });
    await page.route("**/api/v1/agents/usage?*", async (route) => {
      await Bun.sleep(900);
      const url = new URL(route.request().url()),
        range = Number(url.searchParams.get("range")),
        hours = Array.from({ length: range }, (_, d) =>
          ["claude", "codex"].map((provider, i) => ({
            provider,
            model: i ? "gpt-5.4" : "claude-sonnet-4-6",
            project: "Example",
            hour: new Date(Date.now() - d * 86400000).toISOString(),
            input: 10000,
            cacheRead: 20000,
            cacheWrite: 1000,
            cacheWrite1h: 0,
            output: 1000,
            reasoning: 0,
            events: 1,
            sessions: 1,
          })),
        ).flat();
      await route.fulfill({ json: { hours, timeZone: url.searchParams.get("timeZone") } });
    });
    await page.goto(origin + "/agents", { waitUntil: "domcontentloaded" });
    await expect(page.locator('.agent-usage[aria-busy="true"]')).toBeVisible();
    await expect(page.locator('.agent-usage[aria-busy="false"]')).toBeVisible();
    await expect(page.locator(".agent-row")).toHaveCount(2);
    await page.getByLabel("Range", { exact: true }).selectOption("90");
    await expect(page.locator('.agent-usage[aria-busy="false"]')).toBeVisible();
    await page.getByLabel("Group by").selectOption("day");
    await expect(page.locator(".agent-table tbody tr")).toHaveCount(90);
    await page.waitForTimeout(600);
    const shifts = await page.evaluate(() => (window as any).__shifts),
      cls = shifts.reduce((n: number, e: any) => n + e.value, 0);
    if (cls) console.log(JSON.stringify(shifts));
    expect(cls).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    console.log(
      `Portal coding agents ${width}px: CLS=0; delayed usage, range changes and private session starts checked.`,
    );
    await context.close();
  }
} finally {
  await browser.close();
  server.kill();
}
