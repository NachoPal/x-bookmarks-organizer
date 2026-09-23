import type { Api, Model } from '@earendil-works/pi-ai';
import type {
  CompletionRequest,
  CompletionResult,
  Health,
  LlmClient,
  ProviderDefinition,
  ProviderParams,
  ResolvedProviderConfig,
} from '../types';
import { CLAUDE_TOKEN_KEY } from './claude-cli';
import {
  CURATED_ANTHROPIC_MODELS,
  anthropicModelId,
  buildAnthropicModelCatalog,
  curatedAnthropicModels,
  parseAnthropicModelId,
} from './anthropic-catalog';
import {
  PI_AI_EFFORTS,
  completeOnPi,
  isSubscriptionToken,
  lazyRuntime,
  loadPiRuntime,
  redactError,
  type PiRuntime,
} from './pi-ai';

/**
 * The owner's Claude SUBSCRIPTION, driven through pi - an explicit opt-in.
 *
 * `claude-cli` (Anthropic's own binary) is, and stays, the default and the
 * sanctioned way to spend a subscription. pi can also drive one: handed an
 * `sk-ant-oat…` token, its Anthropic adapter switches to OAuth and presents
 * itself as Claude Code (the `claude-code-20250219` / `oauth-2025-04-20` betas
 * and Claude Code's system prompt). Anthropic's Claude Code terms prohibit
 * exactly that - subscription OAuth is for Claude Code and Anthropic's own
 * apps, and third parties may not intermediate those credentials - and
 * Anthropic may enforce it against the ACCOUNT without notice. The owner has
 * weighed that and chosen to allow it for personal use; this provider's job is
 * to make it a deliberate, labelled choice, never a silent one:
 *
 * - It is its OWN provider id, not a mode of `pi-ai`, so selecting it IS the
 *   opt-in. It is registered after the default and is never a default for any
 *   role; `pi-ai` keeps refusing a subscription token exactly as before.
 * - It carries {@link PI_CLAUDE_SUBSCRIPTION_WARNING} as its `warning`, which
 *   the settings selector shows at the point of choice and every run prints
 *   beside its billing line.
 * - It reads ONLY `CLAUDE_CODE_OAUTH_TOKEN`, through the app's credential
 *   chain, and passes it to pi on every call - pi never resolves a credential
 *   itself. It never reads `ANTHROPIC_API_KEY`, and it refuses a token that is
 *   not a subscription token: pi would bill an API key per token, and a route
 *   labelled "subscription" must never be able to do that.
 */

/** Provider id - the value of `XBOOKMARKS_LLM_PROVIDER` / `XBOOKMARKS_*_PROVIDER`. */
export const PI_CLAUDE_SUBSCRIPTION_PROVIDER_ID = 'pi-claude-subscription';

/** What the owner is told wherever this route can be chosen, and on every run. */
export const PI_CLAUDE_SUBSCRIPTION_WARNING =
  'Account risk: this sends your Claude subscription token through pi, which presents itself to ' +
  "Anthropic as Claude Code. Anthropic's Claude Code terms prohibit third-party use of subscription " +
  'OAuth and allow Anthropic to act against your account without notice. The "claude-cli" provider ' +
  'is the sanctioned way to use your subscription.';

/** What the model list's hint line says this route costs and needs. */
const BILLING_NOTE = `Uses your subscription quota via pi. Needs ${CLAUDE_TOKEN_KEY}.`;

type TokenResolution = { ok: true; token: string } | { ok: false; health: Health };

/**
 * The subscription token, from the credential chain - or why this route cannot
 * run. Only `CLAUDE_CODE_OAUTH_TOKEN` is ever consulted.
 */
export function resolveSubscriptionToken(cfg: ResolvedProviderConfig): TokenResolution {
  const token = cfg.get(CLAUDE_TOKEN_KEY)?.trim();
  if (!token) {
    return {
      ok: false,
      health: {
        state: 'unconfigured',
        detail:
          `The "${PI_CLAUDE_SUBSCRIPTION_PROVIDER_ID}" provider needs ${CLAUDE_TOKEN_KEY} (from \`claude setup-token\`). ` +
          'Provide it through the environment, a .env file in the project root, your OS keychain, or ' +
          '~/.config/x-bookmarks-organizer/credentials.json. A `claude` CLI logged in interactively is ' +
          'not enough here - use the "claude-cli" provider for that.',
      },
    };
  }
  if (!isSubscriptionToken(token)) {
    return {
      ok: false,
      health: {
        state: 'unconfigured',
        detail:
          `${CLAUDE_TOKEN_KEY} does not hold a Claude subscription token (sk-ant-oat...). This route only ` +
          'ever spends a subscription, so it will not use it: an API key would be billed per token. To pay ' +
          'per token, pick the "pi-ai" provider with an Anthropic model and ANTHROPIC_API_KEY.',
      },
    };
  }
  return { ok: true, token };
}

