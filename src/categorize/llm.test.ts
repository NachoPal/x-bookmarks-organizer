import { describe, it, expect } from 'vitest';
import { Categorizer, isClaudeAvailable, isClaudeCliAvailable, type LlmRunner } from './llm';
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

  it('emits a fixed-tree prompt in strict mode and a reuse-or-create prompt in extend mode', async () => {
    const prompts: string[] = [];
    const runner: LlmRunner = async (prompt) => {
      prompts.push(prompt);
      return '{"assignments":[]}';
    };
    const cat = new Categorizer(runner, { model: 'm', maxDepth: 4 });
    await cat.categorizeBatch([bm('1')], '- AI', 'strict');
    await cat.categorizeBatch([bm('1')], '- AI', 'extend');

    // Strict forbids inventing categories; extend explicitly permits creating a
    // new node when nothing fits. These are the two distinct emitted interfaces.
    expect(prompts[0]).toMatch(/do not invent/i);
    expect(prompts[0]).not.toMatch(/create a NEW category/i);
    expect(prompts[1]).toMatch(/create a NEW category/i);
    expect(prompts[1]).toMatch(/prefer existing nodes/i);
  });
});

describe('isClaudeCliAvailable', () => {
  it('is true when the binary resolves and runs (using `node --version` as a stand-in)', () => {
    expect(isClaudeCliAvailable('node')).toBe(true);
  });

  it('is false when the binary does not exist on PATH', () => {
    expect(isClaudeCliAvailable('this-binary-does-not-exist-xyz')).toBe(false);
  });
});

describe('isClaudeAvailable', () => {
  it('is available when a token is set, even if the CLI probe fails', () => {
    expect(isClaudeAvailable({ claudeToken: 'tok' }, () => false)).toBe(true);
  });

  it('is available when the CLI probe succeeds, even with no token set', () => {
    expect(isClaudeAvailable({ claudeToken: undefined }, () => true)).toBe(true);
  });

  it('is unavailable when there is no token and the CLI probe fails', () => {
    expect(isClaudeAvailable({ claudeToken: undefined }, () => false)).toBe(false);
  });
});
