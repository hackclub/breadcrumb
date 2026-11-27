// Synthetic browser checks for connection controls and explicit screenshot sharing.
import { chromium, expect } from "@playwright/test";
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
  env: {
    ...process.env,
    PUBLIC_URL: origin,
    DATABASE_URL: "postgres://synthetic@127.0.0.1:1/unavailable",
    AUTH_DATABASE_URL: "postgres://synthetic@127.0.0.1:1/unavailable",
    BETTER_AUTH_SECRET: "synthetic-connection-ui-secret-only",
  },
});
const browser = await chromium.launch();
try {
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(origin + "/icon.svg")).ok) break;
    } catch {}
    await Bun.sleep(100);
  }
  await mkdir("test-results/integrations", { recursive: true });
  for (const width of [1280, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    // The controls use mocked APIs; the SSR session-store outage hint keeps
    // this fixture signed in without connecting to a real account or database.
    await page.context().addCookies([
      {
        name: "better-auth.session_token",
        value: "synthetic-connections-layout",
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
      },
    ]);
    const captureId = "00000000-0000-4000-8000-000000000001";
    let revoked = false,
      disconnected = false;
    await page.route("**/api/v1/connections", async (route) => {
      if (route.request().method() === "DELETE") {
        expect(route.request().postDataJSON()).toEqual({ id: "grant" });
        disconnected = true;
        await route.fulfill({ json: { disconnected: true } });
      } else
        await route.fulfill({
          json: {
            entries: [
              {
                id: "grant",
                name: "Personal assistant",
                clientId: "client",
                scopes: ["time:read", "apps:read"],
                device: null,
                lastUsed: null,
              },
              {
                id: "old-laptop",
                name: "Breadcrumb Desktop",
                clientId: "desktop-old",
                scopes: ["email", "offline_access", "captures:sync", "agents:sync"],
                device: { name: "Studio iMac", platform: "darwin-amd64", version: "0.2.9" },
                lastUsed: new Date(Date.now() - 3 * 3_600_000).toISOString(),
              },
              {
                id: "laptop",
                name: "Breadcrumb Desktop",
                clientId: "desktop",
                scopes: ["email", "offline_access", "captures:sync", "agents:sync"],
                device: { name: "Synthetic MacBook", platform: "darwin-arm64", version: "0.2.9" },
                lastUsed: new Date(Date.now() - 60_000).toISOString(),
              },
            ],
          },
        });
    });
    await page.route("**/api/v1/screenshots", (route) =>
      route.fulfill({
        json: {
          entries: [{ id: captureId, date: "2026-01-02T12:00:00Z", hasScreenshot: true }],
          nextCursor: "",
        },
      }),
    );
    await page.route("**/api/v1/screenshots/*/image", (route) =>
      route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
          "base64",
        ),
      }),
    );
    await page.route("**/api/v1/shares", async (route) => {
      const method = route.request().method();
      if (method === "POST") {
        expect(route.request().postDataJSON()).toEqual({ captureId, expiresInHours: 1 });
        await route.fulfill({
          json: {
            id: "share",
            url: origin + "/s/synthetic-link",
            expiresAt: "2026-01-03T12:00:00Z",
          },
        });
      } else if (method === "DELETE") {
        expect(route.request().postDataJSON()).toEqual({ id: "share" });
        revoked = true;
        await route.fulfill({ json: { revoked: true } });
      } else await route.fulfill({ json: { entries: [] } });
    });
    await page.goto(origin + "/connections");
    await expect(page.getByText("Personal assistant", { exact: true })).toBeVisible();
    const devices = page.locator(".connections-panel").filter({ hasText: "Devices" });
    await expect(devices.locator("h3")).toHaveText(["Synthetic MacBook", "Studio iMac"]);
    await expect(devices.locator(".connection-row").first()).toContainText("Online");
    await expect(devices.locator(".connection-row").first()).toContainText("macOS · Apple silicon");
    await expect(devices.locator(".connection-row").nth(1)).toContainText("Last used 3 hours ago");
    await expect(devices.getByText("Upload all existing and future captures").first()).toBeHidden();
    await expect(page.locator(".screenshot-preview")).toHaveCount(0);
    await page.locator(".capture-choice").click();
    await expect(page.locator(".screenshot-preview img")).toBeVisible();
    await page.getByRole("combobox", { name: "Link expires after" }).selectOption("1");
    await page.getByRole("button", { name: "Create share link" }).click();
    await expect(page.getByRole("textbox", { name: "Screenshot share link" })).toHaveValue(
      origin + "/s/synthetic-link",
    );
    await page.getByRole("button", { name: "Revoke link", exact: true }).click();
    expect(revoked).toBe(true);
    await expect(page.getByRole("textbox", { name: "Screenshot share link" })).toHaveCount(0);
    await page
      .locator(".connection-row")
      .filter({ hasText: "Personal assistant" })
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    expect(disconnected).toBe(true);
    await expect(page.getByText("No apps connected yet.")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/integrations/sharing-${width}.png`,
      fullPage: true,
    });
    await page.close();
  }
  console.log(
    "Passed: desktop/mobile device names and last use, connection withdrawal, screenshot preview, explicit link creation, expiry choice, link revocation and no horizontal overflow.",
  );
} finally {
  await browser.close();
  server.kill();
  await server.exited;
}
