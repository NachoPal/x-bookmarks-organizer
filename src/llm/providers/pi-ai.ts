import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ModelThinkingLevel,
  ThinkingLevel,
} from '@earendil-works/pi-ai';
import type {
  Billing,
  ModelSource,
  ProviderModelCatalog,
  CompletionRequest,
  CompletionResult,
  Health,
  LlmClient,
  ProviderDefinition,
  ProviderModel,
  ProviderParams,
  ResolvedProviderConfig,
} from '../types';
import { redactError as redactCliError } from './redact';
import {
  PI_UPSTREAMS,
  PI_UPSTREAM_IDS,
  isPiUpstream,
  type HostedUpstream,
  type PiUpstream,
} from './pi-upstreams';

export { PI_UPSTREAMS, type HostedUpstream, type PiUpstream } from './pi-upstreams';

/**
 * Many model APIs through ONE SDK: `@earendil-works/pi-ai` (issue #70).
 *
 * pi-ai is a model-API library - plain completions, no agent, no tools - so a
 * prompt built from attacker-authored bookmark text has nothing to reach but
 * the model itself. That is why this adapter needs none of `claude-cli`'s
 * `--safe-mode --tools ""` hardening: there is no filesystem or tool surface
 * to close.
 *
 * Every hosted upstream here is PAID PER TOKEN on the owner's own API key. It
 * is therefore never a default: it runs only when the owner selects `pi-ai`
 * for a pass (the settings selector or `XBOOKMARKS_*_PROVIDER`), a key for the
 * model's upstream resolves through the credential chain, and every sync
 * announces the per-token billing before it starts (`reportCategorizerBilling`).
 *
 * **The Claude SUBSCRIPTION is deliberately NOT reachable through THIS
 * provider.** pi can drive a Claude Pro/Max OAuth token, but it does so by
 * presenting itself as Claude Code, and Anthropic's terms reserve subscription
 * OAuth for Claude Code and Anthropic's own apps ("developers may not collect,
 * store, or intermediate Claude.ai credentials or session tokens"). An owner's
 * account is what that would put at risk, so an `sk-ant-oat…` token is refused
 * with a pointer to the `claude-cli` provider - Anthropic's own binary, which
 * is the sanctioned way to spend a subscription - and `CLAUDE_CODE_OAUTH_TOKEN`
 * is never read. An owner who accepts that risk can still take this route, but
 * only by selecting the SEPARATE `pi-claude-subscription` provider
 * (`./pi-claude-subscription.ts`), which is never a default and carries the
 * risk in its label wherever it can be chosen.
 *
 * pi-ai ships as ESM only (its `exports` map has no `require` condition), so
 * it is loaded with a real dynamic `import()`, once, on first use - and each
 * upstream's provider module (with its catalog) only when a model of THAT
 * upstream is first looked up, run or listed (`./pi-upstreams.ts`). That keeps
 * this CommonJS app's startup - and every path that never selects pi-ai -
 * untouched by the SDK, and registering many upstreams costs nothing until one
 * is used.
 *
 * The model catalog the selector browses (`modelCatalog`) is pi's own: static
 * data bundled in the package, read locally. Browsing it never makes a request
 * and never spends anything.
 */

/** Provider id - the value of `XBOOKMARKS_LLM_PROVIDER` / `XBOOKMARKS_*_PROVIDER`. */
export const PI_AI_PROVIDER_ID = 'pi-ai';

/**
 * Base URL of an OpenAI-compatible local endpoint (Ollama, LM Studio, vLLM...).
 * Process environment ONLY (`ENV_ONLY_KEYS` in `src/creds/resolve.ts`): it
 * decides where prompts full of bookmark text are sent, so no file may set it.
 */
export const PIAI_LOCAL_BASE_URL_KEY = 'XBOOKMARKS_PIAI_BASE_URL';
/** Optional key for that endpoint; most local servers need none. */
export const PIAI_LOCAL_API_KEY_KEY = 'XBOOKMARKS_PIAI_API_KEY';
/** The local model's context window, which no catalog can know. */
export const PIAI_LOCAL_CONTEXT_WINDOW_KEY = 'XBOOKMARKS_PIAI_CONTEXT_WINDOW';

/** Used for a local model when the owner has not said otherwise. */
const DEFAULT_LOCAL_CONTEXT_WINDOW = 32_768;
const DEFAULT_LOCAL_MAX_TOKENS = 8_192;


