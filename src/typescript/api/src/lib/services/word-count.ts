/**
 * Whitespace-delimited word count stored on ContentBlob and compared against
 * WORD_COUNT_LIMIT by investigateNow and the selector (SPEC §2.4).
 */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
