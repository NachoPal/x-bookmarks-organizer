import { describe, it, expect } from 'vitest';
import { assembleTree, renderTreeForPrompt } from './tree';
import type { CategoryNode } from '../types';

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

describe('renderTreeForPrompt', () => {
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
});
