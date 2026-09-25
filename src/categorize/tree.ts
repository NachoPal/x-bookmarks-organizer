import type { Database } from '../db/database';
import type { CategoryNode, CategoryTreeNode, TaxonomyNode } from '../types';
import { OWNER_MARKER, findOwnerAnchor, findOwnerSibling, nameKey, stripOwnerMarker } from './owner-categories';

/**
 * The node a designed name lands on under `parentId`, WITHOUT creating
 * anything: the existing sibling of that name, else a sibling it
 * near-duplicates ("LLM" beside "LLMs" - the owner's first, whoever made it),
 * else an owner ROOT minted again somewhere deeper ("Food > Cooking" when
 * "Cooking" is the owner's top-level category), or, for the first segment of
 * a path, the one owner category of that name wherever it sits (the model
 * re-rooted it). A deeper name is NOT redirected to a deeper owner category:
 * "Python > Tools" is not the owner's "Rust > Tools". Undefined means a new
 * node is genuinely needed.
 */
export function findMergeTarget(
  db: Database,
  name: string,
  parentId: number | null,
  atTop: boolean,
): CategoryNode | undefined {
  const exact =
    db.findCategory(name, parentId) ?? findOwnerSibling(db, name, parentId) ?? findSimilarSibling(db, name, parentId);
  if (exact) return exact;
  const anchor = findOwnerAnchor(db, name);
  return anchor && (atTop || anchor.parentId === null) ? anchor : undefined;
}

/**
 * Any existing category directly under `parentId` whose name means the same as
 * `name` (`nameKey`): a pass that grows the tree reuses it rather than adding
 * a near-duplicate twin beside it.
 */
function findSimilarSibling(db: Database, name: string, parentId: number | null): CategoryNode | undefined {
  const key = nameKey(name);
  if (!key) return undefined;
  return db.getAllCategories().find((c) => c.parentId === parentId && nameKey(c.name) === key);
}

/**
 * Materialize a designed taxonomy into `categories` rows, MERGING into the
 * existing tree rather than duplicating it: a designed node that already
 * exists (by name under the same parent, or as the owner's own category it
 * near-duplicates - see {@link findMergeTarget}) is reused, and only a
 * genuinely new node is created. Depth is capped at `maxDepth`; branches
 * deeper than that are truncated. Idempotent, and ADD-ONLY: it never renames,
 * moves or deletes an existing category, which is what lets every sync's
 * pass 1 grow the tree without being able to change it.
 *
 * Each node's one-line `description` (issue #61) is carried through to the row;
 * `getOrCreateCategory` only ever fills a missing one in, so re-materializing
 * never clears a description a previous pass wrote - and never touches an
 * owner category's at all.
 */
export function materializeTaxonomy(
  db: Database,
  taxonomy: TaxonomyNode[],
  maxDepth: number,
  when: string,
): void {
  const walk = (nodes: TaxonomyNode[], parentId: number | null, depth: number) => {
    if (depth >= maxDepth) return;
    for (const node of nodes) {
      const name = stripOwnerMarker(node.name);
      if (!name) continue;
      const existing = findMergeTarget(db, name, parentId, depth === 0);
      const target =
        existing && existing.origin === 'user'
          ? existing
          : db.getOrCreateCategory(existing?.name ?? name, existing ? existing.parentId : parentId, when, node.description);
      walk(node.children ?? [], target.id, depth + 1);
    }
  };
  walk(taxonomy, null, 0);
}

/**
 * The part of the tree a recategorize keeps: every owner category and the
 * ancestors that hold it in place, with every other node pruned. What the
 * anchored taxonomy design is shown as "Existing categories" - computed
 * BEFORE anything is cleared, so a failed design never loses the tree.
 */
export function pruneToProtected(roots: CategoryTreeNode[], keep: Set<number>): CategoryTreeNode[] {
  const prune = (nodes: CategoryTreeNode[]): CategoryTreeNode[] =>
    nodes.filter((n) => keep.has(n.id)).map((n) => ({ ...n, children: prune(n.children) }));
  return prune(roots);
}

/**
 * Build the full category tree with counts rolled up so that each node's
 * `total`/`unread` include all of its descendants. Siblings at every level
 * follow the owner's saved order, then any never-ordered one by name
 * ({@link orderSiblings}).
 */
export function buildCategoryTree(db: Database): CategoryTreeNode[] {
  const categories = db.getAllCategories();
  const membership = db.getDirectMembership();
  return assembleTree(categories, membership, readRootOrder(db));
}

/**
 * `run_state` key holding the ROOT level's order as a JSON array of names
 * (issue #82). Since sibling order moved into `categories.position` it is a
 * mirror, kept for one reason: identity by NAME. A `recategorize` clears and
 * re-creates every generated row, so a position does not survive it but a
 * root's name does - a re-created root with a remembered name goes back where
 * the owner put it. Every write that changes the root level rewrites both
 * together (`moveCategory`), so a root's position and its index here agree.
 */
export const ROOT_ORDER_KEY = 'root_order';

/**
 * The saved root order, as names (a renamed root is a new root and simply
 * falls to the end). Tolerant of a missing or unreadable blob.
 */
