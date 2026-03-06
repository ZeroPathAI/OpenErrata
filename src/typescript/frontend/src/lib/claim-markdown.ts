import MarkdownIt from "markdown-it";

const markdownRenderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

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
