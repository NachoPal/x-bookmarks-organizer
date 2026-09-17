/**
 * Identify the primary external link in a bookmarked post's text, if any.
 *
 * X shortens every URL a post contains (including quote-tweet permalinks) to a
 * `t.co` link in the raw `text` field we store, so this cannot yet tell an
 * article link from a link back to X by domain alone - that only becomes
 * knowable once it is actually fetched and its redirect resolves (see
 * `fetch-article.ts`, which treats a resolved x.com/twitter.com/t.co host as
 * "not an article"). This function just finds the first URL-shaped token in
 * the text, trimming trailing punctuation a sentence would leave attached.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"]+/gi;
const TRAILING_PUNCTUATION = /[).,;:!?\]'"]+$/;

export function extractArticleLink(text: string): string | null {
  const matches = text.match(URL_PATTERN);
  if (!matches || matches.length === 0) return null;

  for (const raw of matches) {
    const trimmed = raw.replace(TRAILING_PUNCTUATION, '');
    if (!trimmed) continue;
    try {
      // Validate it actually parses as a URL before treating it as a candidate.
      new URL(trimmed);
      return trimmed;
    } catch {
      continue;
    }
  }
  return null;
}
