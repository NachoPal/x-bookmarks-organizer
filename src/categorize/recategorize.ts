/**
 * The in-app recategorize, end to end: generate a proposal (phase 1, no data
 * changed), and accept it (write the tree, then re-file every stored bookmark
 * from scratch with phase 2).
 *
 * Built on the same pieces a sync and the CLI `recategorize` use - the one
 * article-context builder (`loadArticleContext`), the one pass-1 designer
 * (`TaxonomyDesigner`, whose prompts every caller shares), the one filing
 * interface (`BatchCategorizer`) and the one strict resolver
 * (`strictFilings`) - so whatever a sync's prompts are given, these are too.
 *
 * Atomicity: the tree is written, the draft cleared and the list of posts
 * still to re-file recorded in ONE transaction, so a failure before that
 * point leaves the old tree and every link exactly as they were. The re-file
 * then runs batch by batch, each batch's new links and its "done" mark
 * landing together; a failure part way leaves a clear count and the rest
 * recorded for {@link refileRemaining} to finish.
 */
import { RECATEGORIZE_REFILE_KEY, type Database } from '../db/database';
import type { ArticleFetcher } from '../articles/fetch-article';
import { chunk, loadArticleContext, strictFilings } from '../ingest';
import type { BatchCategorizer } from './llm';
import type { TaxonomyDesigner } from './taxonomy';
import { buildCategoryTree, renderTreeForPrompt } from './tree';
import {
  applyDraft,
  clearDraft,
  diffDraft,
  editDraft,
  proposalFromAdditions,
  proposalFromDesign,
  readDraft,
  writeDraft,
  type RecategorizeDraft,
  type RecategorizeMode,
} from './proposal';

export interface ProposalSummary {
  kind: 'proposal';
  mode: RecategorizeMode;
  bookmarks: number;
  added: number;
  removed: number;
  renamed: number;
  moved: number;
}

export interface ApplySummary {
  kind: 'apply';
  mode: RecategorizeMode;
  /** Posts re-filed by this run. */
  refiled: number;
  /** Posts the accepted tree was re-filed over in all (a retry included). */
  total: number;
  created: number;
  deleted: number;
}

export type RecategorizeSummary = ProposalSummary | ApplySummary;

/** What a partial re-file left to do, as `run_state` records it. */
export interface RefileState {
  mode: RecategorizeMode;
  total: number;
  remaining: number[];
  created: number;
  deleted: number;
}

export const NO_BOOKMARKS_MESSAGE = 'There are no stored bookmarks to recategorize yet. Sync first.';
export const NO_DRAFT_MESSAGE = 'There is no proposal to accept. Start a new one from Recategorize.';
export const NOTHING_TO_REFILE_MESSAGE = 'Every post is already re-filed into the accepted tree.';

export interface ProposalDeps {
  db: Database;
  taxonomer: TaxonomyDesigner;
  maxDepth: number;
  articleFetcher?: ArticleFetcher;
  logger?: (message: string) => void;
}

/**
 * Phase 1 over every stored bookmark, stored as a DRAFT - nothing in the
 * library changes. `redesign` designs a whole new tree with the current one
 * as context; `extend` is the incremental pass a sync runs, over the whole
 * library, answering with additions only.
 */
export async function generateProposal(deps: ProposalDeps, mode: RecategorizeMode): Promise<ProposalSummary> {
  const { db, taxonomer, maxDepth } = deps;
  const log = deps.logger ?? (() => {});
  const bookmarks = db.getAllBookmarks();
  if (bookmarks.length === 0) throw new Error(NO_BOOKMARKS_MESSAGE);
  log(`Proposing ${mode === 'redesign' ? 'a new category tree' : 'additions to your tree'} over ${bookmarks.length} stored bookmark(s).`);

  const articleContext = await loadArticleContext(db, bookmarks, deps.articleFetcher, log);
  const live = buildCategoryTree(db);
  const treeText = renderTreeForPrompt(live);

  let tree;
  if (mode === 'redesign') {
    log('Designing a new taxonomy (pass 1)...');
    const designed = await taxonomer.designTaxonomy(bookmarks, treeText, articleContext, 'redesign');
    if (designed.length === 0) throw new Error('The taxonomy model proposed an empty tree. Nothing was changed; try again.');
    tree = proposalFromDesign(designed, live, maxDepth);
  } else {
    log('Looking for categories your bookmarks need that the tree lacks (pass 1)...');
    const additions = await taxonomer.designTaxonomy(bookmarks, treeText, articleContext, 'incremental');
    tree = proposalFromAdditions(additions, live, maxDepth);
  }

  const now = new Date().toISOString();
  const draft: RecategorizeDraft = { version: 1, mode, createdAt: now, updatedAt: now, bookmarkCount: bookmarks.length, tree };
  writeDraft(db, draft);
  const diff = diffDraft(draft, live);
  log(
    mode === 'redesign'
      ? `Proposal ready: ${diff.added} new, ${diff.renamed} renamed, ${diff.moved} moved, ${diff.removed} removed. Review it before anything changes.`
      : diff.added > 0
        ? `Proposal ready: ${diff.added} categor${diff.added === 1 ? 'y' : 'ies'} to add. Review them before anything changes.`
        : 'Proposal ready: your tree already covers your bookmarks - nothing to add.',
  );
  return {
    kind: 'proposal',
    mode,
    bookmarks: bookmarks.length,
    added: diff.added,
    removed: diff.removed,
    renamed: diff.renamed,
    moved: diff.moved,
  };
}

