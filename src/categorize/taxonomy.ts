import type { LlmRunner } from './llm';
import type { ArticleContext } from '../articles/link-metadata';
import type { RawBookmark, TaxonomyNode } from '../types';

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
): string {
  const items = bookmarks.map((bm, i) => compactLine(bm, i, articleContext)).join('\n');
  return `You are designing a category taxonomy for a person's X (Twitter) bookmarks.

You are shown ALL of the bookmarks at once. Study the whole collection first, then design a single, coherent, DEEP nested tree of topic categories that organizes it well.

# Existing categories
${existingTreeText}
If the section above lists real categories, KEEP them and extend the tree around them; do not rename or delete existing nodes. If it says there are none, design the whole tree from scratch.

# Design goals
- Look across ALL bookmarks before choosing any label. Do not anchor on the first few you read.
- Build a genuinely nested hierarchy. Target AT LEAST ${minDepth} levels of nesting wherever the material supports it (e.g. "Top > Subtopic > Specific"). Sparse topics may be shallower - do not pad with empty filler nodes.
- Do NOT collapse everything into two or three broad buckets (like a bare "AI" or "Development" with no substructure). Split broad areas into meaningful subtopics and give each branch real depth.
- Use specific, descriptive labels. You have complete freedom over the labels and the structure.
- Do not nest deeper than ${maxDepth} levels.
- Give EVERY node a one-sentence "description" saying what belongs under it. Write each description to SEPARATE that node from its siblings - what goes here that does not go in the node next to it. Keep it under 160 characters. This is what later passes use to file a bookmark into the right branch.

# Bookmarks
${items}

# Output
Return ONLY a JSON object, no prose, no markdown fences, of exactly this shape:
{"tree":[{"name":"Top","description":"What belongs under Top, and what does not.","children":[{"name":"Sub","description":"...","children":[{"name":"Leaf","description":"...","children":[]}]}]}]}
Every node has a non-empty "name" and a one-sentence "description"; leaf nodes have "children": [].`;
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
  designTaxonomy(
    bookmarks: RawBookmark[],
    existingTreeText: string,
    articleContext?: Map<string, ArticleContext>,
  ): Promise<TaxonomyNode[]>;
}

export interface TaxonomyDesignerOptions {
  minDepth: number;
  maxDepth: number;
}

/**
 * Designs a taxonomy by prompting an LLM. Pure orchestration around an injected
 * {@link LlmRunner}; the runner is expected to be the Opus-class, high-effort
 * model for this hard, large-context step.
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
  ): Promise<TaxonomyNode[]> {
    if (bookmarks.length === 0) return [];
    const prompt = buildTaxonomyPrompt(
      bookmarks,
      existingTreeText,
      this.options.minDepth,
      this.options.maxDepth,
      articleContext,
    );
    const response = await this.runner(prompt);
    return parseTaxonomy(response);
  }
}
