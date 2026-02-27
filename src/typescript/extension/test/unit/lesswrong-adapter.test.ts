import assert from "node:assert/strict";
import { test } from "node:test";
import { lesswrongAdapter } from "../../src/content/adapters/lesswrong.js";
import { assertNotReady, assertReady, withWindow } from "../helpers/adapter-harness.js";

test("LessWrong adapter reads author from post header instead of global /users links", () => {
  const result = withWindow(
    "https://www.lesswrong.com/posts/abcd1234/the-ml-ontology-and-the-alignment-ontology",
    `
      <!doctype html>
      <html>
        <body>
          <a href="/users/lc">lc</a>
          <h1>The ML ontology and the alignment ontology</h1>
          <div id="postBody">
            <div class="LWPostsPageHeader-authorInfo">
              by
              <span class="PostsAuthors-authorName">
                <a href="/users/richard_ngo?from=post_header">Richard_Ngo</a>
              </span>
            </div>
            <div class="PostsPage-postContent">
              <div id="postContent"><p>Post body text.</p></div>
            </div>
          </div>
        </body>
      </html>
    `,
    (document) => lesswrongAdapter.extract(document),
  );

  const extracted = assertReady(result).content;
  assert.equal(extracted.platform, "LESSWRONG");
  assert.equal(extracted.metadata.authorName, "Richard_Ngo");
  assert.equal(extracted.metadata.authorSlug, "richard_ngo");
});

test("LessWrong adapter omits author metadata when no post-header author exists", () => {
  const result = withWindow(
    "https://www.lesswrong.com/posts/abcd1234/post-without-header-author",
    `
      <!doctype html>
      <html>
        <body>
          <a href="/users/lc">lc</a>
          <h1>Post without header author</h1>
          <div id="postBody">
            <div class="PostsPage-postContent">
              <div id="postContent"><p>Post body text.</p></div>
            </div>
          </div>
        </body>
      </html>
    `,
    (document) => lesswrongAdapter.extract(document),
  );

  const extracted = assertReady(result).content;
  assert.equal(extracted.platform, "LESSWRONG");
  assert.equal(extracted.metadata.authorSlug, null);
  assert.equal(extracted.metadata.authorName, undefined);
});

test("LessWrong adapter versioning HTML uses #postContent and strips linkpost callout", () => {
  const result = withWindow(
    "https://www.lesswrong.com/posts/abcd1234/canonical-html-test",
    `
      <!doctype html>
      <html>
        <body>
          <h1>Canonical HTML test</h1>
          <div id="postBody">
            <div class="LWPostsPageHeader-authorInfo">
              <span class="PostsAuthors-authorName">
                <a href="/users/example_author">Example Author</a>
              </span>
            </div>
            <div class="PostsPage-postContent">
              <div class="LinkPostMessage-root">outside callout</div>
              <div id="postContent">
                <div class="LinkPostMessage-root">inside callout</div>
                <p>Canonical paragraph.</p>
              </div>
              <p>non-canonical sibling text</p>
            </div>
          </div>
        </body>
      </html>
    `,
    (document) => lesswrongAdapter.extract(document),
  );

  const extracted = assertReady(result).content;
  assert.equal(extracted.platform, "LESSWRONG");
  assert.match(extracted.metadata.htmlContent, /Canonical paragraph\./);
  assert.doesNotMatch(extracted.metadata.htmlContent, /non-canonical sibling text/);
  assert.doesNotMatch(extracted.metadata.htmlContent, /inside callout/);
  assert.doesNotMatch(extracted.metadata.htmlContent, /outside callout/);
});

test("LessWrong adapter reports hydrating until #postContent is available", () => {
  const result = withWindow(
    "https://www.lesswrong.com/posts/abcd1234/no-post-content-id-yet",
    `
      <!doctype html>
      <html>
        <body>
          <h1>Pending hydrate post</h1>
          <div id="postBody">
            <div class="LWPostsPageHeader-authorInfo">
              <span class="PostsAuthors-authorName">
                <a href="/users/example_author">Example Author</a>
              </span>
            </div>
            <div class="PostsPage-postContent">
              <p>Rendered text exists but canonical #postContent is not ready yet.</p>
            </div>
          </div>
        </body>
      </html>
    `,
    (document) => lesswrongAdapter.extract(document),
  );

  assertNotReady(result, "hydrating");
});

