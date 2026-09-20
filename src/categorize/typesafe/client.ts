/**
 * Thin wrapper over `@typesafe-ai/sdk` (issue #61).
 *
 * Its only job is to turn the walk's tree-shaped questions into `Choice`
 * questions and the SDK's answers back into {@link LevelAnswer}s. All the
 * classification logic lives in the pure `walk.ts`; nothing here decides
 * anything.
 *
 * Two deliberate properties:
 * - **Offline-testable.** The SDK exposes an injectable `Fetch`, which is the
 *   seam every test uses (mirroring `ServerOptions.articleFetcher` and the
 *   `XBOOKMARKS_CLAUDE_BIN` stub). No test ever reaches the network or spends
 *   money.
 * - **The API key is passed in, never read from the environment here.** It
 *   comes from the app's layered credential chain (`src/creds/resolve.ts`), so
 *   this file has no opinion about where a secret lives - and the key itself is
 *   never logged or included in an error message.
 */
import { choice, TypeSafeClient, type ChoiceCriteria, type EntryType, type Fetch } from '@typesafe-ai/sdk';
import type { AskLevel, LevelAnswer } from './walk';

/** The TypeSafe model this integration targets unless overridden. */
export const DEFAULT_TYPESAFE_MODEL = 'jev-latest';

/**
 * TypeSafe's documented ceiling on options per `Choice`. A personal bookmark
 * taxonomy will never approach it, but a level that did would otherwise fail
 * the whole request, so the walk is handed the first 255 siblings and told.
 */
export const MAX_CHOICE_OPTIONS = 255;

export interface TypeSafeAskerOptions {
  /** Resolved through the credential chain by the caller. Never read from env here. */
  apiKey: string;
  model?: string;
  baseURL?: string;
  /** Injectable HTTP transport - the offline test seam. Defaults to the SDK's own. */
  fetch?: Fetch;
  /** Per-attempt timeout in ms. */
  timeout?: number;
  logger?: (message: string) => void;
}

/** The narrow port the categorizer depends on, so it can be faked without the SDK. */
export interface LevelAsker {
  ask(state: EntryType, levels: AskLevel[]): Promise<LevelAnswer[]>;
}

/**
 * Build the `Choice.criteria` for one level, plus the label -> node id map
 * needed to read the answer back.
 *
 * Labels are the category names, which the DB keeps unique per parent; the
 * uniqueness constraint is case-sensitive though, so a `Foo`/`foo` sibling pair
 * is disambiguated rather than silently collapsed into one option. A node's
 * one-line description becomes its criterion - that is the whole reason the
 * `description` column exists (issue #61) - and a node without one is sent as
 * `null`, which the SDK accepts as "undescribed".
 */
export function buildLevelCriteria(level: AskLevel): {
  criteria: ChoiceCriteria;
  idByLabel: Map<string, number>;
  truncated: number;
} {
  const options = level.options.slice(0, MAX_CHOICE_OPTIONS);
  const truncated = level.options.length - options.length;
  const criteria: ChoiceCriteria = {};
  const idByLabel = new Map<string, number>();

  for (const option of options) {
    let label = option.name;
    for (let n = 2; label in criteria; n++) label = `${option.name} (${n})`;
    criteria[label] = option.description?.trim() || null;
    idByLabel.set(label, option.id);
  }

  return { criteria, idByLabel, truncated };
}

/** The question text for one level, naming the branch already walked. */
export function buildLevelInstructions(level: AskLevel): string {
  if (level.path.length === 0) {
    return 'Which of these top-level categories does this bookmark belong to? Choose the one that best matches what the bookmark is actually about.';
  }
  const path = level.path.map((n) => n.name).join(' > ');
  return `This bookmark has been filed under "${path}". Which of these sub-categories of "${level.path[level.path.length - 1]!.name}" does it belong to? Choose the one that best matches what the bookmark is actually about.`;
}

/** A stable, collision-free question key per level. */
function questionKey(index: number): string {
  return `level_${index}`;
}

/**
 * Redact an SDK error into something safe and actionable.
 *
 * Never includes the API key or the request body (which carries the owner's
 * bookmark text), mirroring how the `claude-cli` adapter surfaces failures.
 */
export function describeTypeSafeError(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) {
    return 'TypeSafe rejected TYPESAFE_API_KEY (HTTP 401/403). Check the key is current and has access to Jev.';
  }
  if (status === 429) {
    return 'TypeSafe rate-limited the request (HTTP 429) after retries. Try again shortly, or lower XBOOKMARKS_TYPESAFE_CONCURRENCY.';
  }
  if (typeof status === 'number' && status >= 500) {
    return `TypeSafe returned a server error (HTTP ${status}) after retries.`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `TypeSafe request failed: ${message}`;
}

/**
 * Asks one batched TypeSafe call per tree level.
 *
 * Every live beam candidate at a level goes into the SAME `systemOne` call:
 * TypeSafe evaluates questions in parallel and in isolation against one shared
 * state, so a beam of K costs one round trip, not K.
 */
export class TypeSafeLevelAsker implements LevelAsker {
  private readonly client: TypeSafeClient;
  private readonly model: string;
  private readonly logger: (message: string) => void;

  constructor(options: TypeSafeAskerOptions) {
    this.model = options.model?.trim() || DEFAULT_TYPESAFE_MODEL;
    this.logger = options.logger ?? (() => {});
    this.client = new TypeSafeClient({
      apiKey: options.apiKey,
      defaultModel: this.model,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeout ? { timeout: options.timeout } : {}),
    });
  }

  async ask(state: EntryType, levels: AskLevel[]): Promise<LevelAnswer[]> {
    if (levels.length === 0) return [];

    const prepared = levels.map((level) => buildLevelCriteria(level));
    prepared.forEach((p, i) => {
      if (p.truncated > 0) {
        this.logger(
          `TypeSafe: level has more than ${MAX_CHOICE_OPTIONS} sibling categories; ` +
            `${p.truncated} were not offered for "${levels[i]!.path.map((n) => n.name).join(' > ') || '(root)'}".`,
        );
      }
    });

    const questions: Record<string, ReturnType<typeof choice>> = {};
    levels.forEach((level, i) => {
      questions[questionKey(i)] = choice(buildLevelInstructions(level), prepared[i]!.criteria);
    });

    let result;
    try {
      result = await this.client.systemOne({ state, questions, model: this.model });
    } catch (err) {
      throw new Error(describeTypeSafeError(err), { cause: err });
    }

    return levels.map((_level, i) => {
      const answer = result.answers[questionKey(i)];
      const { idByLabel } = prepared[i]!;
      const probabilities = new Map<number, number>();
      if (!answer || answer.type !== 'choice') {
        return { probabilities, confidence: 0 };
      }
      for (const [label, p] of Object.entries(answer.probabilities)) {
        const id = idByLabel.get(label);
        if (id !== undefined && typeof p === 'number' && Number.isFinite(p)) {
          probabilities.set(id, p);
        }
      }
      const confidence = typeof answer.confidence === 'number' && Number.isFinite(answer.confidence)
        ? answer.confidence
        : 0;
      return { probabilities, confidence };
    });
  }
}
