import { CURATED_ANTHROPIC_MODELS } from '../llm/providers/anthropic-catalog';
import { CLAUDE_CLI_EFFORTS } from '../llm/providers/claude-cli';

/**
 * What the chat's model picker offers: the app's own curated Claude shortlist
 * (`anthropic-catalog.ts`, the same picks Settings recommends) run by Claude
 * Code on the owner's subscription, and the effort levels Claude Code takes.
 * A small picker on purpose - the chat is a conversation, not a pass to tune.
 */
export type ChatEffort = (typeof CLAUDE_CLI_EFFORTS)[number];

export interface ChatModel {
  /** The bare Anthropic id Claude Code runs (`claude-sonnet-5-5`), never the `anthropic/` catalog form. */
  id: string;
  label: string;
  description: string;
}

export const CHAT_EFFORTS: readonly ChatEffort[] = CLAUDE_CLI_EFFORTS;
export const DEFAULT_CHAT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_CHAT_EFFORT: ChatEffort = 'medium';

/** What each newest model is for in a conversation (the catalog's own hints are about the categorization passes). */
const CHAT_HINTS: Record<string, string> = {
  'claude-opus-5-5': 'Most capable, slowest',
  'claude-sonnet-5-5': 'Balanced - the default',
  'claude-haiku-5-5': 'Fastest, lightest on your quota',
};

export function chatModels(): ChatModel[] {
  return CURATED_ANTHROPIC_MODELS.map((m) => ({
    id: m.id,
    // "Sonnet 5.5": the drawer's picker is narrow, and every choice is Claude.
    label: m.label.replace(/^Claude\s+/, ''),
    description: CHAT_HINTS[m.id] ?? m.role,
  }));
}

export function isChatEffort(value: unknown): value is ChatEffort {
  return typeof value === 'string' && (CHAT_EFFORTS as readonly string[]).includes(value);
}
