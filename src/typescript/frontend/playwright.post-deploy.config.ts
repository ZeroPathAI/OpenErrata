import { defineConfig } from "@playwright/test";

/**
 * Playwright config for post-deploy smoke tests.
 *
 * No webServer — tests run against the live deployed frontend at
 * FRONTEND_BASE_URL. This config only includes the post-deploy test file.
 */
export default defineConfig({
  testDir: "test/e2e",
  testMatch: "post-deploy-smoke.spec.ts",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
});