/**
 * pi's reasoning levels, ascending - the provider's effort catalog. A model
 * that lacks the requested level is clamped to its nearest supported one by
 * pi itself (`clampThinkingLevel`); a model with no reasoning ignores it.
 */
export const PI_AI_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const VALID_EFFORTS = new Set<string>(PI_AI_EFFORTS);
const DEFAULT_EFFORT: ThinkingLevel = 'high';

/**
 * A model reference is `<upstream>/<pi model id>`: `anthropic/claude-haiku-4-5`,
 * `openrouter/google/gemini-2.5-flash`, `local/llama3.1:8b`. The upstream is
 * what decides which key is needed and how the call is billed, so it is part
 * of the id the owner picks rather than a second setting to keep in step.
 */
export interface PiModelRef {
  upstream: PiUpstream;
  modelId: string;
}

export function parseModelRef(ref: string): PiModelRef | undefined {
  const slash = ref.indexOf('/');
  if (slash <= 0) return undefined;
  const upstream = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1).trim();
  if (!isPiUpstream(upstream) || !modelId) return undefined;
  return { upstream, modelId };
}

function badRefMessage(ref: string): string {
  return (
    `pi-ai model "${ref}" is not "<upstream>/<model>". Upstreams: ${PI_UPSTREAM_IDS.join(', ')} - ` +
    'e.g. "anthropic/claude-haiku-4-5", "openrouter/google/gemini-2.5-flash" or "local/llama3.1:8b".'
  );
}

/**
 * The models this provider RECOMMENDS: the selector's quick picks, surfaced
 * above the full catalog, and the source of the per-pass `suggestedFor`
 * defaults (Opus-class to design the tree, Haiku-class to file). Every other
 * model of every upstream is reachable through `modelCatalog` - pi's own
 * catalog, browsed and searched in the selector.
 *
 * `contextWindow`, `maxOutputTokens` and the per-million-token prices are pi's
 * own catalog values, restated so the synchronous catalog can carry them;
 * `pi-ai.test.ts` pins every one against the installed pi catalog, so a
 * version bump that changes them fails a test instead of drifting.
 */
export interface CuratedPiModel {
  ref: string;
  label: string;
  suggestedFor: ProviderModel['suggestedFor'];
  role: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** USD per million tokens, input / output. */
  price: { input: number; output: number };
}

export const CURATED_PI_MODELS: readonly CuratedPiModel[] = [
  {
    ref: 'anthropic/claude-opus-4-8',
    label: 'Claude Opus 4.8 (Anthropic API)',
    suggestedFor: ['taxonomy'],
    role: 'Opus-class Claude - the pick for designing the tree',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    price: { input: 5, output: 25 },
  },
  {
    ref: 'anthropic/claude-haiku-4-5',
    label: 'Claude Haiku 4.5 (Anthropic API)',
    suggestedFor: ['assignment', 'chat'],
    role: 'Fast and cheap - the pick for filing each bookmark',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    price: { input: 1, output: 5 },
  },
  {
    ref: 'anthropic/claude-sonnet-5',
    label: 'Claude Sonnet 5 (Anthropic API)',
    suggestedFor: ['summary'],
    role: 'Balanced Claude',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    price: { input: 2, output: 10 },
  },
  {
    ref: 'anthropic/claude-opus-5-5',
    label: 'Claude Opus 5.5 (Anthropic API)',
    suggestedFor: [],
    role: 'Newest Claude Opus',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    price: { input: 4, output: 20 },
  },
  {
    ref: 'openai/gpt-5.5',
    label: 'GPT-5.5 (OpenAI API)',
    suggestedFor: [],
    role: 'Previous OpenAI flagship',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    price: { input: 5, output: 30 },
  },
  {
    ref: 'openai/gpt-5-mini',
    label: 'GPT-5 mini (OpenAI API)',
    suggestedFor: [],
    role: 'Small and cheap OpenAI model',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    price: { input: 0.25, output: 2 },
  },
  {
    ref: 'openai/gpt-6-sol',
    label: 'GPT-6 Sol (OpenAI API)',
    suggestedFor: [],
    role: 'Newest OpenAI flagship',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    price: { input: 2, output: 10 },
  },
  {
    ref: 'openai/gpt-6-luna',
    label: 'GPT-6 Luna (OpenAI API)',
    suggestedFor: [],
    role: 'Newest small, very cheap OpenAI model',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    price: { input: 0.1, output: 0.5 },
  },
  {
    ref: 'xai/grok-4.6',
    label: 'Grok 4.6 (xAI API)',
    suggestedFor: [],
    role: 'xAI flagship',
    contextWindow: 500_000,
    maxOutputTokens: 500_000,
    price: { input: 2, output: 6 },
  },
  {
    ref: 'openrouter/google/gemini-2.5-flash',
    label: 'Gemini 2.5 Flash (OpenRouter)',
    suggestedFor: [],
    role: 'Fast, very long context',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_535,
    price: { input: 0.3, output: 2.5 },
  },
  {
    ref: 'openrouter/deepseek/deepseek-v4-flash',
    label: 'DeepSeek V4 Flash (OpenRouter)',
    suggestedFor: [],
    role: 'Very cheap, long context',
    contextWindow: 1_024_000,
    maxOutputTokens: 384_000,
    price: { input: 0.049, output: 0.098 },
  },
];

