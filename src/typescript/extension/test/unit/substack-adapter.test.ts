import assert from "node:assert/strict";
import { test } from "node:test";
import { substackAdapter } from "../../src/content/adapters/substack.js";
import { assertNotReady, assertReady, withWindow } from "../helpers/adapter-harness.js";

test("Substack adapter returns missing_identity when slug is absent", () => {
  const result = withWindow(
    "https://example.substack.com/",
    "<!doctype html><html><body></body></html>",
    (document) => substackAdapter.extract(document),
  );

  assertNotReady(result, "missing_identity");
});

test("Substack adapter returns hydrating when content root is missing", () => {
  const result = withWindow(
    "https://example.substack.com/p/test-post",
    `
      <!doctype html>
      <html>
        <head>
          <meta name="author" content="Example Author" />
        </head>
        <body>
          <h1 class="post-title">Test Post</h1>
        </body>
      </html>
    `,
    (document) => substackAdapter.extract(document),
  );

  assertNotReady(result, "hydrating");
});

test("Substack adapter returns missing_identity when post id cannot be proven", () => {
  const result = withWindow(
    "https://example.substack.com/p/test-post",
    `
      <!doctype html>
      <html>
        <head>
          <meta name="author" content="Example Author" />
        </head>
        <body>
          <h1 class="post-title">Test Post</h1>
          <div class="body markup">Post body text.</div>
        </body>
      </html>
    `,
    (document) => substackAdapter.extract(document),
  );

  assertNotReady(result, "missing_identity");
});

test("Substack adapter returns missing_identity when publication subdomain is unknown", () => {
  const result = withWindow(
    "https://newsletter.example.com/p/test-post",
    `
      <!doctype html>
      <html>
        <head>
          <meta name="author" content="Example Author" />
          <meta name="twitter:image" content="https://cdn.example.com/post_preview/123456/twitter.jpg" />
        </head>
        <body>
          <h1 class="post-title">Test Post</h1>
          <div class="body markup">Post body text.</div>
        </body>
      </html>
    `,
    (document) => substackAdapter.extract(document),
  );

  assertNotReady(result, "missing_identity");
});

test("Substack adapter returns ready when identity metadata is complete", () => {
  const postId = "123456";
  const result = withWindow(
    "https://example.substack.com/p/test-post",
    `
      <!doctype html>
      <html>
        <head>
          <meta name="author" content="Example Author" />
          <meta
            name="twitter:image"
            content="https://substackcdn.com/image/fetch/w_1456,c_limit,f_jpg,q_auto:good,fl_progressive:steep/https%3A%2F%2Fexample.substack.com%2Fpost_preview%2F${postId}%2Ftwitter.jpg"
          />
        </head>
        <body>
          <h1 class="post-title">Test Post</h1>
          <div class="body markup">Post body text.</div>
        </body>
      </html>
    `,
    (document) => substackAdapter.extract(document),
  );

  const ready = assertReady(result);
  assert.equal(ready.content.platform, "SUBSTACK");
  assert.equal(ready.content.externalId, postId);
  assert.equal(ready.content.metadata.slug, "test-post");
  assert.equal(ready.content.metadata.publicationSubdomain, "example");
  assert.equal(typeof ready.content.metadata.htmlContent, "string");
  assert.match(ready.content.metadata.htmlContent ?? "", /Post body text\./);
});

