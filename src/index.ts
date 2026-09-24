#!/usr/bin/env node
import { loadConfig, requireXCredentials, type Config } from './config';
import { createCredentialStore, dotenvExposure, type CredentialStore } from './creds/resolve';
import { Database } from './db/database';
import { getAuthenticatedClient, login } from './x/auth';
import { buildCategorizers, buildTaxonomyDesigner, reportCategorizerBilling, requireLlm } from './categorize/build';
import { Categorizer } from './categorize/llm';
import { recategorizeAll, runIngest } from './ingest';
import { startServer } from './web/server';
import { LlmSummaryGenerator } from './summarize/summarizer';
import { billingLabel, createLlmFactory } from './llm/factory';
import { toRunner } from './llm/runner';
import { getProvider } from './llm/registry';
import { CLAUDE_CLI_PROVIDER_ID } from './llm/providers/claude-cli';
import type { ResolvedProviderConfig } from './llm/types';
import { buildSettingsCatalog } from './settings/catalog';
import { createModelBrowser } from './settings/model-browser';
import { applySettingsToConfig, effectiveSettings } from './settings/settings';
import { createSyncJob } from './web/sync-job';
import { createRankWiring } from './web/rank-job';
import { backfillArticlePreviews } from './articles/backfill';
import { HttpArticleFetcher } from './articles/fetch-article';
import { backfillXArticles } from './x/backfill-articles';
import { refetchFailedArticles } from './articles/refetch';
import { buildRanker, reportRankerBilling } from './rank/build';
import { planRanking, rankBookmarks } from './rank/ranker';
import { buildEvalJev, reportEvalBilling } from './eval/build';
import { planCategorizerEval, runCategorizerEval } from './eval/run';
import { DEFAULT_TYPESAFE_MODEL } from './categorize/typesafe/client';
import { PACKAGE_ROOT } from './paths';
import fs from 'node:fs';
import path from 'node:path';

const HELP = `X Bookmarks Organizer

Usage:
  node dist/index.js [run]       Fetch new bookmarks, categorize, store (default)
  node dist/index.js login       One-time X OAuth login (opens a browser once)
  node dist/index.js recategorize  Rebuild the taxonomy and reassign ALL stored
                                   bookmarks from scratch (no re-fetch from X)
  node dist/index.js serve       Start the local web viewer. It can fetch and
                                 categorize on its own: the Sync button runs
                                 the same work as \`run\`, using the
                                 categorization settings saved in the app.
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
  node dist/index.js rank [--all] [--dry-run] [--limit N]
                                  Score stored bookmarks by learning value with
                                  the TypeSafe/Jev API and store the score, so
                                  the viewer can sort by it. PAID per token; it
                                  runs only when you invoke it, and only when
                                  TYPESAFE_API_KEY resolves (set
                                  XBOOKMARKS_RANKER=off to disable ranking
                                  entirely). --dry-run says how many would be
                                  scored without calling the API. Scores only
                                  what is missing, so it is resumable; --all
                                  re-scores everything.
  node dist/index.js clear-scores
                                  Delete every stored ranking score. No
                                  secrets, no network - just the DB.
  node dist/index.js eval-categorizers [--dry-run] [--limit N]
                                  Compare the two assignment-pass methods.
                                  Designs ONE fresh taxonomy, files every
                                  stored bookmark into it with BOTH the Claude
                                  and the TypeSafe/Jev categorizer, and writes
                                  a Markdown comparison report to data/eval/.
                                  Your library is never written to - not its
                                  categories, read state, favorites, summaries
                                  or scores. The Jev half is PAID per token and
                                  OFF unless XBOOKMARKS_EVAL_CATEGORIZERS=typesafe
                                  is set AND TYPESAFE_API_KEY resolves;
                                  --dry-run sizes the run without calling
                                  anything at all.
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
the local claude CLI). Each categorization pass can pick its own with
XBOOKMARKS_TAXONOMY_PROVIDER / XBOOKMARKS_ASSIGNMENT_PROVIDER. \`pi-ai\` runs a
pass on an Anthropic, OpenAI, xAI or OpenRouter model (model id
"<upstream>/<model>") PAID PER TOKEN to that upstream's API key, or on a local
OpenAI-compatible server (XBOOKMARKS_PIAI_BASE_URL). It is never the default,
refuses to run without the key, and every run prints each pass's billing first.
\`pi-claude-subscription\` is an OPT-IN route that runs your Claude subscription
(CLAUDE_CODE_OAUTH_TOKEN) through pi. Anthropic's Claude Code terms prohibit
that use and it puts your account at risk; claude-cli stays the default.

XBOOKMARKS_RANKER turns the optional ranking pass on (\`typesafe\`). It is the
only feature with no free implementation - it is PAID per token - so it is off by
default and the \`rank\` command refuses to run without both the opt-in and
TYPESAFE_API_KEY. XBOOKMARKS_RANKER_INTERESTS, when set, adds a relevance
question about what you say you care about.

XBOOKMARKS_EVAL_CATEGORIZERS turns the one-off categorizer COMPARISON on
(\`typesafe\`). Its Jev half is PAID per token, so - exactly like ranking - it is
off by default and \`eval-categorizers\` refuses without both the opt-in and
TYPESAFE_API_KEY. It only ever produces a report; nothing in the app starts it.

XBOOKMARKS_CATEGORIZER picks which implementation files bookmarks into the tree
(the assignment pass) - claude-cli (default) or typesafe. \`typesafe\` routes that
pass through the TypeSafe/Jev API, which is PAID PER TOKEN and needs
TYPESAFE_API_KEY; it refuses to run without one. The taxonomy-design pass always
stays on the LLM. Leave it unset and nothing costs money per call.

The same choice - plus the provider, models and effort - can be made in the
viewer's Settings panel instead, where it is saved in the database and reused by
every later sync. On the CLI an explicitly exported XBOOKMARKS_* variable still
overrides the saved choice; in the viewer the saved choice wins.
`;

