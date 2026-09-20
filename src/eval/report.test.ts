import { describe, expect, it } from 'vitest';
import { compareFilings, type FiledPath, type PairedFiling } from './compare';
import { renderEvalReport, type EvalReport } from './report';

/** Pure rendering: a finished report in, a Markdown string out. No I/O anywhere. */

const AI_MCP: FiledPath = { leafId: 100, rootId: 1, names: ['AI', 'Harnesses', 'MCP'] };
const AI_RESEARCH: FiledPath = { leafId: 11, rootId: 1, names: ['AI', 'Research'] };

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

function report(pairs: PairedFiling[]): EvalReport {
  return {
    meta: {
      generatedAt: '2024-05-01T12:00:00.000Z',
      bookmarks: pairs.length,
      libraryBookmarks: pairs.length,
      treeNodes: 12,
      treeRoots: 3,
      maxDepth: 4,
      taxonomyProvider: 'claude-cli',
      taxonomyModel: 'claude-opus-5',
      taxonomyEffort: 'high',
      claudeProvider: 'claude-cli',
      claudeModel: 'claude-haiku-4-5',
      jevModel: 'jev-latest',
      beamWidth: 3,
      confidenceThreshold: 0.55,
      multiLabelThreshold: 0.6,
      maxLabels: 3,
    },
    cost: { taxonomyMs: 41_000, claudeMs: 12_500, jevMs: 8_200, jevRequests: 42, jevInputTokens: 1234 },
    comparison: compareFilings(pairs),
  };
}

const PAIRS: PairedFiling[] = [
  pair({ postId: '1', claude: { paths: [AI_MCP] }, jev: { paths: [AI_MCP] }, jevConfidence: 0.9 }),
  pair({
    postId: '2',
    text: 'a post about | pipes',
    claude: { paths: [AI_MCP] },
    jev: { paths: [AI_RESEARCH] },
    jevConfidence: 0.6,
  }),
];

describe('renderEvalReport', () => {
  const markdown = renderEvalReport(report(PAIRS));

  it('heads the document with the run: date, counts, tree size and the exact models', () => {
    expect(markdown).toContain('# Categorizer comparison: Claude vs TypeSafe/Jev');
    expect(markdown).toContain('2024-05-01T12:00:00.000Z');
    expect(markdown).toContain('12 node(s), 3 top-level branch(es), max depth 4');
    expect(markdown).toContain('claude-opus-5, effort high');
    expect(markdown).toContain('claude-haiku-4-5');
    expect(markdown).toContain('jev-latest');
  });

  it('states the Jev walk settings the comparison actually ran under', () => {
    expect(markdown).toContain('beam 3, confidence >= 0.55, multi-label >= 0.6, max 3 label(s)');
  });

  it('says a run is only one sample, because Claude filing is non-deterministic', () => {
    expect(markdown).toContain('one sample');
    expect(markdown).toContain('non-deterministic');
  });

  it('spells out the multi-label and early-stop rules the percentages rest on', () => {
    expect(markdown).toContain('## How the numbers are counted');
    expect(markdown).toContain('Multi-label');
    expect(markdown).toContain('low-confidence early stop is not an abstention');
  });

  it('reports agreement as a share of the bookmarks BOTH methods placed', () => {
    expect(markdown).toContain('| Same exact leaf (primary paths) | 1 | 50.0% |');
    expect(markdown).toContain('not of the whole run');
  });

  it('puts the two distributions side by side in one table', () => {
    expect(markdown).toContain('| # | Claude category | n | Jev category | n |');
    expect(markdown).toContain('AI > Harnesses > MCP');
  });

  it('shows the sampled disagreements, escaping a pipe so the table survives it', () => {
    expect(markdown).toContain('## Sampled disagreements');
    expect(markdown).toContain('a post about \\| pipes');
    expect(markdown).toContain('| @alice | a post about \\| pipes | AI > Harnesses > MCP | AI > Research | 0.60 |');
  });

  it('reports wall clock per method and the Jev token spend, and says Claude is free', () => {
    expect(markdown).toContain('| Claude filing pass | 12.5s |');
    expect(markdown).toContain('| Jev filing pass | 8.2s |');
    expect(markdown).toContain('| Jev input tokens billed | 1234 |');
    expect(markdown).toContain('free at the margin');
  });

  it('renders n/a rather than a misleading zero when a measure has no denominator', () => {
    const empty = renderEvalReport(report([pair({ postId: 'x', jevUnresolved: true })]));

    expect(empty).toContain('| Same exact leaf (primary paths) | 0 | n/a |');
    expect(empty).toContain('| Jev primary-path score, mean | n/a |');
  });

  it('says so plainly when the two methods never disagreed', () => {
    const agreeing = renderEvalReport(
      report([pair({ postId: '1', claude: { paths: [AI_MCP] }, jev: { paths: [AI_MCP] }, jevConfidence: 0.9 })]),
    );

    expect(agreeing).toContain('_The two methods filed every bookmark the same way._');
  });

  it('says how much of the library a limited run covered', () => {
    const limited = report(PAIRS);
    limited.meta.libraryBookmarks = 500;

    expect(renderEvalReport(limited)).toContain('2 of 500 in the library');
  });
});