function unknownModelDetail(modelId: string): string {
  return (
    `pi does not know the Claude model "${modelId}". ` +
    `Recommended here: ${CURATED_ANTHROPIC_MODELS.map((m) => anthropicModelId(m.id)).join(', ')} - ` +
    'or browse the full catalog.'
  );
}

function callFailureMessage(modelId: string, detail: string): string {
  const redacted = redactError(detail);
  return `The Claude subscription via pi (${modelId}) failed${redacted ? `: ${redacted}` : ''}.`;
}

/** Build the provider around a runtime loader - the real SDK, or a test's fake. */
export function createPiClaudeSubscriptionProvider(
  load: () => Promise<PiRuntime> = loadPiRuntime,
): ProviderDefinition {
  const getRuntime = lazyRuntime(load);

  async function modelFor(modelId: string): Promise<{ model: Model<Api> } | { health: Health }> {
    const model = await (await getRuntime()).findModel('anthropic', parseAnthropicModelId(modelId));
    return model ? { model } : { health: { state: 'unconfigured', detail: unknownModelDetail(modelId) } };
  }

  /** Ready means: a subscription token resolves and pi knows the model. No request is made. */
  async function check(cfg: ResolvedProviderConfig, opts?: { model?: string }): Promise<Health> {
    const token = resolveSubscriptionToken(cfg);
    if (!token.ok) return token.health;
    const modelId = opts?.model;
    if (!modelId) return { state: 'unconfigured', detail: 'No Claude model is selected for this pass.' };
    try {
      const resolved = await modelFor(modelId);
      if ('health' in resolved) return resolved.health;
      return {
        state: 'ok',
        detail: `Claude subscription via pi / ${modelId} is configured (subscription quota; account risk - see the warning).`,
      };
    } catch (err) {
      return {
        state: 'unavailable',
        detail: `The pi-ai SDK could not be loaded: ${redactError(err instanceof Error ? err.message : String(err))}`,
      };
    }
  }

  return {
    id: PI_CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    label: "Claude subscription via pi (against Anthropic's terms)",
    billing: 'subscription',
    warning: PI_CLAUDE_SUBSCRIPTION_WARNING,
    configKeys: [
      {
        key: CLAUDE_TOKEN_KEY,
        required: true,
        description:
          'Claude subscription OAuth token (sk-ant-oat...) from `claude setup-token`, passed to pi. ' +
          "Anthropic's Claude Code terms prohibit this use - account risk.",
        secret: true,
      },
    ],
    models: curatedAnthropicModels({ requiresKey: CLAUDE_TOKEN_KEY, billingNote: BILLING_NOTE }),
    modelCatalog: buildAnthropicModelCatalog(getRuntime, { requiresKey: CLAUDE_TOKEN_KEY, billingNote: BILLING_NOTE }),
    capabilities: { jsonMode: false, effort: true, temperature: false, streaming: false },
    efforts: PI_AI_EFFORTS,
    check,
    create(cfg, opts): LlmClient {
      const params: ProviderParams = opts.params ?? {};
      const modelId = opts.model;
      return {
        providerId: PI_CLAUDE_SUBSCRIPTION_PROVIDER_ID,
        model: modelId,
        billing: 'subscription',
        async contextWindow() {
          try {
            const resolved = await modelFor(modelId);
            return 'model' in resolved ? resolved.model.contextWindow : undefined;
          } catch {
            return undefined;
          }
        },
        async complete(req: CompletionRequest): Promise<CompletionResult> {
          // Resolved on every call, never cached: the token is the ONLY credential
          // this route may hand pi, and a refusal must hold before any request.
          const token = resolveSubscriptionToken(cfg);
          if (!token.ok) throw new Error(token.health.detail);
          const resolved = await modelFor(modelId);
          if ('health' in resolved) throw new Error(resolved.health.detail);
          return completeOnPi({
            rt: await getRuntime(),
            model: resolved.model,
            // An sk-ant-oat token is what switches pi's Anthropic adapter to
            // its OAuth (Claude Pro/Max) path.
            apiKey: token.token,
            params,
            req,
            ref: modelId,
            providerId: PI_CLAUDE_SUBSCRIPTION_PROVIDER_ID,
            failure: (detail) => callFailureMessage(modelId, detail),
          });
        },
      };
    },
  };
}

/** The registered instance, backed by the real SDK. */
export const piClaudeSubscriptionProvider: ProviderDefinition = createPiClaudeSubscriptionProvider();
