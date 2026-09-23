import { describe, it, expect } from 'vitest';
import {
  buildReconcilePrompt,
  buildTaxonomyPrompt,
  extractDomain,
  LlmTaxonomyDesigner,
  MAX_NODE_DESCRIPTION_CHARS,
  parseTaxonomy,
  type TaxonomyDesigner,
} from './taxonomy';
import type { LlmRunner } from './llm';
import {
  DEFAULT_TAXONOMY_CONTEXT_WINDOW,
  TAXONOMY_INPUT_FRACTION,
  estimateTokens,
  inputBudgetFor,
} from './taxonomy-budget';
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

describe('node descriptions (issue #61)', () => {
  it('asks the designer for a one-line description per node', () => {
    const prompt = buildTaxonomyPrompt([], '(no categories yet)', 3, 4);

    expect(prompt).toContain('one-sentence "description"');
    expect(prompt).toContain('SEPARATE that node from its siblings');
    // The output shape it is shown must carry the field too.
    expect(prompt).toContain('"description"');
  });

  it('parses a description onto each node', () => {
    const taxonomy = parseTaxonomy(
      JSON.stringify({
        tree: [
          {
            name: 'AI',
            description: 'Machine learning and tooling.',
            children: [{ name: 'Harnesses', description: 'Agent harnesses.', children: [] }],
          },
        ],
      }),
    );

    expect(taxonomy[0]!.description).toBe('Machine learning and tooling.');
    expect(taxonomy[0]!.children[0]!.description).toBe('Agent harnesses.');
  });

  it('collapses whitespace and caps an overlong description', () => {
    const taxonomy = parseTaxonomy(
      JSON.stringify({ tree: [{ name: 'AI', description: `a  b\n c ${'x'.repeat(400)}`, children: [] }] }),
    );

    expect(taxonomy[0]!.description!.length).toBe(MAX_NODE_DESCRIPTION_CHARS);
    expect(taxonomy[0]!.description!.startsWith('a b c ')).toBe(true);
  });

  it('omits the description entirely when the model did not supply one', () => {
    const taxonomy = parseTaxonomy(JSON.stringify({ tree: [{ name: 'AI', children: [] }] }));

    expect(taxonomy[0]!.description).toBeUndefined();
    expect(taxonomy[0]!.name).toBe('AI');
  });

  it('ignores a non-string description rather than failing the whole parse', () => {
    const taxonomy = parseTaxonomy(
      JSON.stringify({ tree: [{ name: 'AI', description: { nope: 1 }, children: [] }] }),
    );

    expect(taxonomy[0]!.description).toBeUndefined();
    expect(taxonomy[0]!.name).toBe('AI');
  });
});

