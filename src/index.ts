#!/usr/bin/env node
import { loadConfig, requireXCredentials, type Config } from './config';
import { Database } from './db/database';
import { getAuthenticatedClient, login } from './x/auth';
import { Categorizer, createClaudeCliRunner, isClaudeAvailable } from './categorize/llm';
import { LlmTaxonomyDesigner } from './categorize/taxonomy';
import { recategorizeAll, runIngest } from './ingest';
import { startServer } from './web/server';
import { ClaudeSummaryGenerator } from './summarize/summarizer';

const HELP = `X Bookmarks Organizer

Usage:
  node dist/index.js [run]       Fetch new bookmarks, categorize, store (default)
  node dist/index.js login       One-time X OAuth login (opens a browser once)
  node dist/index.js recategorize  Rebuild the taxonomy and reassign ALL stored
                                   bookmarks from scratch (no re-fetch from X)
  node dist/index.js serve       Start the local web viewer
  node dist/index.js help        Show this help

X credentials (XBOOKMARKS_CLIENT_ID / XBOOKMARKS_CLIENT_SECRET) must be in the environment.
Provide them however you like - e.g. via Automic Vault:
  av inject +XBOOKMARKS_CLIENT_ID +XBOOKMARKS_CLIENT_SECRET -- node dist/index.js

Categorization needs Claude to be usable: either the \`claude\` CLI is installed and logged
in, or CLAUDE_CODE_OAUTH_TOKEN is set for a headless machine.
`;

/** Build the two categorization passes' collaborators from config. */
function buildCategorizers(config: Config) {
  const taxonomyRunner = createClaudeCliRunner(config.taxonomyModel, {
    effort: config.taxonomyEffort,
  });
  const taxonomer = new LlmTaxonomyDesigner(taxonomyRunner, {
    minDepth: config.minCategoryDepth,
    maxDepth: config.maxCategoryDepth,
  });
  const assignmentRunner = createClaudeCliRunner(config.categorizeModel);
  const categorizer = new Categorizer(assignmentRunner, {
    model: config.categorizeModel,
    maxDepth: config.maxCategoryDepth,
  });
  return { taxonomer, categorizer };
}

/** Assert Claude is usable (categorization needs it): CLI on PATH, or a token set. */
function requireClaudeAvailable(config: Config): void {
  if (!isClaudeAvailable(config)) {
    throw new Error(
      'Claude is not available: the `claude` CLI was not found on PATH and no CLAUDE_CODE_OAUTH_TOKEN ' +
        'is set. Install and log in to the `claude` CLI (https://claude.com/claude-code), or set ' +
        'CLAUDE_CODE_OAUTH_TOKEN however you provide env vars, e.g. `av inject +CLAUDE_CODE_OAUTH_TOKEN -- ...`.',
    );
  }
}

async function cmdLogin(config: Config, db: Database): Promise<void> {
  requireXCredentials(config);
  await login(config, db);
  console.log('Logged in. Refresh token stored locally. Future runs are headless.');
}

async function cmdRun(config: Config, db: Database): Promise<void> {
  requireXCredentials(config);
  requireClaudeAvailable(config);
  const client = await getAuthenticatedClient(config, db);
  const { taxonomer, categorizer } = buildCategorizers(config);

  const summary = await runIngest({
    db,
    client,
    taxonomer,
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

async function cmdRecategorize(config: Config, db: Database): Promise<void> {
  requireClaudeAvailable(config);
  const { taxonomer, categorizer } = buildCategorizers(config);

  const summary = await recategorizeAll({
    db,
    taxonomer,
    categorizer,
    batchSize: config.batchSize,
    maxDepth: config.maxCategoryDepth,
    logger: (msg) => console.log(msg),
  });

  console.log(
    `\nDone. Re-categorized ${summary.bookmarks} bookmark(s) into ` +
      `${summary.nodesCreated} categor(y/ies) over ${summary.batches} batch(es).`,
  );
  console.log('Read state and dates were preserved.');
  console.log('Browse them with:  node dist/index.js serve');
}

async function cmdServe(config: Config, db: Database): Promise<void> {
  // Summaries reuse the assignment-pass model (Haiku-class, for cost) and the
  // same subscription-only `claude` CLI runner as categorization. Claude is
  // probed as a capability (CLI on PATH, or a token for a headless box), not
  // required as a secret - without either, the viewer still serves everything
  // else and the summary endpoint degrades gracefully instead of the server
  // needing this to start.
  const summaryGenerator = isClaudeAvailable(config)
    ? new ClaudeSummaryGenerator(createClaudeCliRunner(config.categorizeModel))
    : undefined;
  const app = await startServer(db, config.webPort, '127.0.0.1', {
    pageSize: config.pageSize,
    summaryGenerator,
  });
  console.log(`Web viewer running at http://127.0.0.1:${config.webPort}`);
  if (!summaryGenerator) {
    console.log(
      'Summaries disabled: the `claude` CLI was not found on PATH and no CLAUDE_CODE_OAUTH_TOKEN is set. ' +
        'Install and log in to the `claude` CLI, or set CLAUDE_CODE_OAUTH_TOKEN, then restart `serve`.',
    );
  }
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
      case 'recategorize':
        await cmdRecategorize(config, db);
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
