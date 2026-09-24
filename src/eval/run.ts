/**
 * The categorizer comparison run: file every bookmark into ONE fresh tree with
 * BOTH assignment passes, diff the results, write the report.
 *
 * The design is one idea: hold the taxonomy fixed. Pass 1 is always Claude and
 * structurally cannot be Jev (Jev invents no labels), so the filing pass is the
 * only thing that can differ - and it only actually differs if both methods are
 * handed the identical tree and the identical article context. Both are built
 * ONCE here and shared.
 *
 * ## The library is never written to
 *
 * This is the invariant the whole command has to earn, and it is enforced
 * structurally rather than by care:
 *
 * - The fresh tree is materialized into a THROWAWAY database in a temp
 *   directory, removed when the run ends. `materializeTaxonomy` and
 *   `buildCategoryTree` run against that one, so the live `categories` table is
 *   never cleared, extended, or read for anything but its node count.
 * - Filings are compared in memory. Nothing is stored: `storeCategorizedBatch`
 *   is never called, so no `bookmarks`, `bookmark_categories`, `summaries` or
 *   `bookmark_scores` row is touched.
 * - The article/link context goes through {@link ReadThroughMetadataCache},
 *   which READS the live caches and buffers anything freshly fetched in memory.
 *   A normal `run` would populate `article_link_metadata` here; an eval must
 *   not, because "byte-identical" is the promise. Run `backfill-previews` first
 *   if you want those links cached for real.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BatchCategorizer } from '../categorize/llm';
import type { TaxonomyDesigner } from '../categorize/taxonomy';
import { buildCategoryTree, materializeTaxonomy, renderTreeForPrompt } from '../categorize/tree';
import type { LevelAsker } from '../categorize/typesafe/client';
import { buildBookmarkState } from '../categorize/typesafe/categorizer';
import { buildArticleContext, type ArticleMetadataCache } from '../articles/link-metadata';
import { HttpArticleFetcher, type ArticleFetcher } from '../articles/fetch-article';
import { Database } from '../db/database';
import { resolveExistingPathToLeafId } from '../ingest';
import type { ArticleLinkMetadata, CategoryTreeNode, RawBookmark, StoredBookmark, XArticle } from '../types';
import { compareFilings, type Comparison, type FiledPath, type Filing, type PairedFiling } from './compare';
import { fileWithJev, newJevUsage, type FileWithJevOptions, type JevUsage } from './jev';
import { renderEvalReport, type EvalCost, type EvalReport, type EvalReportMeta } from './report';

/** Text used for the "existing tree" section: the eval always designs from scratch. */
const EMPTY_TREE_TEXT = '(no categories yet)';

/** Rough characters-per-token, used only for the `--dry-run` cost estimate. */
const CHARS_PER_TOKEN = 4;

/**
 * An {@link ArticleMetadataCache} that reads the live caches and writes nowhere.
 *
 * The shape mirrors `backfill.ts`'s `forceFetchCache` view - a narrow adapter
 * around the real cache rather than a second fetcher - but inverted: that one
 * hides the cache to force a fetch and writes through, this one exposes the
 * cache and swallows the write, so a fetch performed for the eval never leaves
 * a row behind in the owner's library.
 */
export class ReadThroughMetadataCache implements ArticleMetadataCache {
  /** Fetched this run; keeps a URL shared by two bookmarks from being fetched twice. */
  private readonly buffered = new Map<string, ArticleLinkMetadata>();

  constructor(private readonly live: ArticleMetadataCache) {}

  getArticleLinkMetadata(url: string): ArticleLinkMetadata | undefined {
    return this.buffered.get(url) ?? this.live.getArticleLinkMetadata(url);
  }

  saveArticleLinkMetadata(record: ArticleLinkMetadata): void {
    this.buffered.set(record.url, record);
  }

