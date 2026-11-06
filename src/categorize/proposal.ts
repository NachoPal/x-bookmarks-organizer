/**
 * The in-app recategorize's PROPOSAL: a category tree the owner reviews and
 * edits before it changes anything.
 *
 * Two modes, the owner's two options:
 *
 * - `redesign` ("Propose a new tree"): phase 1 designs a complete new tree
 *   over every stored bookmark, shown the current tree as context only. The
 *   proposal may restructure anything - the owner's own categories included,
 *   because the owner decides in the review. Accepting REPLACES the tree.
 * - `extend` ("Keep the tree, only add"): phase 1 runs incrementally over
 *   every stored bookmark against the whole current tree and answers with
 *   additions only. The proposal is the current tree, locked, plus those
 *   additions; only the additions can be edited. Accepting only ADDS.
 *
 * Either way the draft lives in `run_state` (`RECATEGORIZE_DRAFT_KEY`), never
 * in the live tree, so generating, editing and cancelling a proposal change
 * no data at all, and the draft survives a reload until it is accepted or
 * cancelled. Everything here except {@link applyDraft} and the draft storage
 * is pure.
 *
 * A draft node may name the existing category it KEEPS (`sourceId`): a
 * designed node matched to a current category by name. Keeping the row keeps
 * its id - so the posts in it stay linked until they are re-filed - and is
 * what the diff (added / removed / renamed / moved) and the origin rule
 * (a node kept from one of the owner's categories stays the owner's) read.
 */
import { RECATEGORIZE_DRAFT_KEY, type Database, type PlannedCategory } from '../db/database';
import type { CategoryNode, CategoryOrigin, CategoryTreeNode, TaxonomyNode } from '../types';
import { nameKey, stripOwnerMarker } from './owner-categories';
import { buildCategoryTree, writeRootOrder } from './tree';

export type RecategorizeMode = 'redesign' | 'extend';

export const RECATEGORIZE_MODES: RecategorizeMode[] = ['redesign', 'extend'];

export function isRecategorizeMode(value: unknown): value is RecategorizeMode {
  return value === 'redesign' || value === 'extend';
}

/** Longest category name a draft may carry. */
export const MAX_DRAFT_NAME_CHARS = 120;
/** Longest description kept on a draft node. */
export const MAX_DRAFT_DESCRIPTION_CHARS = 300;
/** A bound on how big a proposal may grow, so a PUT cannot balloon `run_state`. */
export const MAX_DRAFT_NODES = 2000;

export interface DraftNode {
  /** Unique within the draft; the editor's handle on the node. */
  id: number;
  name: string;
  description?: string | null;
  /** The existing category this node keeps, or absent for a new one. */
  sourceId?: number;
  /** The owner created or renamed it in the review - it becomes theirs. */
  edited?: boolean;
  children: DraftNode[];
}

export interface RecategorizeDraft {
  version: 1;
  mode: RecategorizeMode;
  createdAt: string;
  updatedAt: string;
  /** How many stored bookmarks the proposal was designed over. */
  bookmarkCount: number;
  tree: DraftNode[];
}

/** How a draft differs from the live tree. */
export interface DraftDiff {
  added: number;
  removed: number;
  renamed: number;
  moved: number;
  /** The live categories the proposal drops, as paths - nothing in the editor shows them. */
  removedPaths: string[][];
}

/** A draft node as the editor shows it: what it would become, and how it differs. */
export interface DraftNodeView {
  id: number;
  name: string;
  description: string | null;
  sourceId: number | null;
  edited: boolean;
  /** Extend mode: an existing category, shown but not editable. */
  locked: boolean;
  /** The origin it would carry once accepted. */
  origin: CategoryOrigin;
  change: { added?: true; renamedFrom?: string; movedFrom?: string[] };
  /** Posts filed in the kept category's subtree today (0 for a new node). */
  total: number;
  children: DraftNodeView[];
}

// ---- building a proposal from a phase-1 answer ------------------------------

interface LiveIndex {
  byId: Map<number, CategoryTreeNode>;
  roots: CategoryTreeNode[];
}

function indexLive(roots: CategoryTreeNode[]): LiveIndex {
  const byId = new Map<number, CategoryTreeNode>();
  const walk = (nodes: CategoryTreeNode[]) => {
    for (const n of nodes) {
      byId.set(n.id, n);
      walk(n.children);
    }
  };
  walk(roots);
  return { byId, roots };
}

