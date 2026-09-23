import type { Api, Provider } from '@earendil-works/pi-ai';

/**
 * The pi upstreams the `pi-ai` provider offers: each is one of pi's own
 * provider ids, reached with ONE API key the owner holds, and billed per token
 * to that key. Adding an upstream is one row here - pi already ships its
 * catalog - and nothing else in the app has to change: the settings selector,
 * the model browser and the credential presence check all read this table.
 *
 * `load` imports pi's provider module for that upstream, and it is only ever
 * called ON DEMAND (the first time a model of that upstream is looked up, run
 * or listed). That is what keeps registering many upstreams cheap: pi's
 * `providers/all` would import ~40 catalogs at once, so it is never used.
 *
 * Every row is a plain API-key provider whose catalog is STATIC data bundled in
 * the pi package, so listing its models is a local read - no request, no
 * spend. Deliberately left out, and why:
 * - `amazon-bedrock`, `google-vertex`, `azure-openai-responses`: cloud IAM /
 *   ambient credentials (AWS profiles, ADC files, Azure deployments), not one
 *   key the credential chain can hand over.
 * - `cloudflare-ai-gateway`, `cloudflare-workers-ai`: need an account id as
 *   well as a token.
 * - `openai-codex`, `github-copilot`, `kimi-coding`, `meta`, the Qwen / Xiaomi
 *   "token plan"s: subscription or OAuth logins, the same account-risk class
 *   `pi-ai` refuses for the Claude subscription.
 * - `radius`: its catalog is fetched over the network (`fetchModels`), which
 *   the free, offline model browser must never do.
 * - the `-cn` regional twins (`moonshotai-cn`, `minimax-cn`, `zai-coding-cn`):
 *   same models on a regional endpoint; add a row if one is ever wanted.
 */

/** How an upstream is grouped in the selector. */
export type PiUpstreamKind = 'direct' | 'gateway' | 'local';

export interface PiUpstreamInfo {
  label: string;
  kind: PiUpstreamKind;
  /** The credential-chain key holding this upstream's API key. Absent for `local`. */
  keyName?: string;
  /** pi's provider for this upstream, imported on first use. Absent for `local`. */
  load?: () => Promise<Provider<Api>>;
}

/** Selector order: the model makers first, then the one-key-many-models gateways, then local. */
const TABLE = {
  anthropic: {
    label: 'Anthropic API',
    kind: 'direct',
    keyName: 'ANTHROPIC_API_KEY',
    load: async () => (await import('@earendil-works/pi-ai/providers/anthropic')).anthropicProvider(),
  },
  openai: {
    label: 'OpenAI API',
    kind: 'direct',
    keyName: 'OPENAI_API_KEY',
    load: async () => (await import('@earendil-works/pi-ai/providers/openai')).openaiProvider(),
  },
  google: {
    label: 'Google Gemini API',
    kind: 'direct',
    keyName: 'GEMINI_API_KEY',
    load: async () => (await import('@earendil-works/pi-ai/providers/google')).googleProvider(),
  },
  xai: {
    label: 'xAI API',
    kind: 'direct',
    keyName: 'XAI_API_KEY',
    load: async () => (await import('@earendil-works/pi-ai/providers/xai')).xaiProvider(),
  },
  deepseek: {
    label: 'DeepSeek API',
    kind: 'direct',
    keyName: 'DEEPSEEK_API_KEY',
    load: async () => (await import('@earendil-works/pi-ai/providers/deepseek')).deepseekProvider(),
  },
  mistral: {
    label: 'Mistral API',
    kind: 'direct',
    keyName: 'MISTRAL_API_KEY',
    load: async () => (await import('@earendil-works/pi-ai/providers/mistral')).mistralProvider(),
  },
  moonshotai: {
    label: 'Moonshot AI (Kimi) API',
    kind: 'direct',
    keyName: 'MOONSHOT_API_KEY',
    load: async () => (await import('@earendil-works/pi-ai/providers/moonshotai')).moonshotaiProvider(),
  },
  zai: {
    label: 'Z.AI (GLM) API',
    kind: 'direct',
    keyName: 'ZAI_API_KEY',
    load: async () => (await import('@earendil-works/pi-ai/providers/zai')).zaiProvider(),
  },
  minimax: {
    label: 'MiniMax API',
    kind: 'direct',
    keyName: 'MINIMAX_API_KEY',
    load: async () => (await import('@earendil-works/pi-ai/providers/minimax')).minimaxProvider(),
  },
  groq: {
    label: 'Groq',
    kind: 'direct',
    keyName: 'GROQ_API_KEY',
    load: async () => (await import('@earendil-works/pi-ai/providers/groq')).groqProvider(),
  },
  cerebras: {
    label: 'Cerebras',
    kind: 'direct',
    keyName: 'CEREBRAS_API_KEY',
    load: async () => (await import('@earendil-works/pi-ai/providers/cerebras')).cerebrasProvider(),
  },
  openrouter: {
    label: 'OpenRouter',
    kind: 'gateway',
    keyName: 'OPENROUTER_API_KEY',
    load: async () => (await import('@earendil-works/pi-ai/providers/openrouter')).openrouterProvider(),
  },
  opencode: {
    label: 'OpenCode Zen',
    kind: 'gateway',
    keyName: 'OPENCODE_API_KEY',
    load: async () => (await import('@earendil-works/pi-ai/providers/opencode')).opencodeProvider(),
  },
  'opencode-go': {
    label: 'OpenCode Go',
    kind: 'gateway',
    // pi reads the same key for both OpenCode plans.
    keyName: 'OPENCODE_API_KEY',
    load: async () => (await import('@earendil-works/pi-ai/providers/opencode-go')).opencodeGoProvider(),
  },
  'vercel-ai-gateway': {
    label: 'Vercel AI Gateway',
    kind: 'gateway',
    keyName: 'AI_GATEWAY_API_KEY',
    load: async () => (await import('@earendil-works/pi-ai/providers/vercel-ai-gateway')).vercelAIGatewayProvider(),
  },
  together: {
    label: 'Together AI',
    kind: 'gateway',
    keyName: 'TOGETHER_API_KEY',
    load: async () => (await import('@earendil-works/pi-ai/providers/together')).togetherProvider(),
  },
  fireworks: {
    label: 'Fireworks AI',
    kind: 'gateway',
    keyName: 'FIREWORKS_API_KEY',
    load: async () => (await import('@earendil-works/pi-ai/providers/fireworks')).fireworksProvider(),
  },
  huggingface: {
    label: 'Hugging Face Inference',
    kind: 'gateway',
    keyName: 'HF_TOKEN',
    load: async () => (await import('@earendil-works/pi-ai/providers/huggingface')).huggingfaceProvider(),
  },
  local: { label: 'Local OpenAI-compatible endpoint', kind: 'local' },
} satisfies Record<string, PiUpstreamInfo>;

export type PiUpstream = keyof typeof TABLE;
export const PI_UPSTREAMS: Readonly<Record<PiUpstream, PiUpstreamInfo>> = TABLE;
/** An upstream pi hosts a catalog for - everything but `local`. */
export type HostedUpstream = Exclude<PiUpstream, 'local'>;

export const PI_UPSTREAM_IDS = Object.keys(PI_UPSTREAMS) as PiUpstream[];

export function isPiUpstream(value: string): value is PiUpstream {
  return Object.prototype.hasOwnProperty.call(PI_UPSTREAMS, value);
}
