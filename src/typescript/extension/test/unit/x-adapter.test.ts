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
  assert.equal(ready.content.hasVideo, false);
  assert.deepEqual(
    ready.content.imageOccurrences.map((occurrence) => occurrence.sourceUrl),
    ["https://x.com/media/one.jpg"],
  );
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

// Logged-out x.com (2026-10) serves a frontend without any data-testid
// attributes: each tweet is a bare <article>, the tweet text is a
// `div[dir="auto"]` after the author header, and replies or quote tweets that
// reference the target also link to its permalink. These fixtures mirror the
// structure captured from x.com/TheEllenShow/status/440322224407314432.
function loggedOutArticle(input: {
  handle: string;
  name: string;
  statusId: string;
  text: string;
  quotedStatusPath?: string;
  photo?: string;
}): string {
  return `
    <article class="flex flex-col gap-1">
      <div class="flex gap-2">
        <a class="x-link" href="/${input.handle}">
          <div class="x-avatar"><img alt="@${input.handle}" src="https://pbs.twimg.com/profile_images/1/${input.handle}_normal.jpg"></div>
        </a>
        <div class="flex min-w-0 flex-1 flex-col">
          <a class="x-link" href="/${input.handle}"><div class="text-body font-bold">${input.name}</div></a>
          <a class="x-link" href="/${input.handle}"><span>@${input.handle}</span></a>
          <div class="max-w-full whitespace-pre-wrap" dir="auto">${input.text}</div>
          ${
            input.photo === undefined
              ? ""
              : `<a href="/${input.handle}/status/${input.statusId}/photo/1"><img alt="Image" src="${input.photo}"></a>`
          }
          ${input.quotedStatusPath === undefined ? "" : `<a href="${input.quotedStatusPath}"><div dir="auto">The Ellen Show</div></a>`}
          <a href="/${input.handle}/status/${input.statusId}">7:06 PM · Mar 2, 2014</a>
          <div>158K</div>
        </div>
      </div>
    </article>`;
}

test("X adapter extracts the target tweet from the logged-out frontend, ignoring replies that link to it", () => {
  const tweetId = "440322224407314432";
  const result = withWindow(
    `https://x.com/TheEllenShow/status/${tweetId}`,
    `<!doctype html><html><body><main>
      ${loggedOutArticle({
        handle: "TheEllenShow",
        name: "The Ellen Show",
        statusId: tweetId,
        text: "If only Bradley's arm was longer. Best photo ever. #oscars",
        photo: "https://pbs.twimg.com/media/BhxWutnCEAAtEQ6?format=webp&name=large",
      })}
      ${loggedOutArticle({
        handle: "KevinSpacey",
        name: "Kevin Spacey",
        statusId: "440338760480198657",
        text: "My photobombing gets better and better! @TheEllenShow #oscars",
        quotedStatusPath: `/TheEllenShow/status/${tweetId}`,
      })}
    </main></body></html>`,
    (document) => xAdapter.extract(document),
  );

  const ready = assertReady(result);
  if (ready.content.platform !== "X") throw new Error("expected an X post");
  assert.equal(ready.content.externalId, tweetId);
  assert.equal(
    ready.content.contentText,
    "If only Bradley's arm was longer. Best photo ever. #oscars",
  );
  assert.deepEqual(
    ready.content.imageOccurrences.map((occurrence) => occurrence.sourceUrl),
    ["https://pbs.twimg.com/media/BhxWutnCEAAtEQ6?format=webp&name=large"],
    "the photo is an image of the post; the author's avatar is not",
  );
  assert.equal(ready.content.metadata.authorHandle, "TheEllenShow");
  assert.equal(ready.content.metadata.authorDisplayName, null);
});

test("X adapter reads an anonymous status URL on the logged-out frontend", () => {
  const result = withWindow(
    "https://x.com/i/status/20",
    `<!doctype html><html><body><main>
      ${loggedOutArticle({ handle: "jack", name: "jack", statusId: "20", text: "just setting up my twttr" })}
    </main></body></html>`,
    (document) => xAdapter.extract(document),
  );

  const ready = assertReady(result);
  if (ready.content.platform !== "X") throw new Error("expected an X post");
  assert.equal(ready.content.contentText, "just setting up my twttr");
  assert.equal(ready.content.metadata.authorHandle, "jack");
});

test("X adapter stays ambiguous when several articles link to the status and the URL names no author", () => {
  const tweetId = "440322224407314432";
  const result = withWindow(
    `https://x.com/i/status/${tweetId}`,
    `<!doctype html><html><body><main>
      ${loggedOutArticle({ handle: "TheEllenShow", name: "The Ellen Show", statusId: tweetId, text: "Original" })}
      ${loggedOutArticle({
        handle: "KevinSpacey",
        name: "Kevin Spacey",
        statusId: "440338760480198657",
        text: "Reply",
        quotedStatusPath: `/TheEllenShow/status/${tweetId}`,
      })}
    </main></body></html>`,
    (document) => xAdapter.extract(document),
  );

  assert.equal(result.kind === "not_ready" && result.reason, "ambiguous_dom");
});