test("LessWrong adapter selects content root whose JSON-LD matches current post id", () => {
  const result = withWindow(
    "https://www.lesswrong.com/posts/newPost123/current-post",
    `
      <!doctype html>
      <html>
        <body>
          <div id="postBody">
            <script type="application/ld+json">
              {"url":"https://www.lesswrong.com/posts/oldPost456/previous-post"}
            </script>
            <div class="LWPostsPageHeader-authorInfo">
              <span class="PostsAuthors-authorName">
                <a href="/users/old_author">Old Author</a>
              </span>
            </div>
            <div class="PostsPage-postContent" style="display:none">
              <div id="postContent">
                <p>Old post body text.</p>
              </div>
            </div>
          </div>

          <div id="postBody">
            <script type="application/ld+json">
              {"url":"https://www.lesswrong.com/posts/newPost123/current-post"}
            </script>
            <div class="LWPostsPageHeader-authorInfo">
              <span class="PostsAuthors-authorName">
                <a href="/users/new_author">New Author</a>
              </span>
            </div>
            <div class="PostsPage-postContent">
              <div id="postContent">
                <p>New post body text.</p>
              </div>
            </div>
          </div>
        </body>
      </html>
    `,
    (document) => lesswrongAdapter.extract(document),
  );

  const extracted = assertReady(result).content;
  assert.equal(extracted.platform, "LESSWRONG");
  assert.equal(extracted.metadata.authorName, "New Author");
  assert.equal(extracted.metadata.authorSlug, "new_author");
  assert.match(extracted.metadata.htmlContent, /New post body text\./);
  assert.doesNotMatch(extracted.metadata.htmlContent, /Old post body text\./);
});

test("LessWrong adapter reports ambiguous_dom when multiple visible roots match", () => {
  const result = withWindow(
    "https://www.lesswrong.com/posts/newPost123/current-post",
    `
      <!doctype html>
      <html>
        <body>
          <div id="postBody">
            <div class="LWPostsPageHeader-authorInfo">
              <span class="PostsAuthors-authorName">
                <a href="/users/first_author">First Author</a>
              </span>
            </div>
            <div class="PostsPage-postContent">
              <div id="postContent">
                <p>First visible body.</p>
              </div>
            </div>
          </div>

          <div id="postBody">
            <div class="LWPostsPageHeader-authorInfo">
              <span class="PostsAuthors-authorName">
                <a href="/users/second_author">Second Author</a>
              </span>
            </div>
            <div class="PostsPage-postContent">
              <div id="postContent">
                <p>Second visible body.</p>
              </div>
            </div>
          </div>
        </body>
      </html>
    `,
    (document) => lesswrongAdapter.extract(document),
  );

  assertNotReady(result, "ambiguous_dom");
});

test("LessWrong adapter reports hydrating while single canonical root is hidden", () => {
  const result = withWindow(
    "https://www.lesswrong.com/posts/newPost123/current-post",
    `
      <!doctype html>
      <html>
        <body>
          <div id="postBody">
            <script type="application/ld+json">
              {"url":"https://www.lesswrong.com/posts/newPost123/current-post"}
            </script>
            <div class="LWPostsPageHeader-authorInfo">
              <span class="PostsAuthors-authorName">
                <a href="/users/new_author">New Author</a>
              </span>
            </div>
            <div class="PostsPage-postContent" style="display:none">
              <div id="postContent">
                <p>Hidden pre-hydration body.</p>
              </div>
            </div>
          </div>
        </body>
      </html>
    `,
    (document) => lesswrongAdapter.extract(document),
  );

  assertNotReady(result, "hydrating");
});

test("LessWrong adapter prefers post JSON-LD published date over unrelated document time", () => {
  const result = withWindow(
    "https://www.lesswrong.com/posts/newPost123/current-post",
    `
      <!doctype html>
      <html>
        <body>
          <time datetime="2026-01-16T00:00:00.000Z">3h</time>
          <div id="postBody">
            <script type="application/ld+json">
              {
                "url":"https://www.lesswrong.com/posts/newPost123/current-post",
                "datePublished":"2025-12-03T00:00:00.000Z"
              }
            </script>
            <div class="LWPostsPageHeader-authorInfo">
              <span class="PostsAuthors-authorName">
                <a href="/users/new_author">New Author</a>
              </span>
            </div>
            <div class="PostsPage-postContent">
              <div id="postContent">
                <p>New post body text.</p>
              </div>
            </div>
          </div>
        </body>
      </html>
    `,
    (document) => lesswrongAdapter.extract(document),
  );

  const extracted = assertReady(result).content;
  assert.equal(extracted.platform, "LESSWRONG");
  assert.equal(extracted.metadata.publishedAt, "2025-12-03T00:00:00.000Z");
});
