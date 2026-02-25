import {
  viewPostInputSchema,
  type PlatformContent,
  type ViewPostInput,
} from "@openerrata/shared";

export function toViewPostInput(content: PlatformContent): ViewPostInput {
  const common = {
    externalId: content.externalId,
    url: content.url,
    observedImageUrls: content.imageUrls,
  };

  switch (content.platform) {
    case "LESSWRONG":
      return viewPostInputSchema.parse({
        ...common,
        platform: "LESSWRONG",
        metadata: content.metadata,
      });
    case "X":
      return viewPostInputSchema.parse({
        ...common,
        platform: "X",
        observedContentText: content.contentText,
        metadata: content.metadata,
      });
    case "SUBSTACK":
      return viewPostInputSchema.parse({
        ...common,
        platform: "SUBSTACK",
        observedContentText: content.contentText,
        metadata: content.metadata,
      });
  }
}
