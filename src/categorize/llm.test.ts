import { describe, it, expect } from 'vitest';
import { Categorizer, type LlmRunner } from './llm';
import type { RawBookmark } from '../types';

const bm = (postId: string): RawBookmark => ({
  postId,
  authorUsername: 'c',
  authorName: 'C',
  text: 't',
  url: `https://x.com/c/status/${postId}`,
  postCreatedAt: '',
});

describe('Categorizer', () => {
  it('returns [] for an empty batch without calling the runner', async () => {
    let called = false;
    const runner: LlmRunner = async () => {
      called = true;
      return '';
    };
    const cat = new Categorizer(runner, { model: 'm', maxDepth: 4 });
    expect(await cat.categorizeBatch([], '')).toEqual([]);
    expect(called).toBe(false);
  });

  it('passes the prompt to the runner and parses its response', async () => {
    let seenPrompt = '';
    const runner: LlmRunner = async (prompt) => {
      seenPrompt = prompt;
      return '{"assignments":[{"post_id":"1","categories":[["AI"]]}]}';
    };
    const cat = new Categorizer(runner, { model: 'm', maxDepth: 4 });
    const res = await cat.categorizeBatch([bm('1')], '- AI');
    expect(seenPrompt).toContain('post_id: 1');
    expect(seenPrompt).toContain('- AI');
    expect(res).toEqual([{ postId: '1', categories: [['AI']] }]);
  });
});
