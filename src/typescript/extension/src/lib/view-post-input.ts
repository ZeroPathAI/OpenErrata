import type { PlatformContent, ViewPostInput } from "@openerrata/shared";

/** The API's view-post input for observed page content (spec §2.6). */
export function toViewPostInput(content: PlatformContent): ViewPostInput {
  const common = {
    url: content.url,
    observedImageOccurrences: content.imageOccurrences,
  };

  switch (content.platform) {
    case "LESSWRONG":
      // LessWrong versioning derives canonical text from metadata.htmlContent.
      return {
        ...common,
        platform: "LESSWRONG",
        externalId: content.externalId,
        metadata: content.metadata,
      };
    case "X":
      return {
        ...common,
        platform: "X",
        externalId: content.externalId,
        observedContentText: content.contentText,
        metadata: content.metadata,
      };
    case "SUBSTACK":
      return {
        ...common,
        platform: "SUBSTACK",
        externalId: content.externalId,
        observedContentText: content.contentText,
        metadata: content.metadata,
      };
    case "WIKIPEDIA":
      // The API derives the Wikipedia external ID from metadata.
      return {
        ...common,
        platform: "WIKIPEDIA",
        observedContentText: content.contentText,
        metadata: content.metadata,
      };
  }
}
