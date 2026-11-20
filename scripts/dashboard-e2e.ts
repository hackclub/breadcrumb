// Synthetic delayed responses: canonical app rows, category icons, skeleton geometry and zero CLS.
import { chromium, expect } from "@playwright/test";
import { calendarClock, REFERENCE } from "../web/lib/insights";
import { appSeed } from "../web/lib/apps";
import { createServer, type AddressInfo } from "node:net";
import { mkdir } from "node:fs/promises";
const socket = createServer();
await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = (socket.address() as AddressInfo).port;
await new Promise<void>((resolve) => socket.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const server = Bun.spawn(["bun", "run", "--cwd", "web", "start", "--port", String(port)], {
  stdout: "ignore",
  stderr: "inherit",
});
const browser = await chromium.launch();
try {
  await mkdir("test-results/dashboard", { recursive: true });
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      if ((await fetch(origin + "/icon.svg")).ok) break;
    } catch {}
    if (attempt === 149) throw Error("Dashboard test server did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const width of [1280, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      locale: "en-US",
      timezoneId: "America/New_York",
    });
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: "synthetic-layout-hint",
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
      },
    ]);
    const page = await context.newPage();
    await page.addInitScript(() => {
      (window as any).__shifts = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as any)
          if (!entry.hadRecentInput)
            (window as any).__shifts.push({
              value: entry.value,
              sources: entry.sources?.map((source: any) => ({
                node: (source.node?.outerHTML || source.node?.parentElement?.outerHTML)?.slice(
                  0,
                  180,
                ),
                from: source.previousRect,
                to: source.currentRect,
              })),
            });
      }).observe({ type: "layout-shift", buffered: true });
    });
    const today = calendarClock("America/New_York")(Date.now() / 1000 - REFERENCE).day;
    let summaries = 0,
      indexes = 0;
    const dataset = (full: boolean) => ({
      day: today,
      seconds: 18000,
      firstCapture: Date.parse(today + "T12:00:00Z") / 1000 - REFERENCE,
      lastCapture: Date.parse(today + "T22:00:00Z") / 1000 - REFERENCE,
      captures: full ? 1000 : 50,
      lastSynced: new Date().toISOString(),
      apps: full
        ? [
            { name: "Helium", id: "net.imput.helium", seconds: 6000 },
            { name: "Helium", seconds: 5000 },
            { name: "Slick", seconds: 4000 },
            { name: "Ghostty", seconds: 3000 },
          ]
        : [
            { name: "Slick", seconds: 13000 },
            { name: "Helium", seconds: 5000 },
          ],
      activities: full
        ? [
            { name: "Browsing", seconds: 11000 },
            { name: "Coding", seconds: 3000 },
            { name: "Messaging interface", seconds: 4000 },
          ]
        : [{ name: "Coding", seconds: 18000 }],
      projects: full
        ? [
            { name: "Project one", seconds: 11000 },
            { name: "Another project", seconds: 7000 },
          ]
        : [{ name: "Unassigned", seconds: 18000 }],
      activityDetails: full
        ? {
            Browsing: {
              seconds: 11000,
              apps: [{ name: "Helium", seconds: 11000 }],
              projects: [{ name: "Project one", seconds: 11000 }],
            },
          }
        : {},
      hours: Array(24).fill(750),
    });
    await page.route("**/api/auth/get-session", async (route) => {
      await new Promise((r) => setTimeout(r, 900));
      await route.fulfill({
        json: {
          session: {
            id: "preview",
            userId: "preview",
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
          user: {
            id: "preview",
            email: "preview@example.invalid",
            emailVerified: true,
            name: "Preview",
          },
        },
      });
    });
    await page.route("**/api/apps", async (route) => {
      await new Promise((r) => setTimeout(r, 1600));
      await route.fulfill({ json: { apps: appSeed } });
    });
    const zones: string[] = [];
    await page.route("**/v1/account/summary*", async (route) => {
      zones.push(new URL(route.request().url()).searchParams.get("timeZone") ?? "");
      const count = ++summaries;
      await new Promise((r) => setTimeout(r, 1100));
      await route.fulfill({ json: { days: [dataset(count > 1)], nextCursor: "" } });
    });
    await page.route("**/v1/account/index", async (route) => {
      await new Promise((r) => setTimeout(r, 80));
      await route.fulfill({ json: { done: ++indexes >= 6 } });
    });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await expect(page.locator('.time-dashboard[aria-busy="true"]')).toBeVisible();
    const selectors = [
      ".insight-stats",
      ".daily-panel",
      ".ranking-panel:first-child",
      ".ranking-panel:last-child",
      ".hour-scroll",
      "footer",
    ];
    const positions = async () =>
      page.evaluate(
        (selectors) =>
          selectors.map((selector) => {
            const r = document.querySelector(selector)!.getBoundingClientRect();
            return { selector, x: r.x, y: r.y, width: r.width, height: r.height };
          }),
        selectors,
      );
    const before = await positions();
    await page.screenshot({ path: `test-results/dashboard/loading-${width}.png`, fullPage: true });
    await expect(page.locator(".time-dashboard")).toHaveAttribute("aria-busy", "false");
    await page.waitForFunction(
      () => !document.querySelector(".dashboard-message")?.textContent?.includes("Updating older"),
    );
    await expect(page.locator(".sync-count")).toContainText("1,000 captures");
    await page.waitForTimeout(150);
    expect(zones).toContain("America/New_York");
    await expect(page.getByText("Observed time", { exact: true })).toBeVisible();
    await expect(page.getByText("Captures synced", { exact: true })).toHaveCount(0);
    await expect(page.locator(".stat-app .catalog-app-icon")).toBeVisible();
    await page.waitForFunction(() => {
      const icon = document.querySelector<HTMLImageElement>(".stat-app .catalog-app-icon");
      return icon?.complete && icon.naturalWidth > 0;
    });
    await expect(page.getByLabel("History coverage")).toContainText("50%");
    const after = await positions();
    const shifts = await page.evaluate(() => (window as any).__shifts);
    const cls = shifts.reduce((s: any, e: any) => s + e.value, 0);
    if (cls) console.error(JSON.stringify({ width, before, after, cls, shifts }));
    console.log(
      `Dashboard ${width}px: CLS=${cls}; delayed auth, stats, catalog and index updates checked.`,
    );
    for (let i = 0; i < before.length; i++)
      for (const key of ["x", "y", "width", "height"] as const)
        expect(Math.abs(after[i][key] - before[i][key])).toBeLessThan(0.5);
    expect(shifts.reduce((s: any, e: any) => s + e.value, 0)).toBe(0);
    await expect(
      page.locator(".ranking-panel").first().getByText("Helium", { exact: true }),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await expect(
      page.locator(".ranking-panel").first().locator(".category-icon svg").first(),
    ).toBeVisible();
    await page.screenshot({ path: `test-results/dashboard/loaded-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "Explore Browsing", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Helium", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Project one", { exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/dashboard/activity-${width}.png`, fullPage: true });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Explore Browsing", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Explore Browsing", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(`Explore Browsing on ${today}`) }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Clear day ×" })).toBeVisible();
    await context.close();
  }
} finally {
  await browser.close();
  server.kill();
  await server.exited;
}