function cleanName(raw: string): string {
  return stripOwnerMarker(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_DRAFT_NAME_CHARS);
}

function cleanDescription(raw: string | null | undefined): string | null {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, MAX_DRAFT_DESCRIPTION_CHARS) : '';
  return text || null;
}

/** Hands out draft ids, never reusing one already taken. */
function idAllocator(taken: Iterable<number> = []): (wanted?: number) => number {
  const used = new Set(taken);
  let next = 1;
  return (wanted) => {
    if (wanted !== undefined && Number.isInteger(wanted) && wanted > 0 && !used.has(wanted)) {
      used.add(wanted);
      return wanted;
    }
    while (used.has(next)) next += 1;
    used.add(next);
    return next;
  };
}

/**
 * Turn a `redesign` answer into draft nodes, matching each designed node to
 * the current category it most plausibly IS: first the child of the matched
 * parent with the same name (`nameKey`, so "LLM" is "LLMs"), else the one
 * unused current category of that name anywhere (the design moved it).
 * Siblings with the same name collapse; depth is capped at `maxDepth`.
 */
export function proposalFromDesign(
  designed: TaxonomyNode[],
  live: CategoryTreeNode[],
  maxDepth: number,
): DraftNode[] {
  const index = indexLive(live);
  const used = new Set<number>();
  const allLive = [...index.byId.values()];
  const nextId = idAllocator();

  const matchFor = (name: string, siblings: CategoryTreeNode[]): CategoryTreeNode | undefined => {
    const key = nameKey(name);
    if (!key) return undefined;
    const local = siblings.find((c) => !used.has(c.id) && nameKey(c.name) === key);
    if (local) return local;
    // Not where it was: the design may have moved it.
    const elsewhere = allLive.filter((c) => !used.has(c.id) && nameKey(c.name) === key);
    return elsewhere.length === 1 ? elsewhere[0] : undefined;
  };

  const walk = (nodes: TaxonomyNode[], siblings: CategoryTreeNode[], depth: number): DraftNode[] => {
    if (depth >= maxDepth) return [];
    const out: DraftNode[] = [];
    const seen = new Set<string>();
    for (const node of nodes) {
      const name = cleanName(node.name);
      const lower = name.toLowerCase();
      if (!name || seen.has(lower)) continue;
      seen.add(lower);
      const source = matchFor(name, siblings);
      if (source) used.add(source.id);
      const draft: DraftNode = {
        id: nextId(),
        name,
        description: cleanDescription(node.description) ?? source?.description ?? null,
        ...(source ? { sourceId: source.id } : {}),
        children: [],
      };
      // Under a new node there are no current siblings to prefer.
      draft.children = walk(node.children ?? [], source ? source.children : [], depth + 1);
      out.push(draft);
    }
    return out;
  };
  return walk(designed, index.roots, 0);
}

/** The live tree as locked draft nodes, each keeping its own row (and its id as the draft id). */
function liveAsDraft(live: CategoryTreeNode[]): DraftNode[] {
  return live.map((n) => ({
    id: n.id,
    name: n.name,
    description: n.description ?? null,
    sourceId: n.id,
    children: liveAsDraft(n.children),
  }));
}

/**
 * Turn an `extend` (incremental) answer into a draft: the whole current tree,
 * locked, with the additions merged in the way `materializeTaxonomy` would
 * merge them - a node that names an existing category (`nameKey`) walks into
 * it, anything else is a new category with its whole subtree.
 */
export function proposalFromAdditions(
  additions: TaxonomyNode[],
  live: CategoryTreeNode[],
  maxDepth: number,
): DraftNode[] {
  const tree = liveAsDraft(live);
  const taken: number[] = [];
  const collect = (nodes: DraftNode[]) => nodes.forEach((n) => (taken.push(n.id), collect(n.children)));
  collect(tree);
  const nextId = idAllocator(taken);

  const fresh = (node: TaxonomyNode, depth: number): DraftNode | undefined => {
    const name = cleanName(node.name);
    if (!name || depth >= maxDepth) return undefined;
    const seen = new Set<string>();
    const children: DraftNode[] = [];
    for (const child of node.children ?? []) {
      const made = fresh(child, depth + 1);
      if (made && !seen.has(made.name.toLowerCase())) {
        seen.add(made.name.toLowerCase());
        children.push(made);
      }
    }
    return { id: nextId(), name, description: cleanDescription(node.description), children };
  };

  const merge = (nodes: TaxonomyNode[], into: DraftNode[], depth: number) => {
    if (depth >= maxDepth) return;
    for (const node of nodes) {
      const name = cleanName(node.name);
      const key = nameKey(name);
      if (!key) continue;
      const existing = into.find((n) => nameKey(n.name) === key);
      if (existing) {
        merge(node.children ?? [], existing.children, depth + 1);
        continue;
      }
      const made = fresh(node, depth);
      if (made) into.push(made);
    }
  };
  merge(additions, tree, 0);
  return tree;
}