test("Substack adapter prefers structured published date over unrelated document time", () => {
  const postId = "123456";
  const result = withWindow(
    "https://example.substack.com/p/test-post",
    `
      <!doctype html>
      <html>
        <head>
          <meta name="author" content="Example Author" />
          <meta
            name="twitter:image"
            content="https://substackcdn.com/image/fetch/w_1456,c_limit,f_jpg,q_auto:good,fl_progressive:steep/https%3A%2F%2Fexample.substack.com%2Fpost_preview%2F${postId}%2Ftwitter.jpg"
          />
          <script type="application/ld+json">
            {
              "@type":"NewsArticle",
              "datePublished":"2025-12-03T00:00:00.000Z"
            }
          </script>
        </head>
        <body>
          <time datetime="2026-01-16T00:00:00.000Z">3h</time>
          <h1 class="post-title">Test Post</h1>
          <article>
            <div class="body markup">Post body text.</div>
          </article>
        </body>
      </html>
    `,
    (document) => substackAdapter.extract(document),
  );

  const ready = assertReady(result);
  assert.equal(ready.content.platform, "SUBSTACK");
  assert.equal(ready.content.metadata.publishedAt, "2025-12-03T00:00:00.000Z");
});

test("Substack adapter falls back to article-local time before document-global time", () => {
  const postId = "123456";
  const result = withWindow(
    "https://example.substack.com/p/test-post",
    `
      <!doctype html>
      <html>
        <head>
          <meta name="author" content="Example Author" />
          <meta
            name="twitter:image"
            content="https://substackcdn.com/image/fetch/w_1456,c_limit,f_jpg,q_auto:good,fl_progressive:steep/https%3A%2F%2Fexample.substack.com%2Fpost_preview%2F${postId}%2Ftwitter.jpg"
          />
        </head>
        <body>
          <time datetime="2026-01-16T00:00:00.000Z">3h</time>
          <h1 class="post-title">Test Post</h1>
          <article>
            <time datetime="2025-12-03T00:00:00.000Z">Dec 3</time>
            <div class="body markup">Post body text.</div>
          </article>
        </body>
      </html>
    `,
    (document) => substackAdapter.extract(document),
  );

  const ready = assertReady(result);
  assert.equal(ready.content.platform, "SUBSTACK");
  assert.equal(ready.content.metadata.publishedAt, "2025-12-03T00:00:00.000Z");
});

test("Substack adapter preserves word boundaries across adjacent block elements", () => {
  const postId = "123456";
  const result = withWindow(
    "https://example.substack.com/p/test-post",
    `
      <!doctype html>
      <html>
        <head>
          <meta name="author" content="Example Author" />
          <meta
            name="twitter:image"
            content="https://substackcdn.com/image/fetch/w_1456,c_limit,f_jpg,q_auto:good,fl_progressive:steep/https%3A%2F%2Fexample.substack.com%2Fpost_preview%2F${postId}%2Ftwitter.jpg"
          />
        </head>
        <body>
          <h1 class="post-title">Test Post</h1>
          <div class="body markup"><p>Alpha</p><p>Beta</p><div>Gamma</div></div>
        </body>
      </html>
    `,
    (document) => substackAdapter.extract(document),
  );

  const ready = assertReady(result);
  assert.equal(ready.content.platform, "SUBSTACK");
  assert.equal(ready.content.contentText, "Alpha Beta Gamma");
});

test("Substack adapter correctly extracts publication subdomain from percent-encoded CDN image URL on custom domain", () => {
  // Custom Substack domains (e.g. astralcodexten.com) serve posts but embed the
  // publication subdomain only inside CDN image URLs like:
  //   https://substackcdn.com/.../https%3A%2F%2Fastralcodexten.substack.com%2Fpost_preview%2F...
  // decodeCandidates must try the decoded form first; applying the publication regex
  // to the raw percent-encoded string skips the `%` and captures `2fastralcodexten`
  // instead of `astralcodexten`.
  const postId = "123456";
  const result = withWindow(
    "https://www.astralcodexten.com/p/test-post",
    `
      <!doctype html>
      <html>
        <head>
          <meta name="author" content="Example Author" />
          <meta
            name="twitter:image"
            content="https://substackcdn.com/image/fetch/w_1456,c_limit,f_jpg,q_auto:good,fl_progressive:steep/https%3A%2F%2Fastralcodexten.substack.com%2Fpost_preview%2F${postId}%2Ftwitter.jpg"
          />
        </head>
        <body>
          <h1 class="post-title">Test Post</h1>
          <div class="body markup">Post body text.</div>
        </body>
      </html>
    `,
    (document) => substackAdapter.extract(document),
  );

  const ready = assertReady(result);
  assert.equal(ready.content.platform, "SUBSTACK");
  assert.equal(ready.content.externalId, postId);
  assert.equal(ready.content.metadata.publicationSubdomain, "astralcodexten");
  assert.equal(ready.content.metadata.slug, "test-post");
});