function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(2))}M`;
  return `${Math.round(n / 1000)}k`;
}

function formatPrice(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

/** The one-line hint for a paid model: what it costs, how much it reads, and the key it needs. */
function paidDescription(
  role: string | undefined,
  price: { input: number; output: number },
  contextWindow: number,
  keyName: string | undefined,
): string {
  return (
    (role ? `${role}. ` : '') +
    `PAID: ${formatPrice(price.input)} in / ${formatPrice(price.output)} out ` +
    `per 1M tokens, ${compactTokens(contextWindow)} context` +
    (keyName ? `. Needs ${keyName}.` : '.')
  );
}

function toProviderModel(m: CuratedPiModel): ProviderModel {
  const ref = parseModelRef(m.ref);
  const keyName = ref ? PI_UPSTREAMS[ref.upstream].keyName : undefined;
  return {
    id: m.ref,
    label: m.label,
    suggestedFor: m.suggestedFor,
    description: paidDescription(m.role, m.price, m.contextWindow, keyName),
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    requiresKey: keyName,
    price: m.price,
  };
}

/**
 * One entry of pi's catalog as the selector lists it. A model that is also a
 * recommended pick keeps that pick's role hint and `suggestedFor`, so it reads
 * the same whether it is found in the quick picks or by search.
 */
export function catalogModelFrom(upstream: HostedUpstream, model: Model<Api>): ProviderModel {
  const id = `${upstream}/${model.id}`;
  const curated = CURATED_PI_MODELS.find((c) => c.ref === id);
  const keyName = PI_UPSTREAMS[upstream].keyName;
  const price = { input: model.cost.input, output: model.cost.output };
  return {
    id,
    label: model.name || model.id,
    suggestedFor: curated ? curated.suggestedFor : [],
    description: paidDescription(curated?.role, price, model.contextWindow, keyName),
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    requiresKey: keyName,
    price,
  };
}

/** Every upstream as a selectable source of models, in the table's order. */
export const PI_MODEL_SOURCES: readonly ModelSource[] = PI_UPSTREAM_IDS.map((id) => {
  const info = PI_UPSTREAMS[id];
  return {
    id,
    label: info.label,
    kind: info.kind,
    billing: id === 'local' ? 'local' : 'per-token',
    ...(info.keyName ? { requiresKey: info.keyName } : {}),
    ...(id === 'local' ? { freeform: true } : {}),
  };
});

/** A local OpenAI-compatible endpoint, when the owner configured one. */
interface LocalEndpoint {
  baseUrl: string;
  contextWindow: number;
}

function localEndpoint(cfg: ResolvedProviderConfig): LocalEndpoint | undefined {
  const baseUrl = cfg.get(PIAI_LOCAL_BASE_URL_KEY)?.trim();
  if (!baseUrl) return undefined;
  const raw = Number.parseInt(cfg.get(PIAI_LOCAL_CONTEXT_WINDOW_KEY) ?? '', 10);
  return { baseUrl, contextWindow: Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LOCAL_CONTEXT_WINDOW };
}

/**
 * The slice of pi-ai this adapter uses. The real one wraps the SDK; tests
 * inject a fake, so no test loads a provider SDK or makes a network call.
 */
export interface PiRuntime {
  /** pi's model entry for a hosted upstream, or undefined when pi does not know the id. */
  findModel(upstream: HostedUpstream, modelId: string): Promise<Model<Api> | undefined>;
  /** Every model pi's static catalog lists for a hosted upstream. A local read - no request. */
  listModels(upstream: HostedUpstream): Promise<readonly Model<Api>[]>;
  /** A model entry for a local endpoint - no catalog knows those. */
  localModel(modelId: string, endpoint: LocalEndpoint): Model<Api>;
  /** The level pi would actually send for this model, or `off`. */
  clampEffort(model: Model<Api>, level: ThinkingLevel): ModelThinkingLevel;
  complete(
    model: Model<Api>,
    context: Context,
    options: { apiKey?: string; reasoning?: ThinkingLevel; maxTokens?: number; signal?: AbortSignal },
  ): Promise<AssistantMessage>;
}

/**
 * Build the real runtime. Only pi's core and a keyless OpenAI-compatible
 * provider for a local endpoint load up front; each hosted upstream's provider
 * (and with it, its catalog) is imported and registered the first time one of
 * its models is needed - never pi's `providers/all`, which would load ~40
 * catalogs at once.
 *
 * Auth is never left to pi: every call passes the key this adapter resolved
 * through the app's own credential chain, which is what stops pi from picking
 * up something the owner did not route here (an `ANTHROPIC_OAUTH_TOKEN` in the
 * shell, a pi `auth.json`). pi's in-memory credential store stays empty.
 */
export async function loadPiRuntime(): Promise<PiRuntime> {
  const [core, completions] = await Promise.all([
    import('@earendil-works/pi-ai'),
    import('@earendil-works/pi-ai/api/openai-completions.lazy'),
  ]);
  const models = core.createModels();
  const registered = new Map<HostedUpstream, Promise<void>>();
  /** Register one upstream's pi provider, once. A failed import is retried on the next call. */
  function ensureUpstream(upstream: HostedUpstream): Promise<void> {
    let ready = registered.get(upstream);
    if (!ready) {
      const load = PI_UPSTREAMS[upstream].load;
      if (!load) return Promise.reject(new Error(`pi-ai has no provider module for "${upstream}".`));
      ready = load().then((provider) => {
        models.setProvider(provider);
      });
      ready.catch(() => registered.delete(upstream));
      registered.set(upstream, ready);
    }
    return ready;
  }
  models.setProvider(
    core.createProvider({
      id: 'local',
      name: 'Local endpoint',
      // Keyless by default; an explicit key, when configured, is passed per call.
      auth: { apiKey: { name: 'Local endpoint', resolve: async () => ({ auth: {} }) } },
      models: [],
      api: completions.openAICompletionsApi(),
    }),
  );

  return {
    async findModel(upstream, modelId) {
      await ensureUpstream(upstream);
      return models.getModel(upstream, modelId);
    },
    async listModels(upstream) {
      await ensureUpstream(upstream);
      return models.getModels(upstream);
    },
    localModel: (modelId, endpoint) => ({
      id: modelId,
      name: `${modelId} (local)`,
      api: 'openai-completions',
      provider: 'local',
      baseUrl: endpoint.baseUrl,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: endpoint.contextWindow,
      maxTokens: Math.min(DEFAULT_LOCAL_MAX_TOKENS, endpoint.contextWindow),
      // What Ollama / LM Studio / vLLM accept: no `developer` role, no reasoning_effort.
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    }),
    clampEffort: (model, level) => core.clampThinkingLevel(model, level),
    complete: (model, context, options) => models.completeSimple(model, context, options),
  };
}

/**
 * Make a failure safe to show: no key of any upstream, bounded length. The
 * key-shaped patterns cover the upstreams' known formats; `secret` (the key
 * this call actually sent) is scrubbed verbatim, which also covers a format
 * no pattern here anticipates.
 */
export function redactError(raw: string, secret?: string): string {
  let text = raw;
  if (secret && secret.length >= 8) text = text.split(secret).join('[redacted]');
  return redactCliError(
    text
      .replace(/xai-[A-Za-z0-9_-]{16,}/g, '[redacted]')
      .replace(/gsk_[A-Za-z0-9]{16,}/g, '[redacted]')
      .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
      .replace(/hf_[A-Za-z0-9]{16,}/g, '[redacted]')
      .replace(/fw_[A-Za-z0-9]{16,}/g, '[redacted]'),
  );
}

function callFailureMessage(ref: string, detail: string): string {
  const redacted = redactError(detail);
  return `The pi-ai model "${ref}" failed${redacted ? `: ${redacted}` : ''}.`;
}

/** An Anthropic subscription OAuth token, as `claude setup-token` issues it. */
export function isSubscriptionToken(value: string): boolean {
  return value.includes('sk-ant-oat');
}

const SUBSCRIPTION_TOKEN_REFUSAL =
  'ANTHROPIC_API_KEY holds a Claude subscription token (sk-ant-oat...), not an API key. ' +
  "Anthropic's terms allow subscription tokens only in Claude Code and Anthropic's own apps, so " +
  'pi-ai will not use it. Run the pass on the "claude-cli" provider to use your subscription, ' +
  'or set an Anthropic API key (sk-ant-api...) from console.anthropic.com to pay per token here.';

type KeyResolution = { ok: true; apiKey?: string } | { ok: false; health: Health };

/**
 * The key for this model's upstream, from the credential chain. Named per
 * upstream, so an OpenRouter model never picks up an Anthropic key.
 */
export function resolveUpstreamKey(cfg: ResolvedProviderConfig, ref: PiModelRef): KeyResolution {
  if (ref.upstream === 'local') {
    if (!localEndpoint(cfg)) {
      return {
        ok: false,
        health: {
          state: 'unconfigured',
          detail:
            `pi-ai model "local/${ref.modelId}" needs ${PIAI_LOCAL_BASE_URL_KEY} - the base URL of an ` +
            'OpenAI-compatible server, e.g. http://127.0.0.1:11434/v1 for Ollama - exported in the ' +
            'environment, since it is never read from .env.',
        },
      };
    }
    return { ok: true, apiKey: cfg.get(PIAI_LOCAL_API_KEY_KEY)?.trim() || undefined };
  }
  const { keyName, label } = PI_UPSTREAMS[ref.upstream];
  const apiKey = keyName ? cfg.get(keyName)?.trim() : undefined;
  if (!apiKey) {
    return {
      ok: false,
      health: {
        state: 'unconfigured',
        detail:
          `pi-ai model "${ref.upstream}/${ref.modelId}" runs on the ${label} and needs ${keyName}. ` +
          'Provide it through the environment, a .env file in the project root, your OS keychain, ' +
          'or ~/.config/x-bookmarks-organizer/credentials.json. Calls are PAID per token.',
      },
    };
  }
  if (ref.upstream === 'anthropic' && isSubscriptionToken(apiKey)) {
    return { ok: false, health: { state: 'unconfigured', detail: SUBSCRIPTION_TOKEN_REFUSAL } };
  }
  return { ok: true, apiKey };
}

function billingForRef(ref: string): Billing {
  return parseModelRef(ref)?.upstream === 'local' ? 'local' : 'per-token';
}

function normalizeEffort(raw: string | undefined): ThinkingLevel | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  return VALID_EFFORTS.has(value) ? (value as ThinkingLevel) : DEFAULT_EFFORT;
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** Remove the literal key a call sent from a failure detail, before anything else sees it. */
function scrub(detail: string, apiKey: string | undefined): string {
  return apiKey && apiKey.length >= 8 ? detail.split(apiKey).join('[redacted]') : detail;
}

/**
 * Tokens of thinking a reasoning pass may spend ON TOP of its answer budget.
 * A model with adaptive thinking (and every OpenAI-style reasoning model)
 * counts its thinking against the same `maxTokens` as the answer, so a cap
 * sized for the answer alone would cut a deep pass off mid-thought. Sized a
 * notch above pi's own `DEFAULT_THINKING_BUDGETS` for each level; for a model
 * with budget-based thinking pi adds its budget again, which only loosens a
 * cap that is still far below the model maximum.
 */
export const REASONING_ALLOWANCE: Record<ModelThinkingLevel, number> = {
  off: 0,
  minimal: 2_048,
  low: 4_096,
  medium: 16_384,
  high: 32_768,
  xhigh: 65_536,
  max: 65_536,
};

/**
 * The `maxTokens` a call is sent with (security review 2, #19): the role's
 * answer budget plus the thinking allowance for the effort actually in force,
 * never more than the model can produce. Undefined only when no budget was
 * given at all, which no role built by `createLlmFactory` does.
 */
export function outputCeiling(
  model: Pick<Model<Api>, 'maxTokens'>,
  answerBudget: number | undefined,
  effort: ModelThinkingLevel,
): number | undefined {
  if (!answerBudget || answerBudget <= 0) return undefined;
  const total = answerBudget + REASONING_ALLOWANCE[effort];
  return model.maxTokens > 0 ? Math.min(total, model.maxTokens) : total;
}

/** Load the runtime once, on first use. */
export function lazyRuntime(load: () => Promise<PiRuntime>): () => Promise<PiRuntime> {
  let runtime: Promise<PiRuntime> | undefined;
  return () => {
    runtime ??= load().catch((err) => {
      // A failed load is not cached: the next call gets a fresh attempt.
      runtime = undefined;
      throw err;
    });
    return runtime;
  };
}

/**
 * One completion on a resolved pi model, authenticated with the credential
 * this app resolved - never one pi finds on its own. Shared by every provider
 * built on pi, so what counts as a failed, cut-off or usable response is
 * decided in one place.
 */
export async function completeOnPi(opts: {
  rt: PiRuntime;
  model: Model<Api>;
  apiKey?: string;
  params: ProviderParams;
  req: CompletionRequest;
  /** The id the result reports as its model. */
  ref: string;
  providerId: string;
  /** The user-facing message for a failure, given its raw detail. */
  failure: (detail: string) => string;
}): Promise<CompletionResult> {
  const { rt, model, apiKey, params, req, ref, providerId, failure } = opts;
  const effort = normalizeEffort(params.effort);
  const clamped = effort && model.reasoning ? rt.clampEffort(model, effort) : 'off';
  const context: Context = {
    ...(req.system ? { systemPrompt: req.system } : {}),
    messages: [{ role: 'user', content: req.prompt, timestamp: Date.now() }],
  };

  const maxTokens = outputCeiling(model, req.maxOutputTokens ?? params.maxOutputTokens, clamped);

  let message: AssistantMessage;
  try {
    message = await rt.complete(model, context, {
      ...(apiKey ? { apiKey } : {}),
      ...(clamped !== 'off' ? { reasoning: clamped } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    });
  } catch (err) {
    throw new Error(failure(scrub(err instanceof Error ? err.message : String(err), apiKey)));
  }

  // pi reports a failed request as a message, not a throw.
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    throw new Error(failure(scrub(message.errorMessage ?? message.stopReason, apiKey)));
  }
  if (message.stopReason === 'length') {
    // A cut-off response is truncated JSON to every caller in this app;
    // saying so beats a parse error that points nowhere.
    const limit = maxTokens ?? model.maxTokens;
    throw new Error(failure(`the response hit its output limit (${limit} tokens) before it finished`));
  }
  return {
    text: textOf(message),
    model: ref,
    providerId,
    usage: { inputTokens: message.usage.input, outputTokens: message.usage.output },
  };
}

/** Each distinct upstream key once, with every upstream that reads it (OpenCode's two plans share one). */
function upstreamKeys(): { key: string; labels: string[] }[] {
  const byKey = new Map<string, string[]>();
  for (const id of PI_UPSTREAM_IDS) {
    const { keyName, label } = PI_UPSTREAMS[id];
    if (!keyName) continue;
    byKey.set(keyName, [...(byKey.get(keyName) ?? []), label]);
  }
  return [...byKey].map(([key, labels]) => ({ key, labels }));
}

/** Build the provider around a runtime loader - the real SDK, or a test's fake. */
export function createPiAiProvider(load: () => Promise<PiRuntime> = loadPiRuntime): ProviderDefinition {
  const getRuntime = lazyRuntime(load);

  /** pi's model for a reference, or an actionable reason it cannot be run. */
  async function modelFor(
    cfg: ResolvedProviderConfig,
    ref: string,
  ): Promise<{ model: Model<Api>; parsed: PiModelRef } | { health: Health }> {
    const parsed = parseModelRef(ref);
    if (!parsed) return { health: { state: 'unconfigured', detail: badRefMessage(ref) } };
    const rt = await getRuntime();
    if (parsed.upstream === 'local') {
      const endpoint = localEndpoint(cfg);
      if (!endpoint) {
        const key = resolveUpstreamKey(cfg, parsed);
        return { health: key.ok ? { state: 'unconfigured', detail: badRefMessage(ref) } : key.health };
      }
      return { model: rt.localModel(parsed.modelId, endpoint), parsed };
    }
    const model = await rt.findModel(parsed.upstream, parsed.modelId);
    if (!model) {
      return {
        health: {
          state: 'unconfigured',
          detail: `pi-ai does not know the ${PI_UPSTREAMS[parsed.upstream].label} model "${parsed.modelId}". Check the id against that provider's model list.`,
        },
      };
    }
    return { model, parsed };
  }

  /**
   * Ready means: the reference parses, pi knows the model, and its upstream's
   * key resolves (and is not a subscription token). All local reads - no
   * request is made, so the check spends nothing.
   */
  async function check(cfg: ResolvedProviderConfig, opts?: { model?: string }): Promise<Health> {
    const ref = opts?.model;
    if (!ref) {
      return { state: 'unconfigured', detail: 'No pi-ai model is selected for this pass.' };
    }
    try {
      const resolved = await modelFor(cfg, ref);
      if ('health' in resolved) return resolved.health;
      const key = resolveUpstreamKey(cfg, resolved.parsed);
      if (!key.ok) return key.health;
      const billing = billingForRef(ref) === 'local' ? 'local, no per-call charge' : 'PAID per token';
      return { state: 'ok', detail: `pi-ai / ${ref} is configured (${billing}).` };
    } catch (err) {
      return {
        state: 'unavailable',
        detail: `The pi-ai SDK could not be loaded: ${redactError(err instanceof Error ? err.message : String(err))}`,
      };
    }
  }

  /**
   * pi's own catalog, one upstream at a time. Loading an upstream's catalog
   * imports its provider module and nothing more: no key is read and no
   * request is made, so the selector can browse every upstream - including
   * one the owner has no key for yet - for free.
   */
  const modelCatalog: ProviderModelCatalog = {
    sources: PI_MODEL_SOURCES,
    async listModels(source) {
      if (!isPiUpstream(source)) throw new Error(`pi-ai has no upstream "${source}".`);
      if (source === 'local') return [];
      const models = await (await getRuntime()).listModels(source);
      return models
        .map((m) => catalogModelFrom(source, m))
        .sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
    },
  };

  return {
    id: PI_AI_PROVIDER_ID,
    label: 'pi-ai (your API key or a local model)',
    billing: 'per-token',
    billingFor: billingForRef,
    configKeys: [
      ...upstreamKeys().map(({ key, labels }) => ({
        key,
        required: false,
        description: `API key for ${labels.join(' / ')} models (PAID per token).`,
        secret: true,
      })),
      {
        key: PIAI_LOCAL_BASE_URL_KEY,
        required: false,
        description:
          'Base URL of an OpenAI-compatible local server, for "local/<model>" ids. Environment only - never read from .env.',
        secret: false,
      },
      {
        key: PIAI_LOCAL_API_KEY_KEY,
        required: false,
        description: 'API key for that local server, if it needs one.',
        secret: true,
      },
      {
        key: PIAI_LOCAL_CONTEXT_WINDOW_KEY,
        required: false,
        description: `Context window of the local model in tokens (default ${DEFAULT_LOCAL_CONTEXT_WINDOW}).`,
        secret: false,
      },
    ],
    models: CURATED_PI_MODELS.map(toProviderModel),
    modelCatalog,
    capabilities: { jsonMode: false, effort: true, temperature: false, streaming: false },
    efforts: PI_AI_EFFORTS,
    check,
    create(cfg, opts): LlmClient {
      const params: ProviderParams = opts.params ?? {};
      const ref = opts.model;
      return {
        providerId: PI_AI_PROVIDER_ID,
        model: ref,
        billing: billingForRef(ref),
        async contextWindow() {
          try {
            const resolved = await modelFor(cfg, ref);
            return 'model' in resolved ? resolved.model.contextWindow : undefined;
          } catch {
            return undefined;
          }
        },
        async complete(req: CompletionRequest): Promise<CompletionResult> {
          const resolved = await modelFor(cfg, ref);
          if ('health' in resolved) throw new Error(resolved.health.detail);
          const { model, parsed } = resolved;
          const key = resolveUpstreamKey(cfg, parsed);
          if (!key.ok) throw new Error(key.health.detail);

          return completeOnPi({
            rt: await getRuntime(),
            model,
            apiKey: key.apiKey,
            params,
            req,
            ref,
            providerId: PI_AI_PROVIDER_ID,
            failure: (detail) => callFailureMessage(ref, detail),
          });
        },
      };
    },
  };
}

/** The registered instance, backed by the real SDK. */
export const piAiProvider: ProviderDefinition = createPiAiProvider();
