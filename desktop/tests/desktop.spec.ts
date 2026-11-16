import { test, expect } from "@playwright/test";
test("history scrubbing keeps alongside context attached to the capture", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("12 captures · kept until you delete them")).toBeVisible();
  await expect(page.getByRole("img", { name: /Desktop capture/ })).toBeVisible();
  await page.getByRole("slider", { name: "Capture timeline" }).focus();
  await page.keyboard.press("Home");
  await expect(page.getByText("1 of 12")).toBeVisible();
  await expect(page.getByText("Synthetic video - YouTube")).toBeVisible();
});
test("save and review a clip; correct a focused activity label", async ({ page }) => {
  await page.goto("/");
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
  ).toContainText("5 captures");
});
test("sessions open their capture set", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Sessions/ }).click();
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
  await page.getByRole("button", { name: /Settings/ }).click();
  await page.getByLabel("Keep history").selectOption("168");
  await page.getByLabel("History storage", { exact: true }).selectOption("50");
  await page.getByLabel("Capture interval", { exact: true }).selectOption("30");
  let confirmed = false;
  page.once("dialog", async (dialog) => {
    confirmed = true;
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Apply logging settings" }).click();
  await expect(page.getByRole("status")).toContainText("Logging settings saved.");
  expect(confirmed).toBe(true);
  await page.getByRole("button", { name: /History/ }).click();
  await page.getByRole("button", { name: /Settings/ }).click();
  await expect(page.getByLabel("Keep history")).toHaveValue("168");
  await expect(page.getByLabel("Capture interval", { exact: true })).toHaveValue("30");
});
