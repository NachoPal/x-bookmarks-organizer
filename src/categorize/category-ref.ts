import type { CategoryTreeNode } from '../types';

/**
 * Resolving a category NAME (as an owner or an assistant would type it) to a
 * tree node - shared by the MCP server (`category` arg of `search_bookmarks`/
 * `list_category_bookmarks`) and the in-app search bar's `category:` operator,
 * so the two can never disagree about what a name means or how an ambiguous
 * one is reported.
 */

/** Every category as `id -> "Root > Child"`, from one read of the tree. */
export function categoryTreePaths(tree: CategoryTreeNode[]): Map<number, string> {
  const paths = new Map<number, string>();
  const walk = (nodes: CategoryTreeNode[]) => {
    for (const node of nodes) {
      paths.set(node.id, node.path.join(' > '));
      walk(node.children);
    }
  };
  walk(tree);
  return paths;
}

export function findCategoryNode(tree: CategoryTreeNode[], id: number): CategoryTreeNode | undefined {
  for (const node of tree) {
    if (node.id === id) return node;
    const found = findCategoryNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

/**
 * A category named by its id or its path (`AI > Agents`, `AI/Agents`, or a
 * name that is unique in the tree), case-insensitively. Throws a plain `Error`
 * with a message meant to be shown as-is; each caller wraps it in its own
 * domain's error type (an MCP `ToolInputError`, a `SearchQueryError`, ...).
 */
export function resolveCategoryRef(tree: CategoryTreeNode[], ref: string | number): CategoryTreeNode {
  const asText = String(ref).trim();
  if (/^\d+$/.test(asText)) {
    const node = findCategoryNode(tree, Number(asText));
    if (node) return node;
  }
  const key = asText.toLowerCase().replace(/\s*(>|\/)\s*/g, '>');
  const all: CategoryTreeNode[] = [];
  const walk = (nodes: CategoryTreeNode[]) => nodes.forEach((n) => (all.push(n), walk(n.children)));
  walk(tree);
  const byPath = all.filter((n) => n.path.join('>').toLowerCase() === key);
  if (byPath.length === 1) return byPath[0]!;
  const byName = all.filter((n) => n.name.toLowerCase() === asText.toLowerCase());
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new Error(
      `"${asText}" names several categories: ${byName.map((n) => n.path.join(' > ')).join('; ')}. Pass the full path or the id.`,
    );
  }
  throw new Error(`No category matches "${asText}".`);
}