test("Substack adapter omits htmlContent when serialized HTML exceeds transport budget", () => {
  const postId = "123456";
  const oversizedParagraph = "A".repeat(300 * 1024);
  const result = withWindow(
    "https://example.substack.com/p/test-post",
    `
      <!doctype html>
      <html>
        <head>
          <meta name="author" content="Example Author" />
          <meta
            name="twitter:image"
            content="https://substackcdn.com/image/fetch/w_1456,c_limit,f_jpg,q_auto:good,fl_progressive:steep/https%3A%2F%2Fexample.substack.com%2Fpost_preview%2F${postId}%2Ftwitter.jpg"
          />
        </head>
        <body>
          <h1 class="post-title">Test Post</h1>
          <div class="body markup"><p>${oversizedParagraph}</p></div>
        </body>
      </html>
    `,
    (document) => substackAdapter.extract(document),
  );

  const ready = assertReady(result);
  assert.equal(ready.content.platform, "SUBSTACK");
  assert.equal(ready.content.metadata.htmlContent, undefined);
});

// Substack's "free unlock" paywall (seen on noahpinion.blog, 2026-10) uses
// none of the usual paywall wording; paid-only posts are recognizable by
// their JSON-LD `isAccessibleForFree: false`.
function substackPostWithJsonLd(isAccessibleForFree: boolean): string {
  return `
    <!doctype html>
    <html>
      <head>
        <meta name="author" content="Noah Smith" />
        <script type="application/ld+json">${JSON.stringify({
          "@context": "https://schema.org",
          "@type": "NewsArticle",
          headline: "A paid post",
          isAccessibleForFree,
        })}</script>
      </head>
      <body>
        <h1 class="post-title">A paid post</h1>
        <div class="body markup"><p>The preview paragraphs everyone can read.</p></div>
        <div class="paywall" data-testid="paywall">
          Continue reading this post for free, courtesy of Noah Smith.
          <button>Claim my free post</button> Or purchase a paid subscription.
        </div>
      </body>
    </html>`;
}

test("Substack adapter treats posts declared not accessible for free as private_or_gated", () => {
  const gated = withWindow(
    "https://www.noahpinion.blog/p/a-paid-post",
    substackPostWithJsonLd(false),
    (document) => substackAdapter.detectPrivateOrGated?.(document),
  );
  assert.equal(gated, true);
});

test("Substack adapter does not gate posts declared accessible for free", () => {
  const gated = withWindow(
    "https://garymarcus.substack.com/p/a-public-post",
    substackPostWithJsonLd(true).replace(/<div class="paywall"[\s\S]*?<\/div>/, ""),
    (document) => substackAdapter.detectPrivateOrGated?.(document),
  );
  assert.equal(gated, false);
});

