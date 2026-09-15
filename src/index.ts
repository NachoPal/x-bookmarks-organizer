#!/usr/bin/env node
import { loadConfig, requireXCredentials, type Config } from './config';
import { Database } from './db/database';
import { getAuthenticatedClient, login } from './x/auth';
import { Categorizer, createClaudeCliRunner } from './categorize/llm';
import { runIngest } from './ingest';
import { startServer } from './web/server';

const HELP = `X Bookmarks Organizer

Usage:
  node dist/index.js [run]     Fetch new bookmarks, categorize, store (default)
  node dist/index.js login     One-time X OAuth login (opens a browser once)
  node dist/index.js serve     Start the local web viewer
  node dist/index.js help      Show this help

Secrets are injected via Automic Vault, e.g.:
  av inject +XBOOKMARKS_CLIENT_ID +XBOOKMARKS_CLIENT_SECRET +CLAUDE_CODE_OAUTH_TOKEN -- node dist/index.js
`;

async function cmdLogin(config: Config, db: Database): Promise<void> {
  requireXCredentials(config);
  await login(config, db);
  console.log('Logged in. Refresh token stored locally. Future runs are headless.');
}

async function cmdRun(config: Config, db: Database): Promise<void> {
  requireXCredentials(config);
  if (!config.claudeToken) {
    throw new Error(
      'Missing CLAUDE_CODE_OAUTH_TOKEN. Categorization runs on your Claude subscription, so this token is required for a run.',
    );
  }
  const client = await getAuthenticatedClient(config, db);
  const runner = createClaudeCliRunner(config.categorizeModel);
  const categorizer = new Categorizer(runner, {
    model: config.categorizeModel,
    maxDepth: config.maxCategoryDepth,
  });

  const summary = await runIngest({
    db,
    client,
    categorizer,
    batchSize: config.batchSize,
    maxDepth: config.maxCategoryDepth,
    logger: (msg) => console.log(msg),
  });

  console.log(
    `\nDone. ${summary.newBookmarks} new bookmark(s), ` +
      `${summary.batches} batch(es), ${summary.nodesCreated} new categor(y/ies).`,
  );
  console.log('Browse them with:  node dist/index.js serve');
}

async function cmdServe(config: Config, db: Database): Promise<void> {
  const app = await startServer(db, config.webPort);
  console.log(`Web viewer running at http://127.0.0.1:${config.webPort}`);
  console.log('Press Ctrl+C to stop.');
  const shutdown = () => {
    app.close().finally(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'run';
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }

  const config = loadConfig();
  const db = new Database(config.dbPath);

  try {
    switch (command) {
      case 'login':
        await cmdLogin(config, db);
        break;
      case 'run':
        await cmdRun(config, db);
        break;
      case 'serve':
        await cmdServe(config, db);
        return; // serve keeps the process alive; do not close the db here.
      default:
        console.error(`Unknown command: ${command}\n`);
        console.log(HELP);
        process.exitCode = 1;
    }
  } finally {
    if (command !== 'serve') db.close();
  }
}

main().catch((err) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
