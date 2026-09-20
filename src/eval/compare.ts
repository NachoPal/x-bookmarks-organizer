/**
 * The comparison itself: how differently the two assignment passes filed the
 * same bookmarks into the same tree.
 *
 * PURE, in the same spirit as `src/rank/rubric.ts` and
 * `src/categorize/typesafe/walk.ts` - no database, no SDK, no clock, no I/O.
 * Every metric here is a function of two filings, so the whole comparison is
 * driven in tests from a fixture where the methods partly agree, with nothing
 * mocked.
 *
 * The rules the numbers rest on, stated once here and restated in the report so
 * the owner never has to guess what a percentage counted:
 *
 * - A **filing** is an ordered list of paths, best first. Claude's order is the
 *   order the model returned; Jev's is descending path score. The first is the
 *   PRIMARY path.
 * - **Multi-label**: Jev may return several paths and so may Claude, so
 *   agreement is reported twice - strictly on the primary paths, and leniently
 *   as "the two filings share at least one leaf".
 * - An **empty** filing means the method placed the bookmark nowhere that
 *   resolves in the fixed tree, which in a real run is exactly what lands it in
 *   `Uncategorized`. Two empty filings are not counted as agreement; they are
 *   reported separately, because "we both gave up" says nothing about filing
 *   quality.
 * - Jev's **low-confidence early stop** is not an abstention: the path is kept
 *   and compared like any other, and the fact that it stopped at an ancestor is
 *   reported alongside. Only `unresolved` (not even the root level was
 *   answered confidently) is an abstention.
 */

/** One path a method filed a bookmark under, resolved against the fixed eval tree. */
export interface FiledPath {
  /** The leaf node's id in the eval tree. Agreement is compared on ids, not names. */
  leafId: number;
  /** The root ancestor's id - the top-level branch this path lives in. */
  rootId: number;
  /** The tree's own node names, root -> leaf. */
  names: string[];
}

/** How one method filed one bookmark. Best path first; empty means "nowhere". */
export interface Filing {
  paths: FiledPath[];
}

/** One bookmark as both methods filed it, plus the evidence the report shows. */
export interface PairedFiling {
  postId: string;
  author: string;
  text: string;
  claude: Filing;
  jev: Filing;
  /** Jev's score for its primary path, 0..1. Absent when it filed nothing. */
  jevConfidence?: number;
  /** Jev kept a path that stopped at a confident ancestor rather than a leaf. */
  jevEarlyStopped: boolean;
  /** Jev could not answer even the root level confidently. */
  jevUnresolved: boolean;
  /** The Jev walk failed outright for this bookmark. */
  jevError?: string;
}

export interface AgreementMetrics {
  /** Bookmarks compared. */
  bookmarks: number;
  /** Both placed it and the PRIMARY paths end at the same leaf node. */
  samePrimaryLeaf: number;
  /** Both placed it and their leaf sets intersect (the multi-label-tolerant read). */
  sharedLeaf: number;
  /** Both placed it and the PRIMARY paths sit under the same top-level branch. */
  samePrimaryRoot: number;
  /** Both placed it and their root-branch sets intersect. */
  sharedRoot: number;
  /** Both placed it somewhere - the denominator the four counts above are honest against. */
  bothPlaced: number;
  /** Neither placed it. Reported apart: agreeing to give up is not agreeing. */
  bothUnplaced: number;
  onlyClaudePlaced: number;
  onlyJevPlaced: number;
}

/** One category and how many bookmarks a method put in it. */
export interface CategoryCount {
  path: string[];
  count: number;
}

export interface DistributionMetrics {
  claudeTop: CategoryCount[];
  jevTop: CategoryCount[];
  claudeUnplaced: number;
  jevUnplaced: number;
  claudeDistinctLeaves: number;
  jevDistinctLeaves: number;
  /** Labels assigned per bookmark, averaged - how much more multi-label one method is. */
  claudeLabelsPerBookmark: number;
  jevLabelsPerBookmark: number;
}

