import { defineConfig } from "@playwright/test";

const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const port = Number(process.env.PLAYWRIGHT_PORT ?? "3100");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid PLAYWRIGHT_PORT");

export default defineConfig({
  testDir: "./e2e",
  timeout: 40_000,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  ...(process.env.CI ? { workers: 2 } : {}),
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? "test-results",
  reporter: [["list"], ["junit", { outputFile: `${process.env.PLAYWRIGHT_OUTPUT_DIR ?? "test-results"}/junit.xml` }]],
  use: {
    baseURL: externalBaseUrl || `http://localhost:${port}`,
    channel: process.env.PLAYWRIGHT_CHANNEL === "chrome" ? "chrome" : "chromium",
    trace: "retain-on-failure",
  },
  ...(externalBaseUrl
    ? {}
    : { webServer: {
        command: `NEXT_PUBLIC_REOWN_PROJECT_ID= NEXT_PUBLIC_API_URL= npm run build && npm run start -- --port ${port}`,
        url: `http://localhost:${port}`,
        reuseExistingServer: false,
        timeout: 120_000,
      } }),
});
