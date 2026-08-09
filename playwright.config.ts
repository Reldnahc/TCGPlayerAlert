import { defineConfig, devices } from "@playwright/test";
import process from "node:process";

const localBrowserPath = process.env.TCGPLAYER_ALERT_BROWSER_PATH;

export default defineConfig({
  testDir: "test/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:47839",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/preview-ui.mjs",
    url: "http://127.0.0.1:47839/api/settings",
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(localBrowserPath === undefined
          ? {}
          : { launchOptions: { executablePath: localBrowserPath } }),
      },
    },
  ],
});
