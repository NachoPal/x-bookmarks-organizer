import { describe, it, expect } from 'vitest';
import { buildExtendPrompt, buildPrompt, parseAssignments } from './prompt';
import type { ArticleContext } from '../articles/link-metadata';
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
    expect(prompt).toContain('"assignments"');
  });

  it('instructs the model to file into the fixed tree without inventing nodes', () => {
    const prompt = buildPrompt([bm('1')], '- AI', 4);
    expect(prompt).toContain('do not invent new categories');
    expect(prompt).toContain('never be longer than 4 levels');
  });

  it('includes the linked article title/description for a link-heavy post (issue #25)', () => {
    const articleContext = new Map<string, ArticleContext>([
      ['123', { title: 'New Transformer Architecture', description: 'A paper on sparse attention' }],
    ]);
    const prompt = buildPrompt([bm('123', 'https://t.co/abcd')], '- AI', 4, articleContext);
    expect(prompt).toContain('linked article: New Transformer Architecture - A paper on sparse attention');
  });

  it('omits the linked-article line for a bookmark with no entry in articleContext', () => {
    const articleContext = new Map<string, ArticleContext>([['999', { title: 'Unrelated' }]]);
    const prompt = buildPrompt([bm('123', 'https://t.co/abcd')], '- AI', 4, articleContext);
    expect(prompt).not.toContain('linked article:');
  });
});

describe('owner categories in the assignment prompts', () => {
  it('asks both modes to prefer the [owner] categories and never to copy the marker', () => {
    for (const prompt of [buildPrompt([bm('1')], '- Rust [owner]', 4), buildExtendPrompt([bm('1')], '- Rust [owner]', 4)]) {
      expect(prompt).toContain('Categories marked [owner] were created by the person by hand');
      expect(prompt).toContain('never write it in a path');
    }
    expect(buildExtendPrompt([bm('1')], '- Rust [owner]', 4)).toContain('Never create a category that means the same thing');
  });
});

describe('buildExtendPrompt', () => {
  it('includes the linked article title/description for a link-heavy post (issue #25)', () => {
    const articleContext = new Map<string, ArticleContext>([
      ['123', { title: 'A Robotics Breakthrough' }],
    ]);
    const prompt = buildExtendPrompt([bm('123', 'https://t.co/abcd')], '- Robotics', 4, articleContext);
    expect(prompt).toContain('linked article: A Robotics Breakthrough');
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
