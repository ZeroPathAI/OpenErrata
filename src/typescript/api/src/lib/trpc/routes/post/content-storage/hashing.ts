import { createHash } from "node:crypto";
import {
  serializeVersionHashSeed,
  serializeVersionIdentityImageOccurrences,
  type ViewPostInput,
} from "@openerrata/shared";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function imageOccurrencesHash(
  normalizedOccurrences: NonNullable<ViewPostInput["observedImageOccurrences"]>,
): string {
  return sha256(serializeVersionIdentityImageOccurrences(normalizedOccurrences));
}

export function versionHashFromContentAndImages(
  contentHash: string,
  occurrencesHash: string,
): string {
  return sha256(serializeVersionHashSeed(contentHash, occurrencesHash));
}
