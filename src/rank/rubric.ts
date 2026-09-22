/**
 * The ranking rubric, and the pure arithmetic that turns Jev's answers into one
 * stored score (issue #62).
 *
 * This file is deliberately PURE - no SDK, no database, no network, not even a
 * clock - exactly like `src/categorize/typesafe/walk.ts`. The rubric is data,
 * the combination is a function of that data, and both are unit-tested without
 * anything to stub.
 *
 * Why several questions instead of one "rate this bookmark": TypeSafe's own
 * design guidance is that a System One model "works best when each question
 * asks one specific, well-scoped thing" and that a question weighing multiple
 * independent factors should be decomposed. All of them ride in ONE
 * `systemOne` call - questions are evaluated in parallel and in isolation
 * against the same state, so asking four costs about what asking one costs and
 * creates no context rot between them.
 */
import { createHash } from 'node:crypto';

/** One well-scoped question in the rubric. */
export interface RubricDimension {
  /** Stable key; it is what a stored row's `dimensions` map is keyed by. */
  id: string;
  /** The question Jev is asked. One specific thing, per TypeSafe's guidance. */
  instructions: string;
  /**
   * The ordered rubric levels, lowest first. The SDK requires at least two.
   * Each level describes what that score MEANS - the model reads these, so
   * they are the actual tuning surface, not the weights.
   */
  levels: readonly [string, string, ...string[]];
  /** Relative weight in the combined score. Only ratios matter. */
  weight: number;
}

export interface Rubric {
  /**
   * Identifies this rubric's scale. Stored on every row so a later revision is
   * re-scored deliberately instead of silently sorted against the old scale.
   */
  version: string;
  dimensions: RubricDimension[];
}

/** The rubric's base version tag. Bump it when a dimension, level or weight changes. */
export const RUBRIC_VERSION = 'v1';

/**
 * The owner saves bookmarks to extract insights from them, so the rubric scores
 * that: what a reader would LEARN, how much of the content is substance, how
 * long that stays true, and whether it can be acted on. Ordinary engagement
 * signals (how popular or how well written a post is) are deliberately absent -
 * they are not what the library is for.
 */
export const BASE_DIMENSIONS: readonly RubricDimension[] = [
  {
    id: 'learning_value',
    weight: 3,
    instructions:
      'How much would a reader who saves posts in order to learn from them actually learn from this content?',
    levels: [
      'Nothing to learn: an announcement, a reaction, a joke, self-promotion, or a bare link with no substance of its own.',
      'A little: it names something worth knowing about but explains none of it.',
      'Something real: it explains an idea, a result or a technique at least in outline.',
      'A lot: it teaches a non-obvious idea in enough depth that a reader comes away understanding it.',
      'Exceptional: a thorough explanation or analysis that would take real effort to find elsewhere.',
    ],
  },
  {
    id: 'insight_density',
    weight: 2,
    instructions:
      'How much of this content is substance, as opposed to filler, restatement, hype or self-promotion?',
    levels: [
      'Almost all filler: hype, engagement bait, or a promotion with no content behind it.',
      'Mostly filler with an occasional real point.',
      'A mix: real points padded with restatement or salesmanship.',
      'Mostly substance, densely put.',
    ],
  },
  {
    id: 'durability',
    weight: 1,
    instructions:
      'Would this content still be worth reading in a year, or is its value tied to a passing moment?',
    levels: [
      'Tied to the moment: news, a live event, a launch, a passing argument.',
      'Fades: relevant for a release cycle or a season, then stale.',
      'Lasting: an idea, a technique or an explanation that stays true.',
    ],
  },
  {
    id: 'actionability',
    weight: 2,
    instructions:
      'Does this content give a reader something concrete they could actually apply or try themselves?',
    levels: [
      'Nothing to act on.',
      'A pointer only: it names a tool, paper or approach without saying how to use it.',
      'Something usable: concrete enough to try, though details are missing.',
      'Directly applicable: steps, code, numbers or a method a reader could follow.',
    ],
  },
];

/**
 * The built-in rubric's relevance question, added only when the owner has said
 * what they are interested in.
 *
 * It is a property of the BUILT-IN rubric, not of ranking in general: a custom
 * preset (issue #102) authors its own questions, so quietly appending one the
 * owner cannot see in the editor would make the editor lie about what runs.
 */
function relevanceDimension(interests: string): RubricDimension {
  return {
    id: 'relevance',
    weight: 2,
    instructions: `How relevant is this content to a reader with these interests: ${interests}`,
    levels: [
      'Unrelated to any of those interests.',
      'Adjacent: it touches a neighbouring area.',
      'Relevant: squarely within one of those interests.',
      'Highly relevant: central to one of those interests.',
    ],
  };
}

function normalizeInterests(interests?: string): string {
  return interests?.replace(/\s+/g, ' ').trim() ?? '';
}

