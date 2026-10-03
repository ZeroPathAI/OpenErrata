/**
 * Frontend smoke tests against the production build.
 *
 * playwright.config.ts starts the built SvelteKit server with API_BASE_URL
 * pointing at test/e2e/mock-public-api.ts, which serves canned public-API
 * fixtures (including hostile values) so these tests exercise real page
 * loads, error pages and output sanitization without the API.
 *
 * For post-deploy validation against the real API, see post-deploy-smoke.spec.ts.
 */

import { test, expect, type Page } from "@playwright/test";
import {
  API_FAILURE_SEARCH_QUERY,
  GOOD_INVESTIGATION_ID,
  JAVASCRIPT_POST_URL_INVESTIGATION_ID,
} from "./public-api-fixtures.js";

const EXPECTED_EXTENSION_URL =
  "https://chromewebstore.google.com/detail/openerrata/iflopmpcoifkihfimncdjkokibdfkkbd";

function collectCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) {
      violations.push(message.text());
    }
  });
  return violations;
}

test.describe("Landing page", () => {
  test("renders hero and key sections", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("h1")).toContainText("Fact-check what you read");
    await expect(page.locator("text=Unimpeachable results")).toBeVisible();
    await expect(page.locator("text=Fully transparent")).toBeVisible();
    await expect(page.locator("text=Non-intrusive")).toBeVisible();
    await expect(page.locator("text=How it works")).toBeVisible();
    await expect(page.locator("text=You browse normally")).toBeVisible();
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
    await expect(nav.getByRole("link", { name: "Install Extension" })).toHaveAttribute(
      "href",
      EXPECTED_EXTENSION_URL,
    );
    await expect(page.getByRole("link", { name: "Install for Chrome" })).toHaveAttribute(
      "href",
      EXPECTED_EXTENSION_URL,
    );
  });

  test("is served with a CSP the page itself does not violate", async ({ page }) => {
    const violations = collectCspViolations(page);
    const response = await page.goto("/");

    const csp = response?.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("frame-ancestors 'none'");
    await page.locator("nav").getByText("Corrections").click();
    await expect(page.locator("h1")).toContainText("Latest Corrections");
    expect(violations).toEqual([]);
  });
});

test.describe("Corrections page", () => {
  test("lists corrections from the public API", async ({ page }) => {
    const response = await page.goto("/corrections");

    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/Corrections/);
    await expect(page.locator('input[name="q"]')).toBeVisible();
    await expect(page.locator('select[name="platform"]')).toBeVisible();

    const card = page.locator(".investigation-card").first();
    await expect(card).toHaveAttribute("href", `/corrections/${GOOD_INVESTIGATION_ID}`);
    await expect(card.locator(".platform-badge")).toHaveText("LessWrong");
    await expect(card).toContainText("completed in 1889, not 1899");
  });

  test("shows a 502 page without internal details when the API fails", async ({ page }) => {
    const response = await page.goto(`/corrections?q=${API_FAILURE_SEARCH_QUERY}`);

    expect(response?.status()).toBe(502);
    await expect(page.locator("h1")).toHaveText("Something went wrong");
    await expect(page.locator(".message")).toContainText("API is unavailable");
    await expect(page.locator("body")).not.toContainText("mock upstream failure");
  });

  test("rejects an unknown platform filter with a 400 page", async ({ page }) => {
    const response = await page.goto("/corrections?platform=MYSPACE");
    expect(response?.status()).toBe(400);
    await expect(page.locator(".message")).toHaveText("Unknown platform filter.");
  });
});

test.describe("Investigation page", () => {
  test("renders claims, sources and the model, without unsafe markup", async ({ page }) => {
    const response = await page.goto(`/corrections/${GOOD_INVESTIGATION_ID}`);

    expect(response?.status()).toBe(200);
    await expect(page.locator(".post-url a")).toHaveAttribute(
      "href",
      "https://www.lesswrong.com/posts/abc123/example-post",
    );
    await expect(page.locator(".claim-card")).toHaveCount(1);
    await expect(page.locator(".investigation-meta")).toContainText("Model: gpt-6.1-sol");

    await page.locator("summary", { hasText: "Full reasoning" }).click();
    const reasoning = page.locator(".reasoning");
    await expect(reasoning.locator('a[href="https://example.org/report"]')).toHaveCount(1);
    await expect(reasoning.locator("img")).toHaveCount(0);

    await page.locator("summary", { hasText: "2 sources" }).click();
    await expect(page.locator(".source-item")).toHaveCount(2);

    await expect(page.locator('[href^="javascript:" i]')).toHaveCount(0);
  });

  test("refuses to render a post whose URL is not http(s)", async ({ page }) => {
    const response = await page.goto(`/corrections/${JAVASCRIPT_POST_URL_INVESTIGATION_ID}`);

    expect(response?.status()).toBe(502);
    await expect(page.locator('[href^="javascript:" i]')).toHaveCount(0);
  });

  test("shows a 404 page for an unknown investigation", async ({ page }) => {
    const response = await page.goto("/corrections/does-not-exist");

    expect(response?.status()).toBe(404);
    await expect(page.locator("h1")).toHaveText("Not found");
    await expect(page.locator(".message")).toContainText("doesn't exist");
  });
});

test.describe("Navigation", () => {
  test("can navigate from corrections to landing via logo", async ({ page }) => {
    await page.goto("/corrections");
    await page.locator("nav").getByText("OpenErrata").click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("can open an investigation from the corrections list", async ({ page }) => {
    await page.goto("/corrections");
    await page.locator(".investigation-card").first().click();
    await expect(page).toHaveURL(new RegExp(`/corrections/${GOOD_INVESTIGATION_ID}$`));
    await expect(page.locator(".claim-card")).toHaveCount(1);
  });
});

test.describe("Health endpoint", () => {
  test("returns ok", async ({ request }) => {
    const response = await request.get("/health");
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});