export interface ConfidenceMetrics {
  /** Jev kept a path that stopped at a confident ancestor instead of a leaf. */
  jevEarlyStopped: number;
  /** Jev answered nothing confidently - its abstention, the analogue of Uncategorized. */
  jevUnresolved: number;
  /** The Jev walk threw for this bookmark; it is not an opinion either way. */
  jevErrored: number;
  /** Claude returned no path that resolves in the fixed tree -> `Uncategorized`. */
  claudeUnplaced: number;
  /** Mean of Jev's primary-path score over the bookmarks it placed. Null when it placed none. */
  jevMeanConfidence: number | null;
  /** Median of the same. Null when it placed none. */
  jevMedianConfidence: number | null;
  /** Mean primary-path score over the bookmarks Claude and Jev filed to the SAME leaf. */
  jevMeanConfidenceWhenAgreeing: number | null;
  /** Mean primary-path score over the bookmarks they filed differently. */
  jevMeanConfidenceWhenDisagreeing: number | null;
}

/** One row of the human-judgment table: who filed this bookmark where. */
export interface DisagreementRow {
  author: string;
  text: string;
  /** " > "-joined primary path, or "(Uncategorized)". */
  claudePath: string;
  jevPath: string;
  /** Jev's primary-path score, or undefined when it filed nothing. */
  jevConfidence?: number;
  /** Jev stopped at a confident ancestor for this one. */
  jevEarlyStopped: boolean;
}

export interface DisagreementSample {
  /** Every bookmark whose PRIMARY leaves differ - the population the rows were drawn from. */
  total: number;
  rows: DisagreementRow[];
}

export interface Comparison {
  agreement: AgreementMetrics;
  distribution: DistributionMetrics;
  confidence: ConfidenceMetrics;
  disagreements: DisagreementSample;
}

/** How many rows the sampled disagreement table holds at most. */
export const DEFAULT_DISAGREEMENT_ROWS = 40;

/** How many categories each method's distribution table lists. */
export const DEFAULT_TOP_CATEGORIES = 15;

/** Text budget for a post in the disagreement table, so a row stays one line. */
export const MAX_ROW_TEXT_CHARS = 140;

/** The label a path with no nodes gets everywhere in the report. */
export const UNPLACED_LABEL = '(Uncategorized)';

function primary(filing: Filing): FiledPath | undefined {
  return filing.paths[0];
}

function leafIds(filing: Filing): Set<number> {
  return new Set(filing.paths.map((p) => p.leafId));
}

function rootIds(filing: Filing): Set<number> {
  return new Set(filing.paths.map((p) => p.rootId));
}

