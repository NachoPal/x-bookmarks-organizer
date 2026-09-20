import { describe, expect, it } from 'vitest';
import {
  compareFilings,
  computeAgreement,
  computeConfidence,
  computeDistribution,
  formatPath,
  sampleDisagreements,
  summarizeText,
  UNPLACED_LABEL,
  type FiledPath,
  type PairedFiling,
} from './compare';

/**
 * The whole comparison is a pure function of two filings, so every test here
 * drives it with a hand-built fixture: no database, no SDK, no network, no
 * clock. The fixture is built so the two methods PARTLY agree - the interesting
 * case, and the one the counts have to get right.
 */

/** Node ids in the pretend eval tree: 1 AI > {10 Harnesses > 100 MCP, 11 Research}, 2 Cooking > 20 Bread. */
const AI_MCP: FiledPath = { leafId: 100, rootId: 1, names: ['AI', 'Harnesses', 'MCP'] };
const AI_HARNESSES: FiledPath = { leafId: 10, rootId: 1, names: ['AI', 'Harnesses'] };
const AI_RESEARCH: FiledPath = { leafId: 11, rootId: 1, names: ['AI', 'Research'] };
const COOKING_BREAD: FiledPath = { leafId: 20, rootId: 2, names: ['Cooking', 'Bread'] };

function pair(overrides: Partial<PairedFiling> & { postId: string }): PairedFiling {
  return {
    author: '@alice',
    text: 'a post',
    claude: { paths: [] },
    jev: { paths: [] },
    jevEarlyStopped: false,
    jevUnresolved: false,
    ...overrides,
  };
}

/**
 * Six bookmarks:
 *  1 both -> AI>Harnesses>MCP          exact leaf agreement
 *  2 both -> AI>Research               exact leaf agreement
 *  3 Claude AI>Research, Jev AI>Harnesses   same ROOT, different leaf
 *  4 Claude Cooking>Bread, Jev AI>Research  different root entirely
 *  5 Claude AI>MCP, Jev unplaced (unresolved)
 *  6 neither placed it
 */
const FIXTURE: PairedFiling[] = [
  pair({ postId: '1', claude: { paths: [AI_MCP] }, jev: { paths: [AI_MCP] }, jevConfidence: 0.9 }),
  pair({ postId: '2', claude: { paths: [AI_RESEARCH] }, jev: { paths: [AI_RESEARCH] }, jevConfidence: 0.8 }),
  pair({
    postId: '3',
    text: 'agent harness notes',
    claude: { paths: [AI_RESEARCH] },
    jev: { paths: [AI_HARNESSES] },
    jevConfidence: 0.6,
    jevEarlyStopped: true,
  }),
  pair({
    postId: '4',
    text: 'sourdough starter',
    claude: { paths: [COOKING_BREAD] },
    jev: { paths: [AI_RESEARCH] },
    jevConfidence: 0.5,
  }),
  pair({ postId: '5', claude: { paths: [AI_MCP] }, jev: { paths: [] }, jevUnresolved: true }),
  pair({ postId: '6', jevUnresolved: true }),
];

describe('computeAgreement', () => {
  it('counts exact-leaf and top-level agreement over the bookmarks BOTH methods placed', () => {
    const a = computeAgreement(FIXTURE);

    expect(a.bookmarks).toBe(6);
    expect(a.bothPlaced).toBe(4);
    expect(a.samePrimaryLeaf).toBe(2); // 1 and 2
    expect(a.samePrimaryRoot).toBe(3); // 1, 2 and 3 all sit under AI
    expect(a.onlyClaudePlaced).toBe(1); // 5
    expect(a.onlyJevPlaced).toBe(0);
    expect(a.bothUnplaced).toBe(1); // 6
  });

  it('never counts two unplaced filings as agreement', () => {
    const a = computeAgreement([pair({ postId: 'x' })]);

    expect(a.samePrimaryLeaf).toBe(0);
    expect(a.bothPlaced).toBe(0);
    expect(a.bothUnplaced).toBe(1);
  });

  it('reads multi-label leniently: sharing any leaf counts, even off the primary path', () => {
    // Claude's PRIMARY is Research, Jev's is MCP - so the strict measure says
    // "different" while the lenient one says "they overlap".
    const multi = pair({
      postId: 'm',
      claude: { paths: [AI_RESEARCH, AI_MCP] },
      jev: { paths: [AI_MCP] },
      jevConfidence: 0.7,
    });
    const a = computeAgreement([multi]);

    expect(a.samePrimaryLeaf).toBe(0);
    expect(a.sharedLeaf).toBe(1);
    expect(a.sharedRoot).toBe(1);
  });

  it('distinguishes identically named nodes under different parents, because it compares ids', () => {
    const left: FiledPath = { leafId: 41, rootId: 1, names: ['AI', 'Tools'] };
    const right: FiledPath = { leafId: 42, rootId: 2, names: ['Cooking', 'Tools'] };
    const a = computeAgreement([pair({ postId: 't', claude: { paths: [left] }, jev: { paths: [right] } })]);

    expect(a.samePrimaryLeaf).toBe(0);
    expect(a.samePrimaryRoot).toBe(0);
  });
});

