/**
 * Pure hierarchical beam search over a category tree (issue #61).
 *
 * This is the whole classification algorithm, and it is deliberately free of
 * any network, SDK, or database dependency: it walks sibling levels by asking
 * an injected {@link AskLevels} one question per level, and builds each path in
 * code out of the real nodes it was handed. Two properties fall out of that and
 * are the point of the design:
 *
 * - **Off-tree paths are structurally impossible.** A path is a list of nodes
 *   taken from `options`, never a name a model wrote, so there is nothing to
 *   validate, repair, or drop afterwards.
 * - **Depth is a loop bound, not a plea in a prompt.** `maxDepth` is enforced
 *   here, so a tree can never be walked deeper than the caller allows.
 *
 * Scoring follows TypeSafe's hierarchical-classification cookbook: a path's
 * score is the length-normalized geometric mean of its edge probabilities,
 * `product(p) ** (1 / decisions)`, so a shallow and a deep path compare fairly.
 */

/** One candidate node at some level of the walk. Ids come from the real tree. */
export interface WalkNode {
  id: number;
  name: string;
  /** One-line gloss used to separate this node from its siblings, when it has one. */
  description?: string | null;
}

/** A node in the tree being walked. */
export interface WalkTreeNode extends WalkNode {
  children: WalkTreeNode[];
}

/** One question: pick among `options`, having already walked `path`. */
export interface AskLevel {
  /** The nodes already chosen, root -> parent. Empty at the root level. */
  path: WalkNode[];
  /** The sibling nodes to choose between. Always non-empty. */
  options: WalkNode[];
}

/** One answer: how the probability mass fell across `options`. */
export interface LevelAnswer {
  /** Probability per option node id. A missing id counts as zero. */
  probabilities: Map<number, number>;
  /**
   * The model's own reported confidence in its top pick, 0..1. Kept separate
   * from the probabilities because a distribution can be peaked and still be a
   * guess; both have to clear the threshold for the walk to descend.
   */
  confidence: number;
}

/**
 * Answers a whole frontier of questions at once.
 *
 * Batched by design: every live beam candidate at one tree level is one
 * question, and TypeSafe evaluates questions in a single call in parallel and
 * in isolation, so a beam of K costs one round trip rather than K. Tests inject
 * a plain function - no network, no cost.
 */
export type AskLevels = (levels: AskLevel[]) => Promise<LevelAnswer[]>;

export interface WalkOptions {
  /** How many paths to keep alive per level. 1 is greedy descent. */
  beamWidth: number;
  /** Hard bound on path length; the walk never descends past it. */
  maxDepth: number;
  /**
   * Floor, 0..1, that BOTH an edge's probability and the level's reported
   * confidence must clear for the walk to descend through it. Below it the
   * candidate stops where it is and reports the last confident ancestor - a
   * useful "AI > Harnesses" instead of a coin-flip "AI > Harnesses > MCP".
   */
  confidenceThreshold: number;
  /**
   * Floor, 0..1, on a path's normalized score for it to be kept as an
   * ADDITIONAL label beyond the best one. This is what makes the walk
   * multi-label: a bookmark that genuinely belongs to two branches keeps both.
   */
  multiLabelThreshold: number;
  /** Cap on how many paths a single bookmark may be assigned to. */
  maxLabels: number;
}

export const DEFAULT_WALK_OPTIONS: WalkOptions = {
  beamWidth: 3,
  maxDepth: 4,
  confidenceThreshold: 0.55,
  multiLabelThreshold: 0.6,
  maxLabels: 3,
};

/** A finished path with the score it earned. */
export interface ScoredPath {
  /** The chosen nodes, root -> leaf. Never empty. */
  nodes: WalkNode[];
  /** Length-normalized geometric mean of the edge probabilities, 0..1. */
  score: number;
  /**
   * False when the descent was cut short by low confidence, i.e. this path is
   * the last confident ANCESTOR rather than a node the walk actually reached.
   */
  confident: boolean;
}

export interface WalkResult {
  /** Best first. Empty when the walk could not place the bookmark at all. */
  paths: ScoredPath[];
  /**
   * True when not even the root level was answered confidently, so the
   * bookmark belongs nowhere in the current tree. This is the signal the
   * caller routes to the LLM for new-node invention (`extend` mode), rather
   * than the flat `Uncategorized` dump.
   */
  unresolved: boolean;
}

/** A live beam candidate mid-walk. */
interface Candidate {
  nodes: WalkNode[];
  /** Sum of ln(p) over the edges taken, so scores multiply without underflow. */
  logScore: number;
  decisions: number;
  /** Set once the candidate can descend no further. */
  done: boolean;
  confident: boolean;
}

/** Length-normalized geometric mean; a candidate that made no decision scores 0. */
function normalizedScore(candidate: Candidate): number {
  if (candidate.decisions === 0) return 0;
  return Math.exp(candidate.logScore / candidate.decisions);
}

/** True when `a` is a strict prefix of `b` (same nodes, shorter). */
function isPrefixOf(a: WalkNode[], b: WalkNode[]): boolean {
  if (a.length >= b.length) return false;
  return a.every((node, i) => node.id === b[i]?.id);
}

