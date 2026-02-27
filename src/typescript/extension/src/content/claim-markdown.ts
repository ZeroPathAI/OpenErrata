import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

const SAFE_SOURCE_PROTOCOLS = new Set(["http:", "https:"]);

const markdownRenderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

export function renderClaimReasoningHtml(markdown: string): string {
  const rawHtml = markdownRenderer.render(markdown);
  const sanitizedHtml = DOMPurify.sanitize(rawHtml);
  const template = document.createElement("template");
  template.innerHTML = sanitizedHtml;

  for (const link of Array.from(template.content.querySelectorAll("a"))) {
    const safeUrl = toSafeSourceUrl(link.getAttribute("href") ?? "");
    if (safeUrl === null) {
      link.replaceWith(document.createTextNode(link.textContent));
      continue;
    }
    link.setAttribute("href", safeUrl);
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }

  return template.innerHTML;
}

export function toSafeSourceUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!SAFE_SOURCE_PROTOCOLS.has(parsed.protocol)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}
