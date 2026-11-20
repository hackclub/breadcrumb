import { chromium, expect } from "@playwright/test";
const server = Bun.spawn(["bun", "run", "--cwd", "desktop", "dev"], {
  stdout: "ignore",
  stderr: "inherit",
});
const browser = await chromium.launch();
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch("http://127.0.0.1:1420")).ok) break;
    } catch {}
    await Bun.sleep(100);
  }
  for (const width of [1280, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      timezoneId: "America/New_York",
    });
    await context.addInitScript(() => {
      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (command: string, args: any) => {
          if (command !== "engine") return null;
          if (args.command === "state") return { observations: [], demo: false };
          if (args.command === "agentUsage") {
            await new Promise((resolve) => setTimeout(resolve, 900));
            const providers = [
              { id: "claude", name: "Claude Code", enabled: true, detected: true },
              { id: "codex", name: "Codex", enabled: true, detected: true },
            ];
            const hours = Array.from({ length: args.args.range }, (_, d) =>
              providers.map((p, i) => ({
                provider: p.id,
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
              })),
            ).flat();
            return {
              status: { providers, lastScan: new Date().toISOString(), pending: 0, bytes: 0 },
              hours,
              sessions: [],
              timeZone: args.args.timeZone,
            };
          }
          return null;
        },
      };
      (window as any).__agentShifts = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as any)
          if (!entry.hadRecentInput)
            (window as any).__agentShifts.push({
              value: entry.value,
              sources: entry.sources?.map((s: any) => ({
                node: s.node?.outerHTML?.slice(0, 220),
                from: s.previousRect,
                to: s.currentRect,
              })),
            });
      }).observe({ type: "layout-shift", buffered: true });
    });
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:1420/?view=dashboard");
    await page.getByRole("button", { name: "Coding agents", exact: true }).click();
    await expect(page.locator(".agent-usage")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(".agent-row")).toHaveCount(2);
    await page.getByRole("button", { name: "Tokens", exact: true }).click();
    await page.getByLabel("Range", { exact: true }).selectOption("90");
    await expect(page.locator(".agent-usage")).toHaveAttribute("aria-busy", "false");
    await page.getByLabel("Group by", { exact: true }).selectOption("day");
    await expect(page.locator(".agent-table tbody tr")).toHaveCount(90);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    // Let any shift caused by async loading be delivered after input's grace period.
    await page.waitForTimeout(650);
    const cls = await page.evaluate(() =>
      (window as any).__agentShifts.reduce((a: number, b: any) => a + b.value, 0),
    );
    if (cls) console.log(JSON.stringify(await page.evaluate(() => (window as any).__agentShifts)));
    expect(cls).toBe(0);
    console.log(
      `Coding agents ${width}px: CLS=${cls}; providers, ranges and daily breakdown checked.`,
    );
    await context.close();
  }
} finally {
  await browser.close();
  server.kill();
}
