'use strict';

/**
 * Dev-only seed: populate a local SQLite DB with a representative, deeply nested
 * category tree and a spread of sample bookmarks so the web viewer renders
 * realistically WITHOUT the owner's private data.
 *
 * Never run against real data - it targets a throwaway DB path (default
 * data/dev-seed.db, gitignored). Usage:
 *   node scripts/seed-dev-db.js [dbPath]
 *
 * Requires a prior `npm run build` (it uses the compiled Database wrapper).
 */
const path = require('node:path');
const fs = require('node:fs');
const { Database } = require('../dist/db/database');

const dbPath = path.resolve(process.argv[2] || path.join(process.cwd(), 'data', 'dev-seed.db'));
// Start clean so re-seeding is deterministic.
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  try {
    fs.rmSync(f);
  } catch {
    /* not present */
  }
}

const db = new Database(dbPath);
const now = new Date().toISOString();

// A category id cache keyed by full path so we can build the tree top-down.
const idByPath = new Map();
function ensurePath(segments) {
  let parentId = null;
  let key = '';
  for (const name of segments) {
    key = key ? `${key} › ${name}` : name;
    if (!idByPath.has(key)) {
      const node = db.getOrCreateCategory(name, parentId, now);
      idByPath.set(key, node.id);
    }
    parentId = idByPath.get(key);
  }
  return parentId;
}

// A deliberately deep (4-level) taxonomy with long titles to stress the layout.
const TAXONOMY = {
  'Software Engineering': {
    'Programming Languages': {
      'TypeScript & JavaScript': {},
      'Rust Systems Programming': {},
      'Python for Data & Scripting': {},
    },
    'Distributed Systems': {
      'Consensus & Replication Protocols': {},
      'Event-Driven Architecture': {},
    },
    'Developer Tooling & Productivity': {
      'Editors, IDEs & Terminal Setups': {},
      'CI/CD & Build Pipelines': {},
    },
  },
  'Artificial Intelligence & Machine Learning': {
    'Large Language Models': {
      'Prompt Engineering & Evaluation': {},
      'Agentic Workflows & Tool Use': {},
      'Fine-Tuning & Model Alignment': {},
    },
    'Computer Vision': {
      'Image Generation & Diffusion Models': {},
    },
  },
  'Design & Product': {
    'User Interface & Interaction Design': {
      'Design Systems & Component Libraries': {},
      'Typography & Visual Hierarchy': {},
    },
    'Product Strategy': {},
  },
  'Personal Finance & Investing': {
    'Long-Term Investing Principles': {},
    'Startups & Venture Capital': {},
  },
};

function buildTree(obj, prefix) {
  for (const [name, children] of Object.entries(obj)) {
    const segments = [...prefix, name];
    ensurePath(segments);
    if (children && Object.keys(children).length > 0) buildTree(children, segments);
  }
}
buildTree(TAXONOMY, []);

// A pool of sample authors and post templates. A few use real, long-lived public
// post ids so the official embed can render; the rest use synthetic ids that
// exercise the text+link fallback (deleted/protected-post path).
const AUTHORS = [
  ['Sindre Sorhus', 'sindresorhus'],
  ['Dan Abramov', 'dan_abramov'],
  ['Kelsey Hightower', 'kelseyhightower'],
  ['Andrej Karpathy', 'karpathy'],
  ['Sarah Drasner', 'sarah_edo'],
  ['Guillermo Rauch', 'rauchg'],
  ['Amjad Masad', 'amasad'],
  ['Rich Harris', 'Rich_Harris'],
  ['Addy Osmani', 'addyosmani'],
  ['Julia Evans', 'b0rk'],
];

const TEXTS = [
  'A short note. Nothing to see here.',
  'Just shipped a refactor that removed 400 lines and made the whole module easier to reason about. Deleting code is the best feeling in software.',
  'Reminder that the fastest way to learn a new codebase is to fix a real bug in it, end to end, the way a user would hit it. Reading alone never sticks the same way.',
  'Hot take: most "microservice" pain is really just a distributed monolith with a network in the middle. Get the boundaries right first, split later.',
  'The best prompt engineering advice I can give: write the eval before you write the prompt. If you cannot measure it, you are just vibing.\n\nMeasure, then iterate.',
  'Spent the afternoon reading through the source of a tool I use every day. Highly recommend it - you learn so much about API design by seeing the seams.',
  'Design systems are not about components. They are about decisions made once so nobody has to re-litigate padding in every PR forever.',
  'If your CI takes longer than it takes to get a coffee, people stop trusting it and start merging around it. Fast feedback is a feature.',
  'Long-term investing is mostly about surviving long enough for compounding to do its thing. The hard part is the temperament, not the math.',
  'Reader view / offline reading is criminally underrated. Half my bookmarks are articles I will "read later" and never open because the tab died.',
];

