import assert from "node:assert/strict";
import { test } from "node:test";
import { SUPPORTED_IMAGE_MIME_TYPE_VALUES } from "@openerrata/shared";
import { parseImageContentType } from "../../src/lib/services/image-downloader.js";

test("parseImageContentType accepts image/jpeg", () => {
  assert.equal(parseImageContentType("image/jpeg"), "image/jpeg");
});

test("parseImageContentType accepts image/png", () => {
  assert.equal(parseImageContentType("image/png"), "image/png");
});

test("parseImageContentType accepts image/gif", () => {
  assert.equal(parseImageContentType("image/gif"), "image/gif");
});

test("parseImageContentType accepts image/webp", () => {
  assert.equal(parseImageContentType("image/webp"), "image/webp");
});

test("parseImageContentType strips Content-Type parameters", () => {
  assert.equal(parseImageContentType("image/jpeg; charset=utf-8"), "image/jpeg");
  assert.equal(parseImageContentType("image/png; boundary=something"), "image/png");
});

test("parseImageContentType case-normalizes uppercase headers", () => {
  assert.equal(parseImageContentType("IMAGE/JPEG"), "image/jpeg");
  assert.equal(parseImageContentType("Image/Png"), "image/png");
  assert.equal(parseImageContentType("IMAGE/GIF; charset=utf-8"), "image/gif");
});

test("parseImageContentType rejects SVG", () => {
  assert.equal(parseImageContentType("image/svg+xml"), null);
});

test("parseImageContentType rejects TIFF", () => {
  assert.equal(parseImageContentType("image/tiff"), null);
});

test("parseImageContentType rejects BMP", () => {
  assert.equal(parseImageContentType("image/bmp"), null);
});

test("parseImageContentType rejects application/pdf", () => {
  assert.equal(parseImageContentType("application/pdf"), null);
});

test("parseImageContentType rejects text/html", () => {
  assert.equal(parseImageContentType("text/html"), null);
});

test("parseImageContentType rejects null", () => {
  assert.equal(parseImageContentType(null), null);
});

test("parseImageContentType rejects empty string", () => {
  assert.equal(parseImageContentType(""), null);
});

test("every SUPPORTED_IMAGE_MIME_TYPE_VALUES entry is accepted", () => {
  for (const mimeType of SUPPORTED_IMAGE_MIME_TYPE_VALUES) {
    assert.equal(parseImageContentType(mimeType), mimeType, `Expected ${mimeType} to be accepted`);
  }
});
