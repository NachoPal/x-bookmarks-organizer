import type { Database } from '../db/database';
import type { CategoryNode } from '../types';
import { orderSiblings, readRootOrder, writeRootOrder } from './tree';

/**
 * Moving a category by hand: reorder it among its siblings at any depth, or
 * re-parent it (with its whole subtree and every bookmark link, which all hang
 * off its id) under any other category or to the root.
 *
 * This is an OWNER action, so none of the owner-category protections apply -
 * those only stop the automated passes - and the moved category keeps its
 * `origin`. `src/web/public/tree-move.js` mirrors the refusals and their
 * wording so the drag can show "can't drop here" before any round trip; this
 * file stays authoritative.
 */

export interface CategoryMoveRequest {
  id: number;
  /** The new parent's id, or null for the root level. */
  parentId: number | null;
  /** Index among the new parent's children, NOT counting the moved node. Clamped. */
  index: number;
}

export type CategoryMoveProblem = 'not-found' | 'bad-parent' | 'bad-index' | 'cycle' | 'depth' | 'clash';

export type CategoryMovePlan =
  | {
      ok: true;
      /** The new parent's complete child list, in order, the moved node included. */
      siblingOrder: number[];
      /** Whether the root level is the source or the target (its name mirror must be rewritten). */
      touchesRoot: boolean;
      /** Whether anything would change at all. */
      changed: boolean;
    }
  | { ok: false; problem: CategoryMoveProblem; status: 400 | 404 | 409; error: string };

const refuse = (
  problem: CategoryMoveProblem,
  status: 400 | 404 | 409,
  error: string,
): CategoryMovePlan => ({ ok: false, problem, status, error });

/** The (1-based) depth of a node: a root is 1. */
function depthOf(byId: Map<number, CategoryNode>, id: number): number {
  let depth = 0;
  let cur = byId.get(id);
  const seen = new Set<number>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    depth += 1;
    cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
  }
  return depth;
}

/**
 * Validate a move and work out the new parent's child order, WITHOUT
 * touching anything. Pure over the category rows and the root name order.
 *
 * Refused: an unknown category (404) or parent (400); a parent that is the
 * category itself or one of its descendants (400, a cycle); a move that would
 * make the tree deeper than `maxDepth` AND deeper than it already is (400 - a
 * tree the owner already built deeper stays movable within its own depth); a
 * sibling of the same name, case-insensitively, under the new parent (409,
 * the same rule as adding one).
 */
export function planCategoryMove(
  categories: CategoryNode[],
  rootNames: string[],
  req: CategoryMoveRequest,
  maxDepth: number,
): CategoryMovePlan {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const node = byId.get(req.id);
  if (!node) return refuse('not-found', 404, 'category not found');
  if (!Number.isInteger(req.index) || req.index < 0) {
    return refuse('bad-index', 400, 'index must be a whole number, 0 or more.');
  }
  const parent = req.parentId === null ? null : byId.get(req.parentId);
  if (req.parentId !== null && !parent) {
    return refuse('bad-parent', 400, `Unknown category id ${String(req.parentId)}.`);
  }

  const children = new Map<number | null, CategoryNode[]>();
  for (const c of categories) {
    const list = children.get(c.parentId) ?? [];
    list.push(c);
    children.set(c.parentId, list);
  }
  // The subtree's own height (a leaf is 1), and whether the target is inside it.
  const subtree = new Set<number>();
  const height = (id: number): number => {
    subtree.add(id);
    let deepest = 0;
    for (const child of children.get(id) ?? []) deepest = Math.max(deepest, height(child.id));
    return deepest + 1;
  };
  const levels = height(node.id);
  if (parent && subtree.has(parent.id)) {
    return refuse('cycle', 400, `“${node.name}” can’t go inside itself or one of its own sub-categories.`);
  }

  const parentDepth = parent ? depthOf(byId, parent.id) : 0;
  const newDeepest = parentDepth + levels;
  const oldDeepest = depthOf(byId, node.id) - 1 + levels;
  if (newDeepest > maxDepth && newDeepest > oldDeepest) {
    return refuse(
      'depth',
      400,
      `That would make the tree ${newDeepest} levels deep; categories go at most ${maxDepth} levels deep.`,
    );
  }

  const siblings = (children.get(parent ? parent.id : null) ?? []).filter((c) => c.id !== node.id);
  const lower = node.name.toLowerCase();
  const clash = siblings.find((c) => c.name.toLowerCase() === lower);
  if (clash) {
    return refuse(
      'clash',
      409,
      parent
        ? `“${parent.name}” already has a category called “${clash.name}”.`
        : `There is already a top-level category called “${clash.name}”.`,
    );
  }

  const ordered = orderSiblings(siblings, (c) => c.position, parent ? [] : rootNames).map((c) => c.id);
  const at = Math.min(req.index, ordered.length);
  const siblingOrder = [...ordered.slice(0, at), node.id, ...ordered.slice(at)];
  const sameParent = node.parentId === (parent ? parent.id : null);
  const before = sameParent
    ? orderSiblings(children.get(node.parentId) ?? [], (c) => c.position, parent ? [] : rootNames).map((c) => c.id)
    : [];
  const changed = !sameParent || before.some((id, i) => id !== siblingOrder[i]);
  return { ok: true, siblingOrder, touchesRoot: node.parentId === null || !parent, changed };
}

/**
 * Carry out a move in ONE transaction: the re-parent, the new parent's child
 * positions, and - when the root level is involved - every root's position
 * together with the name-keyed root order that mirrors it (see
 * `ROOT_ORDER_KEY`), so the two can never disagree.
 */
export function moveCategory(db: Database, req: CategoryMoveRequest, maxDepth: number): CategoryMovePlan {
  const plan = planCategoryMove(db.getAllCategories(), readRootOrder(db), req, maxDepth);
  if (!plan.ok || !plan.changed) return plan;
  db.inTransaction(() => {
    db.setCategoryParent(req.id, req.parentId);
    db.setCategoryPositions(plan.siblingOrder);
    if (plan.touchesRoot) {
      const all = db.getAllCategories();
      const roots = orderSiblings(
        all.filter((c) => c.parentId === null),
        (c) => c.position,
        readRootOrder(db),
      );
      db.setCategoryPositions(roots.map((c) => c.id));
      writeRootOrder(db, roots.map((c) => c.name));
    }
  });
  return plan;
}