function digest(input: string, length: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

/**
 * The built-in rubric's dimensions - the DEFAULT preset's content (issue #102),
 * and what an owner who never opens the editor is ranked against.
 */
export function baseDimensions(interests?: string): RubricDimension[] {
  const trimmed = normalizeInterests(interests);
  return trimmed ? [...BASE_DIMENSIONS, relevanceDimension(trimmed)] : [...BASE_DIMENSIONS];
}

/**
 * One rubric's content, as a stable string.
 *
 * Property order is fixed here rather than taken from the object, so a preset
 * round-tripped through JSON (or written by a future version with the fields in
 * another order) hashes to the same version as the one it came from - which is
 * what keeps "the same rules" meaning "the same scores".
 */
function canonicalize(dimensions: readonly RubricDimension[]): string {
  return JSON.stringify(
    dimensions.map((d) => [d.id, d.instructions, [...d.levels], d.weight]),
  );
}

/** The version tag the built-in rubric has always carried. */
function baseVersion(interests?: string): string {
  const trimmed = normalizeInterests(interests);
  return trimmed ? `${RUBRIC_VERSION}-i${digest(trimmed, 8)}` : RUBRIC_VERSION;
}

/**
 * The version tag for an arbitrary set of dimensions (issue #102).
 *
 * Every preset gets its own tag, derived from its FULL content - ids,
 * questions, levels and weights - because a stored score is only comparable to
 * another score produced by the identical rubric. `getBookmarksToScore` selects
 * on this tag, so changing any of those fields is what makes a bookmark
 * re-rankable under the edited rules while its old verdict stays keyed to the
 * old ones.
 *
 * Two rules fall out of deriving it from content rather than from a preset's
 * identity, and both are wanted. Two presets with identical rules share a
 * version, so the owner pays once for one scale. And the BUILT-IN rubric keeps
 * the tag it has always had (`v1`, or `v1-i<digest>` with interests set), so a
 * library already ranked under it is not silently re-billed just because the
 * rubric became editable - the one place this function is deliberately an alias
 * rather than a hash.
 */
export function rubricVersionFor(
  dimensions: readonly RubricDimension[],
  interests?: string,
): string {
  const canonical = canonicalize(dimensions);
  if (canonical === canonicalize(baseDimensions(interests))) return baseVersion(interests);
  return `${RUBRIC_VERSION}-r${digest(canonical, 12)}`;
}

/** A rubric from arbitrary dimensions, tagged by {@link rubricVersionFor}. */
export function rubricFor(dimensions: readonly RubricDimension[], interests?: string): Rubric {
  return { version: rubricVersionFor(dimensions, interests), dimensions: [...dimensions] };
}

/**
 * The BUILT-IN rubric to score against, optionally including a relevance
 * question.
 *
 * Relevance is opt-in because it needs the owner to SAY what they are interested
 * in (`XBOOKMARKS_RANKER_INTERESTS`); a model asked "is this relevant?" with
 * nothing to be relevant to would be answering a different question than the
 * one it appears to be answering. When interests are given, the version tag
 * carries a digest of them - two different interest statements produce two
 * different scales, and mixing those in one sort would be meaningless.
 *
 * Since issue #102 this is the DEFAULT PRESET's rubric, not the only one: what
 * a run actually scores against is the ACTIVE preset (`src/rank/presets.ts`).
 */
export function buildRubric(interests?: string): Rubric {
  return rubricFor(baseDimensions(interests), interests);
}

/** One dimension's answer, as read back off a Jev `Score` response. */
export interface DimensionAnswer {
  /** The raw expected score, on that dimension's own 0..levels-1 scale. */
  score: number;
  /** The model's reported confidence, 0..1. */
  confidence: number;
}

export interface CombinedScore {
  /** Weighted overall score, 0..1. */
  score: number;
  /** Weighted mean of the per-dimension confidences, 0..1. */
  confidence: number;
  /** Each dimension's normalized 0..1 score, keyed by dimension id. */
  dimensions: Record<string, number>;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Put one dimension's raw score on a 0..1 scale.
 *
 * Jev's expected score runs from 0 to `levels - 1` and may land between integer
 * levels, so this is a plain division - which is also what lets dimensions with
 * different level counts be weighed against each other at all.
 */
export function normalizeDimensionScore(score: number, levelCount: number): number {
  if (levelCount < 2) return 0;
  return clamp01(score / (levelCount - 1));
}

/**
 * Combine the rubric's answers into the single score that gets stored.
 *
 * A dimension with no answer (a question the API did not come back with) is
 * dropped from both the score and the weighting rather than counted as zero:
 * a missing answer is not a bad one, and treating it as zero would quietly
 * rank a bookmark down for an API hiccup. With no answers at all the result is
 * a zero score at zero confidence, which the caller is expected to treat as a
 * failure rather than store.
 */
export function combineDimensionScores(
  rubric: Rubric,
  answers: Map<string, DimensionAnswer>,
): CombinedScore {
  const dimensions: Record<string, number> = {};
  let weighted = 0;
  let weightedConfidence = 0;
  let totalWeight = 0;

  for (const dimension of rubric.dimensions) {
    const answer = answers.get(dimension.id);
    if (!answer) continue;
    const normalized = normalizeDimensionScore(answer.score, dimension.levels.length);
    dimensions[dimension.id] = normalized;
    weighted += normalized * dimension.weight;
    weightedConfidence += clamp01(answer.confidence) * dimension.weight;
    totalWeight += dimension.weight;
  }

  if (totalWeight === 0) return { score: 0, confidence: 0, dimensions };
  return {
    score: clamp01(weighted / totalWeight),
    confidence: clamp01(weightedConfidence / totalWeight),
    dimensions,
  };
}
