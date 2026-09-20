/**
 * The TypeSafe/Jev side of the ranking pass (issue #62).
 *
 * This is the Score counterpart to `src/categorize/typesafe/client.ts`'s Choice
 * asker, and it deliberately reuses that file's model default and its error
 * redaction rather than restating them: how a TypeSafe failure is turned into
 * something safe to show the owner is one policy, and it should not drift
 * between two callers of the same API.
 *
 * Two properties it must keep, for the same reasons the categorizer's client
 * keeps them:
 * - **Offline-testable.** The SDK's injectable `Fetch` is the seam every test
 *   uses, so the request/response mapping is exercised end to end with no
 *   network call, no API key and no spend.
 * - **The API key is passed in, never read from the environment here.** It
 *   arrives from the app's layered credential chain (`src/creds/resolve.ts`),
 *   and is never logged or put in an error message.
 */
import { score, TypeSafeClient, type EntryType, type Fetch, type ScoreCriteria } from '@typesafe-ai/sdk';
import { DEFAULT_TYPESAFE_MODEL, describeTypeSafeError } from '../categorize/typesafe/client';
import type { DimensionAnswer, Rubric } from './rubric';

export { DEFAULT_TYPESAFE_MODEL };

export interface ScorerOptions {
  /** Resolved through the credential chain by the caller. Never read from env here. */
  apiKey: string;
  model?: string;
  baseURL?: string;
  /** Injectable HTTP transport - the offline test seam. Defaults to the SDK's own. */
  fetch?: Fetch;
  /** Per-attempt timeout in ms. */
  timeout?: number;
}

/** What one scoring round trip produced. */
export interface ScoredState {
  /** One entry per rubric dimension the API answered, keyed by dimension id. */
  answers: Map<string, DimensionAnswer>;
  /** The model that actually answered, as reported by the API. */
  model: string;
  /** Input tokens the call was billed for, as reported by the API. */
  inputTokens: number;
}

/** The narrow port the ranker depends on, so it can be faked without the SDK. */
export interface StateScorer {
  score(state: EntryType, rubric: Rubric): Promise<ScoredState>;
}

/**
 * A stable question key per dimension. Dimension ids are the rubric's own keys
 * and are already unique, but prefixing keeps them clearly ours in a request
 * body someone is reading over.
 */
function questionKey(dimensionId: string): string {
  return `dim_${dimensionId}`;
}

/**
 * Scores one state against every rubric dimension in ONE `systemOne` call.
 *
 * TypeSafe evaluates each question in parallel and in isolation against the
 * same state, so the whole rubric costs one round trip and one copy of the
 * state's input tokens - which is the entire reason the rubric is allowed to be
 * several well-scoped questions instead of one overloaded one.
 */
export class JevStateScorer implements StateScorer {
  private readonly client: TypeSafeClient;
  private readonly model: string;

  constructor(options: ScorerOptions) {
    this.model = options.model?.trim() || DEFAULT_TYPESAFE_MODEL;
    this.client = new TypeSafeClient({
      apiKey: options.apiKey,
      defaultModel: this.model,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeout ? { timeout: options.timeout } : {}),
    });
  }

  async score(state: EntryType, rubric: Rubric): Promise<ScoredState> {
    const questions: Record<string, ReturnType<typeof score>> = {};
    for (const dimension of rubric.dimensions) {
      // The SDK types score criteria as a two-or-more tuple; the rubric's own
      // type already guarantees that, so this cast asserts nothing new.
      questions[questionKey(dimension.id)] = score(
        dimension.instructions,
        dimension.levels as unknown as ScoreCriteria,
      );
    }

    let result;
    try {
      result = await this.client.systemOne({ state, questions, model: this.model });
    } catch (err) {
      throw new Error(describeTypeSafeError(err), { cause: err });
    }

    const answers = new Map<string, DimensionAnswer>();
    for (const dimension of rubric.dimensions) {
      const answer = result.answers[questionKey(dimension.id)];
      // A dimension the API did not answer (or answered with another question
      // type) is left out, and `combineDimensionScores` drops it from the
      // weighting rather than scoring it zero.
      if (!answer || answer.type !== 'score') continue;
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score)) continue;
      answers.set(dimension.id, {
        score: answer.score,
        confidence:
          typeof answer.confidence === 'number' && Number.isFinite(answer.confidence)
            ? answer.confidence
            : 0,
      });
    }

    return {
      answers,
      model: typeof result.model === 'string' && result.model ? result.model : this.model,
      inputTokens: result.usage?.input_tokens ?? 0,
    };
  }
}
