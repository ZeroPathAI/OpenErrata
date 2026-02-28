const SUBSTACK_POST_PATH_REGEX = /^\/p\/([^/?#]+)/i;

export function extractSubstackPostSlug(pathname: string): string | null {
  const match = SUBSTACK_POST_PATH_REGEX.exec(pathname);
  if (match?.[1] === undefined || match[1].length === 0) {
    return null;
  }
  return match[1];
}

export function isSubstackPostPath(pathname: string): boolean {
  return extractSubstackPostSlug(pathname) !== null;
}