// Real, public, long-lived post ids (used for a handful of cards so a live embed
// appears when the network allows; synthetic ids elsewhere hit the fallback).
const REAL_POST_IDS = ['20', '1274809214651805696'];

const leafPaths = [...idByPath.keys()].filter((key) => {
  // A path is a leaf if no other key extends it.
  return ![...idByPath.keys()].some((k) => k !== key && k.startsWith(`${key} › `));
});

let seq = 0;
function makeBookmark(leafKey) {
  const [name, username] = AUTHORS[seq % AUTHORS.length];
  const text = TEXTS[seq % TEXTS.length];
  const useReal = seq % 7 === 0 && REAL_POST_IDS[seq % REAL_POST_IDS.length];
  const postId = useReal ? REAL_POST_IDS[seq % REAL_POST_IDS.length] : `900000000000000${String(1000 + seq)}`;
  const daysAgo = (seq * 3) % 120;
  const created = new Date(Date.now() - daysAgo * 864e5).toISOString();
  seq += 1;
  return {
    raw: {
      postId,
      authorUsername: username,
      authorName: name,
      text,
      url: `https://x.com/${username}/status/${postId}`,
      postCreatedAt: created,
    },
    leafId: idByPath.get(leafKey),
  };
}

// Give every leaf a few bookmarks, with a couple of leaves left empty on purpose
// so the empty-state renders too.
let leafIndex = 0;
for (const leafKey of leafPaths) {
  leafIndex += 1;
  if (leafIndex % 6 === 0) continue; // leave some categories empty
  const count = 2 + (leafIndex % 4); // 2..5 bookmarks
  const items = [];
  const links = [];
  for (let i = 0; i < count; i += 1) {
    const { raw, leafId } = makeBookmark(leafKey);
    items.push(raw);
    links.push(leafId);
  }
  db.storeCategorizedBatch(items, (bm) => {
    const idx = items.indexOf(bm);
    return [links[idx]];
  });
}

// Give one leaf a large batch so the viewer's lazy-load / infinite-scroll path
// (batches of 20) is exercisable in dev - mirrors a real, busy category like
// "Agentic Workflows & Tool Use".
const denseKey =
  'Artificial Intelligence & Machine Learning › Large Language Models › Agentic Workflows & Tool Use';
if (idByPath.has(denseKey)) {
  const denseCount = 47; // comfortably more than two batches of 20
  const denseItems = [];
  const denseLinks = [];
  for (let i = 0; i < denseCount; i += 1) {
    const { raw, leafId } = makeBookmark(denseKey);
    denseItems.push(raw);
    denseLinks.push(leafId);
  }
  db.storeCategorizedBatch(denseItems, (bm) => {
    const idx = denseItems.indexOf(bm);
    return [denseLinks[idx]];
  });
}

// A few bookmarks that exercise the reader view AND the underlying link
// metadata cache (issues #25/#26/#45) end to end: one links to a fixture
// article served locally by this same viewer (so "Read article" can fetch
// and extract it fully offline), one to a domain reserved by RFC 2606 to
// never resolve (so it correctly gets no "Read article" control), one has
// only a title cached (no description/image) to exercise the sparse-metadata
// case, and one is a card-only page (a tool, with OpenGraph tags but no
// readable body - the common real-world case) which must NOT get a "Read
// article" control (the viewer no longer renders a separate preview card -
// issue #46 - since the tweet embed already shows its own card for these
// links).
const readerDemoParent = ensurePath(['Reader View Demo']);
const webPort = process.env.XBOOKMARKS_WEB_PORT || '5173';
const fixtureArticleUrl = `http://127.0.0.1:${webPort}/fixtures/sample-article.html`;
const deadLinkUrl = 'https://reader-view-demo-dead-link.invalid/article';
const sparseLinkUrl = 'https://reader-view-demo-sparse.invalid/article';
// A bare-link post - the whole text is a URL, nothing else - whose link never
// resolves to a readable article. There is genuinely nothing to summarize, so
// Summarize must say so cleanly rather than ask the model to open a URL it has
// no tools to fetch (the refusal fixed in the summary path).
const bareLinkUrl = 'https://reader-view-demo-bare-link.invalid/video';
// A page with a preview card but no readable body (issue #45): card renders,
// reader affordance does not, and Summarize works off the card.
const cardOnlyUrl = 'https://reader-view-demo-tool.invalid/pricing';
db.storeCategorizedBatch(
  [
    {
      postId: '900000000000090001',
      authorUsername: 'sindresorhus',
      authorName: 'Sindre Sorhus',
      text: `Good piece on reader views done right: ${fixtureArticleUrl}`,
      url: `https://x.com/sindresorhus/status/900000000000090001`,
      postCreatedAt: new Date().toISOString(),
    },
    {
      postId: '900000000000090002',
      authorUsername: 'karpathy',
      authorName: 'Andrej Karpathy',
      text: `Interesting writeup here: ${deadLinkUrl}`,
      url: `https://x.com/karpathy/status/900000000000090002`,
      postCreatedAt: new Date().toISOString(),
    },
    {
      postId: '900000000000090003',
      authorUsername: 'addyosmani',
      authorName: 'Addy Osmani',
      text: `Only a title came back for this one: ${sparseLinkUrl}`,
      url: `https://x.com/addyosmani/status/900000000000090003`,
      postCreatedAt: new Date().toISOString(),
    },
    {
      postId: '900000000000090004',
      authorUsername: 'dan_abramov',
      authorName: 'Dan Abramov',
      text: bareLinkUrl,
      url: `https://x.com/dan_abramov/status/900000000000090004`,
      postCreatedAt: new Date().toISOString(),
    },
    {
      postId: '900000000000090005',
      authorUsername: 'swyx',
      authorName: 'swyx',
      text: `Shipping fast with this one: ${cardOnlyUrl}`,
      url: `https://x.com/swyx/status/900000000000090005`,
      postCreatedAt: new Date().toISOString(),
    },
  ],
  () => [readerDemoParent],
);

