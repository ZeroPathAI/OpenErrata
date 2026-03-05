import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4173",
  },
  webServer: {
    command: "node build/index.js",
    port: 4173,
    reuseExistingServer: false,
    env: {
      PORT: "4173",
      API_BASE_URL: "http://localhost:19876",
    },
  },
});
