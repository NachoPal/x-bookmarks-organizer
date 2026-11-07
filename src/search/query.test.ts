import { describe, it, expect } from 'vitest';
import { joinSearchTerms, parseSearchQuery } from './query';

describe('parseSearchQuery', () => {
  it('parses plain words as AND terms', () => {
    expect(parseSearchQuery('rust async')).toMatchObject({ terms: ['rust', 'async'], excludeTerms: [], from: [], category: [], list: [] });
  });

  it('keeps a quoted phrase as one term', () => {
    expect(parseSearchQuery('"prompt caching" node')).toMatchObject({ terms: ['prompt caching', 'node'] });
  });

  it('excludes a bare word and a quoted phrase', () => {
    expect(parseSearchQuery('rust -async -"old news"')).toMatchObject({
      terms: ['rust'],
      excludeTerms: ['async', 'old news'],
    });
  });

  it('parses from: with or without a leading @, lowercased', () => {
    expect(parseSearchQuery('from:@karpathy')).toMatchObject({ from: ['karpathy'], terms: [] });
    expect(parseSearchQuery('from:Karpathy')).toMatchObject({ from: ['karpathy'] });
  });

  it('ORs multiple from: values', () => {
    expect(parseSearchQuery('from:@a from:@b')).toMatchObject({ from: ['a', 'b'] });
  });

  it('combines from: with free-text keywords', () => {
    expect(parseSearchQuery('from:@karpathy transformers')).toMatchObject({ from: ['karpathy'], terms: ['transformers'] });
  });

  it('parses category: by bare name and by quoted name/path', () => {
    expect(parseSearchQuery('category:AI')).toMatchObject({ category: ['AI'] });
    expect(parseSearchQuery('category:"AI > Agents"')).toMatchObject({ category: ['AI > Agents'] });
    expect(parseSearchQuery('category:"Name with spaces"')).toMatchObject({ category: ['Name with spaces'] });
  });

  it('ORs repeated category: and list: values independently', () => {
    expect(parseSearchQuery('category:AI category:Cooking list:"Read later" list:Saved')).toMatchObject({
      category: ['AI', 'Cooking'],
      list: ['Read later', 'Saved'],
    });
  });

  it('combines category: and list: (both present, ANDed by the engine downstream)', () => {
    expect(parseSearchQuery('category:AI list:Saved')).toMatchObject({ category: ['AI'], list: ['Saved'] });
  });

  it('parses since: and until: as plain dates', () => {
    expect(parseSearchQuery('since:2024-01-01 until:2024-06-30')).toMatchObject({ since: '2024-01-01', until: '2024-06-30' });
  });

  it('drops a malformed since:/until: value rather than throwing', () => {
    expect(parseSearchQuery('since:not-a-date').since).toBeUndefined();
    // Well-formed digits, but no such calendar date.
    expect(parseSearchQuery('since:2024-13-99').since).toBeUndefined();
    expect(parseSearchQuery('since:').since).toBeUndefined();
  });

  it('works with operators alone, no keywords', () => {
    expect(parseSearchQuery('from:@karpathy')).toMatchObject({ terms: [], from: ['karpathy'] });
    expect(parseSearchQuery('category:AI')).toMatchObject({ terms: [], category: ['AI'] });
  });

  it('handles a full combination of every operator plus keywords and exclusion', () => {
    const parsed = parseSearchQuery('from:@karpathy "agent harness" -sourdough category:"AI > Agents" since:2024-01-01 until:2024-12-31');
    expect(parsed).toEqual({
      terms: ['agent harness'],
      excludeTerms: ['sourdough'],
      from: ['karpathy'],
      category: ['AI > Agents'],
      list: [],
      since: '2024-01-01',
      until: '2024-12-31',
    });
  });

  it('never throws on malformed or injection-ish input', () => {
    const inputs = [
      '"; DROP TABLE bookmarks; --',
      'from:',
      'category:',
      'list:',
      '-',
      '--',
      '""',
      '"unterminated',
      'from:@',
      '   ',
      '',
      'NOT (rust*',
      "'; SELECT * FROM bookmarks WHERE '1'='1",
    ];
    for (const raw of inputs) {
      expect(() => parseSearchQuery(raw)).not.toThrow();
    }
  });

  it('is empty for an empty or whitespace-only query', () => {
    expect(parseSearchQuery('')).toEqual({ terms: [], excludeTerms: [], from: [], category: [], list: [] });
    expect(parseSearchQuery('   ')).toEqual({ terms: [], excludeTerms: [], from: [], category: [], list: [] });
  });

  it('ignores a bare `from:`/`category:`/`list:` with nothing after the colon', () => {
    expect(parseSearchQuery('from: category: list: hello')).toMatchObject({
      from: [],
      category: [],
      list: [],
      terms: ['hello'],
    });
  });
});

describe('joinSearchTerms', () => {
  it('leaves a single word bare and wraps a multi-word atom back in quotes', () => {
    expect(joinSearchTerms(['rust', 'prompt caching'])).toBe('rust "prompt caching"');
  });

  it('is empty for an empty list', () => {
    expect(joinSearchTerms([])).toBe('');
  });
});
