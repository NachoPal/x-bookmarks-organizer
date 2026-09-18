#!/usr/bin/env node
import { loadConfig, requireXCredentials, type Config } from './config';
import { createCredentialStore, type CredentialStore } from './creds/resolve';
import { Database } from './db/database';
import { getAuthenticatedClient, login } from './x/auth';
import { Categorizer } from './categorize/llm';
import { LlmTaxonomyDesigner } from './categorize/taxonomy';
import { recategorizeAll, runIngest } from './ingest';
import { startServer } from './web/server';
import { LlmSummaryGenerator } from './summarize/summarizer';
import { billingLabel, createLlmFactory, type LlmFactory } from './llm/factory';
import { toRunner } from './llm/runner';
import type { LlmRole } from './llm/types';
import { backfillArticlePreviews } from './articles/backfill';
import { HttpArticleFetcher } from './articles/fetch-article';
import { backfillXArticles } from './x/backfill-articles';
import { refetchFailedArticles } from './articles/refetch';

const HELP = `X Bookmarks Organizer

Usage:
  node dist/index.js [run]       Fetch new bookmarks, categorize, store (default)
  node dist/index.js login       One-time X OAuth login (opens a browser once)
  node dist/index.js recategorize  Rebuild the taxonomy and reassign ALL stored
                                   bookmarks from scratch (no re-fetch from X)
  node dist/index.js serve       Start the local web viewer
  node dist/index.js backfill-previews [--retry-failed]
                                  Fetch + cache article link metadata for
                                  already-stored bookmarks that predate the
                                  previews feature. No categorization, no
                                  taxonomy changes, no re-fetch from X.
                                  --retry-failed also re-fetches links
                                  previously cached as failed.
  node dist/index.js backfill-x-articles [--dry-run]
                                  Read X Article data (title, preview, cover,
                                  body) from the X API for already-stored
                                  bookmarks that link or quote an X Article.
                                  A small one-time PAID X read; --dry-run lists
                                  what would be read and its estimated cost
                                  without calling X.
  node dist/index.js refetch-articles
                                  Re-fetch every bookmark article cached as
                                  unreadable, and drop the cached summary of
                                  each one that now has a body so Summarize
                                  regenerates it with the article. Other
                                  summaries are kept.
  node dist/index.js clear-summaries
                                  Wipe all cached bookmark summaries so they
                                  regenerate cleanly under the current logic.
                                  No secrets, no network - just the DB.
  node dist/index.js help        Show this help

Secrets resolve through a layered chain, first hit wins: the environment (a
vault such as \`av inject\`, a shell export, a systemd unit, CI secrets), a
\`.env\` file in the project root, your OS keychain, or
~/.config/x-bookmarks-organizer/credentials.json. See .env.example.

Categorization and summaries run through the LLM provider named by
XBOOKMARKS_LLM_PROVIDER (default: claude-cli, your Claude Code subscription via
the local claude CLI).
`;

/**
 * Build the two categorization passes' collaborators.
 *
 * Both passes are provider-agnostic: each takes a narrow `LlmRunner` bridged
 * from whichever provider the factory resolved for that role, so the Opus-pass-1
 * / Haiku-pass-2 economics stay expressible without either class knowing what
 * is behind it.
 */
function buildCategorizers(config: Config, llm: LlmFactory) {
  const assignment = llm.forRole('assignment');
  const taxonomer = new LlmTaxonomyDesigner(toRunner(llm.forRole('taxonomy'), { json: true }), {
    minDepth: config.minCategoryDepth,
    maxDepth: config.maxCategoryDepth,
  });
  const categorizer = new Categorizer(toRunner(assignment, { json: true }), {
    model: assignment.model,
    maxDepth: config.maxCategoryDepth,
  });
  return { taxonomer, categorizer };
}

/**
 * Assert the provider backing these roles can actually run, with the adapter's
 * own actionable message. Availability is the adapter's business (for
 * `claude-cli`: does the binary resolve), never a hardcoded token check.
 */
async function requireLlm(llm: LlmFactory, roles: LlmRole[]): Promise<void> {
  for (const role of roles) {
    const health = await llm.check(role);
    // The detail is the adapter's own actionable message (and names the
    // provider when the configured id does not exist at all).
    if (health.state !== 'ok') throw new Error(health.detail);
  }
}

async function cmdLogin(config: Config, db: Database): Promise<void> {
  requireXCredentials(config);
  await login(config, db);
  console.log('Logged in. Refresh token stored locally. Future runs are headless.');
}

