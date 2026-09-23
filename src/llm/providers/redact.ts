/**
 * Make an adapter failure safe to show a user: no secrets, bounded length.
 *
 * Shared by `claude-cli` and `pi-ai` (which layers its own key patterns on
 * top via its own `redactError`) - pulled out on its own so neither adapter
 * module has to import the other just for this.
 */
export function redactError(raw: string): string {
  return raw
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}