  getXArticlesForBookmarks(
    bookmarks: Pick<RawBookmark, 'postId' | 'quotedPostId'>[],
  ): Map<string, { article: XArticle }> {
    return this.live.getXArticlesForBookmarks?.(bookmarks) ?? new Map();
  }
}

export interface EvalDeps {
  /** The owner's real library. READ ONLY - see the module comment. */
  db: Database;
  /** Pass 1, always Claude. The offline test seam. */
  taxonomer: TaxonomyDesigner;
  /** The free Claude filing pass, exactly as a real run builds it. */
  claude: BatchCategorizer;
  /** The paid Jev side's level asker. The offline test seam. */
  asker: LevelAsker;
  /** Usage tally the asker's metering transport writes into. */
  usage?: JevUsage;
  /** Same seam as `IngestDeps.articleFetcher`; defaults to the real HTTP fetcher. */
  articleFetcher?: ArticleFetcher;
  /** Parent directory for the throwaway tree database. Defaults to the OS temp directory. */
  scratchDir?: string;
  logger?: (message: string) => void;
  /** Injected clock, so a test can assert the rendered document. */
  now?: () => Date;
}

export interface EvalOptions {
  /** Bookmarks per Claude assignment request - the same knob a real run uses. */
  batchSize: number;
  maxDepth: number;
  /** Beam/threshold/concurrency settings for the Jev walk. */
  walk: FileWithJevOptions;
  /** Compare only the N most recently ingested bookmarks - a cost ceiling. */
  limit?: number;
  disagreementRows?: number;
  topCategories?: number;
  /** Model/provider strings for the report header, resolved by the caller. */
  models: Pick<
    EvalReportMeta,
    'taxonomyProvider' | 'taxonomyModel' | 'taxonomyEffort' | 'claudeProvider' | 'claudeModel' | 'jevModel'
  >;
}

export interface EvalRunResult {
  report: EvalReport;
  markdown: string;
  comparison: Comparison;
}

/** What a `--dry-run` reports, having made no call of any kind. */
export interface EvalPlan {
  /** Bookmarks that would be compared. */
  bookmarks: number;
  /** Bookmarks stored in the library. */
  libraryBookmarks: number;
  /** Nodes in the CURRENT live tree - a stand-in size, since the eval designs a fresh one. */
  liveTreeNodes: number;
  /** Upper bound on TypeSafe requests: one per tree level per bookmark. */
  jevRequestsUpperBound: number;
  /** Rough input tokens the Jev side would be billed. See {@link planCategorizerEval}. */
  estimatedJevInputTokens: number;
}

/** The bookmarks a run would cover, newest-ingested first, honoring `--limit`. */
function selectBookmarks(db: Database, limit?: number): StoredBookmark[] {
  const all = db.getAllBookmarks();
  return limit != null && limit > 0 ? all.slice(0, limit) : all;
}

/**
 * Report the size and rough price of a run WITHOUT making a single call - not
 * to TypeSafe, and not to the taxonomy model either (pass 1 is free but it
 * burns real subscription quota and minutes, so a dry run has no business
 * spending it).
 *
 * The token figure is an estimate and says so: the state is re-sent once per
 * tree level, so it is (state characters / ~4) x maxDepth, summed. It excludes
 * the per-level choice criteria and the linked-article context (which a dry run
 * deliberately does not fetch), so treat it as a floor on the order of
 * magnitude rather than a quote.
 */
export function planCategorizerEval(db: Database, options: { maxDepth: number; limit?: number }): EvalPlan {
  const bookmarks = selectBookmarks(db, options.limit);
  const stateChars = bookmarks.reduce(
    (sum, bm) => sum + JSON.stringify(buildBookmarkState(bm)).length,
    0,
  );
  return {
    bookmarks: bookmarks.length,
    libraryBookmarks: db.getBookmarkCount(),
    liveTreeNodes: db.getAllCategories().length,
    jevRequestsUpperBound: bookmarks.length * options.maxDepth,
    estimatedJevInputTokens: Math.ceil((stateChars / CHARS_PER_TOKEN) * options.maxDepth),
  };
}

