const JSON_LD_SELECTOR = 'script[type="application/ld+json"]';
const MAX_JSON_LD_DEPTH = 8;

function parseIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return null;
  return parsed.toISOString();
}

export function readFirstMetaDateAsIso(
  document: Document,
  selectors: readonly string[],
): string | null {
  for (const selector of selectors) {
    const value = document.querySelector(selector)?.getAttribute("content");
    const iso = parseIsoDate(value);
    if (iso) return iso;
  }
  return null;
}

export function readFirstTimeDateAsIso(roots: readonly ParentNode[]): string | null {
  for (const root of roots) {
    const value = root.querySelector("time[datetime]")?.getAttribute("datetime");
    const iso = parseIsoDate(value);
    if (iso) return iso;
  }
  return null;
}

function findDateInJsonLd(
  value: unknown,
  candidateKeys: ReadonlySet<string>,
  depth = 0,
): string | null {
  if (depth > MAX_JSON_LD_DEPTH || value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    for (const nested of value) {
      const found = findDateInJsonLd(nested, candidateKeys, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  // Preserve caller-specified key priority (e.g. datePublished before dateCreated).
  for (const key of candidateKeys) {
    const nested = record[key];
    const iso = parseIsoDate(typeof nested === "string" ? nested : null);
    if (iso) return iso;
  }

  for (const nested of Object.values(record)) {
    const found = findDateInJsonLd(nested, candidateKeys, depth + 1);
    if (found) return found;
  }

  return null;
}

export function readPublishedDateFromJsonLd(
  root: ParentNode,
  candidateKeys: ReadonlySet<string>,
): string | null {
  for (const script of root.querySelectorAll<HTMLScriptElement>(JSON_LD_SELECTOR)) {
    const text = script.textContent.trim();
    if (!text) continue;

    try {
      const parsed = JSON.parse(text) as unknown;
      const found = findDateInJsonLd(parsed, candidateKeys);
      if (found) return found;
    } catch {
      // Ignore malformed JSON-LD blobs.
    }
  }

  return null;
}

function uniqueNormalizedUrls(
  values: ReadonlyArray<string | null | undefined>,
  baseUrl: string,
): string[] {
  const uniqueUrls = new Set<string>();

  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (trimmed.length === 0 || trimmed.startsWith("data:")) continue;

    try {
      uniqueUrls.add(new URL(trimmed, baseUrl).toString());
    } catch {
      // Ignore malformed URLs in extracted content.
    }
  }

  return Array.from(uniqueUrls);
}

export function extractImageUrlsFromRoot(
  root: ParentNode,
  baseUrl: string,
  selector = "img[src]",
): string[] {
  const values = Array.from(root.querySelectorAll<HTMLImageElement>(selector)).map((image) =>
    image.getAttribute("src"),
  );
  return uniqueNormalizedUrls(values, baseUrl);
}
