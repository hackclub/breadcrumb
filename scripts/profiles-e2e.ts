// Synthetic UI coverage. Backend tests separately enforce ownership, claims and privacy.
import { chromium, expect } from "@playwright/test";
import { createServer, type AddressInfo } from "node:net";
import { mkdir } from "node:fs/promises";
import { appSeed } from "../web/lib/apps";
import type { Profile } from "../web/lib/profiles";
const socket = createServer();
await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = (socket.address() as AddressInfo).port;
await new Promise<void>((resolve) => socket.close(() => resolve()));
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn(["bun", "run", "--cwd", "web", "start", "--port", String(port)], {
  stdout: "ignore",
  stderr: "inherit",
});
const browser = await chromium.launch();
try {
  await mkdir("test-results/profiles", { recursive: true });
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(base + "/icon.svg")).ok) break;
    } catch {}
    if (i === 149) throw Error("Profile UI server did not start");
    await Bun.sleep(100);
  }
  for (const width of [1280, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      locale: "en-US",
    });
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: "synthetic-profile-layout-hint",
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
      },
    ]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      (window as any).__profileShifts = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as any)
          if (!entry.hadRecentInput) (window as any).__profileShifts.push(entry.value);
      }).observe({ type: "layout-shift", buffered: true });
    });
    let owner: Profile | null = null;
    let claims = 0;
    const patches: any[] = [];
    await page.route("**/api/apps", async (route) => {
      await Bun.sleep(500);
      await route.fulfill({ json: { apps: appSeed } });
    });
    await page.route("**/api/profile", async (route) => {
      if (route.request().method() === "GET") {
        await Bun.sleep(650);
        await route.fulfill({ json: { profile: owner } });
        return;
      }
      const patch = route.request().postDataJSON();
      patches.push(patch);
      if (!owner && ++claims === 1) {
        await route.fulfill({
          status: 409,
          json: { error: "This username was just reserved. Choose another." },
        });
        return;
      }
      owner = { ...patch, createdAt: "2026-11-19T00:00:00Z", updatedAt: "2026-11-19T00:00:00Z" };
      await route.fulfill({ json: { profile: owner } });
    });
    await page.route("**/api/profile/availability?*", async (route) => {
      const username = new URL(route.request().url()).searchParams.get("username");
      if (username === "admin") {
        await route.fulfill({ status: 400, json: { error: "That username is reserved." } });
        return;
      }
      await route.fulfill({ json: { username, available: username !== "taken_name" } });
    });
    await page.route("**/api/profiles/*", async (route) => {
      await Bun.sleep(500);
      if (!owner || owner.visibility !== "public") {
        await route.fulfill({ status: 404, json: { error: "Profile not found" } });
        return;
      }
      await route.fulfill({
        json: {
          profile: {
            username: owner.username,
            displayName: owner.displayName,
            bio: owner.bio,
            ...(owner.shareApps
              ? { apps: appSeed.filter((app) => owner!.apps.includes(app.id)) }
              : {}),
          },
        },
      });
    });
    await page.goto(base + "/profile");
    await expect(page.locator(".profile-form")).toHaveAttribute("aria-busy", "true");
    const before = await page.locator(".profile-app-options").boundingBox();
    await expect(page.locator(".profile-form")).toHaveAttribute("aria-busy", "false");
    expect(
      await page.evaluate(() =>
        ((window as any).__profileShifts as number[]).reduce((n, value) => n + value, 0),
      ),
    ).toBe(0);
    const after = await page.locator(".profile-app-options").boundingBox();
    expect(before).toEqual(after);
    expect(
      await page.evaluate(() =>
        ((window as any).__profileShifts as number[]).reduce((n, value) => n + value, 0),
      ),
    ).toBe(0);
    await expect(page.getByRole("switch", { name: /Public profile/ })).toBeChecked();
    await expect(page.getByRole("switch", { name: /Share my selected apps/ })).not.toBeChecked();
    await page.getByLabel("Username", { exact: true }).fill("admin");
    await expect(page.locator("#username-status")).toHaveText("That username is reserved.");
    await expect(page.getByRole("button", { name: "Reserve username" })).toBeDisabled();
    await page.getByLabel("Username", { exact: true }).fill("taken_name");
    await expect(page.locator("#username-status")).toContainText("already reserved");
    await page.getByLabel("Username", { exact: true }).fill("builder_one");
    await expect(page.locator("#username-status")).toContainText("Available");
    await page.getByLabel(/Display name/).fill("A fellow builder");
    await page.getByLabel(/A little about you/).fill("Making things and exploring new tools.");
    await page.getByRole("switch", { name: /Public profile/ }).uncheck();
    await page.getByRole("switch", { name: /Share my selected apps/ }).check();
    for (const app of appSeed.slice(0, 2))
      await page.getByRole("checkbox", { name: app.name, exact: true }).check();
    await page.getByRole("button", { name: "Reserve username" }).click();
    await expect(page.locator(".profile-feedback[role=alert]")).toContainText("just reserved");
    await expect(page.getByLabel(/Display name/)).toHaveValue("A fellow builder");
    await page.getByLabel("Username", { exact: true }).fill("builder_two");
    await expect(page.locator("#username-status")).toContainText("Available");
    await page.getByRole("button", { name: "Reserve username" }).click();
    await expect(page.locator(".profile-feedback")).toHaveText("Your username is reserved.");
    await expect(page.getByLabel("Username", { exact: true })).toHaveAttribute("readonly", "");
    expect(patches.at(-1)).toMatchObject({
      username: "builder_two",
      visibility: "private",
      shareApps: true,
      apps: appSeed.slice(0, 2).map((app) => app.id),
    });
    expect(Object.keys(patches.at(-1)).sort()).toEqual([
      "apps",
      "bio",
      "displayName",
      "shareApps",
      "username",
      "visibility",
    ]);
    await page.screenshot({ path: `test-results/profiles/settings-${width}.png`, fullPage: true });
    await page.getByRole("link", { name: /View your profile/ }).click();
    await expect(page.getByRole("heading", { name: "Profile not found" })).toBeVisible();
    await expect(page.getByText("A fellow builder", { exact: true })).toHaveCount(0);
    await page.goto(base + "/profile");
    await expect(page.locator(".profile-form")).toHaveAttribute("aria-busy", "false");
    await page.getByRole("switch", { name: /Public profile/ }).check();
    await page.getByRole("switch", { name: /Share my selected apps/ }).uncheck();
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.locator(".profile-feedback")).toHaveText("Profile saved.");
    await page.getByRole("link", { name: /View your profile/ }).click();
    await expect(page.getByRole("heading", { name: "A fellow builder" })).toBeVisible();
    await expect(page.getByText("No apps shared.", { exact: true })).toBeVisible();
    for (const app of appSeed.slice(0, 2))
      await expect(page.getByText(app.name, { exact: true })).toHaveCount(0);
    await page.goto(base + "/profile");
    await expect(page.locator(".profile-form")).toHaveAttribute("aria-busy", "false");
    await page.getByRole("switch", { name: /Share my selected apps/ }).check();
    await page.getByRole("checkbox", { name: appSeed[0].name, exact: true }).uncheck();
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.locator(".profile-feedback")).toHaveText("Profile saved.");
    await page.getByRole("link", { name: /View your profile/ }).click();
    await expect(page.getByText(appSeed[1].name, { exact: true })).toBeVisible();
    await expect(page.getByText(appSeed[0].name, { exact: true })).toHaveCount(0);
    await expect(page.locator(".public-app .catalog-app-icon")).toHaveCount(1);
    await page.screenshot({ path: `test-results/profiles/public-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const cls = await page.evaluate(() =>
      ((window as any).__profileShifts as number[]).reduce((n, value) => n + value, 0),
    );
    expect(cls).toBe(0);
    expect(errors).toEqual([]);
    console.log(
      `Profiles ${width}px: reservation, conflict, immutable username, private/public app controls, no overflow, CLS=${cls}.`,
    );
    await context.close();
  }
  const page = await browser.newPage();
  await page.route("**/api/profile", (route) =>
    route.fulfill({ status: 401, json: { error: "Sign in required" } }),
  );
  await page.route("**/api/apps", (route) => route.fulfill({ json: { apps: appSeed } }));
  await page.goto(base + "/profile");
  await expect(page.getByRole("heading", { name: "Make it yours" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute(
    "href",
    "/",
  );
} finally {
  await browser.close();
  server.kill();
  await server.exited;
}
