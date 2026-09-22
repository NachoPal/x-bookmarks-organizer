/**
 * The LLM provider abstraction.
 *
 * Two levels, deliberately:
 * - {@link LlmClient} is the rich port an *adapter* implements (model, billing,
 *   usage, structured request).
 * - `LlmRunner` (`src/categorize/llm.ts`) stays the narrow port every *feature*
 *   consumes, bridged by `toRunner` in `./runner`. That is what lets the
 *   categorization passes and the summary generator stay provider-agnostic
 *   without a single logic change.
 */

/** What the app is asking a model to do. Drives per-role model/param defaults. */
export type LlmRole = 'taxonomy' | 'assignment' | 'summary' | 'chat';

/** Every role, in a stable order (used to build per-role config). */
export const LLM_ROLES: readonly LlmRole[] = ['taxonomy', 'assignment', 'summary', 'chat'];

/** How the owner pays for a call. Surfaced so no path can silently spend money. */
export type Billing = 'subscription' | 'per-token' | 'local';

export interface CompletionRequest {
  prompt: string;
  /** Optional system instruction. Adapters that have no notion of one ignore it. */
  system?: string;
  maxOutputTokens?: number;
  /**
   * A *hint* that the app will parse the response as JSON. An adapter with a
   * native JSON mode may use it; one without simply ignores it. The app's own
   * parsers are deliberately tolerant of fences and prose, so no adapter is
   * ever required to honor this.
   */
  responseFormat?: 'text' | 'json';
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface CompletionResult {
  text: string;
  model: string;
  providerId: string;
  usage?: Usage;
}

/** The ONE primitive every LLM feature ultimately depends on. */
export interface LlmClient {
  readonly providerId: string;
  readonly model: string;
  readonly billing: Billing;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  /**
   * The model's context window in tokens, as its provider reports it at
   * runtime - which covers a model chosen by id outside the provider's curated
   * catalog, where no static value exists. Undefined when the provider cannot
   * say. Never spends money or quota.
   */
  contextWindow?(): Promise<number | undefined>;
}

/** Parameters an adapter may or may not support; unsupported ones are ignored, never an error. */
export interface ProviderParams {
  /** Reasoning effort, for providers whose `capabilities.effort` is true. */
  effort?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

/**
 * A value an adapter needs, named but never read directly: the adapter is handed
 * a {@link ResolvedProviderConfig} and asks for the key by name, so where the
 * value comes from (env today, a credential store later) stays the app's problem.
 */
export interface ProviderConfigKey {
  key: string;
  required: boolean;
  description: string;
  /** Never echoed to the browser or the logs. */
  secret: boolean;
}

export interface ProviderModel {
  id: string;
  label: string;
  /** Roles this model is a sensible default for. */
  suggestedFor: LlmRole[];
  /** One line on when to pick it, shown as the hint in the settings selector. */
  description?: string;
  /**
   * Total tokens the model accepts in one request (prompt + output), as the
   * provider declares it. What a caller that must fit a whole library into
   * one prompt (the taxonomy pass, issue #109) sizes itself against.
   */
  contextWindow?: number;
  /** Most tokens the model will generate in one response. */
  maxOutputTokens?: number;
  /**
   * The credential this model cannot run without, named - never its value.
   * Lets the settings selector say what a choice needs before a sync fails.
   */
  requiresKey?: string;
}

export type HealthState = 'ok' | 'unconfigured' | 'unavailable';

export interface Health {
  state: HealthState;
  /** Actionable, user-facing, and never contains a secret. */
  detail: string;
}

/** A thin read-only view over wherever config values live. Adapters never touch `process.env`. */
export interface ResolvedProviderConfig {
  get(key: string): string | undefined;
}

export interface ProviderCapabilities {
  jsonMode: boolean;
  /** Accepts a reasoning-effort level. */
  effort: boolean;
  temperature: boolean;
  streaming: boolean;
}

/** Everything a provider adapter declares about itself. One file, one registration line. */
export interface ProviderDefinition {
  /** Kebab-case and stable - it is the value of `XBOOKMARKS_LLM_PROVIDER`. */
  id: string;
  label: string;
  billing: Billing;
  configKeys: ProviderConfigKey[];
  models: ProviderModel[];
  capabilities: ProviderCapabilities;
  /**
   * Reasoning-effort levels this provider accepts, in ascending order - the
   * catalog the in-app settings selector offers (and validates against), the
   * same way `models` is. Empty or omitted means the provider has no effort
   * axis, which `capabilities.effort` already says; the two are kept in step
   * by the adapter that declares them.
   */
  efforts?: readonly string[];
  /**
   * A risk the owner must see at the point of choice - beyond what `billing`
   * says - for a provider whose use carries one (the Claude subscription
   * driven through pi, which Anthropic's terms prohibit). Shown in the
   * settings selector and printed with the billing line on every run.
   */
  warning?: string;
  /**
   * How a given model is billed, for a provider whose models differ (a hosted
   * API is per-token, a local endpoint is not). Omitted means `billing` holds
   * for every model.
   */
  billingFor?(model: string): Billing;
  /**
   * Cheap availability check. MUST NOT spend money or quota. `model` is the
   * one the role resolved to, for a provider whose readiness depends on it
   * (which upstream, and so which key); a provider that does not care ignores it.
   */
  check(cfg: ResolvedProviderConfig, opts?: { model?: string }): Promise<Health>;
  create(
    cfg: ResolvedProviderConfig,
    opts: { model: string; params?: ProviderParams },
  ): LlmClient;
}

/** Pick the model a provider suggests for a role, falling back to its first model. */
export function suggestedModelFor(provider: ProviderDefinition, role: LlmRole): string {
  const match = provider.models.find((m) => m.suggestedFor.includes(role));
  const fallback = provider.models[0];
  const id = match?.id ?? fallback?.id;
  if (!id) throw new Error(`Provider "${provider.id}" declares no models.`);
  return id;
}

/** Per-role overrides. Anything left undefined falls back to the provider's own default. */
export interface LlmRoleConfig {
  provider?: string;
  model?: string;
  params?: ProviderParams;
}

/** The app's LLM configuration: which provider runs, and with which model per role. */
export interface LlmConfig {
  /** Provider id used by any role that does not override it. */
  defaultProvider: string;
  /** Model used by any role that does not override it (else the provider's suggestion). */
  defaultModel?: string;
  roles: Record<LlmRole, LlmRoleConfig>;
}
