import type { LlmRunner } from './llm';
import type { ArticleContext } from '../articles/link-metadata';
import type { RawBookmark, TaxonomyNode } from '../types';
import { effectiveContextWindow, estimateTokens, inputBudgetFor, planBatches } from './taxonomy-budget';

/** Text budget per bookmark in the (large, holistic) taxonomy-design prompt. */
const MAX_TEXT_CHARS = 220;

/** Text budget for the linked article's title+description shown per bookmark. */
const MAX_ARTICLE_CHARS = 160;

/**
 * Cap on a designed node's one-line description (issue #61). The prompt asks
 * for one sentence; this is the hard bound applied to whatever comes back.
 */
export const MAX_NODE_DESCRIPTION_CHARS = 160;

/**
 * Pull a human-meaningful domain out of a post's text, if one is present.
 * X wraps outbound links as `t.co` shortlinks, which carry no topical signal,
 * so those are ignored; a real domain (e.g. `arxiv.org`) is a useful hint for
 * the taxonomy designer.
 */
export function extractDomain(text: string): string | undefined {
  const urls = text.match(/https?:\/\/[^\s]+/gi);
  if (!urls) return undefined;
  for (const raw of urls) {
    try {
      const host = new URL(raw).hostname.replace(/^www\./, '');
      if (host && host !== 't.co') return host;
    } catch {
      // Skip malformed URLs.
    }
  }
  return undefined;
}

/** Format a linked article's title (+ optional description) for the prompt. */
function formatArticleContext(article: ArticleContext): string {
  const combined = article.description ? `${article.title} - ${article.description}` : article.title;
  return combined.replace(/\s+/g, ' ').trim().slice(0, MAX_ARTICLE_CHARS);
}

/**
 * One compact line describing a bookmark for the taxonomy-design pass. When
 * `articleContext` has an entry for this bookmark (its post links to an
 * article - issue #25), the linked article's title/description is appended so
 * a link-heavy post with almost no text of its own is placed by what the link
 * is actually about, not left to fall back to `Uncategorized`.
 */
function compactLine(
  bm: RawBookmark,
  index: number,
  articleContext?: Map<string, ArticleContext>,
): string {
  const text = bm.text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
  const domain = extractDomain(bm.text);
  const suffix = domain ? ` [link: ${domain}]` : '';
  const article = articleContext?.get(bm.postId);
  const articleSuffix = article ? ` [article: ${formatArticleContext(article)}]` : '';
  return `[${index}] @${bm.authorUsername}: ${text}${suffix}${articleSuffix}`;
}

/**
 * Build the taxonomy-design prompt. The model is shown ALL bookmarks at once and
 * asked to design one coherent, genuinely nested tree with complete freedom over
 * labels and structure, targeting a minimum nesting depth. This is the holistic
 * step that replaces cold-start per-batch labelling.
 */
export function buildTaxonomyPrompt(
  bookmarks: RawBookmark[],
  existingTreeText: string,
  minDepth: number,
  maxDepth: number,
  articleContext?: Map<string, ArticleContext>,
  batch?: TaxonomyBatch,
): string {
  const items = bookmarks.map((bm, i) => compactLine(bm, i, articleContext)).join('\n');
  const scope = batch
    ? `You are shown PART ${batch.index} of ${batch.count} of the bookmarks - the collection is too large for one request. A later step merges the ${batch.count} parts' trees into one, so design the best tree for THIS part; do not invent categories for material you were not shown. Study the whole part first, then design a single, coherent, DEEP nested tree of topic categories that organizes it well.`
    : 'You are shown ALL of the bookmarks at once. Study the whole collection first, then design a single, coherent, DEEP nested tree of topic categories that organizes it well.';
  return `You are designing a category taxonomy for a person's X (Twitter) bookmarks.

${scope}

# Existing categories
${existingTreeText}
${EXISTING_RULE}

# Design goals
- Look across ALL bookmarks before choosing any label. Do not anchor on the first few you read.
- Build a genuinely nested hierarchy. Target AT LEAST ${minDepth} levels of nesting wherever the material supports it (e.g. "Top > Subtopic > Specific"). Sparse topics may be shallower - do not pad with empty filler nodes.
- Do NOT collapse everything into two or three broad buckets (like a bare "AI" or "Development" with no substructure). Split broad areas into meaningful subtopics and give each branch real depth.
- Use specific, descriptive labels. You have complete freedom over the labels and the structure.
- Do not nest deeper than ${maxDepth} levels.
- ${DESCRIPTION_RULE}

# Bookmarks
${items}

${OUTPUT_SPEC}`;
}

