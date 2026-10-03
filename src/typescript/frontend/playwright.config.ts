import { defineConfig } from "@playwright/test";

const MOCK_PUBLIC_API_PORT = "19876";

export default defineConfig({
  testDir: "test/e2e",
  testIgnore: "post-deploy-smoke.spec.ts",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4173",
    // The full Chromium build in new headless mode, as the extension suite
    // uses: one browser download serves both, and no window ever opens.
    channel: "chromium",
    headless: true,
  },
  webServer: [
    {
      command: "node --import tsx test/e2e/mock-public-api.ts",
      url: `http://127.0.0.1:${MOCK_PUBLIC_API_PORT}/health`,
      reuseExistingServer: false,
      env: { MOCK_PUBLIC_API_PORT },
    },
    {
      command: "node build/index.js",
      port: 4173,
      reuseExistingServer: false,
      env: {
        PORT: "4173",
        API_BASE_URL: `http://127.0.0.1:${MOCK_PUBLIC_API_PORT}`,
      },
    },
  ],
});