describe('computeDistribution', () => {
  it('ranks each method’s categories by count and reports what each left unplaced', () => {
    const d = computeDistribution(FIXTURE);

    expect(d.claudeTop[0]).toEqual({ path: ['AI', 'Harnesses', 'MCP'], count: 2 });
    expect(d.claudeUnplaced).toBe(1); // 6
    expect(d.jevUnplaced).toBe(2); // 5 and 6
    expect(d.jevTop.find((c) => c.path.join('>') === 'AI>Research')?.count).toBe(2); // 2 and 4
  });

  it('counts a bookmark once per DISTINCT leaf, and reports labels per bookmark', () => {
    const d = computeDistribution([
      pair({ postId: 'a', claude: { paths: [AI_MCP, AI_RESEARCH] }, jev: { paths: [AI_MCP] } }),
      pair({ postId: 'b', claude: { paths: [AI_MCP] }, jev: { paths: [AI_MCP] } }),
    ]);

    expect(d.claudeDistinctLeaves).toBe(2);
    expect(d.claudeLabelsPerBookmark).toBe(1.5);
    expect(d.jevLabelsPerBookmark).toBe(1);
  });

  it('caps each side at the requested number of categories', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      pair({ postId: `p${i}`, claude: { paths: [{ leafId: i, rootId: i, names: [`C${i}`] }] } }),
    );

    expect(computeDistribution(many, 3).claudeTop).toHaveLength(3);
  });
});

describe('computeConfidence', () => {
  it('separates Jev’s early stop from its abstention and from Claude’s Uncategorized', () => {
    const c = computeConfidence(FIXTURE);

    expect(c.jevEarlyStopped).toBe(1); // 3
    expect(c.jevUnresolved).toBe(2); // 5 and 6
    expect(c.claudeUnplaced).toBe(1); // 6
    expect(c.jevErrored).toBe(0);
  });

  it('splits Jev’s confidence by whether it agreed with Claude', () => {
    const c = computeConfidence(FIXTURE);

    // Agreements: 0.9 and 0.8. Disagreements: 0.6 and 0.5.
    expect(c.jevMeanConfidenceWhenAgreeing).toBeCloseTo(0.85, 5);
    expect(c.jevMeanConfidenceWhenDisagreeing).toBeCloseTo(0.55, 5);
    expect(c.jevMedianConfidence).toBeCloseTo(0.7, 5);
  });

  it('reports null rather than zero when Jev placed nothing at all', () => {
    const c = computeConfidence([pair({ postId: 'x', jevUnresolved: true })]);

    expect(c.jevMeanConfidence).toBeNull();
    expect(c.jevMedianConfidence).toBeNull();
  });

  it('counts a failed walk apart - it is not an opinion either way', () => {
    const c = computeConfidence([pair({ postId: 'x', jevError: 'TypeSafe request failed: boom' })]);

    expect(c.jevErrored).toBe(1);
  });
});

describe('sampleDisagreements', () => {
  it('collects every bookmark whose primary leaves differ, with both paths side by side', () => {
    const sample = sampleDisagreements(FIXTURE);

    expect(sample.total).toBe(3); // 3, 4 and 5
    const row = sample.rows.find((r) => r.text === 'agent harness notes')!;
    expect(row.claudePath).toBe('AI > Research');
    expect(row.jevPath).toBe('AI > Harnesses');
    expect(row.jevConfidence).toBeCloseTo(0.6, 5);
    expect(row.jevEarlyStopped).toBe(true);
  });

  it('labels the side that placed nothing rather than leaving the cell blank', () => {
    const rows = sampleDisagreements(FIXTURE).rows;

    expect(rows.some((r) => r.jevPath === UNPLACED_LABEL)).toBe(true);
  });

  it('caps the table and spreads the rows across the whole run, not just the front', () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      pair({
        postId: `p${i}`,
        text: `post ${i}`,
        claude: { paths: [AI_MCP] },
        jev: { paths: [AI_RESEARCH] },
      }),
    );

    const sample = sampleDisagreements(many, 10);

    expect(sample.total).toBe(100);
    expect(sample.rows).toHaveLength(10);
    expect(sample.rows[0]!.text).toBe('post 0');
    // Stride sampling, so the last row comes from the tail of the run.
    expect(sample.rows[9]!.text).toBe('post 90');
  });

  it('is deterministic: the same filings always sample the same rows', () => {
    const first = sampleDisagreements(FIXTURE, 2);
    const second = sampleDisagreements(FIXTURE, 2);

    expect(first.rows).toEqual(second.rows);
  });
});

describe('formatting helpers', () => {
  it('renders a path as a breadcrumb and an empty filing as the unplaced label', () => {
    expect(formatPath(AI_MCP)).toBe('AI > Harnesses > MCP');
    expect(formatPath(undefined)).toBe(UNPLACED_LABEL);
  });

  it('collapses whitespace and caps a post body so a table row stays one line', () => {
    expect(summarizeText('a\n\n  b  ')).toBe('a b');
    expect(summarizeText('abcdef', 4)).toBe('abc…');
  });
});

describe('compareFilings', () => {
  it('assembles every section from one pass over the filings', () => {
    const comparison = compareFilings(FIXTURE, { disagreementRows: 2 });

    expect(comparison.agreement.bookmarks).toBe(6);
    expect(comparison.distribution.claudeTop.length).toBeGreaterThan(0);
    expect(comparison.confidence.jevUnresolved).toBe(2);
    expect(comparison.disagreements.rows).toHaveLength(2);
    expect(comparison.disagreements.total).toBe(3);
  });
});
