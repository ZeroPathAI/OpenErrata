import {
  type PlatformContent,
  type VersionIdentityImageOccurrence,
  serializeObservedVersionIdentity,
} from "@openerrata/shared";

function toVersionIdentityImageOccurrences(
  content: PlatformContent,
): readonly VersionIdentityImageOccurrence[] | undefined {
  if (content.imageOccurrences === undefined) {
    return undefined;
  }

  return content.imageOccurrences.map((occurrence) => ({
    originalIndex: occurrence.originalIndex,
    normalizedTextOffset: occurrence.normalizedTextOffset,
    sourceUrl: occurrence.sourceUrl,
    ...(occurrence.captionText === undefined ? {} : { captionText: occurrence.captionText }),
  }));
}

/**
 * Identity key used by content script refresh logic to decide whether the
 * currently observed page content changed and needs re-sync.
 */
export function pageSessionKeyFor(content: PlatformContent): string {
  return JSON.stringify({
    platform: content.platform,
    externalId: content.externalId,
    mediaState: content.mediaState,
    observedVersionIdentity: serializeObservedVersionIdentity({
      contentText: content.contentText,
      imageOccurrences: toVersionIdentityImageOccurrences(content),
    }),
  });
}
