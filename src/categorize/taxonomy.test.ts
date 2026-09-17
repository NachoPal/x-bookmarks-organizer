import { describe, it, expect } from 'vitest';
import {
  buildTaxonomyPrompt,
  extractDomain,
  LlmTaxonomyDesigner,
  parseTaxonomy,
  type TaxonomyDesigner,
} from './taxonomy';
import type { LlmRunner } from './llm';
import type { ArticleContext } from '../articles/link-metadata';
import type { RawBookmark } from '../types';

const bm = (postId: string, text = 'hello', authorUsername = 'bob'): RawBookmark => ({
  postId,
  authorUsername,
  authorName: 'Bob',
  text,
  url: `https://x.com/${authorUsername}/status/${postId}`,
  postCreatedAt: '',
});

describe('extractDomain', () => {
  it('pulls a real domain out of post text', () => {
    expect(extractDomain('great paper https://arxiv.org/abs/1234 worth a read')).toBe('arxiv.org');
  });

  it('ignores t.co shortlinks (no topical signal)', () => {
    expect(extractDomain('check this out https://t.co/abcd')).toBeUndefined();
  });

  it('strips a www. prefix', () => {
    expect(extractDomain('see https://www.example.com/x')).toBe('example.com');
  });

  it('returns undefined when there is no URL', () => {
    expect(extractDomain('just a plain tweet')).toBeUndefined();
  });
});

describe('buildTaxonomyPrompt', () => {
  it('shows all bookmarks and asks for the target minimum depth', () => {
    const prompt = buildTaxonomyPrompt(
      [bm('1', 'a tweet about evals', 'alice'), bm('2', 'a tweet about godot', 'bob')],
      '(no categories yet)',
      3,
      4,
    );
    expect(prompt).toContain('@alice');
    expect(prompt).toContain('@bob');
    expect(prompt).toContain('a tweet about evals');
    expect(prompt).toContain('AT LEAST 3 levels');
    expect(prompt).toContain('Do not nest deeper than 4 levels');
    expect(prompt).toContain('"tree"');
  });

  it('includes an existing tree so incremental runs extend it', () => {
    const prompt = buildTaxonomyPrompt([bm('1')], '- AI\n  - Evals', 3, 4);
    expect(prompt).toContain('- AI');
    expect(prompt).toContain('  - Evals');
  });

  it('surfaces a linked domain as a hint', () => {
    const prompt = buildTaxonomyPrompt(
      [bm('1', 'paper https://arxiv.org/abs/1')],
      '(no categories yet)',
      3,
      4,
    );
    expect(prompt).toContain('[link: arxiv.org]');
  });

  it('includes the linked article title/description for a link-heavy post (issue #25)', () => {
    const articleContext = new Map<string, ArticleContext>([
      ['1', { title: 'New Transformer Architecture', description: 'A paper on sparse attention' }],
    ]);
    const prompt = buildTaxonomyPrompt(
      [bm('1', 'https://t.co/abcd')],
      '(no categories yet)',
      3,
      4,
      articleContext,
    );
    expect(prompt).toContain('[article: New Transformer Architecture - A paper on sparse attention]');
  });

  it('omits the article hint for a bookmark with no entry in articleContext', () => {
    const articleContext = new Map<string, ArticleContext>([
      ['2', { title: 'Unrelated' }],
    ]);
    const prompt = buildTaxonomyPrompt(
      [bm('1', 'https://t.co/abcd')],
      '(no categories yet)',
      3,
      4,
      articleContext,
    );
    expect(prompt).not.toContain('[article:');
  });
});

describe('parseTaxonomy', () => {
  it('parses a nested tree object', () => {
    const tree = parseTaxonomy(
      '{"tree":[{"name":"AI","children":[{"name":"LLMs","children":[{"name":"Evals","children":[]}]}]}]}',
    );
    expect(tree).toEqual([
      {
        name: 'AI',
        children: [{ name: 'LLMs', children: [{ name: 'Evals', children: [] }] }],
      },
    ]);
  });

  it('accepts a bare top-level array', () => {
    const tree = parseTaxonomy('[{"name":"AI","children":[]}]');
    expect(tree).toEqual([{ name: 'AI', children: [] }]);
  });

  it('handles markdown code fences and surrounding prose', () => {
    const tree = parseTaxonomy('Sure:\n```json\n{"tree":[{"name":"X","children":[]}]}\n```\nDone');
    expect(tree).toEqual([{ name: 'X', children: [] }]);
  });

  it('drops empty names and collapses duplicate siblings', () => {
    const tree = parseTaxonomy(
      '{"tree":[{"name":"","children":[]},{"name":"AI","children":[]},{"name":"ai","children":[]}]}',
    );
    expect(tree).toEqual([{ name: 'AI', children: [] }]);
  });

  it('tolerates missing children arrays', () => {
    const tree = parseTaxonomy('{"tree":[{"name":"AI"}]}');
    expect(tree).toEqual([{ name: 'AI', children: [] }]);
  });

  it('throws on non-JSON garbage', () => {
    expect(() => parseTaxonomy('I cannot help with that.')).toThrow();
  });
});

describe('LlmTaxonomyDesigner', () => {
  it('returns [] for an empty set without calling the runner', async () => {
    let called = false;
    const runner: LlmRunner = async () => {
      called = true;
      return '';
    };
    const designer: TaxonomyDesigner = new LlmTaxonomyDesigner(runner, {
      minDepth: 3,
      maxDepth: 4,
    });
    expect(await designer.designTaxonomy([], '(no categories yet)')).toEqual([]);
    expect(called).toBe(false);
  });

  it('passes the prompt to the runner and parses the tree', async () => {
    let seenPrompt = '';
    const runner: LlmRunner = async (prompt) => {
      seenPrompt = prompt;
      return '{"tree":[{"name":"AI","children":[]}]}';
    };
    const designer = new LlmTaxonomyDesigner(runner, { minDepth: 3, maxDepth: 4 });
    const tree = await designer.designTaxonomy([bm('1', 'about ai')], '(no categories yet)');
    expect(seenPrompt).toContain('about ai');
    expect(seenPrompt).toContain('AT LEAST 3 levels');
    expect(tree).toEqual([{ name: 'AI', children: [] }]);
  });

  it('forwards articleContext through to the prompt', async () => {
    let seenPrompt = '';
    const runner: LlmRunner = async (prompt) => {
      seenPrompt = prompt;
      return '{"tree":[]}';
    };
    const designer = new LlmTaxonomyDesigner(runner, { minDepth: 3, maxDepth: 4 });
    const articleContext = new Map<string, ArticleContext>([
      ['1', { title: 'Sparse Attention Explained' }],
    ]);
    await designer.designTaxonomy([bm('1', 'https://t.co/abcd')], '(no categories yet)', articleContext);
    expect(seenPrompt).toContain('[article: Sparse Attention Explained]');
  });
});
