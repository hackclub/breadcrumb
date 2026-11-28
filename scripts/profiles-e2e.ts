// Owner UI fixtures plus real PostgreSQL-backed public SSR. Never reads or edits a real account.
import { chromium, expect, type Browser } from "@playwright/test";
import { createServer, type AddressInfo } from "node:net";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { appSeed } from "../web/lib/apps";
import type { Profile } from "../web/lib/profiles";
import { profileUIFixture } from "../web/scripts/support/profile-ui-fixture";
const connection = process.env.PROFILE_TEST_DATABASE_URL;
if (!connection) throw Error("PROFILE_TEST_DATABASE_URL is required for public profile SSR tests");

const socket = createServer();
await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = (socket.address() as AddressInfo).port;
await new Promise<void>((resolve) => socket.close(() => resolve()));
const base = `http://127.0.0.1:${port}`;
const authSecret = randomUUID() + randomUUID();
const fixture = await profileUIFixture(connection, base, authSecret);
const server = Bun.spawn(["bun", "run", "--cwd", "web", "start", "--port", String(port)], {
  stdout: "ignore",
  stderr: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: connection,
    AUTH_DATABASE_URL: connection,
    BETTER_AUTH_SECRET: authSecret,
    ALLOWED_EMAILS: "",
    PUBLIC_URL: base,
    R2_ACCESS_KEY_ID: "",
    R2_SECRET_ACCESS_KEY: "",
    AWS_ACCESS_KEY_ID: "",
    AWS_SECRET_ACCESS_KEY: "",
    LOOPS_API_KEY: "",
  },
});
let browser: Browser | undefined;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG8kAAAAASUVORK5CYII=",
  "base64",
);
try {
  browser = await chromium.launch();
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
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      (window as any).__profileShifts = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as any)
          if (!entry.hadRecentInput)
            (window as any).__profileShifts.push({
              value: entry.value,
              sources: entry.sources?.map((source: any) => ({
                node: source.node?.outerHTML?.slice(0, 260),
                from: source.previousRect,
                to: source.currentRect,
              })),
            });
      }).observe({ type: "layout-shift", buffered: true });
    });
    const ownerId = "profile_ui_" + randomUUID(),
      suffix = randomUUID().slice(0, 8),
      username = `maker_${width}_${suffix}`;
    await context.addCookies(await fixture.cookies(ownerId));
    let owner: Profile | null = null,
      claims = 0,
      uploads = 0,
      avatarRequests = 0,
      brokenAvatar = false;
    const patches: any[] = [];
    const save = async (value: Profile) => {
      owner = value;
      await fixture.save(ownerId, value);
    };
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
      const now = new Date().toISOString();
      const profile: Profile = {
        avatarMode: "none",
        avatarURL: null,
        githubUrl: "",
        websiteUrl: "",
        ...owner,
        ...patch,
        createdAt: owner?.createdAt ?? now,
        updatedAt: now,
      };
      profile.avatarURL =
        profile.avatarMode === "none" ? null : `/api/profile/avatar?v=${Date.parse(now)}`;
      await save(profile);
      await route.fulfill({ json: { profile } });
    });
    await page.route("**/api/profile/availability?*", async (route) => {
      const name = new URL(route.request().url()).searchParams.get("username");
      if (name === "admin") {
        await route.fulfill({ status: 400, json: { error: "That username is reserved." } });
        return;
      }
      await route.fulfill({ json: { username: name, available: name !== "taken_name" } });
    });
    await page.route(/\/api\/profile\/avatar(?:\?.*)?$/, async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        avatarRequests++;
        await Bun.sleep(700);
        await route.fulfill({
          status: brokenAvatar ? 404 : 200,
          contentType: "image/png",
          body: brokenAvatar ? Buffer.alloc(0) : png,
        });
        return;
      }
      if (method === "POST") {
        uploads++;
        expect(route.request().headers()["content-type"]).toContain("multipart/form-data");
        await Bun.sleep(650);
        if (uploads === 1) {
          await route.fulfill({
            status: 422,
            json: { error: "This image could not be processed." },
          });
          return;
        }
        const now = new Date().toISOString();
        await save({
          ...owner!,
          avatarMode: "upload",
          avatarURL: `/api/profile/avatar?v=${Date.parse(now)}`,
          updatedAt: now,
        });
      } else
        await save({
          ...owner!,
          avatarMode: "none",
          avatarURL: null,
          updatedAt: new Date().toISOString(),
        });
      await route.fulfill({ json: { profile: owner } });
    });
    await page.route(/\/api\/profiles\/[^/]+\/avatar(?:\?.*)?$/, async (route) => {
      avatarRequests++;
      await Bun.sleep(700);
      await route.fulfill({
        status: brokenAvatar ? 404 : 200,
        contentType: "image/png",
        body: brokenAvatar ? Buffer.alloc(0) : png,
      });
    });
    const cls = () =>
      page.evaluate(() =>
        ((window as any).__profileShifts as { value: number }[]).reduce(
          (n, entry) => n + entry.value,
          0,
        ),
      );
    const checkCLS = async (phase: string) => {
      const value = await cls();
      if (value)
        console.error(
          JSON.stringify({
            width,
            phase,
            value,
            shifts: await page.evaluate(() => (window as any).__profileShifts),
          }),
        );
      expect(value).toBe(0);
    };
    const ready = async () => {
      await expect(
        page.locator('.profile-form[aria-busy="false"], .profile-edit-button').first(),
      ).toBeVisible();
      if (await page.getByRole("button", { name: "Edit profile", exact: true }).isVisible())
        await page.getByRole("button", { name: "Edit profile", exact: true }).click();
    };
    const saveProfile = async () => {
      await page.getByRole("button", { name: "Save profile" }).click();
      await expect(page.locator(".profile-feedback")).toHaveText("Profile saved.");
      await expect(page.getByRole("button", { name: "Edit profile", exact: true })).toBeVisible();
      await expect(page.locator(".profile-form")).toHaveCount(0);
    };
    const uploadInput = () => page.getByLabel("Upload profile picture", { exact: true });
    const photo = { name: "photo.png", mimeType: "image/png", buffer: png };
    await page.goto(base + "/profile");
    await expect(page.locator(".profile-form")).toHaveAttribute("aria-busy", "false");
    const before = await page.locator(".profile-save-row").boundingBox();
    await ready();
    expect(before).toEqual(await page.locator(".profile-save-row").boundingBox());
    await checkCLS("checkpoint1");
    await expect(page.getByLabel("Profile picture source")).toBeDisabled();
    expect(avatarRequests).toBe(0);
    await page.getByLabel("Username", { exact: true }).fill("admin");
    await expect(page.locator("#username-status")).toHaveText("That username is reserved.");
    await expect(page.getByRole("button", { name: "Reserve username" })).toBeDisabled();
    await page.getByLabel("Username", { exact: true }).fill("taken_name");
    await expect(page.locator("#username-status")).toContainText("already reserved");
    await page.getByLabel("Username", { exact: true }).fill("builder_" + suffix);
    await expect(page.locator("#username-status")).toContainText("Available");
    await page.getByLabel(/Display name/).fill("A fellow builder");
    await page.getByLabel(/A little about you/).fill("Making things and exploring new tools.");
    await page.getByLabel("GitHub", { exact: true }).fill("https://github.com/fellow-builder");
    await page.getByLabel("Personal website", { exact: true }).fill("https://builder.example/");
    await page.getByRole("switch", { name: /Public profile/ }).uncheck();
    await page.getByRole("button", { name: "Reserve username" }).click();
    await expect(page.locator(".profile-feedback[role=alert]")).toContainText("just reserved");
    await expect(page.getByLabel(/Display name/)).toHaveValue("A fellow builder");
    await page.getByLabel("Username", { exact: true }).fill(username);
    await expect(page.locator("#username-status")).toContainText("Available");
    await page.getByRole("button", { name: "Reserve username" }).click();
    await expect(page.locator(".profile-feedback")).toHaveText("Your username is reserved.");
    await expect(page.getByRole("button", { name: "Edit profile", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Edit profile", exact: true }).click();
    await expect(page.getByLabel("Username", { exact: true })).toHaveAttribute("readonly", "");
    const savedWrites = patches.length;
    await page.getByLabel(/Display name/).fill("Discard this draft");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "A fellow builder", exact: true }),
    ).toBeVisible();
    expect(patches.length).toBe(savedWrites);
    await page.getByRole("button", { name: "Edit profile", exact: true }).click();
    await expect(page.getByLabel(/Display name/)).toHaveValue("A fellow builder");
    expect(patches.at(-1)).toMatchObject({ username, visibility: "private", avatarMode: "none" });
    expect(patches.at(-1)).not.toHaveProperty("apps");
    expect(avatarRequests).toBe(0);
    await page.getByLabel("Profile picture source").selectOption("gravatar");
    expect(avatarRequests).toBe(0); // Gravatar is not looked up until explicitly saved.
    await saveProfile();
    await expect(page.locator(".profile-avatar img")).toBeVisible();
    await page.waitForFunction(
      () => document.querySelector<HTMLImageElement>(".profile-avatar img")?.naturalWidth,
    );
    expect(avatarRequests).toBeGreaterThan(0);
    const anonymous = await browser.newContext({ viewport: { width, height: 1000 } });
    const visitor = await anonymous.newPage();
    await visitor.goto(base + "/@" + username);
    await expect(visitor.getByRole("heading", { name: "Profile not found" })).toBeVisible();
    await expect(visitor.getByText("A fellow builder", { exact: true })).toHaveCount(0);
    expect((await context.request.get(`${base}/api/profiles/${username}/avatar`)).status()).toBe(
      404,
    );
    await page.goto(base + "/profile");
    await ready();
    await checkCLS("checkpoint2");
    await page.getByLabel("Profile picture source").selectOption("upload");
    await uploadInput().setInputFiles({
      name: "huge.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(2 * 1024 * 1024 + 1),
    });
    await expect(page.locator(".profile-avatar-feedback[role=alert]")).toContainText("2 MiB");
    expect(uploads).toBe(0);
    await page.getByLabel(/A little about you/).fill("Unsaved thoughts survive a picture upload.");
    await uploadInput().setInputFiles(photo);
    await expect(page.getByRole("progressbar", { name: "Updating profile picture" })).toBeVisible();
    await expect(page.locator(".profile-avatar-feedback[role=alert]")).toContainText(
      "could not be processed",
    );
    await expect(page.getByLabel(/A little about you/)).toHaveValue(
      "Unsaved thoughts survive a picture upload.",
    );
    await uploadInput().setInputFiles(photo);
    await expect(page.locator(".profile-avatar-feedback")).toContainText("Picture uploaded");
    await expect(page.getByLabel(/A little about you/)).toHaveValue(
      "Unsaved thoughts survive a picture upload.",
    );
    await saveProfile();
    expect(patches.at(-1)).not.toHaveProperty("avatarMode");
    await page.getByRole("button", { name: "Edit profile", exact: true }).click();
    await page.getByRole("button", { name: "Remove picture", exact: true }).click();
    await expect(page.locator(".profile-avatar-feedback")).toHaveText("Profile picture removed.");
    await expect(page.getByLabel("Profile picture source")).toHaveValue("none");
    await expect(page.locator(".profile-avatar img")).toHaveCount(0);
    await page.getByLabel("Profile picture source").selectOption("upload");
    await uploadInput().setInputFiles(photo);
    await expect(page.locator(".profile-avatar-feedback")).toContainText("Picture uploaded");
    await page.getByRole("switch", { name: /Public profile/ }).check();
    await saveProfile();
    await expect(page.getByRole("link", { name: /View your profile/ })).toHaveAttribute(
      "href",
      `/@${username}`,
    );
    await page.getByRole("link", { name: /View your profile/ }).click();
    await expect(page).toHaveURL(base + "/@" + username);
    const legacy = await page.request.get(base + "/u/" + username, { maxRedirects: 0 });
    expect(legacy.status()).toBe(308);
    expect(new URL(legacy.headers().location, base).pathname).toBe("/@" + username);
    await page.reload();
    await expect(page).toHaveURL(base + "/@" + username);
    await expect(page.getByRole("heading", { name: "A fellow builder" })).toBeVisible();
    await expect(page.getByText(/Your time isn’t shown yet/)).toBeVisible();
    await expect(page.locator(".profile-stats")).toHaveCount(0);
    await visitor.goto(base + "/@" + username);
    await expect(
      visitor.getByRole("heading", { name: "A fellow builder", exact: true }),
    ).toBeVisible();
    await expect(visitor.getByRole("button", { name: "Edit profile", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /GitHub profile/ })).toHaveAttribute(
      "href",
      "https://github.com/fellow-builder",
    );
    await expect(page.getByRole("link", { name: /Personal website/ })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    await expect(page.locator(".profile-avatar img")).toHaveAttribute(
      "src",
      new RegExp(`^/api/profile/avatar`),
    );
    const card = await page.locator(".public-profile-card").boundingBox();
    await page.waitForFunction(
      () => document.querySelector<HTMLImageElement>(".profile-avatar img")?.naturalWidth,
    );
    expect(await page.locator(".public-profile-card").boundingBox()).toEqual(card);
    await checkCLS("checkpoint3");
    expect((await page.content()).includes("a".repeat(64))).toBe(false);
    expect((await page.content()).includes("avatar_hash")).toBe(false);
    await fixture.share(ownerId, appSeed[1]);
    await page.goto(base + "/profile");
    await ready();
    await saveProfile();
    await page.waitForFunction(
      () => document.querySelector<HTMLImageElement>(".profile-avatar img")?.naturalWidth,
    );
    await page.screenshot({ path: `test-results/profiles/settings-${width}.png`, fullPage: true });
    await page.getByRole("link", { name: /View your profile/ }).click();
    await expect(page.locator(".profile-totals")).toContainText("Last 7 days2h");
    await expect(page.locator(".profile-week li")).toHaveCount(7);
    await expect(page.locator(".public-app")).toHaveCount(1);
    await expect(page.locator(".public-app")).toContainText(appSeed[1].name);
    await expect(page.locator(".public-app .catalog-app-icon")).toHaveCount(1);
    await visitor.goto(base + "/@" + username);
    await expect(visitor.locator(".profile-totals")).toContainText("All time2h");
    await expect(visitor.locator(".public-app")).toContainText("2h");
    await page.waitForFunction(
      () => document.querySelector<HTMLImageElement>(".profile-avatar img")?.naturalWidth,
    );
    await page.screenshot({ path: `test-results/profiles/public-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await checkCLS("checkpoint4");
    brokenAvatar = true;
    await page.reload();
    await expect(page.getByRole("heading", { name: "A fellow builder" })).toBeVisible();
    await expect(page.locator(".profile-avatar img")).toHaveCount(0);
    await checkCLS("checkpoint5");
    if (width === 320) {
      const longName = "w".repeat(20) + randomUUID().slice(0, 4);
      await fixture.save("profile_ui_" + randomUUID(), {
        ...owner!,
        username: longName,
        displayName: "w".repeat(60),
        bio: "w".repeat(280),
        avatarMode: "none",
        avatarURL: null,
      });
      await page.goto(base + "/@" + longName);
      await expect(page.getByRole("heading", { name: "w".repeat(60), exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await checkCLS("long-profile");
    }
    expect(errors).toEqual([]);
    console.log(
      `Profiles ${width}px: immutable claims, actual public SSR/privacy, links, shared time and apps, explicit Gravatar opt-in, upload limits/progress/error/retry/removal, no overflow, CLS=0.`,
    );
    await anonymous.close();
    await context.close();
  }
  const page = await browser.newPage();
  await page.route("**/api/profile", (route) =>
    route.fulfill({ status: 401, json: { error: "Sign in required" } }),
  );
  await page.route("**/api/apps", (route) => route.fulfill({ json: { apps: appSeed } }));
  await page.goto(base + "/profile");
  await expect(page.getByRole("heading", { name: "Make it yours" })).toBeVisible();
} finally {
  await browser?.close();
  server.kill();
  await server.exited;
  await fixture.close();
}
