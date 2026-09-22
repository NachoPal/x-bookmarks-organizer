import { registerProvider } from '../registry';
import { claudeCliProvider } from './claude-cli';
import { piAiProvider } from './pi-ai';
import { piClaudeSubscriptionProvider } from './pi-claude-subscription';

/**
 * The one file a new provider adds a line to.
 *
 * Importing this module registers every built-in provider; `./factory` does it
 * for you, so nothing else in the app needs to know the list. Registration
 * order is the settings selector's order, and the FIRST provider is the
 * default a fresh install starts on - which is why `claude-cli` (the
 * subscription, no per-call charge) leads and the paid `pi-ai` follows.
 * `pi-claude-subscription` (the subscription driven through pi, which
 * Anthropic's terms prohibit) comes LAST: it is an opt-in, never a default.
 */
registerProvider(claudeCliProvider);
registerProvider(piAiProvider);
registerProvider(piClaudeSubscriptionProvider);

export { claudeCliProvider, piAiProvider, piClaudeSubscriptionProvider };
