/**
 * Post-deploy smoke tests.
 *
 * These run against a live deployed frontend URL (set via FRONTEND_BASE_URL
 * env var) to verify that the deployment actually works end-to-end. They are
 * executed as a separate CI job after `pulumi up` completes.
 *
 * Unlike the regular smoke tests (which run against a local build with no
 * real API), these hit the live frontend backed by the real API and verify
 * that the full stack is healthy.
 */

import { test, expect } from "@playwright/test";

const FRONTEND_BASE_URL: string | undefined = process.env["FRONTEND_BASE_URL"];

test.skip(
  FRONTEND_BASE_URL === undefined,
  "FRONTEND_BASE_URL not set; skipping post-deploy smoke tests",
);

test.describe("Post-deploy smoke", () => {
  test("landing page loads and renders hero", async ({ page }) => {
    await page.goto(FRONTEND_BASE_URL!);
    await expect(page.locator("h1")).toContainText("Fact-check what you read");
    await expect(page.locator("nav")).toBeVisible();
  });

  test("health endpoint returns ok", async ({ request }) => {
    const response = await request.get(`${FRONTEND_BASE_URL!}/health`);
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  test("corrections page loads data from the API", async ({ page }) => {
    // An API outage renders a 502 error page, which must fail the deploy check.
    const response = await page.goto(`${FRONTEND_BASE_URL!}/corrections`);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/Corrections/);

    const results = page.locator(".results");
    if (await results.isVisible()) {
      const firstCard = page.locator(".investigation-card").first();
      await expect(firstCard.locator(".platform-badge")).toBeVisible();
      await expect(firstCard.locator(".card-url")).toBeVisible();
      await expect(firstCard.locator(".claim-count")).toBeVisible();
    } else {
      await expect(page.locator(".empty-state")).toBeVisible();
    }
  });
});
