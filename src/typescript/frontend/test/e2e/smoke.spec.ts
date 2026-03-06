/**
 * Frontend smoke tests.
 *
 * These verify that the built SvelteKit app starts, renders pages, and
 * navigates correctly. The webServer config in playwright.config.ts starts
 * the production build with a dummy API_BASE_URL pointing to a port that
 * nothing listens on — so the corrections page shows the error state rather
 * than real data. This is intentional: these tests verify the frontend
 * application itself, not the API.
 *
 * For post-deploy validation against the real API, see the separate
 * `post-deploy-smoke` CI job which hits the live URL.
 */

import { test, expect } from "@playwright/test";

const EXPECTED_EXTENSION_URL =
  "https://chromewebstore.google.com/detail/openerrata/iflopmpcoifkihfimncdjkokibdfkkbd";

test.describe("Landing page", () => {
  test("renders hero and key sections", async ({ page }) => {
    await page.goto("/");

    // Hero heading
    await expect(page.locator("h1")).toContainText("Fact-check what you read");

    // Key sections are present
    await expect(page.locator("text=Unimpeachable results")).toBeVisible();
    await expect(page.locator("text=Fully transparent")).toBeVisible();
    await expect(page.locator("text=Non-intrusive")).toBeVisible();

    // How it works section
    await expect(page.locator("text=How it works")).toBeVisible();
    await expect(page.locator("text=You browse normally")).toBeVisible();

    // Supported platforms
    await expect(page.locator("text=LessWrong")).toBeVisible();
    await expect(page.locator("text=X (Twitter)")).toBeVisible();
  });

  test("has correct page title", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/OpenErrata/);
  });

  test("nav bar has expected links", async ({ page }) => {
    await page.goto("/");

    const nav = page.locator("nav");
    await expect(nav.getByText("OpenErrata")).toBeVisible();
    await expect(nav.getByText("Corrections")).toBeVisible();
    await expect(nav.getByText("GitHub")).toBeVisible();
    await expect(nav.getByText("Install Extension")).toBeVisible();
    await expect(nav.getByRole("link", { name: "Install Extension" })).toHaveAttribute(
      "href",
      EXPECTED_EXTENSION_URL,
    );
    await expect(page.getByRole("link", { name: "Install for Chrome" })).toHaveAttribute(
      "href",
      EXPECTED_EXTENSION_URL,
    );
  });
});

test.describe("Corrections page", () => {
  test("renders search UI and handles API unavailability", async ({ page }) => {
    await page.goto("/corrections");

    await expect(page).toHaveTitle(/Corrections/);

    // Search bar elements
    await expect(page.locator('input[name="q"]')).toBeVisible();
    await expect(page.locator('select[name="platform"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();

    // API is unreachable, so either error state or empty state appears
    const errorOrEmpty = page.locator(".error-state, .empty-state");
    await expect(errorOrEmpty).toBeVisible();
  });

  test("nav bar is consistent with landing page", async ({ page }) => {
    await page.goto("/corrections");

    const nav = page.locator("nav");
    await expect(nav.getByText("OpenErrata")).toBeVisible();
    await expect(nav.getByText("Corrections")).toBeVisible();
    await expect(nav.getByText("Install Extension")).toBeVisible();
    await expect(nav.getByRole("link", { name: "Install Extension" })).toHaveAttribute(
      "href",
      EXPECTED_EXTENSION_URL,
    );
  });
});

test.describe("Navigation", () => {
  test("can navigate from landing to corrections via nav link", async ({ page }) => {
    await page.goto("/");
    await page.locator("nav").getByText("Corrections").click();
    await expect(page).toHaveURL(/\/corrections/);
    await expect(page.locator("h1")).toContainText("Latest Corrections");
  });

  test("can navigate from corrections to landing via logo", async ({ page }) => {
    await page.goto("/corrections");
    await page.locator("nav").getByText("OpenErrata").click();
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe("Health endpoint", () => {
  test("returns ok", async ({ request }) => {
    const response = await request.get("/health");
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});
