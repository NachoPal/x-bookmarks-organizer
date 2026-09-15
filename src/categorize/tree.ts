import type { Database } from '../db/database';
import type { CategoryNode, CategoryTreeNode } from '../types';

/**
 * Build the full category tree with counts rolled up so that each node's
 * `total`/`unread` include all of its descendants. Roots are returned sorted
 * by name; children likewise.
 */
export function buildCategoryTree(db: Database): CategoryTreeNode[] {
  const categories = db.getAllCategories();
  const direct = db.getDirectCounts();
  return assembleTree(categories, direct);
}

/** Pure assembly of the counted tree, separated for testability. */
export function assembleTree(
  categories: CategoryNode[],
  directCounts: Map<number, { total: number; unread: number }>,
): CategoryTreeNode[] {
  const nodes = new Map<number, CategoryTreeNode>();
  for (const c of categories) {
    const d = directCounts.get(c.id) ?? { total: 0, unread: 0 };
    nodes.set(c.id, {
      id: c.id,
      parentId: c.parentId,
      name: c.name,
      path: [],
      total: 0,
      unread: 0,
      directTotal: d.total,
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

  // Compute paths and rolled-up counts via post-order traversal.
  const visit = (node: CategoryTreeNode, parentPath: string[]): { total: number; unread: number } => {
    node.path = [...parentPath, node.name];
    node.children.sort(byName);
    const own = directCounts.get(node.id) ?? { total: 0, unread: 0 };
    let total = own.total;
    let unread = own.unread;
    for (const child of node.children) {
      const c = visit(child, node.path);
      total += c.total;
      unread += c.unread;
    }
    node.total = total;
    node.unread = unread;
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