async function cmdRun(config: Config, db: Database, store: CredentialStore): Promise<void> {
  requireXCredentials(config);
  const llm = createLlmFactory(config, process.env, store);
  await requireLlm(llm, ['taxonomy', 'assignment']);
  const client = await getAuthenticatedClient(config, db);
  const { taxonomer, categorizer } = buildCategorizers(config, llm);

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

async function cmdRecategorize(config: Config, db: Database, store: CredentialStore): Promise<void> {
  const llm = createLlmFactory(config, process.env, store);
  await requireLlm(llm, ['taxonomy', 'assignment']);
  const { taxonomer, categorizer } = buildCategorizers(config, llm);

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

async function cmdBackfillPreviews(db: Database): Promise<void> {
  const retryFailed = process.argv.includes('--retry-failed');
  const summary = await backfillArticlePreviews(db, new HttpArticleFetcher(), {
    retryFailed,
    logger: (msg) => console.log(msg),
  });
  console.log(
    `\nDone. ${summary.totalLinks} link(s) found, ${summary.fetched} fetched ` +
      `(${summary.ok} readable article(s), ${summary.card} preview card(s), ` +
      `${summary.failed} with nothing usable), ${summary.skipped} already cached.`,
  );
}

async function cmdBackfillXArticles(config: Config, db: Database): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const summary = await backfillXArticles(
    db,
    async () => {
      requireXCredentials(config);
      return getAuthenticatedClient(config, db);
    },
    { dryRun, logger: (msg) => console.log(msg) },
  );
  console.log(
    `\nDone. ${summary.direct} bookmark(s) link an X Article, ${summary.quoted} quote another X post; ` +
      `${summary.requested} post(s) read from X, ${summary.stored} X Article(s) stored.`,
  );
  if (summary.stored > 0) {
    console.log(
      'Cards and summaries use them right away. To re-file bookmarks now sitting in Uncategorized, ' +
        'run:  node dist/index.js recategorize',
    );
  }
}

async function cmdRefetchArticles(db: Database): Promise<void> {
  const summary = await refetchFailedArticles(db, new HttpArticleFetcher(), {
    logger: (msg) => console.log(msg),
  });
  console.log(
    `\nDone. ${summary.retried} re-fetched: ${summary.recovered} now readable, ` +
      `${summary.stillFailed} still without a body; ${summary.summariesCleared} stale summar` +
      `${summary.summariesCleared === 1 ? 'y' : 'ies'} cleared.`,
  );
}

/**
 * Delete every cached summary so they regenerate under the current logic -
 * e.g. after a bug cached bad/garbage summaries (the model's refusal text) as
 * if they were real. Explicit and idempotent: never run automatically.
 */
async function cmdClearSummaries(db: Database): Promise<void> {
  const removed = db.clearSummaries();
  console.log(`Removed ${removed} cached summar${removed === 1 ? 'y' : 'ies'}.`);
}

async function cmdServe(config: Config, db: Database, store: CredentialStore): Promise<void> {
  // Summaries go through the same provider abstraction as categorization, on
  // the summary role's model. The button is offered whenever the provider says
  // it can run; a call that then fails surfaces the adapter's actionable error
  // in the modal instead of the control being pre-disabled.
  const llm = createLlmFactory(config, process.env, store);
  const health = await llm.check('summary');
  const available = health.state === 'ok';
  const summaryGenerator = available
    ? new LlmSummaryGenerator(toRunner(llm.forRole('summary')))
    : undefined;
  const app = await startServer(db, config.webPort, '127.0.0.1', {
    pageSize: config.pageSize,
    summaryGenerator,
    summaryUnavailableReason: available ? undefined : health.detail,
  });
  console.log(`Web viewer running at http://127.0.0.1:${config.webPort}`);
  if (available) {
    const { providerId, model, billing } = llm.describe('summary');
    console.log(`Summaries: ${providerId} / ${model} - ${billingLabel(billing)}`);
  } else {
    console.log(`Summaries disabled: ${health.detail}`);
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

  const store = createCredentialStore();
  const config = loadConfig(process.env, store);
  const db = new Database(config.dbPath);

  try {
    switch (command) {
      case 'login':
        await cmdLogin(config, db);
        break;
      case 'run':
        await cmdRun(config, db, store);
        break;
      case 'recategorize':
        await cmdRecategorize(config, db, store);
        break;
      case 'backfill-previews':
        await cmdBackfillPreviews(db);
        break;
      case 'backfill-x-articles':
        await cmdBackfillXArticles(config, db);
        break;
      case 'refetch-articles':
        await cmdRefetchArticles(db);
        break;
      case 'clear-summaries':
        await cmdClearSummaries(db);
        break;
      case 'serve':
        await cmdServe(config, db, store);
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
