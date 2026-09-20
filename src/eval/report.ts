/**
 * Render the comparison as the Markdown document the owner actually reads.
 *
 * PURE, like `compare.ts`: it takes a finished {@link EvalReport} and returns a
 * string, so the whole document is asserted in tests without a database, an
 * API, or a file on disk. Nothing here recomputes a metric - if a number is not
 * in the {@link Comparison}, it does not belong in the report.
 */
import {
  UNPLACED_LABEL,
  type CategoryCount,
  type Comparison,
  type DisagreementRow,
} from './compare';

/** What the run was configured with - the header the owner reads first. */
export interface EvalReportMeta {
  /** ISO-8601, injected so a test can assert the document byte for byte. */
  generatedAt: string;
  /** Bookmarks actually compared. */
  bookmarks: number;
  /** Bookmarks stored in the library, so a `--limit`ed run says what it skipped. */
  libraryBookmarks: number;
  /** Nodes in the freshly designed eval tree. */
  treeNodes: number;
  /** Top-level branches in it. */
  treeRoots: number;
  maxDepth: number;
  taxonomyProvider: string;
  taxonomyModel: string;
  taxonomyEffort: string;
  claudeProvider: string;
  claudeModel: string;
  jevModel: string;
  beamWidth: number;
  confidenceThreshold: number;
  multiLabelThreshold: number;
  maxLabels: number;
}

/** What the run cost, in time and in tokens. */
export interface EvalCost {
  /** Wall clock of the pass-1 taxonomy design. */
  taxonomyMs: number;
  /** Wall clock of the whole Claude filing pass. */
  claudeMs: number;
  /** Wall clock of the whole Jev filing pass. */
  jevMs: number;
  /** TypeSafe HTTP requests issued, retries included. */
  jevRequests: number;
  /** Input tokens TypeSafe reported billing. Output tokens are free. */
  jevInputTokens: number;
}

export interface EvalReport {
  meta: EvalReportMeta;
  cost: EvalCost;
  comparison: Comparison;
}

/** A percentage of `total`, or "n/a" when there is nothing to divide by. */
function pct(count: number, total: number): string {
  if (total === 0) return 'n/a';
  return `${((count / total) * 100).toFixed(1)}%`;
}

