import { describe, it, expect, afterEach } from 'vitest';
import {
  assembleTree,
  buildCategoryTree,
  materializeTaxonomy,
  orderSiblings,
  readRootOrder,
  pruneToProtected,
  renderTreeForPrompt,
  writeRootOrder,
} from './tree';
import { Database } from '../db/database';
import type { CategoryNode, TaxonomyNode } from '../types';

const cats: CategoryNode[] = [
  { id: 1, parentId: null, name: 'AI', createdAt: '' },
  { id: 2, parentId: 1, name: 'Harnesses', createdAt: '' },
  { id: 3, parentId: 1, name: 'Evals', createdAt: '' },
  { id: 4, parentId: null, name: 'Game Dev', createdAt: '' },
];

const read = (id: number) => ({ id, read: true });
const unread = (id: number) => ({ id, read: false });

describe('assembleTree', () => {
  it('rolls up total/unread counts from descendants to ancestors', () => {
    const membership = new Map([
      [2, [unread(10), read(11), read(12)]], // Harnesses: 3 total, 1 unread
      [3, [unread(20), unread(21)]], // Evals: 2 total, 2 unread
      [1, [read(30)]], // AI direct: 1 total, 0 unread
    ]);
    const roots = assembleTree(cats, membership);
    const ai = roots.find((r) => r.name === 'AI')!;
    expect(ai.total).toBe(6); // 1 direct + 3 + 2, all distinct ids
    expect(ai.unread).toBe(3); // 0 + 1 + 2
    expect(ai.directTotal).toBe(1);
    const gameDev = roots.find((r) => r.name === 'Game Dev')!;
    expect(gameDev.total).toBe(0);
  });

  it('counts a bookmark in several branches once at the shared ancestor', () => {
    // Bookmark 99 is filed under both Harnesses and Evals (siblings under AI),
    // and directly under AI. The AI rollup must count it once.
    const membership = new Map([
      [2, [unread(99)]], // Harnesses
      [3, [unread(99)]], // Evals
      [1, [unread(99)]], // AI directly
    ]);
    const roots = assembleTree(cats, membership);
    const ai = roots.find((r) => r.name === 'AI')!;
    expect(ai.total).toBe(1);
    expect(ai.unread).toBe(1);
    expect(ai.directTotal).toBe(1);
  });

  it('keeps read/unread rollup correct when the same id repeats across the subtree', () => {
    const membership = new Map([
      [2, [read(1), unread(2)]], // Harnesses
      [3, [read(1), unread(3)]], // Evals shares bookmark 1
    ]);
    const roots = assembleTree(cats, membership);
    const ai = roots.find((r) => r.name === 'AI')!;
    expect(ai.total).toBe(3); // distinct ids 1, 2, 3
    expect(ai.unread).toBe(2); // 2 and 3; 1 is read
  });

  it('assigns full paths from root to each node', () => {
    const roots = assembleTree(cats, new Map());
    const ai = roots.find((r) => r.name === 'AI')!;
    const harnesses = ai.children.find((c) => c.name === 'Harnesses')!;
    expect(ai.path).toEqual(['AI']);
    expect(harnesses.path).toEqual(['AI', 'Harnesses']);
  });

  it('sorts roots and children alphabetically', () => {
    const roots = assembleTree(cats, new Map());
    expect(roots.map((r) => r.name)).toEqual(['AI', 'Game Dev']);
    const ai = roots[0]!;
    expect(ai.children.map((c) => c.name)).toEqual(['Evals', 'Harnesses']);
  });
});

describe('materializeTaxonomy', () => {
  let db: Database;
  afterEach(() => db?.close());

  const tree: TaxonomyNode[] = [
    {
      name: 'AI',
      children: [
        { name: 'LLMs', children: [{ name: 'Evals', children: [] }] },
      ],
    },
    { name: 'Game Dev', children: [] },
  ];

  it('creates every node of the designed tree', () => {
    db = new Database(':memory:');
    materializeTaxonomy(db, tree, 4, new Date().toISOString());
    const names = db.getAllCategories().map((c) => c.name).sort();
    expect(names).toEqual(['AI', 'Evals', 'Game Dev', 'LLMs']);
    const rendered = renderTreeForPrompt(buildCategoryTree(db));
    expect(rendered).toContain('- AI');
    expect(rendered).toContain('    - Evals');
  });

  it('caps depth at maxDepth, truncating deeper branches', () => {
    db = new Database(':memory:');
    materializeTaxonomy(db, tree, 2, new Date().toISOString());
    const names = db.getAllCategories().map((c) => c.name).sort();
    expect(names).toEqual(['AI', 'Game Dev', 'LLMs']); // Evals (depth 3) dropped
  });

  it('is idempotent and merges with an existing tree (no duplicates)', () => {
    db = new Database(':memory:');
    const when = new Date().toISOString();
    materializeTaxonomy(db, tree, 4, when);
    const before = db.getAllCategories().length;
    materializeTaxonomy(db, tree, 4, when);
    expect(db.getAllCategories().length).toBe(before);
  });
});