export function readRootOrder(db: Database): string[] {
  const raw = db.getState(ROOT_ORDER_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

export function writeRootOrder(db: Database, names: string[]): void {
  db.setState(ROOT_ORDER_KEY, JSON.stringify(names));
}

/**
 * THE sibling order, at every level: a node the owner placed (its `position`
 * - or, for a ROOT with none, its index in the name-keyed root order, which
 * is what survives a `recategorize`) comes first, in that order; every
 * never-placed node follows, alphabetically. That is where a category a sync
 * creates lands: after the owner's arrangement, never inside it. Never drops
 * or duplicates a node, and saved names that no longer exist are ignored.
 * `positionOf` reads a node's stored position; pass `rootNames` only for the
 * root level.
 */
export function orderSiblings<T extends { name: string }>(
  nodes: T[],
  positionOf: (node: T) => number | null | undefined,
  rootNames: string[] = [],
): T[] {
  const byName = new Map<string, number>();
  rootNames.forEach((n, i) => {
    const key = n.toLowerCase();
    if (!byName.has(key)) byName.set(key, i);
  });
  const rank = (n: T): number | undefined => positionOf(n) ?? byName.get(n.name.toLowerCase());
  return [...nodes].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== undefined && rb !== undefined && ra !== rb) return ra - rb;
    if (ra !== undefined && rb === undefined) return -1;
    if (ra === undefined && rb !== undefined) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Pure assembly of the counted tree, separated for testability.
 *
 * `directMembership` maps a category id to the bookmarks linked directly to it
 * (id + read flag). Rolled-up `total`/`unread` count DISTINCT bookmark ids
 * across the node and all descendants, so a bookmark placed in several branches
 * under a shared ancestor is counted once there.
 */
export function assembleTree(
  categories: CategoryNode[],
  directMembership: Map<number, { id: number; read: boolean }[]>,
  rootOrder: string[] = [],
): CategoryTreeNode[] {
  const nodes = new Map<number, CategoryTreeNode>();
  const positions = new Map(categories.map((c) => [c.id, c.position ?? null]));
  const positionOf = (n: CategoryTreeNode) => positions.get(n.id);
  for (const c of categories) {
    nodes.set(c.id, {
      id: c.id,
      parentId: c.parentId,
      name: c.name,
      description: c.description ?? null,
      origin: c.origin ?? 'generated',
      path: [],
      total: 0,
      unread: 0,
      directTotal: directMembership.get(c.id)?.length ?? 0,
      children: [],
    });
  }

  const roots: CategoryTreeNode[] = [];
  for (const node of nodes.values()) {
    if (node.parentId === null) {
      roots.push(node);
    } else {
      const parent = nodes.get(node.parentId);
      if (parent) parent.children.push(node);
      else roots.push(node); // orphan safety net
    }
  }

  // Compute paths and rolled-up counts via post-order traversal, unioning
  // bookmark ids so each distinct bookmark is counted once per subtree.
  const visit = (node: CategoryTreeNode, parentPath: string[]): { total: Set<number>; unread: Set<number> } => {
    node.path = [...parentPath, node.name];
    node.children = orderSiblings(node.children, positionOf);
    const total = new Set<number>();
    const unread = new Set<number>();
    for (const b of directMembership.get(node.id) ?? []) {
      total.add(b.id);
      if (!b.read) unread.add(b.id);
    }
    for (const child of node.children) {
      const c = visit(child, node.path);
      for (const id of c.total) total.add(id);
      for (const id of c.unread) unread.add(id);
    }
    node.total = total.size;
    node.unread = unread.size;
    return { total, unread };
  };

  const ordered = orderSiblings(roots, positionOf, rootOrder);
  for (const root of ordered) visit(root, []);
  return ordered;
}

/** Text budget for a node's description in the rendered prompt tree. */
const MAX_RENDERED_DESCRIPTION_CHARS = 120;

/**
 * Render the current tree as indented text for the LLM prompt, so the model can
 * reuse existing nodes. Empty tree renders as "(no categories yet)".
 *
 * A node's one-line description (issue #61) is appended after an em-free dash
 * when it has one, which is what tells every prompt how siblings differ
 * instead of leaving the model to guess from bare labels. Nodes designed before
 * descriptions existed simply render as before.
 *
 * An owner category carries the {@link OWNER_MARKER} after its name, which is
 * how every prompt knows which nodes the owner made by hand (keep them, and
 * prefer them when a bookmark fits).
 */
export function renderTreeForPrompt(roots: CategoryTreeNode[]): string {
  if (roots.length === 0) return '(no categories yet)';
  const lines: string[] = [];
  const walk = (node: CategoryTreeNode, depth: number) => {
    const description = node.description?.replace(/\s+/g, ' ').trim();
    const suffix = description ? ` - ${description.slice(0, MAX_RENDERED_DESCRIPTION_CHARS)}` : '';
    const marker = node.origin === 'user' ? ` ${OWNER_MARKER}` : '';
    lines.push(`${'  '.repeat(depth)}- ${node.name}${marker}${suffix}`);
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return lines.join('\n');
}
