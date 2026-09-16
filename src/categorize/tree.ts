import type { Database } from '../db/database';
import type { CategoryNode, CategoryTreeNode, TaxonomyNode } from '../types';

/**
 * Materialize a designed taxonomy into `categories` rows, creating each node
 * (get-or-create, so it merges cleanly with any pre-existing tree). Depth is
 * capped at `maxDepth`; branches deeper than that are truncated. Idempotent.
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
      const created = db.getOrCreateCategory(name, parentId, when);
      walk(node.children ?? [], created.id, depth + 1);
    }
  };
  walk(taxonomy, null, 0);
}

/**
 * Build the full category tree with counts rolled up so that each node's
 * `total`/`unread` include all of its descendants. Roots are returned sorted
 * by name; children likewise.
 */
export function buildCategoryTree(db: Database): CategoryTreeNode[] {
  const categories = db.getAllCategories();
  const membership = db.getDirectMembership();
  return assembleTree(categories, membership);
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
): CategoryTreeNode[] {
  const nodes = new Map<number, CategoryTreeNode>();
  for (const c of categories) {
    nodes.set(c.id, {
      id: c.id,
      parentId: c.parentId,
      name: c.name,
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

  roots.sort(byName);
  for (const root of roots) visit(root, []);
  return roots;
}

/**
 * Render the current tree as indented text for the LLM prompt, so the model can
 * reuse existing nodes. Empty tree renders as "(no categories yet)".
 */
export function renderTreeForPrompt(roots: CategoryTreeNode[]): string {
  if (roots.length === 0) return '(no categories yet)';
  const lines: string[] = [];
  const walk = (node: CategoryTreeNode, depth: number) => {
    lines.push(`${'  '.repeat(depth)}- ${node.name}`);
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return lines.join('\n');
}
