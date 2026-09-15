/** Shared domain types. */

/** A bookmark as fetched from the X API, before it is stored. */
export interface RawBookmark {
  /** X post (tweet) id. Stable, globally unique. */
  postId: string;
  authorUsername: string;
  authorName: string;
  text: string;
  /** Canonical URL to the post. */
  url: string;
  /** ISO-8601 timestamp of when the post was created (NOT when bookmarked). */
  postCreatedAt: string;
}

/** A bookmark row as stored in the database. */
export interface StoredBookmark extends RawBookmark {
  id: number;
  ingestedAt: string;
  read: boolean;
  readAt: string | null;
}

/** A category tree node as stored. */
export interface CategoryNode {
  id: number;
  parentId: number | null;
  name: string;
  createdAt: string;
}

/**
 * A category tree node enriched with counts, used by the web viewer.
 * Counts are rolled up to include all descendants.
 */
export interface CategoryTreeNode {
  id: number;
  parentId: number | null;
  name: string;
  /** Full path from the root, e.g. ["AI", "Harnesses"]. */
  path: string[];
  /** Bookmarks in this node and all descendants. */
  total: number;
  /** Unread bookmarks in this node and all descendants. */
  unread: number;
  /** Bookmarks attached directly to this node (not descendants). */
  directTotal: number;
  children: CategoryTreeNode[];
}

/** The LLM's categorization decision for a single bookmark. */
export interface Assignment {
  postId: string;
  /** One path per category the bookmark belongs to. Each path is root -> leaf. */
  categories: string[][];
}
