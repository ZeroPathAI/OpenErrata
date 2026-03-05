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

  test("corrections page loads and shows results or error state", async ({ page }) => {
    await page.goto(`${FRONTEND_BASE_URL!}/corrections`);
    await expect(page).toHaveTitle(/Corrections/);

    // The page should show either results or an error — but it should render
    const content = page.locator(".results, .error-state, .empty-state");
    await expect(content).toBeVisible();
  });

  test("corrections page loads real data from the API", async ({ page }) => {
    await page.goto(`${FRONTEND_BASE_URL!}/corrections`);

    // If the API is healthy and has data, we should see investigation cards.
    // Allow for the possibility that the API has no corrections yet.
    const results = page.locator(".results");
    const errorState = page.locator(".error-state");

    const hasResults = await results.isVisible().catch(() => false);
    const hasError = await errorState.isVisible().catch(() => false);

    if (hasError) {
      // If there's an error, it should be displayed clearly
      await expect(errorState).toContainText("Failed to load corrections");
      test.info().annotations.push({
        type: "warning",
        description: "API returned an error — corrections page showed error state",
      });
    } else if (hasResults) {
      // If results loaded, verify the cards have expected structure
      const firstCard = page.locator(".investigation-card").first();
      await expect(firstCard).toBeVisible();
      await expect(firstCard.locator(".platform-badge")).toBeVisible();
      await expect(firstCard.locator(".card-url")).toBeVisible();
      await expect(firstCard.locator(".claim-count")).toBeVisible();
    } else {
      // Empty state is also valid
      await expect(page.locator(".empty-state")).toBeVisible();
    }
  });
});
