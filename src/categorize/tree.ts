import type { Database } from '../db/database';
import type { CategoryNode, CategoryTreeNode, TaxonomyNode } from '../types';

/**
 * Materialize a designed taxonomy into `categories` rows, creating each node
 * (get-or-create, so it merges cleanly with any pre-existing tree). Depth is
 * capped at `maxDepth`; branches deeper than that are truncated. Idempotent.
 *
 * Each node's one-line `description` (issue #61) is carried through to the row;
 * `getOrCreateCategory` only ever fills a missing one in, so re-materializing
 * never clears a description a previous pass wrote.
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
      const name = node.name.trim();
      if (!name) continue;
      const created = db.getOrCreateCategory(name, parentId, when, node.description);
      walk(node.children ?? [], created.id, depth + 1);
    }
  };
  walk(taxonomy, null, 0);
}

/**
 * Build the full category tree with counts rolled up so that each node's
 * `total`/`unread` include all of its descendants. Roots follow the owner's
 * saved order (issue #82), then any unsaved root by name; children are
 * always sorted by name.
 */
export function buildCategoryTree(db: Database): CategoryTreeNode[] {
  const categories = db.getAllCategories();
  const membership = db.getDirectMembership();
  return assembleTree(categories, membership, readRootOrder(db));
}

/** `run_state` key holding the owner's root order, as a JSON array of names. */
export const ROOT_ORDER_KEY = 'root_order';

/**
 * The saved root order, as names. Identity is the NAME, not the id: a
 * `recategorize` clears and re-creates every `categories` row, so ids do not
 * survive it but a root's name does (a renamed root is a new root and simply
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
 * Order roots by a saved name list (case-insensitive, matching how sibling
 * names merge); roots absent from it follow, alphabetically. Never drops or
 * duplicates a root, and names in the list that no longer exist are ignored.
 */
export function orderRoots(roots: CategoryTreeNode[], savedNames: string[]): CategoryTreeNode[] {
  const position = new Map<string, number>();
  savedNames.forEach((n, i) => {
    const key = n.toLowerCase();
    if (!position.has(key)) position.set(key, i);
  });
  const byName = (a: CategoryTreeNode, b: CategoryTreeNode) => a.name.localeCompare(b.name);
  const saved = roots
    .filter((r) => position.has(r.name.toLowerCase()))
    .sort((a, b) => position.get(a.name.toLowerCase())! - position.get(b.name.toLowerCase())!);
  const rest = roots.filter((r) => !position.has(r.name.toLowerCase())).sort(byName);
  return [...saved, ...rest];
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
  for (const c of categories) {
    nodes.set(c.id, {
      id: c.id,
      parentId: c.parentId,
      name: c.name,
      description: c.description ?? null,
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

  const byName = (a: CategoryTreeNode, b: CategoryTreeNode) => a.name.localeCompare(b.name);

  // Compute paths and rolled-up counts via post-order traversal, unioning
  // bookmark ids so each distinct bookmark is counted once per subtree.
  const visit = (node: CategoryTreeNode, parentPath: string[]): { total: Set<number>; unread: Set<number> } => {
    node.path = [...parentPath, node.name];
    node.children.sort(byName);
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

  const ordered = orderRoots(roots, rootOrder);
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
 * when it has one, which is what tells the `extend` prompt how siblings differ
 * instead of leaving the model to guess from bare labels. Nodes designed before
 * descriptions existed simply render as before.
 */
export function renderTreeForPrompt(roots: CategoryTreeNode[]): string {
  if (roots.length === 0) return '(no categories yet)';
  const lines: string[] = [];
  const walk = (node: CategoryTreeNode, depth: number) => {
    const description = node.description?.replace(/\s+/g, ' ').trim();
    const suffix = description ? ` - ${description.slice(0, MAX_RENDERED_DESCRIPTION_CHARS)}` : '';
    lines.push(`${'  '.repeat(depth)}- ${node.name}${suffix}`);
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return lines.join('\n');
}
