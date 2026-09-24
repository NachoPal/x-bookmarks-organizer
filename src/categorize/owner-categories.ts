/**
 * The owner's own categories (`origin = 'user'`) as the passes see them.
 *
 * A category the owner made by hand is a promise: whatever fits it goes
 * there, and nothing automated renames, moves, re-describes or deletes it.
 * The prompts ASK the model for that (the `[owner]` marker below), but the
 * guarantee lives in code: `Database.clearGeneratedCategories` keeps them,
 * `getOrCreateCategory` never re-describes them, and the helpers here stop a
 * pass from minting a near-duplicate of one or losing a post the model filed
 * under one by a slightly wrong path.
 */
import type { Database } from '../db/database';
import type { CategoryNode } from '../types';

/**
 * Appended to an owner category's line in every prompt tree. It is NOT part
 * of the name, and {@link stripOwnerMarker} removes it wherever a model
 * copies it back into a path anyway.
 */
export const OWNER_MARKER = '[owner]';

const MARKER_RE = /\s*\[owner\]\s*$/i;

/** A name as the model wrote it, minus a copied `[owner]` marker. */
export function stripOwnerMarker(name: string): string {
  return name.replace(MARKER_RE, '').trim();
}

/**
 * A loose identity for a category name, so "LLMs", "llm" and "L.L.M." are
 * recognised as the same category: case, accents, punctuation and spacing
 * are dropped, and a plural `s` on a word longer than three letters.
 */
export function nameKey(name: string): string {
  const key = stripOwnerMarker(name)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  return key.length > 3 && key.endsWith('s') ? key.slice(0, -1) : key;
}

/**
 * The owner category a name refers to, wherever it sits in the tree - but
 * only when exactly ONE owner category carries that name. Two ("Tools" under
 * two different parents) make the name ambiguous, and guessing would file a
 * post in the wrong one.
 */
export function findOwnerAnchor(db: Database, name: string): CategoryNode | undefined {
  const key = nameKey(name);
  if (!key) return undefined;
  const hits = db.getUserCategories().filter((c) => nameKey(c.name) === key);
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * An owner category directly under `parentId` (null: a root) whose name means
 * the same as `name` - the near-duplicate a pass must reuse instead of
 * creating ("LLM" beside the owner's "LLMs").
 */
export function findOwnerSibling(db: Database, name: string, parentId: number | null): CategoryNode | undefined {
  const key = nameKey(name);
  if (!key) return undefined;
  return db.getUserCategories().find((c) => c.parentId === parentId && nameKey(c.name) === key);
}
