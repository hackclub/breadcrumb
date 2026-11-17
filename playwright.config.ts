import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./desktop/tests",
  use: { baseURL: "http://127.0.0.1:1420", headless: true, viewport: { width: 640, height: 700 } },
  webServer: {
    command: "bun run --cwd desktop dev",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
  },
  reporter: "list",
});
