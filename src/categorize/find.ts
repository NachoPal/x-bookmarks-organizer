/**
 * "Find bookmarks for this category": re-file already-stored bookmarks into
 * ONE category the owner points at - typically one they just added between
 * syncs, which a sync would only ever fill with NEW bookmarks.
 *
 * It is an explicit, in-app action rather than a step in every sync on
 * purpose: it reads the whole library, so it costs a model call per batch,
 * and the owner decides when that is worth it.
 *
 * The question asked is narrow - "which of these belong in THIS category?" -
 * rather than re-running the full filing prompt over the whole tree: the
 * answer is the same for the category in question, the prompt carries one
 * node instead of the whole tree, and nothing else about a bookmark can
 * change. The write is ADD-ONLY (`Database.addBookmarksToCategory`): a match
 * gains this category and keeps every category it already had.
 */
import type { ArticleContext } from '../articles/link-metadata';
import type { Database } from '../db/database';
import type { RawBookmark } from '../types';
import type { LlmRunner } from './llm';

const MAX_TEXT_CHARS = 500;
const MAX_ARTICLE_CHARS = 300;

/** The category a find looks for, as the prompt describes it. */
export interface FindTarget {
  path: string[];
  description: string | null;
  /** Its direct children's names - context for how wide the category is. */
  children: string[];
}

function bookmarkLine(bm: RawBookmark, index: number, articleContext?: Map<string, ArticleContext>): string {
  const text = bm.text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
  const lines = [`[${index}] post_id: ${bm.postId}`, `    author: @${bm.authorUsername}`, `    text: ${text}`];
  const article = articleContext?.get(bm.postId);
  if (article) {
    const combined = article.description ? `${article.title} - ${article.description}` : article.title;
    lines.push(`    linked article: ${combined.replace(/\s+/g, ' ').trim().slice(0, MAX_ARTICLE_CHARS)}`);
  }
  return lines.join('\n');
}

/** The one-category matching prompt. Strict JSON out, like every other pass. */
export function buildFindPrompt(
  bookmarks: RawBookmark[],
  target: FindTarget,
  articleContext?: Map<string, ArticleContext>,
): string {
  const items = bookmarks.map((bm, i) => bookmarkLine(bm, i, articleContext)).join('\n\n');
  const about = target.description ? `\nWhat belongs in it: ${target.description}` : '';
  const inside = target.children.length > 0 ? `\nIt already contains: ${target.children.join(', ')}` : '';
  return `You are helping a person organize their X (Twitter) bookmarks. They created a category and want every bookmark that belongs in it filed there.

# The category
${target.path.join(' > ')}${about}${inside}

# Rules
- Judge each bookmark by its topic: does it genuinely belong in this category, the way the person would expect when they open it?
- A bookmark may already live in other categories; that does not matter. Only decide whether it ALSO belongs here.
- Be precise: leave out bookmarks that only touch the topic in passing. When in doubt, leave it out.

# Bookmarks
${items}

# Output
Return ONLY a JSON object, no prose, no markdown fences, of exactly this shape:
{"matches":["<post_id>","<post_id>"]}
List the post_id of every bookmark that belongs in the category, and nothing else. An empty list is a valid answer.`;
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fence ? (fence[1] ?? '').trim() : trimmed;
}

/**
 * The post ids the model matched, restricted to the batch it was shown.
 * Throws when the answer is not the JSON asked for, so a broken response
 * fails the run loudly instead of reading as "nothing matched".
 */
export function parseFindMatches(responseText: string, validPostIds: Set<string>): string[] {
  const text = stripFences(responseText);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) {
    throw new Error(`The model's answer contained no JSON object: ${responseText.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error(`The model's answer was not valid JSON: ${(err as Error).message}`);
  }
  const matches = (parsed as { matches?: unknown }).matches;
  if (!Array.isArray(matches)) throw new Error('The model\'s answer is missing its "matches" list.');
  const out = new Set<string>();
  for (const id of matches) {
    const postId = typeof id === 'number' ? String(id) : id;
    if (typeof postId === 'string' && validPostIds.has(postId.trim())) out.add(postId.trim());
  }
  return [...out];
}

/** What a find did - the job's summary and what its Undo needs. */
export interface FindSummary {
  categoryId: number;
  categoryName: string;
  /** Bookmarks the model was asked about. */
  checked: number;
  /** Bookmarks this run filed into the category. */
  added: number;
  /** Their ids, so the owner can undo exactly this run. */
  addedBookmarkIds: number[];
}

export interface FindDeps {
  db: Database;
  runner: LlmRunner;
  categoryId: number;
  batchSize: number;
  /** Linked-article titles, fed in exactly as the filing pass gets them. */
  articleContext?: (bookmarks: RawBookmark[]) => Promise<Map<string, ArticleContext>>;
  logger?: (message: string) => void;
}

/** The target as the prompt shows it, or undefined when the id is unknown. */
export function describeFindTarget(db: Database, categoryId: number): FindTarget | undefined {
  const node = db.getCategoryById(categoryId);
  if (!node) return undefined;
  const path = [node.name];
  for (let parent = node.parentId; parent != null; ) {
    const p = db.getCategoryById(parent);
    if (!p) break;
    path.unshift(p.name);
    parent = p.parentId;
  }
  const children = db
    .getAllCategories()
    .filter((c) => c.parentId === categoryId)
    .map((c) => c.name)
    .sort((a, b) => a.localeCompare(b));
  return { path, description: node.description ?? null, children };
}

/**
 * Check every stored bookmark not already in the category's subtree and add
 * the matches to it. Each batch is written as soon as it is answered, so a
 * failure half way keeps what was found before it (and the summary of a
 * thrown run is simply lost - the links are real either way).
 */
export async function findBookmarksForCategory(deps: FindDeps): Promise<FindSummary> {
  const { db, runner, categoryId, batchSize } = deps;
  const log = deps.logger ?? (() => {});
  const target = describeFindTarget(db, categoryId);
  if (!target) throw new Error('That category no longer exists.');
  const categoryName = target.path[target.path.length - 1]!;

  const candidates = db.getBookmarksOutsideCategory(categoryId);
  if (candidates.length === 0) {
    log(`Every bookmark is already in “${categoryName}”.`);
    return { categoryId, categoryName, checked: 0, added: 0, addedBookmarkIds: [] };
  }

  const context = deps.articleContext ? await deps.articleContext(candidates) : undefined;
  const size = Math.max(1, batchSize);
  const batches = Math.ceil(candidates.length / size);
  log(`Checking ${candidates.length} bookmark(s) for “${target.path.join(' > ')}” in ${batches} batch(es).`);

  const addedBookmarkIds: number[] = [];
  for (let i = 0; i < batches; i++) {
    const batch = candidates.slice(i * size, (i + 1) * size);
    const response = await runner(buildFindPrompt(batch, target, context));
    const matched = new Set(parseFindMatches(response, new Set(batch.map((b) => b.postId))));
    // The category may have been deleted while the model was thinking; stop
    // rather than fail on a foreign key.
    if (!db.getCategoryById(categoryId)) throw new Error('That category was deleted while bookmarks were being found.');
    const ids = batch.filter((b) => matched.has(b.postId)).map((b) => b.id);
    const added = db.addBookmarksToCategory(categoryId, ids);
    addedBookmarkIds.push(...added);
    log(`Batch ${i + 1}/${batches}: ${added.length} match(es).`);
  }

  log(`Added ${addedBookmarkIds.length} bookmark(s) to “${categoryName}”.`);
  return { categoryId, categoryName, checked: candidates.length, added: addedBookmarkIds.length, addedBookmarkIds };
}