/**
 * Whether pass 1 designs the tree or grows it:
 * - `design`: the first sync (no generated tree yet) and `recategorize` -
 *   one holistic, deep tree over every bookmark shown, around whatever fixed
 *   anchors exist (the owner's own categories).
 * - `incremental`: every later sync - the new bookmarks against the WHOLE
 *   current tree, answering only with the categories they need that the tree
 *   lacks. Nothing existing is ever renamed, moved, merged or dropped.
 */
export type TaxonomyMode = 'design' | 'incremental';

/**
 * Build the incremental pass-1 prompt: the new bookmarks of a sync against
 * the whole current tree (descriptions and `[owner]` markers included). The
 * model answers with ONLY what is new - each new category with the path of
 * existing categories leading to it - which `materializeTaxonomy` merges
 * into the tree: an existing node it names is reused as-is, so the answer can
 * add categories and never change one. An empty tree is a valid answer: new
 * bookmarks that all fit the tree need nothing.
 */
export function buildIncrementalTaxonomyPrompt(
  bookmarks: RawBookmark[],
  existingTreeText: string,
  maxDepth: number,
  articleContext?: Map<string, ArticleContext>,
  batch?: TaxonomyBatch,
): string {
  const items = bookmarks.map((bm, i) => compactLine(bm, i, articleContext)).join('\n');
  const scope = batch
    ? `You are shown PART ${batch.index} of ${batch.count} of the new bookmarks - there are too many for one request. A later step merges the ${batch.count} parts' additions, so propose what THIS part needs; do not invent categories for material you were not shown.`
    : 'You are shown every new bookmark of this sync.';
  return `You are growing the category taxonomy of a person's X (Twitter) bookmarks.

The person already has the category tree below and has just bookmarked the posts listed under "New bookmarks". ${scope} Decide, for each new bookmark, whether the tree already has a fitting home for it, and add ONLY the categories the new bookmarks need that the tree lacks. A later step files every new bookmark into the resulting tree and can only use categories that exist, so a topic the tree lacks must be added here or its bookmarks land in "Uncategorized".

# Existing categories
${existingTreeText}
${INCREMENTAL_EXISTING_RULE}

# Growth rules
- ${INCREMENTAL_ADD_RULES}
- Do not nest deeper than ${maxDepth} levels, counting from a top-level category.
- ${DESCRIPTION_RULE}

# New bookmarks
${items}

${INCREMENTAL_OUTPUT_SPEC}`;
}

/** Which slice of an over-budget library a pass-1 prompt covers (issue #109). */
export interface TaxonomyBatch {
  /** 1-based. */
  index: number;
  count: number;
}

/**
 * How pass 1 treats the tree it is shown. On a first sync that is the owner's
 * hand-made categories; on a recategorize it is those plus the ancestors that
 * hold them in place. Either way every listed node is a FIXED anchor - the
 * code also enforces it (materializing merges into them, and nothing a pass
 * does can rename, move or delete an owner category), but a design that
 * already honours them files posts into them instead of beside them.
 */
const EXISTING_RULE =
  'If the section above lists categories, they already exist and are FIXED ANCHORS. Nodes marked [owner] were created by the person by hand, because they want every bookmark that fits to be filed there. Keep every listed node exactly as it is - the same name, at the same place in the hierarchy - and include each one in your output tree verbatim (without the [owner] marker, which is not part of the name). Never rename, merge, move or drop them, and never create a second category that means the same thing as one of them. Design everything else around them: new categories beside them, and new sub-categories inside them (including inside [owner] nodes) wherever the material supports it. If it says there are none, design the whole tree from scratch.';

