import MarkdownIt from "markdown-it";

// Reasoning is LLM output that a post's author can steer, so rendering is
// restricted to what is safe to publish: raw HTML is escaped, markdown-it's
// link validation drops javascript:/vbscript:/file:/data: targets, and images
// are disabled so a claim can't embed a remote (tracking) image in our page.
const markdownRenderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
}).disable("image");

const defaultLinkOpenRenderer =
  markdownRenderer.renderer.rules["link_open"] ??
  ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));

markdownRenderer.renderer.rules["link_open"] = (tokens, index, options, env, self) => {
  const token = tokens[index];
  token?.attrSet("target", "_blank");
  token?.attrSet("rel", "noopener noreferrer");
  return defaultLinkOpenRenderer(tokens, index, options, env, self);
};

export function renderClaimReasoningHtml(markdown: string): string {
  return markdownRenderer.render(markdown);
}