// ---- normalizing what the editor sends back ---------------------------------

/**
 * Coerce an untrusted tree (a PUT body, or a stored draft read back) into
 * draft nodes: names cleaned, ids made unique, unknown or repeated
 * `sourceId`s dropped. Problems the owner must fix - an empty name, two
 * siblings of one name, a tree past `maxDepth`, too many nodes - are
 * returned as sentences rather than silently repaired.
 */
export function parseDraftTree(
  raw: unknown,
  liveIds: Set<number>,
  maxDepth: number,
): { tree: DraftNode[]; errors: string[] } {
  const errors: string[] = [];
  const usedSources = new Set<number>();
  const reserved = new Set<number>();
  let count = 0;
  const allIds = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (entry && typeof entry === 'object') {
        const id = (entry as { id?: unknown }).id;
        if (Number.isInteger(id)) reserved.add(id as number);
        allIds((entry as { children?: unknown }).children);
      }
    }
  };
  allIds(raw);
  const usedIds = new Set<number>();
  let next = 1;
  // The id the client gave, unless another node already took it; a duplicate
  // or missing one gets an id no node asked for.
  const claim = (wanted: unknown): number => {
    if (Number.isInteger(wanted) && (wanted as number) > 0 && !usedIds.has(wanted as number)) {
      usedIds.add(wanted as number);
      return wanted as number;
    }
    while (usedIds.has(next) || reserved.has(next)) next += 1;
    usedIds.add(next);
    return next;
  };

  const walk = (list: unknown, depth: number, parentName: string | null): DraftNode[] => {
    if (!Array.isArray(list)) return [];
    const out: DraftNode[] = [];
    const names = new Map<string, string>();
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      count += 1;
      const name = typeof e.name === 'string' ? cleanName(e.name) : '';
      if (!name) {
        errors.push(parentName ? `A category in “${parentName}” has no name.` : 'A top-level category has no name.');
      } else {
        const lower = name.toLowerCase();
        if (names.has(lower)) {
          errors.push(
            parentName
              ? `“${parentName}” has two categories called “${name}”.`
              : `There are two top-level categories called “${name}”.`,
          );
        }
        names.set(lower, name);
      }
      if (depth >= maxDepth) {
        errors.push(`“${name || 'A category'}” is nested too deep; categories go at most ${maxDepth} levels deep.`);
      }
      const sourceRaw = e.sourceId;
      let sourceId: number | undefined;
      if (Number.isInteger(sourceRaw) && liveIds.has(sourceRaw as number) && !usedSources.has(sourceRaw as number)) {
        sourceId = sourceRaw as number;
        usedSources.add(sourceId);
      }
      const node: DraftNode = {
        id: claim(e.id),
        name,
        description: cleanDescription(e.description as string | null | undefined),
        ...(sourceId !== undefined ? { sourceId } : {}),
        ...(e.edited === true ? { edited: true } : {}),
        children: [],
      };
      node.children = walk(e.children, depth + 1, name || parentName);
      out.push(node);
    }
    return out;
  };
  const tree = walk(raw, 0, null);
  if (count > MAX_DRAFT_NODES) errors.push(`A proposal can hold at most ${MAX_DRAFT_NODES} categories.`);
  return { tree, errors: [...new Set(errors)] };
}

/**
 * The `extend` invariant, enforced structurally: whatever the editor sent,
 * the result is the CURRENT tree exactly as it is, plus only the nodes the
 * client tree adds under it. An addition is a node with no (valid) source
 * under a kept node - or at the top - and its whole subtree; a kept node the
 * client renamed, moved or dropped comes back untouched, and an addition
 * whose kept parent no longer exists is dropped with it. This is also how a
 * stored extend draft follows the live tree when a sync adds categories.
 */