/** How incremental pass 1 treats the tree it is shown: every node is FIXED. */
const INCREMENTAL_EXISTING_RULE =
  'Every category above already exists and is FIXED: never rename, re-describe, merge, move or remove one. Nodes marked [owner] were created by the person by hand, because they want every bookmark that fits to be filed there; the [owner] marker is not part of the name.';

/** What incremental pass 1 may add, joined into one list with the depth and description rules. */
const INCREMENTAL_ADD_RULES = [
  'Prefer the existing categories. When a new bookmark fits an existing node - especially an [owner] node or a node inside one - it needs nothing new. Usually most new bookmarks fit.',
  'Add a category only for a topic the tree genuinely lacks: a new top-level category, or a new sub-category inside an existing one (including inside [owner] nodes) where a new bookmark is clearly more specific than anything already there.',
  'Never add a category that means the same thing as an existing one or as another one you add (no "LLMs" beside "Large Language Models", no "JS" beside "JavaScript"). Judge by the descriptions, not only the names.',
  'Place each new category where it fits best in the existing hierarchy, with a specific, descriptive label.',
].join('\n- ');

const DESCRIPTION_RULE =
  'Give EVERY node a one-sentence "description" saying what belongs under it. Write each description to SEPARATE that node from its siblings - what goes here that does not go in the node next to it. Keep it under 160 characters. This is what later passes use to file a bookmark into the right branch.';

const OUTPUT_SPEC = `# Output
Return ONLY a JSON object, no prose, no markdown fences, of exactly this shape:
{"tree":[{"name":"Top","description":"What belongs under Top, and what does not.","children":[{"name":"Sub","description":"...","children":[{"name":"Leaf","description":"...","children":[]}]}]}]}
Every node has a non-empty "name" and a one-sentence "description"; leaf nodes have "children": [].`;

const INCREMENTAL_OUTPUT_SPEC = `# Output
Return ONLY a JSON object, no prose, no markdown fences, containing ONLY the categories you add, each under the path of existing categories that leads to it. Write every existing category on that path by its exact name (without the [owner] marker) with a "children" list; a new category gets a one-sentence "description". Do not repeat existing categories that gain nothing. The shape:
{"tree":[{"name":"Existing Top","children":[{"name":"New Sub","description":"What belongs under New Sub, and what does not.","children":[]}]},{"name":"New Top","description":"...","children":[]}]}
When the new bookmarks need nothing new, return {"tree":[]}.`;

/** One batch's designed tree, as the reconciliation prompt shows it. */
export interface PartialTaxonomy {
  tree: TaxonomyNode[];
  /** How many bookmarks the part was designed over - a rough weight for the merge. */
  bookmarkCount: number;
}

/**
 * Build the reconciliation prompt (issue #109): merge the trees designed for
 * each batch of an over-budget library into ONE coherent tree. The per-batch
 * trees overlap - the same topic under different names or at different depths
 * - so the crux is recognising equivalent categories, which is why every
 * node's description travels with it. The answer has the pass-1 shape, so it
 * goes through the same {@link parseTaxonomy}.
 */
