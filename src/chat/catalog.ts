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

export function chatModels(): ChatModel[] {
  return CURATED_ANTHROPIC_MODELS.map((m) => ({ id: m.id, label: m.label, description: m.role }));
}

export function isChatEffort(value: unknown): value is ChatEffort {
  return typeof value === 'string' && (CHAT_EFFORTS as readonly string[]).includes(value);
}