function intersects(a: Set<number>, b: Set<number>): boolean {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

/** Render a path the way every table and every row in the report renders it. */
export function formatPath(path: FiledPath | undefined): string {
  if (!path || path.names.length === 0) return UNPLACED_LABEL;
  return path.names.join(' > ');
}

/** Collapse whitespace and cap a post body so a table row stays readable. */
export function summarizeText(text: string, max = MAX_ROW_TEXT_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

export function computeAgreement(pairs: PairedFiling[]): AgreementMetrics {
  const metrics: AgreementMetrics = {
    bookmarks: pairs.length,
    samePrimaryLeaf: 0,
    sharedLeaf: 0,
    samePrimaryRoot: 0,
    sharedRoot: 0,
    bothPlaced: 0,
    bothUnplaced: 0,
    onlyClaudePlaced: 0,
    onlyJevPlaced: 0,
  };

  for (const pair of pairs) {
    const c = primary(pair.claude);
    const j = primary(pair.jev);
    if (!c && !j) {
      metrics.bothUnplaced++;
      continue;
    }
    if (!j) {
      metrics.onlyClaudePlaced++;
      continue;
    }
    if (!c) {
      metrics.onlyJevPlaced++;
      continue;
    }
    metrics.bothPlaced++;
    if (c.leafId === j.leafId) metrics.samePrimaryLeaf++;
    if (c.rootId === j.rootId) metrics.samePrimaryRoot++;
    if (intersects(leafIds(pair.claude), leafIds(pair.jev))) metrics.sharedLeaf++;
    if (intersects(rootIds(pair.claude), rootIds(pair.jev))) metrics.sharedRoot++;
  }

  return metrics;
}

/** Count bookmarks per leaf for one side, most-used first, capped at `top`. */
function topCategories(filings: Filing[], top: number): { counts: CategoryCount[]; distinct: number } {
  const byLeaf = new Map<number, CategoryCount>();
  for (const filing of filings) {
    // A bookmark filed twice under the same leaf counts once for that leaf.
    for (const leafId of new Set(filing.paths.map((p) => p.leafId))) {
      const path = filing.paths.find((p) => p.leafId === leafId)!;
      const entry = byLeaf.get(leafId);
      if (entry) entry.count++;
      else byLeaf.set(leafId, { path: path.names, count: 1 });
    }
  }
  const counts = [...byLeaf.values()].sort(
    (a, b) => b.count - a.count || formatPath({ leafId: 0, rootId: 0, names: a.path }).localeCompare(
      formatPath({ leafId: 0, rootId: 0, names: b.path }),
    ),
  );
  return { counts: counts.slice(0, top), distinct: byLeaf.size };
}

function labelsPerBookmark(filings: Filing[]): number {
  if (filings.length === 0) return 0;
  const labels = filings.reduce((sum, f) => sum + new Set(f.paths.map((p) => p.leafId)).size, 0);
  return labels / filings.length;
}

export function computeDistribution(
  pairs: PairedFiling[],
  top = DEFAULT_TOP_CATEGORIES,
): DistributionMetrics {
  const claude = pairs.map((p) => p.claude);
  const jev = pairs.map((p) => p.jev);
  const c = topCategories(claude, top);
  const j = topCategories(jev, top);
  return {
    claudeTop: c.counts,
    jevTop: j.counts,
    claudeUnplaced: claude.filter((f) => f.paths.length === 0).length,
    jevUnplaced: jev.filter((f) => f.paths.length === 0).length,
    claudeDistinctLeaves: c.distinct,
    jevDistinctLeaves: j.distinct,
    claudeLabelsPerBookmark: labelsPerBookmark(claude),
    jevLabelsPerBookmark: labelsPerBookmark(jev),
  };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** True when both methods placed the bookmark and their primary leaves differ. */
function isDisagreement(pair: PairedFiling): boolean {
  return primary(pair.claude)?.leafId !== primary(pair.jev)?.leafId;
}

export function computeConfidence(pairs: PairedFiling[]): ConfidenceMetrics {
  const placed = pairs.filter((p) => p.jevConfidence != null);
  const agreeing: number[] = [];
  const disagreeing: number[] = [];
  for (const pair of placed) {
    (isDisagreement(pair) ? disagreeing : agreeing).push(pair.jevConfidence!);
  }
  return {
    jevEarlyStopped: pairs.filter((p) => p.jevEarlyStopped).length,
    jevUnresolved: pairs.filter((p) => p.jevUnresolved).length,
    jevErrored: pairs.filter((p) => p.jevError != null).length,
    claudeUnplaced: pairs.filter((p) => p.claude.paths.length === 0).length,
    jevMeanConfidence: mean(placed.map((p) => p.jevConfidence!)),
    jevMedianConfidence: median(placed.map((p) => p.jevConfidence!)),
    jevMeanConfidenceWhenAgreeing: mean(agreeing),
    jevMeanConfidenceWhenDisagreeing: mean(disagreeing),
  };
}

/**
 * Draw up to `cap` disagreements, spread evenly across the whole run rather
 * than taken off the front.
 *
 * Stride sampling, not a shuffle: the eval is already one non-deterministic
 * sample of the models, so the REPORT at least has to be reproducible from the
 * same filings, and "the first 40" would over-represent whatever the library's
 * ingest order happens to put first.
 */
export function sampleDisagreements(
  pairs: PairedFiling[],
  cap = DEFAULT_DISAGREEMENT_ROWS,
): DisagreementSample {
  const differing = pairs.filter(isDisagreement);
  const stride = differing.length > cap ? differing.length / cap : 1;
  const rows: DisagreementRow[] = [];
  for (let i = 0; rows.length < Math.min(cap, differing.length); i++) {
    const pair = differing[Math.min(Math.floor(i * stride), differing.length - 1)]!;
    rows.push({
      author: pair.author,
      text: summarizeText(pair.text),
      claudePath: formatPath(primary(pair.claude)),
      jevPath: formatPath(primary(pair.jev)),
      ...(pair.jevConfidence != null ? { jevConfidence: pair.jevConfidence } : {}),
      jevEarlyStopped: pair.jevEarlyStopped,
    });
  }
  return { total: differing.length, rows };
}

export interface CompareOptions {
  disagreementRows?: number;
  topCategories?: number;
}

/** The whole comparison, from nothing but the two filings per bookmark. */
export function compareFilings(pairs: PairedFiling[], options: CompareOptions = {}): Comparison {
  return {
    agreement: computeAgreement(pairs),
    distribution: computeDistribution(pairs, options.topCategories ?? DEFAULT_TOP_CATEGORIES),
    confidence: computeConfidence(pairs),
    disagreements: sampleDisagreements(pairs, options.disagreementRows ?? DEFAULT_DISAGREEMENT_ROWS),
  };
}