export function buildReconcilePrompt(
  parts: PartialTaxonomy[],
  existingTreeText: string,
  minDepth: number,
  maxDepth: number,
  mode: TaxonomyMode = 'design',
): string {
  if (mode === 'incremental') return buildIncrementalReconcilePrompt(parts, existingTreeText, maxDepth);
  const trees = parts
    .map(
      (part, i) =>
        `## Part ${i + 1} of ${parts.length} (${part.bookmarkCount} bookmarks)\n${JSON.stringify({ tree: part.tree })}`,
    )
    .join('\n\n');
  return `You are merging category taxonomies for a person's X (Twitter) bookmarks.

The collection was too large to design in one request, so it was split into ${parts.length} parts and a taxonomy was designed for each part independently. Those per-part trees are below. They overlap: the same topic often appears in several parts under a different name or at a different place in the hierarchy. Merge them into ONE coherent, de-duplicated tree that reads as if it had been designed over the whole collection at once.

# Existing categories
${existingTreeText}
${EXISTING_RULE}

# Merge rules
- Treat categories that mean the same thing as ONE category even when their names differ (e.g. "AI Agents" and "Agentic AI", or "JS" and "JavaScript"). Judge by the descriptions, not only the names: labels that look different can cover the same material, and labels that look alike can cover different material.
- Give each merged category one clear, specific name, and merge the children of its equivalents recursively under it.
- Unify the nesting: when parts placed the same topic at different depths or under different parents, choose the one placement that fits the merged tree best. Never list the same topic twice in two places.
- Keep every topic: each category of every part must have a home in the merged tree, either as its own node or folded into an equivalent one.
- Build a genuinely nested hierarchy. Target AT LEAST ${minDepth} levels of nesting wherever the material supports it. Do not pad with empty filler nodes.
- Do NOT collapse everything into two or three broad buckets. Split broad areas into meaningful subtopics and give each branch real depth.
- Do not nest deeper than ${maxDepth} levels.
- ${DESCRIPTION_RULE} Rewrite descriptions where needed so they separate each node from its siblings in the MERGED tree.

# Per-part taxonomies
${trees}

${OUTPUT_SPEC}`;
}

/**
 * The incremental counterpart of {@link buildReconcilePrompt}: each part holds
 * only the categories its slice of the new bookmarks needs, so the merge
 * de-duplicates those additions against each other and against the fixed
 * tree, and answers in the incremental shape (additions only).
 */
function buildIncrementalReconcilePrompt(parts: PartialTaxonomy[], existingTreeText: string, maxDepth: number): string {
  const trees = parts
    .map(
      (part, i) =>
        `## Part ${i + 1} of ${parts.length} (${part.bookmarkCount} new bookmarks)\n${JSON.stringify({ tree: part.tree })}`,
    )
    .join('\n\n');
  return `You are merging proposed additions to the category taxonomy of a person's X (Twitter) bookmarks.

The person's new bookmarks were too many for one request, so they were split into ${parts.length} parts and the categories each part needs were proposed independently. Those proposals are below, each written as paths from the existing tree to the new categories. They overlap: the same new topic often appears in several parts under a different name or place. Merge them into ONE de-duplicated set of additions.

# Existing categories
${existingTreeText}
${INCREMENTAL_EXISTING_RULE}

# Merge rules
- Treat proposed categories that mean the same thing as ONE category even when their names differ, and drop any proposal that means the same thing as an existing category. Judge by the descriptions, not only the names.
- Keep every genuinely new topic: each proposed category must have a home, either as its own node or folded into an equivalent one.
- ${INCREMENTAL_ADD_RULES}
- Do not nest deeper than ${maxDepth} levels, counting from a top-level category.
- ${DESCRIPTION_RULE}

# Proposed additions
${trees}

${INCREMENTAL_OUTPUT_SPEC}`;
}

/** Strip surrounding markdown code fences if the model wrapped its JSON. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fence ? (fence[1] ?? '').trim() : trimmed;
}

/**
 * Extract the first balanced top-level JSON object or array from arbitrary text,
 * so a bare array (`[...]`) response is accepted as well as `{"tree":[...]}`.
 */
