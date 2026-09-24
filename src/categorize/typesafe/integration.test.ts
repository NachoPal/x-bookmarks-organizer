import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../db/database';
import { runIngest } from '../../ingest';
import { materializeTaxonomy } from '../tree';
import type { RawBookmark, TaxonomyNode } from '../../types';
import type { XClient } from '../../x/client';
import { TypeSafeCategorizer } from './categorizer';
import { TypeSafeLevelAsker } from './client';

/**
 * End-to-end through the REAL ingestion loop, the REAL SDK and a REAL HTTP
 * server standing in for the TypeSafe API - the same "spin up a local server
 * rather than mock fetch" discipline `HttpArticleFetcher`'s tests use.
 *
 * It is the proof of the design's central claim: `src/ingest.ts` cannot tell
 * which categorizer it was handed. No network leaves the machine, no API key
 * is real, and nothing is billable.
 */

const WHEN = '2024-01-01T00:00:00.000Z';

const TAXONOMY: TaxonomyNode[] = [
  {
    name: 'AI',
    description: 'Machine learning and tooling.',
    children: [
      { name: 'Harnesses', description: 'Agent harnesses.', children: [] },
      { name: 'Research', description: 'Papers.', children: [] },
    ],
  },
  { name: 'Cooking', description: 'Food.', children: [{ name: 'Baking', children: [] }] },
];

function bookmark(postId: string, text: string): RawBookmark {
  return {
    postId,
    authorUsername: 'alice',
    authorName: 'Alice',
    text,
    url: `https://x.com/alice/status/${postId}`,
    postCreatedAt: WHEN,
  };
}

/** An X client that serves one fixed page and never touches the network. */
function fakeXClient(bookmarks: RawBookmark[]): XClient {
  return {
    async fetchBookmarksPage() {
      return { bookmarks, nextToken: undefined };
    },
  } as unknown as XClient;
}

/**
 * A stand-in TypeSafe API. Answers each `Choice` by putting the mass on
 * whichever offered label appears in `prefer`, so a test can steer the walk
 * while still exercising the real SDK's request/response handling.
 */
async function startStubTypeSafe(prefer: string[]): Promise<{
  baseUrl: string;
  requests: { state: unknown; questions: Record<string, { criteria: Record<string, unknown> }> }[];
  close: () => Promise<void>;
}> {
  const requests: { state: unknown; questions: Record<string, { criteria: Record<string, unknown> }> }[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);

      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries(
        body.questions as Record<string, { criteria: Record<string, unknown> }>,
      )) {
        const labels = Object.keys(question.criteria);
        const hit = labels.find((l) => prefer.includes(l));
        const probabilities: Record<string, number> = {};
        for (const label of labels) probabilities[label] = label === hit ? 0.95 : 0.02;
        answers[key] = {
          type: 'choice',
          choice: hit ?? labels[0],
          confidence: hit ? 0.95 : 0.1,
          probabilities,
        };
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 0 } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('TypeSafe categorizer through the real ingestion loop', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    materializeTaxonomy(db, TAXONOMY, 4, WHEN);
  });
  afterEach(() => {
    db.close();
  });

  it('ingests and files bookmarks into real categories over HTTP', async () => {
    const stub = await startStubTypeSafe(['AI', 'Harnesses']);
    try {
      const categorizer = new TypeSafeCategorizer(
        {
          db,
          asker: new TypeSafeLevelAsker({ apiKey: 'not-a-real-key', baseURL: stub.baseUrl }),
        },
        { maxDepth: 4 },
      );

      const summary = await runIngest({
        db,
        client: fakeXClient([bookmark('1', 'a post about agent harnesses')]),
        // Pass 1 grows the tree first; the existing tree already fits.
        taxonomer: {
          async designTaxonomy() {
            return [];
          },
        },
        categorizer,
        batchSize: 15,
        maxDepth: 4,
        articleFetcher: { async fetch() { return { ok: false, reason: 'offline test' }; } } as never,
      });

      expect(summary.newBookmarks).toBe(1);

      // The bookmark is linked to the REAL "Harnesses" node, not a new one.
      const harnesses = db.findCategory('Harnesses', db.findCategory('AI', null)!.id)!;
      const rows = db.getDirectMembership().get(harnesses.id) ?? [];
      expect(rows).toHaveLength(1);
      // No node was invented.
      expect(db.getAllCategories()).toHaveLength(5);
    } finally {
      await stub.close();
    }
  });

  it('files a novel topic into the category pass 1 added for it on the same sync', async () => {
    const stub = await startStubTypeSafe(['Gardening', 'Tomatoes']);
    const modes: (string | undefined)[] = [];
    try {
      const categorizer = new TypeSafeCategorizer(
        { db, asker: new TypeSafeLevelAsker({ apiKey: 'not-a-real-key', baseURL: stub.baseUrl }) },
        { maxDepth: 4 },
      );

      await runIngest({
        db,
        client: fakeXClient([bookmark('1', 'growing tomatoes on a balcony')]),
        taxonomer: {
          async designTaxonomy(_bookmarks, _tree, _context, mode) {
            modes.push(mode);
            return [
              { name: 'Gardening', description: 'Growing plants.', children: [{ name: 'Tomatoes', children: [] }] },
            ];
          },
        },
        categorizer,
        batchSize: 15,
        maxDepth: 4,
        articleFetcher: { async fetch() { return { ok: false, reason: 'offline test' }; } } as never,
      });

      expect(modes).toEqual(['incremental']);
      // Jev saw pass 1's new category among the roots it was offered...
      const rootCriteria = Object.values(stub.requests[0]!.questions)[0]!.criteria;
      expect(rootCriteria).toMatchObject({ Gardening: 'Growing plants.' });
      // ...and filed the bookmark into it.
      const tomatoes = db.findCategory('Tomatoes', db.findCategory('Gardening', null)!.id)!;
      expect(db.getBookmarksForCategory(tomatoes.id).map((b) => b.postId)).toEqual(['1']);
      expect(db.getAllCategories()).toHaveLength(7);
    } finally {
      await stub.close();
    }
  });

  it('sends the taxonomy descriptions to the API as Choice criteria', async () => {
    const stub = await startStubTypeSafe(['AI', 'Harnesses']);
    try {
      const categorizer = new TypeSafeCategorizer(
        { db, asker: new TypeSafeLevelAsker({ apiKey: 'not-a-real-key', baseURL: stub.baseUrl }) },
        { maxDepth: 4 },
      );

      await categorizer.categorizeBatch([bookmark('1', 'agents')], '');

      const rootRequest = stub.requests[0]!;
      const criteria = Object.values(rootRequest.questions)[0]!.criteria;
      expect(criteria).toMatchObject({
        AI: 'Machine learning and tooling.',
        Cooking: 'Food.',
      });
    } finally {
      await stub.close();
    }
  });

  it('falls back to Uncategorized (never an invented node) when nothing fits', async () => {
    // Nothing the stub is willing to pick: every level comes back unconfident.
    const stub = await startStubTypeSafe([]);
    try {
      const categorizer = new TypeSafeCategorizer(
        { db, asker: new TypeSafeLevelAsker({ apiKey: 'not-a-real-key', baseURL: stub.baseUrl }) },
        { maxDepth: 4 },
      );

      const assignments = await categorizer.categorizeBatch([bookmark('1', 'unrelated')], '');

      expect(assignments).toEqual([]);
      expect(db.getAllCategories()).toHaveLength(5);
    } finally {
      await stub.close();
    }
  });
});
