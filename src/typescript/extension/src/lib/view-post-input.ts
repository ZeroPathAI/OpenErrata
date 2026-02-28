import { viewPostInputSchema, type PlatformContent, type ViewPostInput } from "@openerrata/shared";

export function toViewPostInput(content: PlatformContent): ViewPostInput {
  const common = {
    url: content.url,
    observedImageUrls: content.imageUrls,
    observedImageOccurrences: content.imageOccurrences,
  };

  switch (content.platform) {
    case "LESSWRONG":
      return viewPostInputSchema.parse({
        ...common,
        externalId: content.externalId,
        platform: "LESSWRONG",
        metadata: content.metadata,
      });
    case "X":
      return viewPostInputSchema.parse({
        ...common,
        externalId: content.externalId,
        platform: "X",
        observedContentText: content.contentText,
        metadata: content.metadata,
      });
    case "SUBSTACK":
      return viewPostInputSchema.parse({
        ...common,
        externalId: content.externalId,
        platform: "SUBSTACK",
        observedContentText: content.contentText,
        metadata: content.metadata,
      });
    case "WIKIPEDIA":
      return viewPostInputSchema.parse({
        ...common,
        platform: "WIKIPEDIA",
        observedContentText: content.contentText,
        metadata: content.metadata,
      });
  }
}
