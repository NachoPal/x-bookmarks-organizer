import { describe, it, expect } from 'vitest';
import { assembleTree, renderTreeForPrompt } from './tree';
import type { CategoryNode } from '../types';

const cats: CategoryNode[] = [
  { id: 1, parentId: null, name: 'AI', createdAt: '' },
  { id: 2, parentId: 1, name: 'Harnesses', createdAt: '' },
  { id: 3, parentId: 1, name: 'Evals', createdAt: '' },
  { id: 4, parentId: null, name: 'Game Dev', createdAt: '' },
];

describe('assembleTree', () => {
  it('rolls up total/unread counts from descendants to ancestors', () => {
    const direct = new Map([
      [2, { total: 3, unread: 1 }],
      [3, { total: 2, unread: 2 }],
      [1, { total: 1, unread: 0 }],
    ]);
    const roots = assembleTree(cats, direct);
    const ai = roots.find((r) => r.name === 'AI')!;
    expect(ai.total).toBe(6); // 1 direct + 3 + 2
    expect(ai.unread).toBe(3); // 0 + 1 + 2
    expect(ai.directTotal).toBe(1);
    const gameDev = roots.find((r) => r.name === 'Game Dev')!;
    expect(gameDev.total).toBe(0);
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
