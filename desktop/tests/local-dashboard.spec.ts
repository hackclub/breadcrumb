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
  await expect(page.getByText("Local captures", { exact: true })).toBeVisible();
  await expect(page.getByText("Captures synced", { exact: true })).toHaveCount(0);
  await expect(page.locator(".insight-stats")).toContainText("12");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("button", { name: "Explore Coding", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Coding");
  await expect(page.getByRole("dialog")).toContainText("Breadcrumb");
  await page.getByRole("button", { name: "Close activity details" }).click();
  await page.getByLabel("Time range").selectOption("all");
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
