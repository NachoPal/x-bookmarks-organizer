/**
 * Sizing pass 1 (taxonomy design) against the taxonomy model's context window
 * (issue #109).
 *
 * Pass 1 shows the model the whole library at once, one compact line per
 * bookmark, so its prompt grows with the bookmark COUNT. Past a budget derived
 * from the model's window the designer splits the library into batches and
 * reconciles their trees (`LlmTaxonomyDesigner`); this module is the pure half
 * of that decision - no LLM, no DB, no clock - so it is tested with plain
 * numbers.
 */

/**
 * The window assumed when the taxonomy model declares none: an unknown or
 * local model, a legacy alias like `opus`, or a provider that cannot report
 * one. Deliberately modest. Assuming too small only costs extra batches (more
 * calls, same result shape); assuming too large sends a prompt the model
 * rejects, so an unknown model is never credited with a big window. Every
 * catalogued Claude model declares its own (200k and up), so this only binds
 * where nothing better is known.
 */
export const DEFAULT_TAXONOMY_CONTEXT_WINDOW = 128_000;

/**
 * The share of the window the prompt may use. The rest is headroom for the
 * response (a taxonomy is a few thousand tokens of JSON), the provider's own
 * system overhead, and the error in the `chars / 4` estimate below, which
 * undercounts dense or non-Latin text.
 */
export const TAXONOMY_INPUT_FRACTION = 0.75;

/** The `chars / 4` heuristic: a rough, provider-agnostic token count. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** A declared window, or the safe default when it is missing or nonsensical. */
export function effectiveContextWindow(declared: number | undefined): number {
  return declared !== undefined && Number.isFinite(declared) && declared > 0
    ? declared
    : DEFAULT_TAXONOMY_CONTEXT_WINDOW;
}

/** Most prompt tokens one pass-1 request may carry for a given window. */
export function inputBudgetFor(contextWindow: number): number {
  return Math.floor(contextWindow * TAXONOMY_INPUT_FRACTION);
}

/** A half-open `[start, end)` slice of the bookmark list. */
export interface BatchRange {
  start: number;
  end: number;
}

/**
 * Split items of the given token `weights` into the FEWEST contiguous batches
 * whose weights each sum to at most `capacity`, keeping the library's order.
 *
 * Greedy packing yields that minimum count, but it leaves the remainder in the
 * last batch - a tail of a few bookmarks would design a thin tree of its own.
 * So the same count is then re-cut evenly by weight, and the greedy cut is kept
 * only when the even one would overflow a batch. Throws when a single item
 * alone exceeds `capacity`: no split can fit it, and silently dropping a
 * bookmark from pass 1 is not an option.
 */
export function planBatches(weights: readonly number[], capacity: number): BatchRange[] {
  const tooBig = weights.findIndex((w) => w > capacity);
  if (tooBig !== -1) {
    throw new Error(
      `A single bookmark needs ~${weights[tooBig]} tokens but only ${capacity} fit beside the ` +
        "taxonomy prompt - the taxonomy model's context window is too small to design a taxonomy.",
    );
  }
  const greedy = greedyBatches(weights, capacity);
  if (greedy.length <= 1) return greedy;
  const even = evenBatches(weights, greedy.length);
  const fits = even.every((r) => r.end > r.start && sum(weights, r) <= capacity);
  return fits ? even : greedy;
}

function greedyBatches(weights: readonly number[], capacity: number): BatchRange[] {
  const out: BatchRange[] = [];
  let start = 0;
  let load = 0;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]!;
    if (i > start && load + w > capacity) {
      out.push({ start, end: i });
      start = i;
      load = 0;
    }
    load += w;
  }
  if (weights.length > start) out.push({ start, end: weights.length });
  return out;
}

/** `count` contiguous batches of roughly equal weight: an item joins the batch its start offset falls in. */
function evenBatches(weights: readonly number[], count: number): BatchRange[] {
  const total = weights.reduce((a, b) => a + b, 0);
  const out: BatchRange[] = [];
  let offset = 0;
  let current = 0;
  let start = 0;
  for (let i = 0; i < weights.length; i++) {
    const part = Math.min(count - 1, Math.floor((offset * count) / total));
    if (part !== current) {
      out.push({ start, end: i });
      start = i;
      current = part;
    }
    offset += weights[i]!;
  }
  out.push({ start, end: weights.length });
  return out;
}

function sum(weights: readonly number[], range: BatchRange): number {
  let total = 0;
  for (let i = range.start; i < range.end; i++) total += weights[i]!;
  return total;
}