export function rebaseAdditions(client: DraftNode[], live: CategoryTreeNode[]): DraftNode[] {
  const tree = liveAsDraft(live);
  const bySource = new Map<number, DraftNode>();
  const index = (nodes: DraftNode[]) => nodes.forEach((n) => (bySource.set(n.sourceId!, n), index(n.children)));
  index(tree);
  const taken: number[] = [];
  const collect = (nodes: DraftNode[]) => nodes.forEach((n) => (taken.push(n.id), collect(n.children)));
  collect(tree);
  const nextId = idAllocator(taken);
  const strip = (n: DraftNode): DraftNode => ({
    id: nextId(n.id),
    name: n.name,
    description: n.description ?? null,
    ...(n.edited ? { edited: true } : {}),
    // A kept category the client dragged inside an addition stays where it is.
    children: n.children.filter((c) => c.sourceId === undefined || !bySource.has(c.sourceId)).map(strip),
  });
  const attach = (nodes: DraftNode[], into: DraftNode[]) => {
    for (const n of nodes) {
      const kept = n.sourceId !== undefined ? bySource.get(n.sourceId) : undefined;
      if (kept) {
        attach(n.children, kept.children);
        continue;
      }
      // A name a kept sibling already carries is that sibling, not a twin.
      const twin = into.find((x) => x.name.toLowerCase() === n.name.toLowerCase());
      if (twin) attach(n.children, twin.children);
      else into.push(strip(n));
    }
  };
  attach(client, tree);
  return tree;
}

// ---- reading a draft against the live tree ---------------------------------

function flattenDraft(tree: DraftNode[]): { node: DraftNode; parent: DraftNode | null }[] {
  const out: { node: DraftNode; parent: DraftNode | null }[] = [];
  const walk = (nodes: DraftNode[], parent: DraftNode | null) => {
    for (const n of nodes) {
      out.push({ node: n, parent });
      walk(n.children, n);
    }
  };
  walk(tree, null);
  return out;
}

/** The origin a draft node is applied with - the rule the owner was promised. */
export function draftOrigin(node: DraftNode, source: { origin?: CategoryOrigin } | undefined): CategoryOrigin {
  if (node.edited) return 'user';
  return source?.origin === 'user' ? 'user' : 'generated';
}

export function diffDraft(draft: RecategorizeDraft, live: CategoryTreeNode[]): DraftDiff {
  const index = indexLive(live);
  const kept = new Set<number>();
  let added = 0;
  let renamed = 0;
  let moved = 0;
  for (const { node, parent } of flattenDraft(draft.tree)) {
    const source = node.sourceId !== undefined ? index.byId.get(node.sourceId) : undefined;
    if (!source) {
      added += 1;
      continue;
    }
    kept.add(source.id);
    if (source.name !== node.name) renamed += 1;
    const newParentSource = parent?.sourceId ?? null;
    if ((parent && parent.sourceId === undefined) || newParentSource !== source.parentId) moved += 1;
  }
  const removedNodes = [...index.byId.values()].filter((c) => !kept.has(c.id));
  const removedIds = new Set(removedNodes.map((c) => c.id));
  // A removed subtree is listed once, at its top: its descendants go with it.
  const removedPaths = removedNodes
    .filter((c) => c.parentId === null || !removedIds.has(c.parentId))
    .map((c) => c.path);
  return { added, removed: removedIds.size, renamed, moved, removedPaths };
}

/** The draft as the editor renders it. */
export function viewDraft(draft: RecategorizeDraft, live: CategoryTreeNode[]): DraftNodeView[] {
  const index = indexLive(live);
  const locked = draft.mode === 'extend';
  const view = (nodes: DraftNode[], parent: DraftNode | null): DraftNodeView[] =>
    nodes.map((n) => {
      const source = n.sourceId !== undefined ? index.byId.get(n.sourceId) : undefined;
      const change: DraftNodeView['change'] = {};
      if (!source) change.added = true;
      else {
        if (source.name !== n.name) change.renamedFrom = source.name;
        const parentSource = parent ? parent.sourceId ?? -1 : null;
        if (parentSource !== source.parentId) change.movedFrom = source.path;
      }
      return {
        id: n.id,
        name: n.name,
        description: n.description ?? null,
        sourceId: source ? source.id : null,
        edited: !!n.edited,
        locked: locked && !!source,
        origin: draftOrigin(n, source),
        change,
        total: source ? source.total : 0,
        children: view(n.children, n),
      };
    });
  return view(draft.tree, null);
}

// ---- storage -----------------------------------------------------------------