// Populate the URL-keyed metadata cache directly (bypassing any real fetch),
// mirroring what a real ingest run's buildArticleContext would have cached,
// so the gated "Read article" control renders deterministically and fully
// offline:
//  - the fixture link runs through the REAL extractArticle against the
//    fixture file on disk, so its cached metadata is exactly what the
//    running viewer's own reader fetch would produce for the same URL;
//  - the dead link is cached as a confirmed failure (never an article);
//  - the sparse link is cached as a confirmed article with only a title;
//  - the tool link is cached as `card`: a card, no readable body.
const { extractArticle } = require('../dist/articles/fetch-article');
const fixtureHtml = fs.readFileSync(
  path.join(__dirname, '../src/web/public/fixtures/sample-article.html'),
  'utf-8',
);
const fixtureExtraction = extractArticle(fixtureHtml, fixtureArticleUrl);
if (fixtureExtraction.status === 'ok') {
  db.saveArticleLinkMetadata({
    url: fixtureArticleUrl,
    status: 'ok',
    title: fixtureExtraction.preview?.title || fixtureExtraction.title,
    description: fixtureExtraction.preview?.description || fixtureExtraction.excerpt,
    image: fixtureExtraction.preview?.image ?? null,
    siteName: fixtureExtraction.preview?.siteName || fixtureExtraction.siteName,
    resolvedUrl: fixtureArticleUrl,
    fetchedAt: new Date().toISOString(),
  });
}
db.saveArticleLinkMetadata({
  url: bareLinkUrl,
  status: 'failed',
  title: null,
  description: null,
  image: null,
  siteName: null,
  resolvedUrl: null,
  fetchedAt: new Date().toISOString(),
});
db.saveArticleLinkMetadata({
  url: deadLinkUrl,
  status: 'failed',
  title: null,
  description: null,
  image: null,
  siteName: null,
  resolvedUrl: null,
  fetchedAt: new Date().toISOString(),
});
db.saveArticleLinkMetadata({
  url: sparseLinkUrl,
  status: 'ok',
  title: 'A Title With No Description or Image',
  description: null,
  image: null,
  siteName: null,
  resolvedUrl: sparseLinkUrl,
  fetchedAt: new Date().toISOString(),
});
db.saveArticleLinkMetadata({
  url: cardOnlyUrl,
  status: 'card',
  title: 'Executor - the gateway to connect your agent to everything',
  description: 'One place every agent plugs into every tool you already use. No readable article body here, just a card.',
  image: null,
  siteName: 'Executor',
  resolvedUrl: cardOnlyUrl,
  fetchedAt: new Date().toISOString(),
});

// Mark a spread of bookmarks read so read/unread states both render.
const all = db.getAllBookmarks();
all.forEach((bm, i) => {
  if (i % 3 === 0) db.markRead(bm.id, new Date(Date.now() - (i % 30) * 864e5).toISOString());
});

console.log(`Seeded ${all.length} bookmarks across ${idByPath.size} categories -> ${dbPath}`);
db.close();