/** Index the eval tree by node id, so a leaf id yields its canonical path and root. */
function indexTree(roots: CategoryTreeNode[]): Map<number, CategoryTreeNode> {
  const byId = new Map<number, CategoryTreeNode>();
  const walk = (nodes: CategoryTreeNode[]) => {
    for (const node of nodes) {
      byId.set(node.id, node);
      walk(node.children);
    }
  };
  walk(roots);
  return byId;
}

/**
 * Turn a leaf id into the {@link FiledPath} every metric and table is built
 * from, using the TREE's own names rather than whatever a method wrote.
 *
 * Canonicalizing here is what lets agreement be compared on ids: two methods
 * that reached the same node by spelling it differently are the same filing,
 * and two identically named nodes under different parents are not.
 */
function toFiledPath(byId: Map<number, CategoryTreeNode>, leafId: number): FiledPath | undefined {
  const leaf = byId.get(leafId);
  if (!leaf) return undefined;
  let root = leaf;
  while (root.parentId != null) {
    const parent = byId.get(root.parentId);
    if (!parent) break;
    root = parent;
  }
  return { leafId, rootId: root.id, names: leaf.path };
}

/** Collapse a list of leaf ids into a deduplicated filing, preserving order. */
function toFiling(byId: Map<number, CategoryTreeNode>, leafIds: (number | undefined)[]): Filing {
  const paths: FiledPath[] = [];
  const seen = new Set<number>();
  for (const leafId of leafIds) {
    if (leafId == null || seen.has(leafId)) continue;
    const filed = toFiledPath(byId, leafId);
    if (!filed) continue;
    seen.add(leafId);
    paths.push(filed);
  }
  return { paths };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Run the whole comparison and return the rendered report.
 *
 * Writing the file is the caller's job (see `src/index.ts`), so this function
 * is entirely testable: it opens one throwaway database, deletes it, and
 * returns a string.
 */
export async function runCategorizerEval(
  deps: EvalDeps,
  options: EvalOptions,
): Promise<EvalRunResult> {
  const { db, taxonomer, claude, asker } = deps;
  const log = deps.logger ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const usage = deps.usage ?? newJevUsage();

  const bookmarks = selectBookmarks(db, options.limit);
  if (bookmarks.length === 0) throw new Error('No stored bookmarks to compare. Run a sync first.');
  const libraryBookmarks = db.getBookmarkCount();
  log(
    `Comparing ${bookmarks.length} bookmark(s)` +
      (bookmarks.length === libraryBookmarks ? '.' : ` of ${libraryBookmarks} in the library.`),
  );

  // ONE article context, shared by both methods: if the two passes saw
  // different link metadata, the diff would be measuring the fetcher.
  log('Building the shared article/link context (nothing is cached back to your library)...');
  const articleFetcher = deps.articleFetcher ?? new HttpArticleFetcher();
  const articleContext = await buildArticleContext(
    bookmarks,
    articleFetcher,
    new ReadThroughMetadataCache(db),
  );

  // Always a directory we made ourselves, so the cleanup below can never
  // delete something the caller wanted to keep.
  const scratchBase = deps.scratchDir ?? os.tmpdir();
  fs.mkdirSync(scratchBase, { recursive: true });
  const scratchDir = fs.mkdtempSync(path.join(scratchBase, 'xbo-eval-'));
  const scratch = new Database(path.join(scratchDir, 'eval-tree.db'));

  try {
    log('Designing one fresh taxonomy over the whole library (pass 1, Claude)...');
    const taxonomyStarted = Date.now();
    const taxonomy = await taxonomer.designTaxonomy(bookmarks, EMPTY_TREE_TEXT, articleContext);
    const taxonomyMs = Date.now() - taxonomyStarted;
    // Materialized into the THROWAWAY database, never the owner's - which is
    // also why the real `materializeTaxonomy` can be reused as-is: the eval
    // tree then has exactly a real run's depth cap, name trimming and
    // case-insensitive sibling merging.
    materializeTaxonomy(scratch, taxonomy, options.maxDepth, now().toISOString());
    const tree = buildCategoryTree(scratch);
    const byId = indexTree(tree);
    if (tree.length === 0) throw new Error('The taxonomy pass returned no categories; nothing to file into.');
    log(`Eval tree: ${byId.size} node(s) in ${tree.length} top-level branch(es).`);

    const treeText = renderTreeForPrompt(tree);
    const when = now().toISOString();

    log('Filing with the Claude assignment pass (free, subscription)...');
    const claudeStarted = Date.now();
    const claudeByPostId = new Map<string, string[][]>();
    const batches = chunk(bookmarks, options.batchSize);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]!;
      // The tree text is rendered ONCE outside the loop: filing never adds a
      // node, so every batch sees the identical tree Jev sees.
      const assignments = await claude.categorizeBatch(batch, treeText, articleContext);
      for (const a of assignments) claudeByPostId.set(a.postId, a.categories);
      log(`Claude: filed batch ${i + 1}/${batches.length} (${batch.length} bookmark(s)).`);
    }
    const claudeMs = Date.now() - claudeStarted;

    log('Filing with the TypeSafe/Jev assignment pass (PAID per token)...');
    const jevStarted = Date.now();
    const jevFilings = await fileWithJev(bookmarks, tree, asker, options.walk, articleContext);
    const jevMs = Date.now() - jevStarted;
    const jevByPostId = new Map(jevFilings.map((f) => [f.postId, f]));

    const pairs: PairedFiling[] = bookmarks.map((bm) => {
      const claudePaths = claudeByPostId.get(bm.postId) ?? [];
      const jev = jevByPostId.get(bm.postId);
      const jevPrimary = jev?.paths[0];
      return {
        postId: bm.postId,
        author: `@${bm.authorUsername}`,
        text: bm.text,
        claude: toFiling(
          byId,
          claudePaths.map((p) => resolveExistingPathToLeafId(scratch, p, options.maxDepth, when)),
        ),
        jev: toFiling(byId, (jev?.paths ?? []).map((p) => p.nodeIds[p.nodeIds.length - 1])),
        ...(jevPrimary ? { jevConfidence: jevPrimary.score } : {}),
        jevEarlyStopped: jev?.earlyStopped ?? false,
        jevUnresolved: jev?.unresolved ?? true,
        ...(jev?.error ? { jevError: jev.error } : {}),
      };
    });

    const comparison = compareFilings(pairs, {
      ...(options.disagreementRows != null ? { disagreementRows: options.disagreementRows } : {}),
      ...(options.topCategories != null ? { topCategories: options.topCategories } : {}),
    });

    const cost: EvalCost = {
      taxonomyMs,
      claudeMs,
      jevMs,
      jevRequests: usage.requests,
      jevInputTokens: usage.inputTokens,
    };
    const meta: EvalReportMeta = {
      generatedAt: now().toISOString(),
      bookmarks: bookmarks.length,
      libraryBookmarks,
      treeNodes: byId.size,
      treeRoots: tree.length,
      maxDepth: options.maxDepth,
      beamWidth: options.walk.beamWidth,
      confidenceThreshold: options.walk.confidenceThreshold,
      multiLabelThreshold: options.walk.multiLabelThreshold,
      maxLabels: options.walk.maxLabels,
      ...options.models,
    };
    const report: EvalReport = { meta, cost, comparison };
    return { report, markdown: renderEvalReport(report), comparison };
  } finally {
    scratch.close();
    // The throwaway tree has served its purpose; leaving it behind would be a
    // second copy of the owner's taxonomy sitting in a temp directory.
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}
