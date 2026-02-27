import assert from "node:assert/strict";
import { test } from "node:test";
import { xAdapter } from "../../src/content/adapters/x.js";
import { assertReady, withWindow } from "../helpers/adapter-harness.js";

test("X adapter keeps contentText scoped to tweetText while preserving image occurrences", () => {
  const tweetId = "1900000000000000000";
  const result = withWindow(
    `https://x.com/example/status/${tweetId}`,
    `
      <!doctype html>
      <html>
        <body>
          <article>
            <a href="/example/status/${tweetId}">Permalink</a>
            <div data-testid="User-Name">
              <span>Example User</span>
              <span>@example</span>
            </div>
            <div data-testid="tweetText">Hello world from tweet body.</div>
            <div>12 Likes</div>
            <div data-testid="tweetPhoto">
              <img src="/media/one.jpg" alt="first photo" />
            </div>
            <time datetime="2026-02-27T01:02:03.000Z">now</time>
          </article>
        </body>
      </html>
    `,
    (document) => xAdapter.extract(document),
  );

  const ready = assertReady(result);
  assert.equal(ready.content.platform, "X");
  assert.equal(ready.content.contentText, "Hello world from tweet body.");
  assert.equal(ready.content.contentText.includes("12 Likes"), false);
  assert.equal(ready.content.mediaState, "has_images");
  assert.deepEqual(ready.content.imageUrls, ["https://x.com/media/one.jpg"]);
  assert.deepEqual(ready.content.imageOccurrences, [
    {
      originalIndex: 0,
      normalizedTextOffset: "Hello world from tweet body.".length,
      sourceUrl: "https://x.com/media/one.jpg",
      captionText: "first photo",
    },
  ]);
  assert.equal(ready.content.metadata.text, "Hello world from tweet body.");
});