/** The stored draft, reconciled with the live tree (a sync may have run since); undefined when none. */
export function readDraft(db: Database, maxDepth: number): RecategorizeDraft | undefined {
  const raw = db.getState(RECATEGORIZE_DRAFT_KEY);
  if (!raw) return undefined;
  let parsed: Partial<RecategorizeDraft>;
  try {
    parsed = JSON.parse(raw) as Partial<RecategorizeDraft>;
  } catch {
    return undefined;
  }
  if (!parsed || !isRecategorizeMode(parsed.mode)) return undefined;
  const live = buildCategoryTree(db);
  const liveIds = new Set(indexLive(live).byId.keys());
  // A stored draft was valid when written; anything off now (a source that
  // vanished) is repaired quietly - there is nothing for the owner to fix.
  let tree = parseDraftTree(parsed.tree, liveIds, maxDepth + 1).tree;
  if (parsed.mode === 'extend') tree = rebaseAdditions(tree, live);
  return {
    version: 1,
    mode: parsed.mode,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    bookmarkCount: Number.isInteger(parsed.bookmarkCount) ? (parsed.bookmarkCount as number) : 0,
    tree,
  };
}

export function writeDraft(db: Database, draft: RecategorizeDraft): void {
  db.setState(RECATEGORIZE_DRAFT_KEY, JSON.stringify(draft));
}

export function clearDraft(db: Database): boolean {
  return db.deleteState(RECATEGORIZE_DRAFT_KEY);
}

/**
 * Validate an edited tree for `draft`'s mode and return the draft to store,
 * or the sentences that refuse it. Extend mode is re-based on the live tree
 * first, so nothing the client did to an existing category can survive.
 */
export function editDraft(
  db: Database,
  draft: RecategorizeDraft,
  rawTree: unknown,
  maxDepth: number,
): { draft?: RecategorizeDraft; errors: string[] } {
  const live = buildCategoryTree(db);
  const liveIds = new Set(indexLive(live).byId.keys());
  const parsed = parseDraftTree(rawTree, liveIds, maxDepth);
  if (parsed.errors.length > 0) return { errors: parsed.errors };
  let tree = parsed.tree;
  if (draft.mode === 'extend') {
    tree = rebaseAdditions(tree, live);
    // Re-check after the rebase: an addition may now sit beside a live twin.
    const again = parseDraftTree(tree, liveIds, maxDepth);
    if (again.errors.length > 0) return { errors: again.errors };
  } else if (tree.length === 0) {
    return { errors: ['A new tree needs at least one category. Cancel the proposal to keep the current tree.'] };
  }
  return { draft: { ...draft, tree, updatedAt: new Date().toISOString() }, errors: [] };
}

// ---- accepting --------------------------------------------------------------

function plan(nodes: DraftNode[], sources: Map<number, CategoryNode>): PlannedCategory[] {
  return nodes.map((n) => {
    const source = n.sourceId !== undefined ? sources.get(n.sourceId) : undefined;
    return {
      ...(source ? { sourceId: source.id } : {}),
      name: n.name,
      description: n.description ?? source?.description ?? null,
      origin: draftOrigin(n, source),
      children: plan(n.children, sources),
    };
  });
}

/**
 * Write an accepted draft into the live tree, in ONE transaction: `redesign`
 * replaces the whole tree (kept rows keep their ids, the rest are deleted, new
 * ones created - the order the owner left in the editor is the order stored,
 * and the root-order mirror follows it); `extend` only inserts the additions
 * under the existing categories they hang from. The draft is NOT cleared here:
 * the caller clears it in the same transaction as the re-file state it
 * records, so a failure can never lose both.
 */
export function applyDraft(db: Database, draft: RecategorizeDraft, when: string): { created: number; deleted: number } {
  const sources = new Map(db.getAllCategories().map((c) => [c.id, c]));
  if (draft.mode === 'redesign') {
    const roots = plan(draft.tree, sources);
    return db.inTransaction(() => {
      const result = db.replaceCategoryTree(roots, when);
      writeRootOrder(db, roots.map((r) => r.name));
      return { created: result.created, deleted: result.deleted };
    });
  }
  return db.inTransaction(() => {
    let created = 0;
    const walk = (nodes: DraftNode[], parentId: number | null) => {
      const additions: PlannedCategory[] = [];
      for (const n of nodes) {
        const source = n.sourceId !== undefined ? sources.get(n.sourceId) : undefined;
        if (source) walk(n.children, source.id);
        else additions.push(...plan([n], sources));
      }
      if (additions.length > 0) created += db.addCategoryNodes(parentId, additions, when);
    };
    walk(draft.tree, null);
    return { created, deleted: 0 };
  });
}