/**
 * Walk the tree with a beam of `beamWidth`, returning every path that earned a
 * label.
 *
 * One `askLevels` call per tree level, carrying every live candidate's question.
 * A candidate stops when it runs out of children, hits `maxDepth`, or the level
 * it is looking at is answered below `confidenceThreshold` - the last case is
 * what produces a confident parent instead of a guessed leaf.
 *
 * The returned paths are the best one plus any other whose normalized score
 * clears `multiLabelThreshold`, with paths that are mere prefixes of a kept
 * deeper path dropped (a parent is not a second label for its own child).
 */
export async function walkTree(
  roots: WalkTreeNode[],
  askLevels: AskLevels,
  options: WalkOptions = DEFAULT_WALK_OPTIONS,
): Promise<WalkResult> {
  const { beamWidth, maxDepth, confidenceThreshold, multiLabelThreshold, maxLabels } = options;
  if (roots.length === 0 || maxDepth < 1 || beamWidth < 1) {
    return { paths: [], unresolved: true };
  }

  // Index children by node id so a candidate's frontier is a lookup, and the
  // walk never has to re-search the tree.
  const childrenById = new Map<number, WalkTreeNode[]>();
  const indexChildren = (nodes: WalkTreeNode[]) => {
    for (const node of nodes) {
      childrenById.set(node.id, node.children);
      indexChildren(node.children);
    }
  };
  indexChildren(roots);

  let live: Candidate[] = [{ nodes: [], logScore: 0, decisions: 0, done: false, confident: true }];
  const finished: Candidate[] = [];
  let rootLevelConfident = true;

  for (let depth = 0; depth < maxDepth; depth++) {
    const expandable = live.filter((c) => !c.done);
    if (expandable.length === 0) break;

    const levels: AskLevel[] = expandable.map((c) => ({
      path: c.nodes,
      options: (c.nodes.length === 0 ? roots : (childrenById.get(c.nodes[c.nodes.length - 1]!.id) ?? [])).map(
        (n) => ({ id: n.id, name: n.name, description: n.description ?? null }),
      ),
    }));

    // A candidate with no children left is finished, not a question to ask.
    const askable: number[] = [];
    levels.forEach((level, i) => {
      if (level.options.length === 0) {
        const candidate = expandable[i]!;
        candidate.done = true;
        finished.push(candidate);
      } else {
        askable.push(i);
      }
    });
    if (askable.length === 0) break;

    const answers = await askLevels(askable.map((i) => levels[i]!));

    const next: Candidate[] = [];
    askable.forEach((levelIndex, answerIndex) => {
      const candidate = expandable[levelIndex]!;
      const level = levels[levelIndex]!;
      const answer = answers[answerIndex];

      // A missing or low-confidence answer stops the descent here rather than
      // guessing: the candidate reports the last node it was sure of.
      if (!answer || answer.confidence < confidenceThreshold) {
        if (depth === 0) rootLevelConfident = false;
        if (candidate.nodes.length > 0) {
          finished.push({ ...candidate, done: true, confident: false });
        }
        return;
      }

      let anyEdgeCleared = false;
      for (const option of level.options) {
        const p = answer.probabilities.get(option.id) ?? 0;
        if (p < confidenceThreshold) continue;
        anyEdgeCleared = true;
        next.push({
          nodes: [...candidate.nodes, option],
          logScore: candidate.logScore + Math.log(p),
          decisions: candidate.decisions + 1,
          done: false,
          confident: candidate.confident,
        });
      }

      // The level was answered confidently but no single sibling carried
      // enough mass - the same "stop at the confident parent" outcome.
      if (!anyEdgeCleared) {
        if (depth === 0) rootLevelConfident = false;
        if (candidate.nodes.length > 0) {
          finished.push({ ...candidate, done: true, confident: false });
        }
      }
    });

    next.sort((a, b) => normalizedScore(b) - normalizedScore(a));
    live = next.slice(0, beamWidth);
    if (live.length === 0) break;
  }

  // Anything still live when the depth bound was reached is a finished path.
  for (const candidate of live) {
    if (!candidate.done && candidate.nodes.length > 0) finished.push({ ...candidate, done: true });
  }

  const scored: ScoredPath[] = finished
    .filter((c) => c.nodes.length > 0)
    .map((c) => ({ nodes: c.nodes, score: normalizedScore(c), confident: c.confident }))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { paths: [], unresolved: true };

  // Keep the best path, plus any other clearing the multi-label threshold.
  // Deduplicate identical paths and drop a path that is only a prefix of one
  // already kept - a parent is not a second label for its own child.
  const kept: ScoredPath[] = [];
  const seen = new Set<string>();
  for (const path of scored) {
    if (kept.length >= maxLabels) break;
    const key = path.nodes.map((n) => n.id).join('/');
    if (seen.has(key)) continue;
    if (kept.length > 0 && path.score < multiLabelThreshold) continue;
    if (kept.some((k) => isPrefixOf(path.nodes, k.nodes))) continue;
    seen.add(key);
    kept.push(path);
  }

  // A kept shallow path may itself be a prefix of a later, deeper keeper.
  const final = kept.filter((p) => !kept.some((other) => isPrefixOf(p.nodes, other.nodes)));

  return { paths: final, unresolved: !rootLevelConfident && final.length === 0 };
}