export interface RefileDeps {
  db: Database;
  categorizer: BatchCategorizer;
  batchSize: number;
  maxDepth: number;
  articleFetcher?: ArticleFetcher;
  logger?: (message: string) => void;
}

export function readRefileState(db: Database): RefileState | undefined {
  const raw = db.getState(RECATEGORIZE_REFILE_KEY);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<RefileState>;
    if (!Array.isArray(parsed.remaining) || (parsed.mode !== 'redesign' && parsed.mode !== 'extend')) return undefined;
    return {
      mode: parsed.mode,
      total: Number(parsed.total) || parsed.remaining.length,
      remaining: parsed.remaining.filter((id): id is number => Number.isInteger(id)),
      created: Number(parsed.created) || 0,
      deleted: Number(parsed.deleted) || 0,
    };
  } catch {
    return undefined;
  }
}

function writeRefileState(db: Database, state: RefileState): void {
  db.setState(RECATEGORIZE_REFILE_KEY, JSON.stringify(state));
}

/**
 * Accept the stored draft: write the tree (replace, or add), clear the draft
 * and record every stored bookmark as still to re-file - all in ONE
 * transaction - then re-file them all.
 */
export async function acceptProposal(deps: RefileDeps): Promise<ApplySummary> {
  const { db, maxDepth } = deps;
  const log = deps.logger ?? (() => {});
  const draft = readDraft(db, maxDepth);
  if (!draft) throw new Error(NO_DRAFT_MESSAGE);
  // The stored draft was valid when saved; the live tree may have moved since.
  const checked = editDraft(db, draft, draft.tree, maxDepth);
  if (!checked.draft) throw new Error(`The proposal cannot be applied: ${checked.errors.join(' ')}`);

  const bookmarkIds = db.getAllBookmarks().map((b) => b.id);
  const when = new Date().toISOString();
  const applied = db.inTransaction(() => {
    const result = applyDraft(db, checked.draft!, when);
    clearDraft(db);
    writeRefileState(db, { mode: draft.mode, total: bookmarkIds.length, remaining: bookmarkIds, ...result });
    return result;
  });
  log(
    draft.mode === 'redesign'
      ? `Replaced the category tree (${applied.created} new categor${applied.created === 1 ? 'y' : 'ies'}, ${applied.deleted} removed).`
      : `Added ${applied.created} categor${applied.created === 1 ? 'y' : 'ies'} to your tree.`,
  );
  return refileRemaining(deps);
}

/**
 * Re-file every post an accepted recategorize has not yet re-filed - the
 * whole library right after an accept, or what a failed run left. Each post's
 * links are REPLACED (a post the owner moved by hand goes wherever phase 2
 * files it now), strictly into the tree, `Uncategorized` when nothing fits.
 */
export async function refileRemaining(deps: RefileDeps): Promise<ApplySummary> {
  const { db, categorizer, batchSize, maxDepth } = deps;
  const log = deps.logger ?? (() => {});
  const state = readRefileState(db);
  if (!state) throw new Error(NOTHING_TO_REFILE_MESSAGE);

  const wanted = new Set(state.remaining);
  // A post deleted since simply drops out.
  const bookmarks = db.getAllBookmarks().filter((b) => wanted.has(b.id));
  let remaining = new Set(bookmarks.map((b) => b.id));
  const summary = (refiled: number): ApplySummary => ({
    kind: 'apply',
    mode: state.mode,
    refiled,
    total: state.total,
    created: state.created,
    deleted: state.deleted,
  });
  if (bookmarks.length === 0) {
    db.deleteState(RECATEGORIZE_REFILE_KEY);
    log('Every post is re-filed.');
    return summary(0);
  }

  const articleContext = await loadArticleContext(db, bookmarks, deps.articleFetcher, log);
  const treeText = renderTreeForPrompt(buildCategoryTree(db));
  const batches = chunk(bookmarks, batchSize);
  log(`Re-filing ${bookmarks.length} post(s) into the tree in ${batches.length} batch(es) (pass 2).`);
  let refiled = 0;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    try {
      const assignments = await categorizer.categorizeBatch(batch, treeText, articleContext);
      const when = new Date().toISOString();
      const filings = strictFilings(db, batch, assignments, maxDepth, when);
      const next = new Set(remaining);
      for (const bm of batch) next.delete(bm.id);
      db.refileBookmarks(filings, () => writeRefileState(db, { ...state, remaining: [...next] }));
      remaining = next;
    } catch (err) {
      const reason = err instanceof Error && err.message ? err.message : String(err);
      const done = state.total - remaining.size;
      throw new Error(
        `Re-filed ${done} of ${state.total} posts, then the filing pass failed: ${reason} ` +
          `The new tree is in place; press Try again to re-file the remaining ${remaining.size}.`,
      );
    }
    refiled += batch.length;
    log(`Re-filed batch ${i + 1}/${batches.length} (${batch.length} post(s)).`);
  }
  db.deleteState(RECATEGORIZE_REFILE_KEY);
  log('Done: every post is filed into the new tree.');
  return summary(refiled);
}
