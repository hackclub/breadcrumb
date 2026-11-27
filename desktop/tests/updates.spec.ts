import { expect, test } from "@playwright/test";

test("updates refresh native status after wake and install only after confirmation", async ({
  page,
}) => {
  await page.goto("/");
  const state = await page.evaluate(async () => {
    const bridge = await import("/src/bridge.ts");
    return bridge.engine("state");
  });
  await page.addInitScript((state) => {
    const probe = { checks: 0, installs: 0 };
    const status = {
      currentVersion: "0.2.0",
      version: "0.2.1",
      notes: "A signed release",
      checkedAt: Date.now(),
      failed: false,
    };
    Object.assign(window, {
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __updatesProbe: probe,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (command: string, args?: { command?: string }) => {
          if (command === "engine") {
            if (args?.command === "agentUsageSettings")
              return { providers: [], lastScan: "", pending: 0, bytes: 0 };
            if (args?.command === "agentUsageSync")
              return {
                enabled: false,
                connected: false,
                allowed: false,
                server: "",
                lastSynced: "",
                error: "",
                signingIn: false,
                authError: "",
              };
            return args?.command === "payload" ? { jpeg: "", tree: [] } : state;
          }
          if (command === "plugin:app|version") return "0.2.0";
          if (command === "update_status") return status;
          if (command === "check_updates") {
            probe.checks++;
            status.checkedAt = Date.now();
            return status;
          }
          if (command === "install_update") probe.installs++;
          return false;
        },
      },
    });
  }, state);
  await page.clock.install();
  await page.reload();
  const probe = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __updatesProbe: { checks: number; installs: number };
          }
        ).__updatesProbe,
    );
  await expect.poll(async () => (await probe()).checks).toBe(0);
  expect((await probe()).installs).toBe(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("Version 0.2.1 is available.")).toBeVisible();
  await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  await expect.poll(async () => (await probe()).checks).toBe(1);
  await page.clock.fastForward(4 * 60 * 60 * 1000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(async () => (await probe()).checks).toBe(2);
  const install = page.getByRole("button", { name: "Install & restart", exact: true });
  await Promise.all([
    page.waitForEvent("dialog").then((dialog) => dialog.dismiss()),
    install.click(),
  ]);
  expect((await probe()).installs).toBe(0);
  await Promise.all([
    page.waitForEvent("dialog").then((dialog) => dialog.accept()),
    install.click(),
  ]);
  await expect.poll(async () => (await probe()).installs).toBe(1);
});