function extractJsonValue(text: string): string | undefined {
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  const candidates = [objStart, arrStart].filter((i) => i !== -1);
  if (candidates.length === 0) return undefined;
  const start = Math.min(...candidates);
  const open = text[start]!;
  const close = open === '{' ? '}' : ']';
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
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Recursively normalize an untrusted node array into clean TaxonomyNodes. */
function normalizeNodes(raw: unknown): TaxonomyNode[] {
  if (!Array.isArray(raw)) return [];
  const out: TaxonomyNode[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const nameRaw = (entry as { name?: unknown }).name;
    const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue; // drop duplicate siblings
    seen.add(key);
    const descriptionRaw = (entry as { description?: unknown }).description;
    const description =
      typeof descriptionRaw === 'string'
        ? descriptionRaw.replace(/\s+/g, ' ').trim().slice(0, MAX_NODE_DESCRIPTION_CHARS)
        : '';
    const node: TaxonomyNode = {
      name,
      children: normalizeNodes((entry as { children?: unknown }).children),
    };
    // Omit rather than store an empty string, so "has no description" is one
    // value everywhere (null in the DB, undefined here).
    if (description) node.description = description;
    out.push(node);
  }
  return out;
}

/**
 * Parse and validate the taxonomy-design response into a clean tree.
 *
 * Accepts either `{"tree":[...]}` or a bare top-level array. Nodes with empty
 * names are dropped and duplicate siblings collapsed. A node's optional
 * one-line `description` (issue #61) is whitespace-collapsed and length-capped;
 * a response that omits it parses exactly as before. Throws if no JSON is
 * present at all, so the caller fails loudly rather than proceeding with an
 * empty taxonomy.
 */
export function parseTaxonomy(responseText: string): TaxonomyNode[] {
  const jsonText = extractJsonValue(stripFences(responseText));
  if (!jsonText) {
    throw new Error(`Taxonomy response contained no JSON: ${responseText.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Taxonomy response was not valid JSON: ${(err as Error).message}`);
  }
  const treeRaw = (parsed as { tree?: unknown }).tree;
  return normalizeNodes(Array.isArray(treeRaw) ? treeRaw : parsed);
}

/**
 * Designs a category taxonomy holistically from a whole set of bookmarks.
 * Abstracted behind an interface so a fake can be injected in tests (no network,
 * no subscription usage), mirroring {@link import('./llm').BatchCategorizer}.
 */
export interface TaxonomyDesigner {
  /**
   * In `design` mode, the whole designed tree (existing anchors included); in
   * `incremental` mode, only the additions, each under its existing path -
   * possibly none. Either way the answer is merged by `materializeTaxonomy`.
   */
  designTaxonomy(
    bookmarks: RawBookmark[],
    existingTreeText: string,
    articleContext?: Map<string, ArticleContext>,
    mode?: TaxonomyMode,
  ): Promise<TaxonomyNode[]>;
}

export interface TaxonomyDesignerOptions {
  minDepth: number;
  maxDepth: number;
  /**
   * The taxonomy model's context window in tokens (issue #109), resolved
   * lazily because a catalog lookup can be async. Undefined, or a result of
   * undefined, means the model declares none and the safe
   * {@link DEFAULT_TAXONOMY_CONTEXT_WINDOW} applies.
   */
  contextWindow?: () => Promise<number | undefined>;
  /** Where a batched design announces itself; a single call logs nothing new. */
  log?: (message: string) => void;
}

/**
 * Designs a taxonomy by prompting an LLM. Pure orchestration around an injected
 * {@link LlmRunner}; the runner is expected to be the Opus-class, high-effort
 * model for this hard, large-context step.
 *
 * The prompt is sized against the model's context window first (issue #109).
 * When it fits - any normal library - this is ONE call, exactly as it always
 * was. Only past the budget is the library split into the fewest batches that
 * fit, one tree designed per batch, and a second call merges those trees into
 * one. Every call's failure propagates, so a batched design fails as loudly
 * as a single one and `recategorize` never clears the old tree for it.
 */
export class LlmTaxonomyDesigner implements TaxonomyDesigner {
  constructor(
    private readonly runner: LlmRunner,
    private readonly options: TaxonomyDesignerOptions,
  ) {}

  async designTaxonomy(
    bookmarks: RawBookmark[],
    existingTreeText: string,
    articleContext?: Map<string, ArticleContext>,
    mode: TaxonomyMode = 'design',
  ): Promise<TaxonomyNode[]> {
    if (bookmarks.length === 0) return [];
    const prompt = this.prompt(mode, bookmarks, existingTreeText, articleContext);
    const contextWindow = effectiveContextWindow(await this.options.contextWindow?.());
    const budget = inputBudgetFor(contextWindow);
    const estimate = estimateTokens(prompt);
    if (estimate <= budget) {
      const response = await this.runner(prompt);
      return parseTaxonomy(response);
    }
    this.log(
      `Taxonomy pass: ~${estimate} tokens for ${bookmarks.length} bookmarks exceeds the ~${budget}-token ` +
        `input budget of the model's ${contextWindow}-token context window; designing in batches, then merging them.`,
    );
    return this.designInBatches(mode, bookmarks, existingTreeText, articleContext, budget);
  }

  /** The pass-1 prompt for `mode`, over `bookmarks` (or one batch of them). */
  private prompt(
    mode: TaxonomyMode,
    bookmarks: RawBookmark[],
    existingTreeText: string,
    articleContext?: Map<string, ArticleContext>,
    batch?: TaxonomyBatch,
  ): string {
    const { minDepth, maxDepth } = this.options;
    return mode === 'incremental'
      ? buildIncrementalTaxonomyPrompt(bookmarks, existingTreeText, maxDepth, articleContext, batch)
      : buildTaxonomyPrompt(bookmarks, existingTreeText, minDepth, maxDepth, articleContext, batch);
  }

  private async designInBatches(
    mode: TaxonomyMode,
    bookmarks: RawBookmark[],
    existingTreeText: string,
    articleContext: Map<string, ArticleContext> | undefined,
    budget: number,
  ): Promise<TaxonomyNode[]> {
    const { minDepth, maxDepth } = this.options;
    // Upper bounds: the scaffold is measured with the widest part numbers any
    // plan could print, and each line with its index in the WHOLE list, which
    // is never shorter than its index within a batch.
    const widest = { index: bookmarks.length, count: bookmarks.length };
    const scaffold = estimateTokens(this.prompt(mode, [], existingTreeText, articleContext, widest));
    const weights = bookmarks.map((bm, i) => estimateTokens(`${compactLine(bm, i, articleContext)}\n`));
    const ranges = planBatches(weights, budget - scaffold);

    const parts: PartialTaxonomy[] = [];
    for (const [i, range] of ranges.entries()) {
      const slice = bookmarks.slice(range.start, range.end);
      const batch = { index: i + 1, count: ranges.length };
      const prompt = this.prompt(mode, slice, existingTreeText, articleContext, batch);
      this.log(`Designing taxonomy batch ${batch.index}/${batch.count} (${slice.length} bookmarks)...`);
      const tree = parseTaxonomy(await this.runner(prompt));
      // An empty DESIGNED part would silently leave its bookmarks' topics out
      // of the merged tree, so it fails the design like a malformed response
      // does. An incremental part may legitimately need nothing new.
      if (tree.length === 0) {
        if (mode === 'incremental') continue;
        throw new Error(`Taxonomy batch ${batch.index}/${batch.count} came back as an empty tree.`);
      }
      parts.push({ tree, bookmarkCount: slice.length });
    }
    if (parts.length === 0) return [];
    // A plan can come out as one batch at the budget's edge (the batch prompt's
    // wording differs slightly from the whole-library one), or only one
    // incremental part needed anything: nothing to merge.
    if (parts.length === 1) return parts[0]!.tree;

    const reconcile = buildReconcilePrompt(parts, existingTreeText, minDepth, maxDepth, mode);
    const reconcileEstimate = estimateTokens(reconcile);
    if (reconcileEstimate > budget) {
      throw new Error(
        `The ${parts.length} batch taxonomies need ~${reconcileEstimate} tokens to merge, over the ` +
          `~${budget}-token input budget of the taxonomy model's context window. Pick a taxonomy model with a larger window.`,
      );
    }
    this.log(`Merging ${parts.length} batch taxonomies into one tree...`);
    const merged = parseTaxonomy(await this.runner(reconcile));
    if (merged.length === 0) {
      throw new Error('Taxonomy reconciliation returned an empty tree; the batch taxonomies were not merged.');
    }
    return merged;
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}
