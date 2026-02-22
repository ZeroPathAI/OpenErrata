import assert from "node:assert/strict";
import { test } from "node:test";
import { getAdapter } from "../../src/content/adapters/index";
import {
  isSupportedPostUrl,
  parseSupportedPageIdentity,
} from "../../src/lib/post-identity";
import { isSubstackPostPathUrl } from "../../src/popup/status-identity";

type SupportedCase = {
  url: string;
  platform: "LESSWRONG" | "X" | "SUBSTACK";
  externalId: string;
};

const supportedCases: SupportedCase[] = [
  {
    url: "https://www.lesswrong.com/posts/qefrWyeiMvWEFRitN",
    platform: "LESSWRONG",
    externalId: "qefrWyeiMvWEFRitN",
  },
  {
    url: "https://www.lesswrong.com/posts/qefrWyeiMvWEFRitN/",
    platform: "LESSWRONG",
    externalId: "qefrWyeiMvWEFRitN",
  },
  {
    url: "https://www.lesswrong.com/posts/qefrWyeiMvWEFRitN/be-skeptical",
    platform: "LESSWRONG",
    externalId: "qefrWyeiMvWEFRitN",
  },
  {
    url: "https://www.lesswrong.com/posts/qefrWyeiMvWEFRitN?commentId=abc",
    platform: "LESSWRONG",
    externalId: "qefrWyeiMvWEFRitN",
  },
  {
    url: "https://x.com/example/status/1234567890123456789",
    platform: "X",
    externalId: "1234567890123456789",
  },
  {
    url: "https://x.com/i/web/status/1234567890123456789",
    platform: "X",
    externalId: "1234567890123456789",
  },
  {
    url: "https://x.com/i/status/1234567890123456789",
    platform: "X",
    externalId: "1234567890123456789",
  },
  {
    url: "https://astralcodexten.substack.com/p/example-post",
    platform: "SUBSTACK",
    externalId: "example-post",
  },
];

const unsupportedUrls = [
  "https://www.lesswrong.com/",
  "https://www.lesswrong.com/posts",
  "https://x.com/home",
  "https://x.com/compose/post",
  "https://example.com/i/status/1234567890123456789",
  "https://example.com/openerrata/status/1234567890123456789",
];

test("supported post URL identity parser and adapter matching stay aligned", () => {
  for (const supported of supportedCases) {
    const parsed = parseSupportedPageIdentity(supported.url);
    assert.deepEqual(parsed, {
      platform: supported.platform,
      externalId: supported.externalId,
    });
    assert.equal(isSupportedPostUrl(supported.url), true);

    const adapter = getAdapter(supported.url);
    assert.notEqual(adapter, null);
    assert.equal(adapter?.platformKey, supported.platform);
  }
});

test("unsupported URLs are rejected consistently", () => {
  for (const url of unsupportedUrls) {
    assert.equal(parseSupportedPageIdentity(url), null);
    assert.equal(isSupportedPostUrl(url), false);
    assert.equal(getAdapter(url), null);
  }
});

test("custom-domain Substack post paths stay eligible for non-identity matching", () => {
  const customDomainSubstackUrl = "https://astralcodexten.com/p/example-post";
  assert.equal(parseSupportedPageIdentity(customDomainSubstackUrl), null);
  assert.equal(isSupportedPostUrl(customDomainSubstackUrl), false);
  assert.equal(getAdapter(customDomainSubstackUrl), null);
  assert.equal(isSubstackPostPathUrl(customDomainSubstackUrl), true);
});