describe('context-window-aware design (issue #109)', () => {
  const EMPTY = '(no categories yet)';
  /** Every line the same length (to within an index digit), so batch sizes are predictable. */
  const library = (n: number) =>
    Array.from({ length: n }, (_, i) => bm(String(i), `post ${String(i).padStart(4, '0')} ${'x'.repeat(190)}`));

  /** A fake taxonomy model: each batch designs its own tree, the merge returns `merged`. */
  function fakeModel(opts: { merged?: string; batch?: (index: number) => string } = {}) {
    const prompts: string[] = [];
    const runner: LlmRunner = async (prompt) => {
      prompts.push(prompt);
      if (prompt.startsWith('You are merging')) {
        return opts.merged ?? '{"tree":[{"name":"Merged","description":"All of it.","children":[]}]}';
      }
      const part = /PART (\d+) of/.exec(prompt)?.[1] ?? '0';
      return opts.batch?.(Number(part)) ?? `{"tree":[{"name":"Topic ${part}","children":[]}]}`;
    };
    return { runner, prompts };
  }

  it('a library that fits is ONE call with the exact same prompt as before, and logs nothing', async () => {
    const { runner, prompts } = fakeModel();
    const logs: string[] = [];
    const books = library(40);
    const designer = new LlmTaxonomyDesigner(runner, {
      minDepth: 3,
      maxDepth: 4,
      contextWindow: async () => 200_000,
      log: (m) => logs.push(m),
    });
    const tree = await designer.designTaxonomy(books, EMPTY);
    expect(prompts).toEqual([buildTaxonomyPrompt(books, EMPTY, 3, 4)]);
    expect(tree).toEqual([{ name: 'Topic 0', children: [] }]);
    expect(logs).toEqual([]);
  });

  it('overflowing the budget splits into the fewest fitting batches, then makes one merge call', async () => {
    const books = library(60);
    // Size the window so exactly 20 lines fit beside the batch prompt's scaffold.
    const scaffold = estimateTokens(buildTaxonomyPrompt([], EMPTY, 3, 4, undefined, { index: 60, count: 60 }));
    const lines = buildTaxonomyPrompt(books, EMPTY, 3, 4)
      .split('\n')
      .filter((l) => /^\[\d+\] @bob:/.test(l));
    const widest = Math.max(...lines.map((l) => estimateTokens(`${l}\n`)));
    const contextWindow = Math.ceil((scaffold + 20 * widest + 5) / TAXONOMY_INPUT_FRACTION);
    const budget = inputBudgetFor(contextWindow);

    const { runner, prompts } = fakeModel();
    const logs: string[] = [];
    const designer = new LlmTaxonomyDesigner(runner, {
      minDepth: 3,
      maxDepth: 4,
      contextWindow: async () => contextWindow,
      log: (m) => logs.push(m),
    });
    const tree = await designer.designTaxonomy(books, EMPTY);

    // 3 batch designs + 1 reconciliation.
    expect(prompts).toHaveLength(4);
    for (const [i, prompt] of prompts.slice(0, 3).entries()) {
      expect(prompt).toContain(`PART ${i + 1} of 3`);
      expect(prompt).not.toContain('You are shown ALL of the bookmarks');
      expect(prompt.match(/^\[\d+\] @bob:/gm)).toHaveLength(20);
      expect(estimateTokens(prompt)).toBeLessThanOrEqual(budget);
    }
    // Every bookmark lands in exactly one batch, in order.
    const shown = prompts.slice(0, 3).flatMap((p) => [...p.matchAll(/post (\d{4})/g)].map((m) => Number(m[1])));
    expect(shown).toEqual(books.map((_, i) => i));

    const merge = prompts[3]!;
    expect(merge).toMatch(/^You are merging/);
    for (const n of [1, 2, 3]) expect(merge).toContain(`"name":"Topic ${n}"`);
    expect(tree).toEqual([{ name: 'Merged', description: 'All of it.', children: [] }]);
    expect(logs[0]).toMatch(/exceeds the ~\d+-token input budget/);
    expect(logs).toContain('Merging 3 batch taxonomies into one tree...');
  });

  it('with no declared window, the safe default applies - a large library is batched, not sent whole', async () => {
    const books = library(2_000); // ~108k tokens: over 75% of the 128k default
    const unknown = fakeModel();
    await new LlmTaxonomyDesigner(unknown.runner, {
      minDepth: 3,
      maxDepth: 4,
      contextWindow: async () => undefined,
    }).designTaxonomy(books, EMPTY);
    expect(unknown.prompts.length).toBeGreaterThan(1);
    for (const p of unknown.prompts) {
      expect(estimateTokens(p)).toBeLessThanOrEqual(inputBudgetFor(DEFAULT_TAXONOMY_CONTEXT_WINDOW));
    }

    // Omitting the resolver entirely is the same safe default.
    const omitted = fakeModel();
    await new LlmTaxonomyDesigner(omitted.runner, { minDepth: 3, maxDepth: 4 }).designTaxonomy(books, EMPTY);
    expect(omitted.prompts).toEqual(unknown.prompts);

    // The same library on a model that declares a 1M window is a single call.
    const big = fakeModel();
    await new LlmTaxonomyDesigner(big.runner, {
      minDepth: 3,
      maxDepth: 4,
      contextWindow: async () => 1_000_000,
    }).designTaxonomy(books, EMPTY);
    expect(big.prompts).toEqual([buildTaxonomyPrompt(books, EMPTY, 3, 4)]);
  });

  it('the merge sees every part with its descriptions, and equivalent categories come back as one', async () => {
    const parts = [
      '{"tree":[{"name":"AI Agents","description":"Autonomous LLM agents that plan and call tools.","children":[]}]}',
      '{"tree":[{"name":"Agentic AI","description":"LLM systems that act on their own with tools.","children":[]}]}',
    ];
    // The model merges the equivalents - and repeats the survivor, which parsing collapses.
    const merged =
      '{"tree":[{"name":"AI Agents","description":"LLMs that plan and act with tools.","children":[]},' +
      '{"name":"ai agents","children":[]}]}';
    const { runner, prompts } = fakeModel({ merged, batch: (n) => parts[n - 1]! });
    const books = library(2_000);
    const tree = await new LlmTaxonomyDesigner(runner, {
      minDepth: 2,
      maxDepth: 4,
      contextWindow: async () => 120_000, // two batches' worth
    }).designTaxonomy(books, EMPTY);

    expect(prompts).toHaveLength(3);
    const merge = prompts[2]!;
    expect(merge).toContain('## Part 1 of 2');
    expect(merge).toContain('## Part 2 of 2');
    expect(merge).toContain('Autonomous LLM agents that plan and call tools.');
    expect(merge).toContain('LLM systems that act on their own with tools.');
    expect(merge).toContain('"AI Agents" and "Agentic AI"');
    expect(merge).toContain('AT LEAST 2 levels');
    expect(merge).toContain('deeper than 4 levels');
    expect(tree).toEqual([{ name: 'AI Agents', description: 'LLMs that plan and act with tools.', children: [] }]);
  });

  it('a failed batch fails the whole design - no merge, no partial tree', async () => {
    const prompts: string[] = [];
    const runner: LlmRunner = async (prompt) => {
      prompts.push(prompt);
      if (prompt.includes('PART 2 of')) throw new Error('model unavailable');
      return '{"tree":[{"name":"A","children":[]}]}';
    };
    const designer = new LlmTaxonomyDesigner(runner, { minDepth: 3, maxDepth: 4, contextWindow: async () => 60_000 });
    await expect(designer.designTaxonomy(library(2_000), EMPTY)).rejects.toThrow('model unavailable');
    expect(prompts.some((p) => p.startsWith('You are merging'))).toBe(false);
  });

  it('an empty batch tree or an empty merge fails loudly instead of yielding a broken tree', async () => {
    const opts = { minDepth: 3, maxDepth: 4, contextWindow: async () => 120_000 };
    const emptyBatch = fakeModel({ batch: (n) => (n === 2 ? '{"tree":[]}' : '{"tree":[{"name":"A","children":[]}]}') });
    await expect(new LlmTaxonomyDesigner(emptyBatch.runner, opts).designTaxonomy(library(2_000), EMPTY)).rejects.toThrow(
      /batch 2\/2 came back as an empty tree/,
    );

    const emptyMerge = fakeModel({ merged: '{"tree":[]}' });
    await expect(new LlmTaxonomyDesigner(emptyMerge.runner, opts).designTaxonomy(library(2_000), EMPTY)).rejects.toThrow(
      /reconciliation returned an empty tree/,
    );

    const garbage = fakeModel({ merged: 'I cannot merge these.' });
    await expect(new LlmTaxonomyDesigner(garbage.runner, opts).designTaxonomy(library(2_000), EMPTY)).rejects.toThrow(
      /no JSON/,
    );
  });
});

describe('buildReconcilePrompt', () => {
  it('lists each part with its bookmark count as JSON and keeps the pass-1 output shape', () => {
    const prompt = buildReconcilePrompt(
      [
        { tree: [{ name: 'Rust', description: 'The Rust language.', children: [] }], bookmarkCount: 700 },
        { tree: [{ name: 'Rust Lang', children: [] }], bookmarkCount: 650 },
      ],
      '(no categories yet)',
      3,
      5,
    );
    expect(prompt).toContain('split into 2 parts');
    expect(prompt).toContain('## Part 1 of 2 (700 bookmarks)\n{"tree":[{"name":"Rust","description":"The Rust language.","children":[]}]}');
    expect(prompt).toContain('## Part 2 of 2 (650 bookmarks)');
    expect(prompt).toContain('Return ONLY a JSON object');
  });
});
