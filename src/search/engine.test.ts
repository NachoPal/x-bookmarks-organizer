import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../db/database';
import type { RawBookmark } from '../types';
import { runSearch, SearchQueryError } from './engine';

const bm = (postId: string, text: string, extra: Partial<RawBookmark> = {}): RawBookmark => ({
  postId,
  authorUsername: `user${postId}`,
  authorName: `User ${postId}`,
  text,
  url: `https://x.com/user${postId}/status/${postId}`,
  postCreatedAt: '2024-05-01T10:00:00.000Z',
  ...extra,
});

describe('runSearch', () => {
  let db: Database;
  const when = '2024-06-01T00:00:00.000Z';
  let ai: number;
  let agents: number;
  let cooking: number;

  beforeEach(() => {
    db = new Database(':memory:');
    ai = db.getOrCreateCategory('AI', null, when).id;
    agents = db.getOrCreateCategory('Agents', ai, when).id;
    cooking = db.getOrCreateCategory('Cooking', null, when).id;
    const home: Record<string, number> = { '1': agents, '2': ai, '3': cooking };
    db.storeCategorizedBatch(
      [
        bm('1', 'agent harness evaluation', { authorUsername: 'karpathy' }),
        bm('2', 'language model notes'),
        bm('3', 'sourdough bread notes', { postCreatedAt: '2024-01-01T00:00:00.000Z' }),
      ],
      (b) => [home[b.postId]!],
      when,
    );
  });
  afterEach(() => db.close());

  const ids = (raw: string, extra: Partial<Parameters<typeof runSearch>[1]> = {}) =>
    runSearch(db, { raw, limit: 10, ...extra }).hits.map((h) => h.bookmark.postId).sort();

  it('plain keywords', () => {
    expect(ids('notes')).toEqual(['2', '3']);
  });

  it('from: alone lists an author\'s posts with no keywords', () => {
    expect(ids('from:@karpathy')).toEqual(['1']);
  });

  it('from: combined with keywords', () => {
    expect(ids('from:@karpathy evaluation')).toEqual(['1']);
    expect(ids('from:@karpathy sourdough')).toEqual([]);
  });

  it('category: by name, matching the subtree', () => {
    expect(ids('category:AI')).toEqual(['1', '2']);
    expect(ids('category:Agents')).toEqual(['1']);
  });

  it('category: by quoted path to disambiguate', () => {
    db.getOrCreateCategory('Agents', cooking, when); // a second "Agents" elsewhere
    expect(() => runSearch(db, { raw: 'category:Agents', limit: 10 })).toThrow(SearchQueryError);
    expect(ids('category:"AI > Agents"')).toEqual(['1']);
  });

  it('category: with an unknown name throws a clear SearchQueryError', () => {
    expect(() => runSearch(db, { raw: 'category:Nope', limit: 10 })).toThrow(/No category matches "Nope"/);
  });

  it('list: by name', () => {
    const id1 = db.getBookmarkByPostId('1')!.id;
    const id3 = db.getBookmarkByPostId('3')!.id;
    db.createAssistantList({ title: 'Faves', note: null, bookmarkIds: [id1, id3] });
    expect(ids('list:Faves')).toEqual(['1', '3']);
    expect(ids('list:"faves"')).toEqual(['1', '3']); // case-insensitive
  });

  it('list: with an unknown name throws', () => {
    expect(() => runSearch(db, { raw: 'list:Nope', limit: 10 })).toThrow(/No list matches "Nope"/);
  });

  it('category: and list: combine as AND', () => {
    const id1 = db.getBookmarkByPostId('1')!.id;
    const id2 = db.getBookmarkByPostId('2')!.id;
    db.createAssistantList({ title: 'Faves', note: null, bookmarkIds: [id1, id2] });
    expect(ids('category:Agents list:Faves')).toEqual(['1']);
  });

  it('exclusion with -word', () => {
    expect(ids('notes -sourdough')).toEqual(['2']);
  });

  it('exact phrases', () => {
    expect(ids('"agent harness"')).toEqual(['1']);
  });

  it('since:/until: bound the post date', () => {
    expect(ids('notes since:2024-02-01')).toEqual(['2']);
    expect(ids('notes until:2024-02-01')).toEqual(['3']);
  });

  it('reports the parsed query back to the caller', () => {
    const result = runSearch(db, { raw: 'from:@karpathy evaluation', limit: 10 });
    expect(result.parsed.from).toEqual(['karpathy']);
    expect(result.parsed.terms).toEqual(['evaluation']);
  });

  it('a legacy categoryRef (the MCP tool\'s existing `category` arg) ORs in with any category: tokens', () => {
    expect(ids('', { categoryRef: 'Cooking' })).toEqual(['3']);
  });

  it('legacy after/before take precedence over a parsed since/until', () => {
    const result = runSearch(db, { raw: 'notes since:2024-02-01', after: '2023-01-01T00:00:00.000Z', limit: 10 });
    expect(result.hits.map((h) => h.bookmark.postId).sort()).toEqual(['2', '3']);
  });
});
