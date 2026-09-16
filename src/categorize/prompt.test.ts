import { describe, it, expect } from 'vitest';
import { buildPrompt, parseAssignments } from './prompt';
import type { RawBookmark } from '../types';

const bm = (postId: string, text = 'hello'): RawBookmark => ({
  postId,
  authorUsername: 'bob',
  authorName: 'Bob',
  text,
  url: `https://x.com/bob/status/${postId}`,
  postCreatedAt: '',
});

describe('buildPrompt', () => {
  it('includes the tree, the rules, the bookmarks, and the output contract', () => {
    const prompt = buildPrompt([bm('123', 'a tweet about evals')], '- AI\n  - Evals', 4);
    expect(prompt).toContain('- AI');
    expect(prompt).toContain('  - Evals');
    expect(prompt).toContain('post_id: 123');
    expect(prompt).toContain('a tweet about evals');
    expect(prompt).toContain('at most 4 levels deep');
    expect(prompt).toContain('"assignments"');
  });
});

describe('parseAssignments', () => {
  const valid = new Set(['1', '2']);

  it('parses a clean JSON object', () => {
    const res = parseAssignments(
      '{"assignments":[{"post_id":"1","categories":[["AI","Evals"]]}]}',
      valid,
      4,
    );
    expect(res).toEqual([{ postId: '1', categories: [['AI', 'Evals']] }]);
  });

  it('handles markdown code fences', () => {
    const res = parseAssignments(
      '```json\n{"assignments":[{"post_id":"1","categories":[["AI"]]}]}\n```',
      valid,
      4,
    );
    expect(res).toEqual([{ postId: '1', categories: [['AI']] }]);
  });

  it('handles surrounding prose', () => {
    const res = parseAssignments(
      'Here you go:\n{"assignments":[{"post_id":"2","categories":[["X"]]}]}\nThanks!',
      valid,
      4,
    );
    expect(res).toEqual([{ postId: '2', categories: [['X']] }]);
  });

  it('supports multi-category assignments', () => {
    const res = parseAssignments(
      '{"assignments":[{"post_id":"1","categories":[["AI","Evals"],["Research"]]}]}',
      valid,
      4,
    );
    expect(res[0]!.categories).toEqual([['AI', 'Evals'], ['Research']]);
  });

  it('drops unknown post ids', () => {
    const res = parseAssignments(
      '{"assignments":[{"post_id":"999","categories":[["X"]]}]}',
      valid,
      4,
    );
    expect(res).toHaveLength(0);
  });

  it('caps paths at maxDepth and trims empty segments', () => {
    const res = parseAssignments(
      '{"assignments":[{"post_id":"1","categories":[["A","B","C","D","E"],[" ",""]]}]}',
      valid,
      3,
    );
    expect(res[0]!.categories).toEqual([['A', 'B', 'C']]);
  });

  it('throws on non-JSON garbage so bookmarks are not silently lost', () => {
    expect(() => parseAssignments('I cannot help with that.', valid, 4)).toThrow();
  });

  it('throws when the assignments array is missing', () => {
    expect(() => parseAssignments('{"foo":true}', valid, 4)).toThrow();
  });
});
