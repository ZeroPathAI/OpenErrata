import { createHash } from "node:crypto";
import {
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_MIME_TYPE_VALUES,
  type SupportedImageMimeType,
} from "@openerrata/shared";
import { getPrisma } from "$lib/db/client.js";
import { isUniqueConstraintError } from "$lib/db/errors.js";
import type { ImageBlob } from "$lib/db/prisma-client";
import { fetchPublicHttp, readBodyPrefix } from "$lib/network/public-http-fetch.js";
import { uploadImage } from "./blob-storage.js";

const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;

const SUPPORTED_MIME_TYPE_SET: ReadonlySet<string> = new Set(SUPPORTED_IMAGE_MIME_TYPE_VALUES);

function isSupportedImageMimeType(value: string): value is SupportedImageMimeType {
  return SUPPORTED_MIME_TYPE_SET.has(value);
}

export function parseImageContentType(
  contentTypeHeader: string | null,
): SupportedImageMimeType | null {
  if (contentTypeHeader === null || contentTypeHeader.length === 0) return null;
  const normalized = contentTypeHeader.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!isSupportedImageMimeType(normalized)) return null;
  return normalized;
}

/**
 * Download one image from the public internet (SSRF-safe; see
 * public-http-fetch.ts). Returns null when the image is unreachable, blocked,
 * not a supported image type, or over MAX_IMAGE_BYTES; a single bad image
 * never fails the investigation. Aborting `signal` aborts the download.
 */
async function downloadImage(
  url: string,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; mimeType: SupportedImageMimeType } | null> {
  try {
    const { response } = await fetchPublicHttp({
      url: new URL(url),
      headers: {
        "User-Agent": "OpenErrataImageDownloader/1.0 (+https://openerrata.com)",
        Accept: "image/*",
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS)]),
    });

    const contentType = parseImageContentType(response.headers.get("content-type"));
    if (!response.ok || contentType === null) {
      await response.body?.cancel();
      return null;
    }

    const { bytes, truncated } = await readBodyPrefix(response, MAX_IMAGE_BYTES);
    if (truncated) {
      return null;
    }
    return { bytes, mimeType: contentType };
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

function hashImageBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function findOrCreateImageBlob(input: {
  contentHash: string;
  originalUrl: string;
  bytes: Uint8Array;
  mimeType: SupportedImageMimeType;
}): Promise<ImageBlob | null> {
  const prisma = getPrisma();
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

export interface ResolvedDownloadedImage {
  blob: ImageBlob;
  bytes: Uint8Array;
  mimeType: SupportedImageMimeType;
  contentHash: string;
}

type ImageDownloadResolution =
  | {
      sourceUrl: string;
      status: "resolved";
      image: ResolvedDownloadedImage;
    }
  | {
      sourceUrl: string;
      status: "failed";
    };

/**
 * Download each URL, dedupe by content hash, and store new images in blob
 * storage. Results are reported per input URL, in order. Throws only when
 * `signal` aborts (the run lost its lease) or storage fails.
 */
export async function downloadAndStoreImages(
  urls: string[],
  signal: AbortSignal,
): Promise<ImageDownloadResolution[]> {
  const resolutions: ImageDownloadResolution[] = [];
  const resolvedByContentHash = new Map<string, ResolvedDownloadedImage>();

  for (const imageUrl of urls) {
    const downloaded = await downloadImage(imageUrl, signal);
    if (!downloaded) {
      resolutions.push({
        sourceUrl: imageUrl,
        status: "failed",
      });
      continue;
    }

    const contentHash = hashImageBytes(downloaded.bytes);
    const duplicateResolution = resolvedByContentHash.get(contentHash);
    if (duplicateResolution) {
      resolutions.push({
        sourceUrl: imageUrl,
        status: "resolved",
        image: duplicateResolution,
      });
      continue;
    }

    const blob = await findOrCreateImageBlob({
      contentHash,
      originalUrl: imageUrl,
      bytes: downloaded.bytes,
      mimeType: downloaded.mimeType,
    });
    if (!blob) {
      resolutions.push({
        sourceUrl: imageUrl,
        status: "failed",
      });
      continue;
    }

    const resolvedImage: ResolvedDownloadedImage = {
      blob,
      bytes: downloaded.bytes,
      mimeType: downloaded.mimeType,
      contentHash,
    };
    resolvedByContentHash.set(contentHash, resolvedImage);
    resolutions.push({
      sourceUrl: imageUrl,
      status: "resolved",
      image: resolvedImage,
    });
  }

  return resolutions;
}
