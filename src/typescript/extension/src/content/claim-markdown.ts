import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

const SAFE_SOURCE_PROTOCOLS = new Set(["http:", "https:"]);

// Claim reasoning is LLM output, and a post's author can steer it (prompt
// injection), so it must not be able to make the reader's browser fetch
// anything: no images, and only text-formatting tags survive sanitization.
// Links stay, but only load when the reader clicks them.
const markdownRenderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
}).disable("image");

const ALLOWED_REASONING_TAGS = [
  "a",
  "p",
  "br",
  "strong",
  "em",
  "b",
  "i",
  "s",
  "del",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
];

export function renderClaimReasoningHtml(markdown: string): string {
  const rawHtml = markdownRenderer.render(markdown);
  const sanitizedHtml = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: ALLOWED_REASONING_TAGS,
    ALLOWED_ATTR: ["href"],
    ALLOW_DATA_ATTR: false,
  });
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
