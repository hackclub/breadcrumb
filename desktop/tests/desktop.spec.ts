import { test, expect } from "@playwright/test";
test("history scrubbing keeps alongside context attached to the capture", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open history", exact: true }).click();
  await expect(page.getByText("12 captures · kept until you delete them")).toBeVisible();
  await expect(page.getByRole("img", { name: /Desktop capture/ })).toBeVisible();
  await page.getByRole("slider", { name: "Capture timeline" }).focus();
  await page.keyboard.press("Home");
  await expect(page.getByText("1 of 12")).toBeVisible();
  await expect(page.getByText("Synthetic video - YouTube")).toBeVisible();
});
test("save and review a clip; correct a focused activity label", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open history", exact: true }).click();
  await page.getByRole("button", { name: "Save last hour", exact: true }).click();
  await page.getByRole("button", { name: /Saved/ }).click();
  await expect(page.getByRole("heading", { name: "Last hour", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByText("Labels & captured context", { exact: true }).click();
  await page.getByLabel("Activity label").selectOption("Reading");
  await expect(page.locator(".capture-caption .pill")).toHaveText("Reading");
  await page.getByRole("button", { name: /Activity/ }).click();
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  await expect(
    page.locator(".activity-row").filter({ has: page.getByText("Reading", { exact: true }) }),
  ).toContainText("≈5 min");
});
test("sessions open their capture set", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open history", exact: true }).click();
  await page.getByRole("button", { name: /Sessions/ }).click();
  await expect(page.locator(".session").first()).toContainText("In focus");
  await expect(page.locator(".session").first()).toContainText("Alongside");
  await expect(page.locator(".session-duration").first()).toContainText("min");
  await expect(page.locator(".session .app-icon").first()).toBeVisible();
  expect(
    await page.evaluate(() => document.querySelector(".workspace")!.scrollWidth),
  ).toBeLessThanOrEqual(360);
  await page.locator(".session").first().click();
  await expect(
    page.getByRole("heading", { name: "Breadcrumb", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "All history", exact: true })).toBeVisible();
});
test("logging settings persist within the preview and reductions request confirmation", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open history", exact: true }).click();
  await page.getByRole("button", { name: /Settings/ }).click();
  await page.getByLabel("Keep history").selectOption("168");
  await page.getByLabel("History storage", { exact: true }).selectOption("50");
  await page.getByLabel("Capture interval", { exact: true }).selectOption("30");
  let confirmed = false;
  page.once("dialog", async (dialog) => {
    confirmed = true;
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Settings saved." })).toBeVisible();
  expect(confirmed).toBe(true);
  await expect(page.getByRole("group", { name: "Unsaved settings" })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to overview", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByLabel("Keep history")).toHaveValue("168");
  await expect(page.getByLabel("Capture interval", { exact: true })).toHaveValue("30");
});

test("popup frame stays fixed, with scrolling only inside detailed views", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Recording overview" })).toBeVisible();
  await expect(page.getByRole("navigation")).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
  await page.getByRole("button", { name: "Save last hour", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Last hour saved.");
  await page.getByRole("button", { name: "Dismiss message" }).click();
  await page.getByRole("button", { name: "Open history", exact: true }).click();
  await expect(page.getByRole("navigation")).toBeVisible();
  await page.getByRole("button", { name: "Back to overview" }).click();
  await expect(page.getByRole("region", { name: "Recording overview" })).toBeVisible();
  await page.mouse.move(180, 200);
  await page.mouse.wheel(300, 600);
  const frame = () =>
    page.evaluate(() => {
      const workspace = document.querySelector('.panel-page[data-active="true"]')!;
      return {
        width: document.querySelector(".desktop")!.getBoundingClientRect().width,
        height: document.querySelector(".desktop")!.getBoundingClientRect().height,
        rootTop: document.documentElement.scrollTop,
        bodyTop: document.body.scrollTop,
        x: workspace.scrollLeft,
        y: workspace.scrollTop,
        overflow: workspace.scrollWidth > workspace.clientWidth,
      };
    });
  const expected = {
    width: 360,
    height: 400,
    rootTop: 0,
    bodyTop: 0,
    x: 0,
    y: 0,
    overflow: false,
  };
  expect(await frame()).toEqual(expected);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await page.getByLabel("Capture interval", { exact: true }).selectOption("30");
  await page.mouse.move(180, 260);
  await page.mouse.wheel(250, 700);
  await expect.poll(async () => (await frame()).y).toBeGreaterThan(0);
  const settings = await frame();
  expect({ ...settings, y: 0 }).toEqual(expected);
});

test("sync status opens fixed-size details with upload controls", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open sync details" }).click();
  await expect(page.getByRole("region", { name: "Sync details" })).toBeVisible();
  await expect(page.getByLabel("Upload workers")).toHaveValue("4");
  await page.getByLabel("Upload workers").selectOption("2");
  await expect(page.getByLabel("Upload workers")).toHaveValue("2");
  await page.getByRole("button", { name: "Pause uploads", exact: true }).click();
  await expect(page.getByText("Sync paused", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume uploads", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause uploads", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(400);
  await page.getByRole("button", { name: "Back to overview", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open sync details" })).toBeVisible();
});

test("settings save only real changes and token usage reuses the account connection", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open history", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const unsaved = page.getByRole("group", { name: "Unsaved settings" });
  await expect(unsaved).toHaveCount(0);
  await page.getByLabel("Capture interval", { exact: true }).selectOption("120");
  await expect(unsaved).toBeVisible();
  await unsaved.getByRole("button", { name: "Discard" }).click();
  await expect(unsaved).toHaveCount(0);
  await expect(page.getByLabel("Capture interval", { exact: true })).toHaveValue("60");
  const saveExclusions = page.getByRole("button", { name: "Save exclusions" });
  await expect(saveExclusions).toBeDisabled();
  await page.getByLabel("Never capture these apps").fill("com.example.secret");
  await expect(saveExclusions).toBeEnabled();
  await expect(page.getByLabel("Usage server")).toHaveCount(0);
  const upload = page.getByLabel("Upload hourly token counts");
  await expect(upload).toHaveCount(0);
  await expect(page.getByText("Sign in again to allow hourly token counts.")).toBeVisible();
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(upload).toBeChecked();
  await upload.click();
  await expect(upload).not.toBeChecked();
});