// Trimmed from public garymarcus.substack.com and noahpinion.blog posts
// (2026-10): the post body holds Substack editor components besides the
// author's prose — a subscribe form, a share button, an embedded tweet card
// (avatar, author, text, photo, time/views/replies footer) and cards
// embedding other posts.
const SUBSTACK_BODY_WITH_COMPONENTS = `
  <p>The FTC is finally looking at the AI labs.</p>
  <div class="captioned-image-container"><figure>
    <a class="image-link image2 is-viewable-img can-restack" data-component-name="Image2ToDOM" href="https://substackcdn.com/image/fetch/chart.png"><img src="https://substack-post-media.s3.amazonaws.com/public/images/chart.png" alt="A chart of incidents"></a>
    <figcaption class="image-caption">Incidents by month.</figcaption>
  </figure></div>
  <div data-component-name="SubscribeWidget" class="subscribe-widget"><div class="pencraft pc-display-flex pc-justifyContent-center pc-reset"><div class="container-IpPqBD"><form action="/api/v1/free?nojs=true" method="post" novalidate="" class="form form-M5sC90"><input type="hidden" name="source" value="subscribe-widget"><div class="sideBySideWrap-vGXrwP"><div class="emailInputWrapper-QlA86j"><input name="email" placeholder="Type your email..." aria-label="Email" type="email"></div><button tabindex="0" type="submit" disabled="" class="pencraft pc-reset pencraft rightButton primary subscribe-btn button-VFSdkv buttonBase-GK1x3M"><span class="button-text ">Subscribe</span></button></div></form></div></div></div>
  <a href="https://x.com/andrewcurran_/status/2105316112061599997" target="_blank" rel="noopener noreferrer" data-component-name="Twitter2ToDOM" class="pencraft pc-display-contents pc-reset"><div class="pencraft pc-display-flex pc-flexDirection-column pc-gap-12 pc-padding-16 pc-reset tweet-fWkQfo twitter-embed"><div class="pencraft pc-display-flex pc-flexDirection-row pc-gap-12 pc-alignItems-center pc-reset"><div style="--scale:40px;" class="pencraft pc-display-flex pc-width-40 pc-height-40 pc-reset container-TAtrWj"><picture><img src="https://substackcdn.com/image/fetch/$s_!aHzF!,w_40,h_40,c_fill/https%3A%2F%2Fpbs.substack.com%2Fprofile_images%2F1596945208058744833%2F_X3LT7fb.jpg" alt="X avatar for @AndrewCurran_" width="40" height="40" class="img-OACg1c pencraft pc-reset"></picture></div><div class="pencraft pc-display-flex pc-flexDirection-column pc-reset flex-grow-hUPOlM"><span class="pencraft pc-reset weight-semibold-LL37we reset-PDs18X">Andrew Curran</span><span class="pencraft pc-reset color-secondary-B3TpYa reset-PDs18X">@AndrewCurran_</span></div></div><div class="pencraft pc-reset size-15-gjMpX1 reset-PDs18X text-aFN1BV">The FTC has opened a probe into Anthropic and OpenAI, as well as other unnamed labs. </div><div class="pencraft pc-reset container-aGHQ9p"><img src="https://pbs.substack.com/media/HTeV2MCa8AANqVb.jpg" loading="lazy" class="image-c_FmAR"></div><div class="pencraft pc-display-flex pc-flexDirection-column pc-gap-8 pc-reset"><div class="pencraft pc-reset size-13-yQMlsX reset-PDs18X"><span class="pencraft pc-reset reset-PDs18X">3:17 PM · Sep 30, 2026</span><span class="pencraft pc-reset reset-PDs18X"> · </span><span class="pencraft pc-reset reset-PDs18X">14.3K Views</span></div><div data-orientation="horizontal" role="none" class="pencraft pc-display-flex pc-flexDirection-row pc-reset container-jte8en"><hr class="pencraft pc-reset divider-Ti4OTa"></div><div class="pencraft pc-reset size-13-yQMlsX reset-PDs18X"><span class="pencraft pc-reset reset-PDs18X">40 Replies</span><span class="pencraft pc-reset reset-PDs18X"> · </span><span class="pencraft pc-reset reset-PDs18X">297 Likes</span></div></div></div></a>
  <p>As I warned last year, the incidents keep coming.</p>
  <div data-component-name="DigestPostEmbed" class="digestPostEmbed-flwiST"><div class="pencraft pc-display-flex pc-flexDirection-column pc-reset"><a href="https://garymarcus.substack.com/p/llms-coding-agents-security-nightmare"><h2 class="pencraft pc-reset reset-PDs18X">LLMs + Coding Agents = Security Nightmare</h2></a><div class="pencraft pc-display-flex pc-gap-4 pc-reset"><div class="pencraft pc-reset meta-SjvJkP"><a href="https://substack.com/profile/14807526-gary-marcus">Gary Marcus</a></div><div class="pencraft pc-reset">·</div><div class="pencraft pc-reset meta-SjvJkP">August 17, 2025</div></div><div class="pencraft pc-paddingTop-24 pc-reset"><a href="https://garymarcus.substack.com/p/llms-coding-agents-security-nightmare"><picture><img src="https://substackcdn.com/image/fetch/w_1300/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F0ae63a76.heic" alt="LLMs + Coding Agents = Security Nightmare" width="1300" height="650"></picture></a></div><p class="caption-QiPycG">Last October, I wrote an essay warning about security.</p><a href="https://garymarcus.substack.com/p/llms-coding-agents-security-nightmare">Read full story</a></div></div>
  <p data-attrs="{&quot;url&quot;:&quot;https://garymarcus.substack.com/p/x?action=share&quot;,&quot;text&quot;:&quot;Share&quot;}" data-component-name="ButtonCreateButton" class="button-wrapper"><a href="https://garymarcus.substack.com/p/x?action=share" class="button primary"><span>Share</span></a></p>
  <div data-component-name="EmbeddedPostToDOM" class="embedded-post-wrap"><a native="true" href="https://www.glinert.co/p/how-trump-and-the-republicans-can?utm_source=substack&amp;utm_campaign=post_embed" class="embedded-post"><div class="embedded-post-header"><img src="https://substackcdn.com/image/fetch/w_56/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F1a5d2fa4.png" loading="lazy" class="embedded-post-publication-logo"><span class="embedded-post-publication-name">Steven’s Substack</span></div><div class="embedded-post-title-wrapper"><div class="embedded-post-title">How Trump and the Republicans can fix the CHIPS Act</div></div><div class="embedded-post-body">The CHIPS Act represents a critical step toward securing America's semiconductor industry.…</div><div class="embedded-post-cta-wrapper"><span class="embedded-post-cta">Read more</span></div><div class="embedded-post-meta">2 years ago · 4 likes · 1 comment · Steven Glinert</div></a></div>
`;