/**
 * The env-shaped config with the owner's in-app categorization choice layered
 * under it (issue #71). `process.env` is passed, so an explicitly exported
 * XBOOKMARKS_* variable keeps overriding the saved setting on the CLI.
 */
function withStoredSettings(config: Config, db: Database): Config {
  const catalog = buildSettingsCatalog();
  return applySettingsToConfig(config, effectiveSettings(db, catalog), process.env);
}

async function cmdLogin(config: Config, db: Database): Promise<void> {
  requireXCredentials(config);
  await login(config, db);
  console.log('Logged in. Refresh token stored locally. Future runs are headless.');
}

async function cmdRun(baseConfig: Config, db: Database, store: CredentialStore): Promise<void> {
  // The choice made in the app is honored here too, so `run` and the viewer's
  // Sync button categorize identically - but an explicitly exported
  // XBOOKMARKS_* variable still wins on the CLI (see applySettingsToConfig).
  const config = withStoredSettings(baseConfig, db);
  requireXCredentials(config);
  const llm = createLlmFactory(config, process.env, store);
  await requireLlm(llm, ['taxonomy', 'assignment']);
  reportCategorizerBilling(config, llm, (msg) => console.log(msg));
  const client = await getAuthenticatedClient(config, db);
  const { taxonomer, categorizer } = buildCategorizers(config, llm, db, store, (msg) => console.log(msg));

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

async function cmdRecategorize(baseConfig: Config, db: Database, store: CredentialStore): Promise<void> {
  const config = withStoredSettings(baseConfig, db);
  const llm = createLlmFactory(config, process.env, store);
  await requireLlm(llm, ['taxonomy', 'assignment']);
  reportCategorizerBilling(config, llm, (msg) => console.log(msg));
  const { taxonomer, categorizer } = buildCategorizers(config, llm, db, store, (msg) => console.log(msg));

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

/**
 * Score stored bookmarks by learning value (issue #62).
 *
 * Paid-safe by construction: `buildRanker` refuses unless ranking was explicitly
 * turned on AND a key resolves, the billing line is printed before any call, and
 * `--dry-run` reports the size of a run while making no call at all. Ranking
 * touches only the score table - no bookmark, category or taxonomy row.
 */
async function cmdRank(config: Config, db: Database, store: CredentialStore): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const rescoreAll = process.argv.includes('--all');
  const limitArg = process.argv.indexOf('--limit');
  const parsedLimit = limitArg === -1 ? NaN : Number.parseInt(process.argv[limitArg + 1] ?? '', 10);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;

  const { scorer, rubric } = buildRanker(config, store, db);
  const options = {
    rubric,
    concurrency: config.ranker.concurrency,
    ...(rescoreAll ? { rescoreAll: true } : {}),
    ...(limit != null ? { limit } : {}),
  };

  if (dryRun) {
    const planned = planRanking(db, options);
    console.log(
      `Dry run: ${planned.length} bookmark(s) would be scored against rubric ${rubric.version} ` +
        `(${rubric.dimensions.length} question(s) each, one request per bookmark). No API call was made.`,
    );
    console.log(`${db.countScoredBookmarks()} of ${db.getBookmarkCount()} bookmark(s) already have a score.`);
    return;
  }

  reportRankerBilling(config, rubric, (msg) => console.log(msg));
  const summary = await rankBookmarks({ db, scorer, logger: (msg) => console.log(msg) }, options);
  console.log(
    `\nDone. ${summary.scored} of ${summary.candidates} bookmark(s) scored ` +
      `(${summary.skipped} had nothing to judge, ${summary.failed} failed); ` +
      `${summary.inputTokens} input token(s) billed.`,
  );
  if (summary.scored > 0) {
    console.log('Sort by score in the viewer\'s Settings panel, or pass ?sort=score to the bookmarks API.');
  }
}

/** Delete every stored ranking score - the way to abandon a rubric. Idempotent. */
async function cmdClearScores(db: Database): Promise<void> {
  const removed = db.clearBookmarkScores();
  console.log(`Removed ${removed} stored ranking score${removed === 1 ? '' : 's'}.`);
}

/**
 * Compare the two assignment-pass methods on one fixed tree.
 *
 * Paid-safe by construction, mirroring `rank`: `buildEvalJev` refuses unless
 * the comparison was explicitly turned on AND a key resolves (opt-in checked
 * FIRST), the billing line is printed before any call, and `--dry-run` sizes
 * the run while making no call at all - not even the free-but-slow taxonomy
 * pass. The library is never written to; the only output is the report file.
 *
 * There is deliberately no in-app trigger for this, for the same reason `rank`
 * has none: nothing that spends money per token gets a button.
 */
async function cmdEvalCategorizers(
  baseConfig: Config,
  db: Database,
  store: CredentialStore,
): Promise<void> {
  const config = withStoredSettings(baseConfig, db);
  const dryRun = process.argv.includes('--dry-run');
  const limitArg = process.argv.indexOf('--limit');
  const parsedLimit = limitArg === -1 ? NaN : Number.parseInt(process.argv[limitArg + 1] ?? '', 10);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;

  if (dryRun) {
    const plan = planCategorizerEval(db, { maxDepth: config.maxCategoryDepth, ...(limit != null ? { limit } : {}) });
    console.log(
      `Dry run: ${plan.bookmarks} of ${plan.libraryBookmarks} stored bookmark(s) would be filed ` +
        'TWICE - once by the Claude assignment pass (free, subscription time) and once by ' +
        `TypeSafe/Jev (${config.typesafe.model ?? DEFAULT_TYPESAFE_MODEL}, PAID per token).`,
    );
    console.log(
      `A fresh taxonomy would be designed first (your current tree has ${plan.liveTreeNodes} node(s), ` +
        'and would be left exactly as it is).',
    );
    console.log(
      `Jev side: at most ${plan.jevRequestsUpperBound} request(s) (one per tree level per bookmark), ` +
        `roughly ${plan.estimatedJevInputTokens} input token(s) - a floor, excluding per-level ` +
        'choice criteria and linked-article context.',
    );
    console.log('No API call was made, and no taxonomy was designed.');
    // A dry run deliberately needs no opt-in and no key: sizing the bill is how
    // an owner decides whether to opt in at all. The real run still refuses
    // without both.
    console.log(
      'To run it for real, set XBOOKMARKS_EVAL_CATEGORIZERS=typesafe and make TYPESAFE_API_KEY resolvable.',
    );
    return;
  }

  const llm = createLlmFactory(config, process.env, store);
  await requireLlm(llm, ['taxonomy', 'assignment']);
  // Refuses here if the comparison is not opted into, BEFORE the key is looked
  // at and before anything is constructed.
  const { asker, usage } = buildEvalJev(config, store, (msg) => console.log(msg));
  reportEvalBilling(config, llm, (msg) => console.log(msg));

  const assignment = llm.forRole('assignment');
  const taxonomyRole = llm.describe('taxonomy');
  const assignmentRole = llm.describe('assignment');
  const { report, markdown } = await runCategorizerEval(
    {
      db,
      taxonomer: buildTaxonomyDesigner(config, llm, (msg) => console.log(msg)),
      claude: new Categorizer(toRunner(assignment, { json: true }), {
        model: assignment.model,
        maxDepth: config.maxCategoryDepth,
      }),
      asker,
      usage,
      logger: (msg) => console.log(msg),
    },
    {
      batchSize: config.batchSize,
      maxDepth: config.maxCategoryDepth,
      walk: {
        beamWidth: config.typesafe.beamWidth,
        maxDepth: config.maxCategoryDepth,
        confidenceThreshold: config.typesafe.confidenceThreshold,
        multiLabelThreshold: config.typesafe.multiLabelThreshold,
        maxLabels: config.typesafe.maxLabels,
        concurrency: config.typesafe.concurrency,
      },
      ...(limit != null ? { limit } : {}),
      models: {
        taxonomyProvider: taxonomyRole.providerId,
        taxonomyModel: taxonomyRole.model,
        taxonomyEffort: config.llm.roles.taxonomy.params?.effort ?? 'default',
        claudeProvider: assignmentRole.providerId,
        claudeModel: assignmentRole.model,
        jevModel: config.typesafe.model ?? DEFAULT_TYPESAFE_MODEL,
      },
    },
  );

  const outDir = path.resolve(PACKAGE_ROOT, 'data', 'eval');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    `categorizer-eval-${report.meta.generatedAt.replace(/[:.]/g, '-')}.md`,
  );
  fs.writeFileSync(outPath, markdown, 'utf8');

  const { agreement } = report.comparison;
  console.log(
    `\nDone. ${agreement.bookmarks} bookmark(s) compared; ${agreement.samePrimaryLeaf} filed to the ` +
      `same exact leaf by both methods, ${report.comparison.disagreements.total} filed differently. ` +
      `Jev billed ${report.cost.jevInputTokens} input token(s) over ${report.cost.jevRequests} request(s).`,
  );
  console.log(`Report: ${outPath}`);
  console.log('Your library was not modified.');
}