describe('renderTreeForPrompt', () => {
  const when = '2024-01-01T00:00:00.000Z';

  it('renders an empty tree with a placeholder', () => {
    expect(renderTreeForPrompt([])).toBe('(no categories yet)');
  });

  it('renders an indented outline', () => {
    const roots = assembleTree(cats, new Map());
    const text = renderTreeForPrompt(roots);
    expect(text).toContain('- AI');
    expect(text).toContain('  - Evals');
    expect(text).toContain('  - Harnesses');
    expect(text).toContain('- Game Dev');
  });

  // Issue #61: descriptions are what tell the extend prompt how siblings
  // differ, instead of leaving the model to guess from bare labels.
  it('appends a node description when it has one', () => {
    const roots = assembleTree(
      [
        { id: 1, parentId: null, name: 'AI', description: 'Models and tooling.', createdAt: when },
        { id: 2, parentId: 1, name: 'Evals', description: 'Benchmarks.', createdAt: when },
      ],
      new Map(),
    );

    const text = renderTreeForPrompt(roots);

    expect(text).toContain('- AI - Models and tooling.');
    expect(text).toContain('  - Evals - Benchmarks.');
  });

  it('renders a node with no description exactly as before', () => {
    const roots = assembleTree(
      [{ id: 1, parentId: null, name: 'AI', description: null, createdAt: when }],
      new Map(),
    );

    expect(renderTreeForPrompt(roots)).toBe('- AI');
  });

  it('collapses whitespace and caps an overlong description', () => {
    const roots = assembleTree(
      [{ id: 1, parentId: null, name: 'AI', description: `a  b ${'x'.repeat(400)}`, createdAt: when }],
      new Map(),
    );

    const line = renderTreeForPrompt(roots);

    expect(line.startsWith('- AI - a b ')).toBe(true);
    expect(line.length).toBeLessThan(140);
  });
});

describe('root order (issue #82)', () => {
  const cats3: CategoryNode[] = [
    ...cats,
    { id: 5, parentId: null, name: 'Zebra', createdAt: '' },
    { id: 6, parentId: 5, name: 'B child', createdAt: '' },
    { id: 7, parentId: 5, name: 'A child', createdAt: '' },
  ];

  it('orders roots by the saved names, leaving children alphabetical', () => {
    const roots = assembleTree(cats3, new Map(), ['Zebra', 'Game Dev', 'AI']);
    expect(roots.map((r) => r.name)).toEqual(['Zebra', 'Game Dev', 'AI']);
    expect(roots[0].children.map((c) => c.name)).toEqual(['A child', 'B child']);
  });

  it('appends a root with no saved position, alphabetically, after the ordered ones', () => {
    const roots = assembleTree(cats3, new Map(), ['Zebra']);
    expect(roots.map((r) => r.name)).toEqual(['Zebra', 'AI', 'Game Dev']);
  });

  it('ignores a saved name whose root is gone', () => {
    const roots = assembleTree(cats3, new Map(), ['Gone', 'Game Dev']);
    expect(roots.map((r) => r.name)).toEqual(['Game Dev', 'AI', 'Zebra']);
  });

  it('round-trips through the db and survives a recategorize-style clear', () => {
    const db = new Database(':memory:');
    try {
      const now = new Date().toISOString();
      for (const n of ['AI', 'Game Dev', 'Zebra']) db.getOrCreateCategory(n, null, now);
      writeRootOrder(db, ['Zebra', 'AI', 'Game Dev']);
      expect(buildCategoryTree(db).map((r) => r.name)).toEqual(['Zebra', 'AI', 'Game Dev']);
      db.clearGeneratedCategories();
      for (const n of ['Game Dev', 'AI', 'Zebra', 'New']) db.getOrCreateCategory(n, null, now);
      expect(buildCategoryTree(db).map((r) => r.name)).toEqual(['Zebra', 'AI', 'Game Dev', 'New']);
    } finally {
      db.close();
    }
  });

  it('tolerates a corrupt stored blob', () => {
    const db = new Database(':memory:');
    try {
      db.setState('root_order', '{nope');
      expect(readRootOrder(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('sibling order at every level (orderSiblings)', () => {
  it('puts placed children first by position, then the never-placed ones by name', () => {
    const roots = assembleTree(
      [
        { id: 1, parentId: null, name: 'AI', createdAt: '' },
        { id: 2, parentId: 1, name: 'Zeta', position: 0, createdAt: '' },
        { id: 3, parentId: 1, name: 'Alpha', position: 1, createdAt: '' },
        { id: 4, parentId: 1, name: 'New B', createdAt: '' },
        { id: 5, parentId: 1, name: 'New A', position: null, createdAt: '' },
      ],
      new Map(),
    );
    expect(roots[0].children.map((c) => c.name)).toEqual(['Zeta', 'Alpha', 'New A', 'New B']);
  });

  it('ranks a root by its position, else by its index in the saved root names', () => {
    const nodes = [
      { name: 'B', position: null },
      { name: 'A', position: 1 },
      { name: 'C', position: null },
      { name: 'D', position: null },
    ];
    expect(orderSiblings(nodes, (n) => n.position, ['B', 'A', 'C']).map((n) => n.name)).toEqual([
      'B',
      'A',
      'C',
      'D',
    ]);
  });
});

describe('owner categories in the prompt tree', () => {
  it('marks the owner’s categories with [owner], and only them', () => {
    const db = new Database(':memory:');
    try {
      const when = new Date().toISOString();
      const ai = db.getOrCreateCategory('AI', null, when, 'Machine learning.');
      db.createCategory('My evals', ai.id, when);
      const text = renderTreeForPrompt(buildCategoryTree(db));
      expect(text).toBe('- AI - Machine learning.\n  - My evals [owner]');
    } finally {
      db.close();
    }
  });

  it('prunes a tree down to the protected ids', () => {
    const db = new Database(':memory:');
    try {
      const when = new Date().toISOString();
      const ai = db.getOrCreateCategory('AI', null, when);
      db.getOrCreateCategory('Evals', ai.id, when);
      db.createCategory('Mine', ai.id, when);
      db.getOrCreateCategory('Game Dev', null, when);
      const pruned = pruneToProtected(buildCategoryTree(db), db.getProtectedCategoryIds());
      expect(renderTreeForPrompt(pruned)).toBe('- AI\n  - Mine [owner]');
    } finally {
      db.close();
    }
  });
});
