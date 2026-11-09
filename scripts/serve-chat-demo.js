'use strict';

/**
 * Dev-only: serve the viewer with the "Ask Claude" chat driven by an OFFLINE
 * scripted stand-in for Claude Code (`src/chat/scripted-query.ts`) instead of
 * the real Agent SDK - so the chat UI can be exercised end to end, tool chips
 * and a real `show_in_app` list included, with no model call and no
 * subscription quota spent.
 *
 * Never point it at real data. Usage (after `npm run build && npm run seed:dev`):
 *   node scripts/serve-chat-demo.js [dbPath] [port]
 * defaults: data/dev-seed.db, port 5199. CHAT_DEMO_DELAY_MS slows the stream (default 35ms a piece).
 *
 * The script: a message mentioning "show", "open" or "list" searches and then
 * sends the matches to the app with show_in_app; anything else searches and
 * answers with the matches as linked posts. "fail" answers with the
 * not-logged-in error, to see that state.
 */
const path = require('node:path');
const { Database } = require('../dist/db/database');
const { startServer } = require('../dist/web/server');
const { scriptedQuery } = require('../dist/chat/scripted-query');
const { searchBookmarks } = require('../dist/mcp/tools');

const dbPath = path.resolve(process.argv[2] || path.join(process.cwd(), 'data', 'dev-seed.db'));
const port = Number(process.argv[3] || 5199);
const db = new Database(dbPath);

const STOP_WORDS = new Set(
  'a an and about are can do find for from have i in is it me my of on or please posts show the them to what which with you saved open list lately'.split(' '),
);

/** The new message (after any history) as search keywords. */
function keywords(prompt) {
  const message = prompt.includes("The owner's new message:") ? prompt.split("The owner's new message:").pop() : prompt;
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9@ ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return { message, query: words.slice(0, 3).join(' ') };
}

const run = scriptedQuery(
  (prompt) => {
    const { message, query } = keywords(prompt);
    if (/\bfail\b/i.test(message)) return [{ error: 'Not logged in · Please run /login' }];
    let found = searchBookmarks(db, { query, limit: 5 });
    let searched = query;
    if (found.results.length === 0) {
      searched = '';
      found = searchBookmarks(db, { limit: 5 });
    }
    const turns = [{ tool: 'search_bookmarks', input: searched ? { query: searched, limit: 5 } : { limit: 5 } }];
    const cite = (r) => `- [@${r.author.split(' ')[0].replace(/^@/, '')}: ${r.text.replace(/\s+/g, ' ').slice(0, 70)}…](${r.url})`;
    if (/\b(show|open|list)\b/i.test(message) && found.results.length > 0) {
      const ids = found.results.map((r) => r.postId);
      turns.push({ text: `I found **${ids.length} post${ids.length === 1 ? "" : "s"}** that fit. Opening them in the app.` });
      turns.push({
        tool: 'show_in_app',
        input: { postIds: ids, title: searched ? `About ${searched}` : 'Recent bookmarks', note: 'Sent from the Ask Claude demo.' },
      });
      turns.push({ text: `Done - they are under **Lists** as "${searched ? `About ${searched}` : 'Recent bookmarks'}".` });
    } else {
      turns.push({
        text:
          found.results.length > 0
            ? `Here is what your library has${searched ? ` on *${searched}*` : ''}:\n\n${found.results.map(cite).join('\n')}\n\nWant me to open them in the app?`
            : 'Your library has no bookmarks yet.',
      });
    }
    return turns;
  },
  { delayMs: Number(process.env.CHAT_DEMO_DELAY_MS || 35) },
);

startServer(db, port, '127.0.0.1', { chat: { run } }).then(() => {
  console.log(`Chat demo (offline, scripted - no model call) at http://127.0.0.1:${port} over ${dbPath}`);
});
