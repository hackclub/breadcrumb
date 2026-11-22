import { expect, test } from "@playwright/test";

test("local dashboard explores history without accounts or API requests", async ({ page }) => {
  const apiRequests: string[] = [];
  const external: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/"))
      apiRequests.push(url.pathname);
    if (url.protocol.startsWith("http") && url.hostname !== "127.0.0.1") external.push(url.origin);
  });
  await page.route("**/api/**", (route) => route.abort());
  await page.goto("/?view=dashboard");
  await expect(page.getByRole("heading", { name: "Where your time went" })).toBeVisible();
  await expect(page.locator(".time-dashboard")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByText("Local captures", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Captures synced", { exact: true })).toHaveCount(0);
  await expect(page.locator(".stat-app .app-monogram")).toHaveText("E");
  const coverage = page.getByLabel("History coverage").locator(":scope > div").first();
  const label = await coverage.locator("span").first().boundingBox();
  const value = await coverage.locator("strong").boundingBox();
  expect(value!.y).toBeGreaterThanOrEqual(label!.y + label!.height);
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("button", { name: "Explore Coding", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Coding");
  await expect(page.getByRole("dialog")).toContainText("Breadcrumb");
  const bar = await page
    .locator(".activity-days button:not(:disabled) .activity-day-space > span")
    .first()
    .boundingBox();
  expect(bar?.width).toBeGreaterThan(0);
  expect(bar?.height).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Close activity details" }).click();
  await page.getByRole("button", { name: "Time range", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "All time", exact: true }).click();
  await page.locator(".day-column").last().click();
  await expect(page.getByRole("button", { name: "Clear day ×" })).toBeVisible();
  await page.locator(".hour-cell").filter({ visible: true }).first().click();
  await expect(page.locator(".hour-detail")).toBeVisible();
  expect(apiRequests).toEqual([]);
  expect(external).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("dashboard opens separately without changing the popup frame", async ({ page }) => {
  await page.goto("/");
  const next = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  const dashboard = await next;
  await expect(dashboard.getByRole("heading", { name: "Where your time went" })).toBeVisible();
  expect(
    await page.locator(".desktop").evaluate((node) => node.getBoundingClientRect().height),
  ).toBe(400);
});

test("insights worker accepts its parent channel and ignores forged events", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const script = `
      import ${JSON.stringify(location.origin + "/src/local-insights-worker.ts")};
      for (const origin of ["", "https://untrusted.example"]) {
        self.dispatchEvent(new MessageEvent("message", {
          origin, data: { records: [], timeZone: "UTC" }
        }));
      }
      self.postMessage({ ready: true });
    `;
    const url = URL.createObjectURL(new Blob([script], { type: "text/javascript" }));
    const worker = new Worker(url, { type: "module" });
    try {
      return await new Promise<{ forged: unknown[]; response: unknown }>((resolve, reject) => {
        const forged: unknown[] = [];
        let ready = false;
        const timeout = setTimeout(() => reject(Error("Worker did not reply")), 5000);
        worker.addEventListener("error", (event) => {
          clearTimeout(timeout);
          reject(Error(event.message));
        });
        worker.addEventListener("message", (event) => {
          if (event.data.ready) {
            ready = true;
            worker.postMessage({ records: [], timeZone: "UTC" });
          } else if (!ready) {
            forged.push(event.data);
          } else {
            clearTimeout(timeout);
            resolve({ forged, response: event.data });
          }
        });
      });
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  });
  expect(result).toEqual({ forged: [], response: { days: [] } });
});
