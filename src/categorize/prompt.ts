import type { Assignment, RawBookmark } from '../types';

const MAX_TEXT_CHARS = 500;

/** One entry in the batch shown to the model. */
function bookmarkLine(bm: RawBookmark, index: number): string {
  const text = bm.text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
  return [
    `[${index}] post_id: ${bm.postId}`,
    `    author: @${bm.authorUsername} (${bm.authorName})`,
    `    text: ${text}`,
  ].join('\n');
}

/**
 * Build the assignment prompt. The tree is FIXED (designed by the holistic
 * taxonomy pass): the model files bookmarks into it and must not invent new
 * categories. Returns strict JSON only.
 */
export function buildPrompt(bookmarks: RawBookmark[], treeText: string, maxDepth: number): string {
  const items = bookmarks.map((bm, i) => bookmarkLine(bm, i)).join('\n\n');
  return `You are filing a person's X (Twitter) bookmarks into an EXISTING, fixed category tree.

# Category tree (fixed - do not invent new categories)
${treeText}

# Rules
- Assign each bookmark to one or more categories, by topic, using ONLY nodes from the tree above.
- Copy each node's exact name and give its full path from a root node, e.g. ["AI","Harnesses"] means the node "Harnesses" under "AI".
- Place a bookmark at the MOST SPECIFIC node that fits. A bookmark may belong to several branches at once (multi-category) - list one path per branch.
- Do NOT invent new categories or emit paths that are not in the tree. A path may never be longer than ${maxDepth} levels.
- Every bookmark must get at least one category. If truly nothing in the tree fits, use ["Uncategorized"].

# Bookmarks to categorize
${items}

# Output
Return ONLY a JSON object, no prose, no markdown fences, of exactly this shape:
{"assignments":[{"post_id":"<id>","categories":[["Top","Child"],["Other"]]}]}
Include every bookmark's post_id exactly once.`;
}

/** Strip surrounding markdown code fences if the model wrapped its JSON. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fence ? (fence[1] ?? '').trim() : trimmed;
}

/** Extract the first balanced top-level JSON object from arbitrary text. */
function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function normalizePath(raw: unknown, maxDepth: number): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parts = raw
    .map((p) => (typeof p === 'string' ? p.trim() : String(p).trim()))
    .filter((p) => p.length > 0)
    .slice(0, maxDepth);
  return parts.length > 0 ? parts : undefined;
}

/**
 * Parse and validate the model's JSON response into assignments.
 *
 * Only post ids present in `validPostIds` are kept; paths are trimmed to
 * `maxDepth` and empty ones dropped. Throws if the response is not parseable
 * JSON of the expected shape, so the caller can retry or fail loudly rather
 * than silently dropping bookmarks.
 */
export function parseAssignments(
  responseText: string,
  validPostIds: Set<string>,
  maxDepth: number,
): Assignment[] {
  const jsonText = extractJsonObject(stripFences(responseText));
  if (!jsonText) {
    throw new Error(`LLM response contained no JSON object: ${responseText.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`LLM response was not valid JSON: ${(err as Error).message}`);
  }
  const assignmentsRaw = (parsed as { assignments?: unknown }).assignments;
  if (!Array.isArray(assignmentsRaw)) {
    throw new Error('LLM response missing "assignments" array');
  }

  const byPostId = new Map<string, string[][]>();
  for (const entry of assignmentsRaw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const postId = (entry as { post_id?: unknown }).post_id;
    if (typeof postId !== 'string' || !validPostIds.has(postId)) continue;
    const categoriesRaw = (entry as { categories?: unknown }).categories;
    if (!Array.isArray(categoriesRaw)) continue;
    const paths: string[][] = [];
    for (const path of categoriesRaw) {
      const normalized = normalizePath(path, maxDepth);
      if (normalized) paths.push(normalized);
    }
    if (paths.length > 0) byPostId.set(postId, paths);
  }

  return [...byPostId.entries()].map(([postId, categories]) => ({ postId, categories }));
}
