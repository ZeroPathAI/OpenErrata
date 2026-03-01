/**
 * Wikipedia browser extraction parity tests.
 *
 * These tests verify that Wikipedia article content extracted from a real
 * Chromium browser DOM (after JavaScript runs) normalizes to the same text as
 * the Wikipedia Parse API response processed by the server's
 * `wikipediaHtmlToNormalizedText`. This is the most end-to-end parity
 * check we have: it tests the same two code paths that run in production
 * (browser DOM extraction vs. server Parse API fetch) against a realistic set
 * of article structures.
 *
 * Test structure:
 *   1. Load the captured Wikipedia fixture HTML in a plain Chromium browser
 *      (no extension loaded — we are testing DOM extraction, not the full
 *      extension pipeline).
 *   2. Let the browser render the page, including running Wikipedia's JavaScript.
 *      External Wikipedia scripts load from the real Wikipedia servers so the
 *      DOM state reflects what a real browser user would see.
 *   3. Extract `#mw-content-text .mw-parser-output` outerHTML from the browser
 *      via page.evaluate(). This mirrors what the Wikipedia adapter's
 *      getContentRoot() + pruneWikipediaContent() pipeline operates on.
 *   4. In Node.js, run wikipediaHtmlToNormalizedText on both the browser
 *      outerHTML and the stored parseApiHtml.
 *   5. Assert they are equal.
 *
 * What bugs this catches:
 *   - getContentRoot() querySelector bug: returning `#mw-content-text`
 *     (parent) instead of `.mw-parser-output` (child) — the broader root
 *     includes tracking pixels, printfooter, and other non-article elements
 *     not present in the Parse API response, so the normalized texts differ.
 *   - shouldExcludeWikipediaElement gaps: any element that Wikipedia's JS
 *     injects into `.mw-parser-output` whose text content is not excluded
 *     would appear in the browser text but not the Parse API text.
 *   - Block separator injection differences between client and server paths.
 *
 * Why Wikipedia's JS runs here (networkidle):
 *   Wikipedia's JavaScript modifies `.mw-parser-output` in ways not reflected
 *   in the raw Parsoid HTML, for example:
 *   - Collapsible-section toggle buttons (`mw-collapsible-toggle`): adds
 *     "show"/"hide" text inside infobox rows.
 *   - TimedMediaHandler video player (`mw-tmh-player`): adds duration labels
 *     and time display for embedded video/audio.
 *   Both of these are excluded by `shouldExcludeWikipediaElement`. Running
 *   with networkidle enforces that invariant and catches new JS additions that
 *   are not yet excluded.
 */

import { chromium, test, expect } from "@playwright/test";
import { wikipediaHtmlToNormalizedText } from "../../../api/src/lib/services/content-fetcher.js";
import { E2E_WIKIPEDIA_FIXTURE_KEYS, readE2eWikipediaFixture } from "./wikipedia-fixtures.js";

for (const fixtureKey of Object.values(E2E_WIKIPEDIA_FIXTURE_KEYS)) {
  test(`Wikipedia browser DOM extraction matches Parse API for ${fixtureKey}`, async () => {
    const fixture = await readE2eWikipediaFixture(fixtureKey);

    // Launch a plain Chromium browser — no extension installed. We are
    // testing DOM extraction logic, not the full extension pipeline.
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();

    // Serve the captured fixture HTML for the Wikipedia article URL.
    // External resources (Wikipedia JS, CSS, images) are allowed to load
    // from the real Wikipedia servers so that JavaScript runs and modifies
    // the DOM as it would in a real browser session. This makes the test
    // sensitive to JS-injected DOM changes that could affect text extraction.
    await context.route(`${fixture.sourceUrl}**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: fixture.html,
      });
    });

    const page = await context.newPage();

    try {
      // networkidle: wait for Wikipedia's JavaScript to finish running so the
      // DOM reflects the fully-rendered state a real browser user sees.
      await page.goto(fixture.sourceUrl, { waitUntil: "networkidle" });

      // Extract the content root's outer HTML from the live browser DOM.
      // This is the same selector used by getContentRoot() in the Wikipedia
      // adapter after our querySelector fix (prefer .mw-parser-output over
      // the broader #mw-content-text).
      const browserHtml = await page.evaluate(() => {
        const root =
          document.querySelector("#mw-content-text .mw-parser-output") ??
          document.querySelector("#mw-content-text");
        return root?.outerHTML ?? "";
      });

      expect(browserHtml.length, "Expected browser to find .mw-parser-output").toBeGreaterThan(0);

      const browserText = wikipediaHtmlToNormalizedText(browserHtml);
      const parseApiText = wikipediaHtmlToNormalizedText(fixture.parseApiHtml);

      expect(browserText.length, "Browser-extracted text must not be empty").toBeGreaterThan(0);
      expect(parseApiText.length, "Parse API text must not be empty").toBeGreaterThan(0);

      // The two texts must match exactly. Any difference means the browser
      // DOM includes content that the server's Parse API does not (or vice
      // versa), which indicates either:
      //   - An extraction bug (wrong root selector, wrong exclusion logic), or
      //   - A new Wikipedia JS-injected element that should be added to
      //     shouldExcludeWikipediaElement in shared/src/wikipedia-canonicalization.ts.
      expect(browserText).toEqual(parseApiText);
    } finally {
      await context.close();
      await browser.close();
    }
  });
}