test("Substack adapter leaves calls to action and embedded tweets and posts out of the post's text and images", () => {
  const postId = "218193712";
  const result = withWindow(
    "https://garymarcus.substack.com/p/can-companies-like-openai-keep-getting",
    `
      <!doctype html>
      <html>
        <head>
          <meta name="author" content="Gary Marcus" />
          <meta name="twitter:image" content="https://substackcdn.com/image/fetch/f_jpg/https%3A%2F%2Fgarymarcus.substack.com%2Fpost_preview%2F${postId}%2Ftwitter.jpg" />
        </head>
        <body>
          <h1 class="post-title">Can companies like OpenAI keep getting away with it?</h1>
          <div class="available-content"><div class="body markup" dir="auto">${SUBSTACK_BODY_WITH_COMPONENTS}</div></div>
        </body>
      </html>
    `,
    (document) => substackAdapter.extract(document),
  );

  const ready = assertReady(result);
  assert.equal(ready.content.platform, "SUBSTACK");
  assert.equal(
    ready.content.contentText,
    "The FTC is finally looking at the AI labs. Incidents by month. As I warned last year, the incidents keep coming.",
  );
  assert.deepEqual(
    ready.content.imageOccurrences.map((image) => image.sourceUrl),
    ["https://substack-post-media.s3.amazonaws.com/public/images/chart.png"],
  );
  const htmlContent = ready.content.metadata.htmlContent ?? "";
  for (const componentText of ["Subscribe", "FTC has opened a probe", "Read full story", "Share"]) {
    assert.equal(htmlContent.includes(componentText), false, componentText);
  }
});