async function cmdServe(baseConfig: Config, db: Database, store: CredentialStore): Promise<void> {
  // In the app, the owner's saved choice wins outright - no `process.env`
  // argument - so the panel never reads "Claude model" while a variable in the
  // launching shell quietly routes the run somewhere billable.
  const catalog = buildSettingsCatalog();
  const config = applySettingsToConfig(baseConfig, effectiveSettings(db, catalog));

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
  // The settings form's own claude-cli availability probe (issue #35): the
  // same `check()` above, but callable fresh per `/api/setup` read (cached
  // server-side) since the owner can pick claude-cli for either pass
  // independently of the summary role's provider.
  const providerConfig: ResolvedProviderConfig = { get: (key) => store.get(key).value };
  const app = await startServer(db, config.webPort, '127.0.0.1', {
    pageSize: config.pageSize,
    summaryGenerator,
    summaryUnavailableReason: available ? undefined : health.detail,
    claudeCliCheck: () => {
      const provider = getProvider(CLAUDE_CLI_PROVIDER_ID);
      return provider
        ? provider.check(providerConfig)
        : Promise.resolve({ state: 'unconfigured' as const, detail: `Unknown LLM provider "${CLAUDE_CLI_PROVIDER_ID}".` });
    },
    // The Sync button's work. `baseConfig` (not `config`) is handed over on
    // purpose: the job re-reads the settings on every run, so changing them in
    // the Settings panel takes effect without restarting the viewer.
    syncJob: createSyncJob({ db, store, config: baseConfig }),
    // The "Rank now" button's work (issue #80). `baseConfig` again, for the
    // same reason as the sync job - and because the ranker's opt-in and knobs
    // are deliberately NOT settings-panel choices: turning ranking on stays an
    // explicit server-side act, which is the first of its paid gates.
    ranking: createRankWiring({ db, store, config: baseConfig }),
    // The built-in preset's relevance question (issue #102 / `rubric.ts`), so
    // the viewer resolves the ACTIVE preset to the SAME version tag the runs it
    // starts will write under - otherwise a viewer started with interests set
    // would read a freshly-ranked library as unranked.
    rankerInterests: baseConfig.ranker.interests,
    credentials: store,
    dotenvExposure: () => dotenvExposure(),
    modelBrowser: createModelBrowser(),
    xLogin: async () => {
      const current = applySettingsToConfig(
        loadConfig(process.env, store),
        effectiveSettings(db, catalog),
      );
      requireXCredentials(current);
      await login(current, db);
    },
  });
  console.log(`Web viewer running at http://127.0.0.1:${config.webPort}`);
  if (available) {
    const { providerId, model, billing } = llm.describe('summary');
    console.log(`Summaries: ${providerId} / ${model} - ${billingLabel(billing)}`);
  } else {
    console.log(`Summaries disabled: ${health.detail}`);
  }
  // The viewer can start a sync itself now, so say how one would be billed
  // before the owner presses the button, not only once it is running.
  reportCategorizerBilling(config, llm, (msg) => console.log(`Sync: ${msg}`));
  // Same courtesy for the in-app ranking run: it is PAID per token, so say up
  // front whether the button can run at all, and never imply a free press.
  const rankBlocker = createRankWiring({ db, store, config: baseConfig }).blocker();
  console.log(
    rankBlocker
      ? `Ranking: "Rank now" is disabled - ${rankBlocker.split('\n')[0]}`
      : `Ranking: "Rank now" is available in the app - ${billingLabel('per-token')}, and every run is confirmed before it starts.`,
  );
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
      case 'rank':
        await cmdRank(config, db, store);
        break;
      case 'clear-scores':
        await cmdClearScores(db);
        break;
      case 'eval-categorizers':
        await cmdEvalCategorizers(config, db, store);
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