function ratio(count: number, total: number): string {
  return `${count} / ${total} (${pct(count, total)})`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function score(value: number | null | undefined): string {
  return value == null ? 'n/a' : value.toFixed(3);
}

/** Make a value safe inside a Markdown table cell. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function table(headers: string[], rows: string[][]): string {
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ];
  return lines.join('\n');
}

/** Pair the two distribution tables row by row so they read side by side. */
function distributionRows(claude: CategoryCount[], jev: CategoryCount[]): string[][] {
  const rows: string[][] = [];
  for (let i = 0; i < Math.max(claude.length, jev.length); i++) {
    const c = claude[i];
    const j = jev[i];
    rows.push([
      String(i + 1),
      c ? c.path.join(' > ') : '',
      c ? String(c.count) : '',
      j ? j.path.join(' > ') : '',
      j ? String(j.count) : '',
    ]);
  }
  return rows;
}

function disagreementRows(rows: DisagreementRow[]): string[][] {
  return rows.map((row) => [
    row.author,
    row.text,
    row.claudePath,
    row.jevPath + (row.jevEarlyStopped ? ' *(stopped early)*' : ''),
    row.jevConfidence == null ? 'n/a' : row.jevConfidence.toFixed(2),
  ]);
}

export function renderEvalReport(report: EvalReport): string {
  const { meta, cost, comparison } = report;
  const { agreement, distribution, confidence, disagreements } = comparison;
  const out: string[] = [];

  out.push('# Categorizer comparison: Claude vs TypeSafe/Jev');
  out.push('');
  out.push(
    'Both methods filed the SAME bookmarks into the SAME freshly designed tree, from the ' +
      'same article/link context. Pass 1 (taxonomy design) is always Claude and cannot be ' +
      'Jev, so the filing pass is the only thing that differs here - every difference below ' +
      'is attributable to the filing method rather than to taxonomy randomness.',
  );
  out.push('');
  out.push(
    '**This run is one sample.** The Claude filing pass is a language model and is ' +
      'non-deterministic: the same bookmarks, the same tree and the same prompt can be filed ' +
      'differently on a second run. Jev is steadier but not a fixed point either. Read the ' +
      'agreement percentages as an order of magnitude, and the disagreement table - where you ' +
      'can judge who filed better - as the real evidence.',
  );
  out.push('');

  out.push('## Run');
  out.push('');
  out.push(
    table(
      ['Field', 'Value'],
      [
        ['Generated', meta.generatedAt],
        [
          'Bookmarks compared',
          meta.bookmarks === meta.libraryBookmarks
            ? String(meta.bookmarks)
            : `${meta.bookmarks} of ${meta.libraryBookmarks} in the library`,
        ],
        ['Eval tree', `${meta.treeNodes} node(s), ${meta.treeRoots} top-level branch(es), max depth ${meta.maxDepth}`],
        ['Taxonomy pass (1)', `${meta.taxonomyProvider} / ${meta.taxonomyModel}, effort ${meta.taxonomyEffort}`],
        ['Claude filing pass (2)', `${meta.claudeProvider} / ${meta.claudeModel}`],
        ['Jev filing pass (2)', meta.jevModel],
        [
          'Jev walk settings',
          `beam ${meta.beamWidth}, confidence >= ${meta.confidenceThreshold}, ` +
            `multi-label >= ${meta.multiLabelThreshold}, max ${meta.maxLabels} label(s)`,
        ],
      ],
    ),
  );
  out.push('');
  out.push(
    'The library was not written to. The fresh tree lives in a throwaway database that is ' +
      'deleted when the run ends; your categories, read state, favorites, summaries and scores ' +
      'are exactly as they were.',
  );
  out.push('');

  out.push('## How the numbers are counted');
  out.push('');
  out.push(
    '- A **filing** is an ordered list of paths, best first. The first is the PRIMARY path. ' +
      "Claude's order is the order the model returned; Jev's is descending path score.",
  );
  out.push(
    '- **Multi-label.** Both methods may return several paths, so agreement is reported twice: ' +
      'strictly on the primary paths, and leniently as "the two filings share at least one leaf".',
  );
  out.push(
    `- **Unplaced** (\`${UNPLACED_LABEL}\`) means the method returned no path that resolves in ` +
      'the fixed tree - in a real run, exactly what lands a bookmark in `Uncategorized`. Two ' +
      'unplaced filings are reported separately and never counted as agreement.',
  );
  out.push(
    "- **Jev's low-confidence early stop is not an abstention.** The walk keeps the last " +
      'confident ANCESTOR ("AI > Harnesses" rather than a guessed "AI > Harnesses > MCP"), and ' +
      'that path is compared like any other; the count of bookmarks it happened to is reported ' +
      'separately. Only `unresolved` - not even the top level answered confidently - is an ' +
      'abstention.',
  );
  out.push('- Agreement is compared on node **ids** in the eval tree, so two identically named nodes under different parents never count as a match.');
  out.push('');

  out.push('## Agreement');
  out.push('');
  out.push(
    table(
      ['Measure', 'Count', 'Share'],
      [
        ['Bookmarks compared', String(agreement.bookmarks), '100%'],
        ['Both methods placed it', String(agreement.bothPlaced), pct(agreement.bothPlaced, agreement.bookmarks)],
        ['Same exact leaf (primary paths)', String(agreement.samePrimaryLeaf), pct(agreement.samePrimaryLeaf, agreement.bothPlaced)],
        ['Share at least one leaf (multi-label)', String(agreement.sharedLeaf), pct(agreement.sharedLeaf, agreement.bothPlaced)],
        ['Same top-level branch (primary paths)', String(agreement.samePrimaryRoot), pct(agreement.samePrimaryRoot, agreement.bothPlaced)],
        ['Share at least one top-level branch', String(agreement.sharedRoot), pct(agreement.sharedRoot, agreement.bothPlaced)],
        ['Only Claude placed it', String(agreement.onlyClaudePlaced), pct(agreement.onlyClaudePlaced, agreement.bookmarks)],
        ['Only Jev placed it', String(agreement.onlyJevPlaced), pct(agreement.onlyJevPlaced, agreement.bookmarks)],
        ['Neither placed it', String(agreement.bothUnplaced), pct(agreement.bothUnplaced, agreement.bookmarks)],
      ],
    ),
  );
  out.push('');
  out.push(
    'The four agreement shares are percentages of the bookmarks BOTH methods placed, not of ' +
      'the whole run - dividing by bookmarks one side abstained on would flatter whichever ' +
      'method abstains more.',
  );
  out.push('');

  out.push('## Distribution');
  out.push('');
  out.push(
    table(
      ['#', 'Claude category', 'n', 'Jev category', 'n'],
      distributionRows(distribution.claudeTop, distribution.jevTop),
    ),
  );
  out.push('');
  out.push(
    table(
      ['Measure', 'Claude', 'Jev'],
      [
        ['Distinct leaves used', String(distribution.claudeDistinctLeaves), String(distribution.jevDistinctLeaves)],
        ['Labels per bookmark (mean)', distribution.claudeLabelsPerBookmark.toFixed(2), distribution.jevLabelsPerBookmark.toFixed(2)],
        [
          `Left ${UNPLACED_LABEL}`,
          ratio(distribution.claudeUnplaced, agreement.bookmarks),
          ratio(distribution.jevUnplaced, agreement.bookmarks),
        ],
      ],
    ),
  );
  out.push('');

  out.push('## Confidence and abstention');
  out.push('');
  out.push(
    table(
      ['Measure', 'Value'],
      [
        ['Claude left unplaced (-> `Uncategorized`)', ratio(confidence.claudeUnplaced, agreement.bookmarks)],
        ['Jev abstained entirely (`unresolved`)', ratio(confidence.jevUnresolved, agreement.bookmarks)],
        ['Jev stopped early at a confident ancestor', ratio(confidence.jevEarlyStopped, agreement.bookmarks)],
        ['Jev walk failed (not an opinion either way)', ratio(confidence.jevErrored, agreement.bookmarks)],
        ['Jev primary-path score, mean', score(confidence.jevMeanConfidence)],
        ['Jev primary-path score, median', score(confidence.jevMedianConfidence)],
        ['Jev score where it agreed with Claude', score(confidence.jevMeanConfidenceWhenAgreeing)],
        ['Jev score where it disagreed', score(confidence.jevMeanConfidenceWhenDisagreeing)],
      ],
    ),
  );
  out.push('');
  out.push(
    'A Jev score meaningfully lower on the disagreements than on the agreements means Jev ' +
      'already knows which of its calls are the shaky ones - which is the property Claude ' +
      'filing gives you no equivalent of.',
  );
  out.push('');

  out.push('## Sampled disagreements');
  out.push('');
  out.push(
    `${disagreements.total} bookmark(s) were filed under different primary leaves. ` +
      `${disagreements.rows.length} of them are shown below, sampled at an even stride across ` +
      'the run rather than taken off the front. This is the part to read: judge, row by row, ' +
      'which column filed the post better.',
  );
  out.push('');
  if (disagreements.rows.length === 0) {
    out.push('_The two methods filed every bookmark the same way._');
  } else {
    out.push(
      table(['Author', 'Post', 'Claude', 'Jev', 'Jev score'], disagreementRows(disagreements.rows)),
    );
  }
  out.push('');

  out.push('## Cost and time');
  out.push('');
  out.push(
    table(
      ['Measure', 'Value'],
      [
        ['Taxonomy design (pass 1, Claude)', seconds(cost.taxonomyMs)],
        ['Claude filing pass', seconds(cost.claudeMs)],
        ['Jev filing pass', seconds(cost.jevMs)],
        ['Jev requests', String(cost.jevRequests)],
        ['Jev input tokens billed', String(cost.jevInputTokens)],
      ],
    ),
  );
  out.push('');
  out.push(
    'Claude filing is free at the margin - it runs on the flat-rate Claude Code subscription - ' +
      'so its cost is the wall clock above plus the subscription quota it consumed, not money. ' +
      'Jev is billed per INPUT token (output tokens are free); the token figure is what the API ' +
      'itself reported for this run.',
  );
  out.push('');

  return `${out.join('\n')}\n`;
}
