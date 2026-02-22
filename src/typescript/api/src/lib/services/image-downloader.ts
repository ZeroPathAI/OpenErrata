import { createHash } from "node:crypto";
import { MAX_IMAGE_BYTES } from "@openerrata/shared";
import { prisma } from "$lib/db/client.js";
import { isUniqueConstraintError } from "$lib/db/errors.js";
import type { ImageBlob } from "$lib/generated/prisma/client";
import {
  hasAddressIntersection,
  resolvePublicHostAddresses,
} from "$lib/network/host-safety.js";
import { uploadImage } from "./blob-storage.js";

const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_REDIRECT_HOPS = 5;

function parseImageContentType(contentTypeHeader: string | null): string | null {
  if (!contentTypeHeader) return null;
  const normalized = contentTypeHeader.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!normalized.startsWith("image/")) return null;
  return normalized;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function uniqueImageUrls(urls: string[]): string[] {
  const unique = new Set<string>();

  for (const url of urls) {
    const trimmed = url.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      if (parsed.username || parsed.password) continue;
      unique.add(parsed.toString());
    } catch {
      // Ignore malformed image URLs to keep investigation flow robust.
    }
  }

  return Array.from(unique);
}

async function readResponseBytesWithinLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!response.body) {
    return null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("Image exceeds maximum byte limit");
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel();
    return null;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

async function downloadImage(
  url: string,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  try {
    let currentUrl = new URL(url);

    for (let redirectHop = 0; redirectHop <= MAX_REDIRECT_HOPS; redirectHop += 1) {
      if (currentUrl.protocol !== "http:" && currentUrl.protocol !== "https:") {
        return null;
      }
      const resolvedBeforeRequest = await resolvePublicHostAddresses(
        currentUrl.hostname,
      );
      if (!resolvedBeforeRequest) {
        return null;
      }

      const response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
        headers: {
          "User-Agent": "OpenErrataImageDownloader/1.0 (+https://openerrata.com)",
          Accept: "image/*",
        },
      });

      if (isRedirectStatus(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          return null;
        }

        currentUrl = new URL(location, currentUrl);
        continue;
      }

      if (!response.ok) {
        return null;
      }

      // Re-resolve and require overlap with pre-request answers. This narrows
      // DNS rebinding windows by rejecting responses when hostname resolution
      // shifts to a disjoint address set during request handling.
      const resolvedAfterRequest = await resolvePublicHostAddresses(
        currentUrl.hostname,
      );
      if (
        !resolvedAfterRequest ||
        !hasAddressIntersection(resolvedBeforeRequest, resolvedAfterRequest)
      ) {
        return null;
      }

      const contentType = parseImageContentType(response.headers.get("content-type"));
      if (!contentType) {
        return null;
      }

      const contentLengthHeader = response.headers.get("content-length");
      if (contentLengthHeader) {
        const contentLength = Number.parseInt(contentLengthHeader, 10);
        if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
          return null;
        }
      }

      const bytes = await readResponseBytesWithinLimit(response, MAX_IMAGE_BYTES);
      if (!bytes) {
        return null;
      }

      return {
        bytes,
        mimeType: contentType,
      };
    }

    return null;
  } catch {
    return null;
  }
}

function hashImageBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function findOrCreateImageBlob(
  input: {
    contentHash: string;
    originalUrl: string;
    bytes: Uint8Array;
    mimeType: string;
  },
): Promise<ImageBlob | null> {
  const existing = await prisma.imageBlob.findUnique({
    where: { contentHash: input.contentHash },
  });
  if (existing) {
    return existing;
  }

  const storageKey = await uploadImage(input.bytes, input.contentHash, input.mimeType);

  try {
    return await prisma.imageBlob.create({
      data: {
        contentHash: input.contentHash,
        storageKey,
        originalUrl: input.originalUrl,
        mimeType: input.mimeType,
        sizeBytes: input.bytes.byteLength,
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    return prisma.imageBlob.findUnique({
      where: { contentHash: input.contentHash },
    });
  }
}

type StoredImage = {
  blob: ImageBlob;
  bytes: Uint8Array;
  mimeType: string;
};

export async function downloadAndStoreImages(
  urls: string[],
  maxCount: number,
): Promise<StoredImage[]> {
  const uniqueUrls = uniqueImageUrls(urls).slice(0, maxCount);
  if (uniqueUrls.length === 0) {
    return [];
  }

  const storedImages: StoredImage[] = [];
  const seenContentHashes = new Set<string>();

  for (const imageUrl of uniqueUrls) {
    const downloaded = await downloadImage(imageUrl);
    if (!downloaded) {
      continue;
    }

    const contentHash = hashImageBytes(downloaded.bytes);
    if (seenContentHashes.has(contentHash)) {
      continue;
    }
    seenContentHashes.add(contentHash);

    const blob = await findOrCreateImageBlob({
      contentHash,
      originalUrl: imageUrl,
      bytes: downloaded.bytes,
      mimeType: downloaded.mimeType,
    });
    if (blob) {
      storedImages.push({
        blob,
        bytes: downloaded.bytes,
        mimeType: downloaded.mimeType,
      });
    }
  }

  return storedImages;
}
