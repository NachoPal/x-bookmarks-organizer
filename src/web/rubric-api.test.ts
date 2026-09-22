import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server';
import { Database } from '../db/database';
import { DEFAULT_PRESET_ID, presetRubric, validatePreset } from '../rank/presets';
import { readPresetDoc, writePresetDoc } from '../rank/preset-store';
import { buildRubric } from '../rank/rubric';
import { rankBookmarks } from '../rank/ranker';
import type { StateScorer } from '../rank/client';
import type { RankWiring } from './rank-job';
import type { RawBookmark } from '../types';

/**
 * The rubric editor's HTTP surface (issue #102), offline end to end.
 *
 * The claim these tests exist to hold: authoring, saving, selecting and
 * deleting ranking rules NEVER calls the paid API. The fake wiring below
 * counts every scoring attempt, and the editor tests assert that counter stays
 * at zero - so a future change that made a preset write "helpfully" re-rank
 * would fail here rather than on the owner's bill.
 */

const bm = (postId: string): RawBookmark => ({
  postId,
  authorUsername: 'a',
  authorName: 'A',
  text: `something worth learning about ${postId}`,
  url: `https://x.com/a/status/${postId}`,
  postCreatedAt: '',
});

const dimension = (over: Record<string, unknown> = {}) => ({
  id: 'signal',
  instructions: 'How much signal is in this post?',
  levels: ['None.', 'Some.', 'A lot.'],
  weight: 2,
  ...over,
});

const body = (over: Record<string, unknown> = {}) => ({
  name: 'Signal only',
  dimensions: [dimension()],
  ...over,
});

describe('the rubric preset API', () => {
  let db: Database;
  let app: FastifyInstance;
  /** Every paid scoring attempt the fake wiring was asked to make. */
  let runs: number;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.storeCategorizedBatch([bm('1'), bm('2')], () => []);
    runs = 0;
    const ranking: RankWiring = {
      job: async () => {
        runs++;
        return { candidates: 0, scored: 0, skipped: 0, failed: 0, inputTokens: 0 };
      },
      rankOne: async () => {
        runs++;
        return { candidates: 0, scored: 0, skipped: 0, failed: 0, inputTokens: 0 };
      },
      blocker: () => null,
      pending: () => 2,
    };
    app = buildServer(db, { ranking });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  const get = (url: string) => app.inject({ method: 'GET', url });
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload });
  const put = (url: string, payload: unknown) => app.inject({ method: 'PUT', url, payload });
  const del = (url: string) => app.inject({ method: 'DELETE', url });

  it('offers the built-in preset, active, on a library that has never seen the editor', async () => {
    const res = await get('/api/rubric');
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.activeId).toBe(DEFAULT_PRESET_ID);
    expect(json.presets).toHaveLength(1);
    expect(json.presets[0]).toMatchObject({
      id: DEFAULT_PRESET_ID,
      builtIn: true,
      version: buildRubric().version,
    });
    // The built-in rubric's own questions, so the editor can show them and
    // offer clone-to-edit rather than an empty form.
    expect(json.presets[0].dimensions.map((d: { id: string }) => d.id)).toContain('learning_value');
  });

  it('creates a preset, makes it active, and gives it its own version', async () => {
    const res = await post('/api/rubric/presets', body());
    expect(res.statusCode).toBe(201);
    const json = res.json();

    expect(json.rubric.presets).toHaveLength(2);
    const created = json.rubric.presets[1];
    expect(created.name).toBe('Signal only');
    expect(json.rubric.activeId).toBe(created.id);
    expect(created.version).not.toBe(buildRubric().version);
    // The active preset is what the ranking state now reports.
    expect(json.ranking.preset).toMatchObject({ id: created.id, version: created.version });
    // And it is durable, readable by the process that would do the spending.
    expect(readPresetDoc(db).activeId).toBe(created.id);
    expect(runs).toBe(0);
  });

  it('spends nothing on any editor action', async () => {
    const created = (await post('/api/rubric/presets', body())).json().rubric.presets[1];
    await put(`/api/rubric/presets/${created.id}`, body({ dimensions: [dimension({ weight: 5 })] }));
    await put('/api/rubric/active', { id: DEFAULT_PRESET_ID });
    await put('/api/rubric/active', { id: created.id });
    await del(`/api/rubric/presets/${created.id}`);
    // Four writes and a delete, and not one call to the paid API: only
    // POST /api/rank and POST /api/bookmarks/:id/rank ever spend.
    expect(runs).toBe(0);
  });

  it('refuses an invalid rubric with one actionable sentence per problem', async () => {
    const res = await post('/api/rubric/presets', body({ dimensions: [dimension({ levels: ['one'] })] }));
    expect(res.statusCode).toBe(400);
    expect(res.json().errors.join(' ')).toMatch(/at least 2 levels/i);
    expect(readPresetDoc(db).presets).toHaveLength(0);

    const unnamed = await post('/api/rubric/presets', body({ name: '' }));
    expect(unnamed.statusCode).toBe(400);
    const empty = await post('/api/rubric/presets', body({ dimensions: [] }));
    expect(empty.statusCode).toBe(400);
  });

  it('refuses a name another preset already holds, but not a preset keeping its own', async () => {
    const created = (await post('/api/rubric/presets', body())).json().rubric.presets[1];
    expect((await post('/api/rubric/presets', body())).statusCode).toBe(400);
    // Re-saving the same preset under its own name is not a collision.
    const same = await put(`/api/rubric/presets/${created.id}`, body({ dimensions: [dimension({ weight: 4 })] }));
    expect(same.statusCode).toBe(200);
    expect(same.json().rubric.presets[1].dimensions[0].weight).toBe(4);
  });

  it('will not edit or delete the built-in preset', async () => {
    expect((await put(`/api/rubric/presets/${DEFAULT_PRESET_ID}`, body())).statusCode).toBe(404);
    const removed = await del(`/api/rubric/presets/${DEFAULT_PRESET_ID}`);
    expect(removed.statusCode).toBe(400);
    expect(removed.json().error).toMatch(/cannot be deleted/i);
    expect((await get('/api/rubric')).json().presets).toHaveLength(1);
  });

  it('falls back to the built-in preset when the active one is deleted', async () => {
    const created = (await post('/api/rubric/presets', body())).json().rubric.presets[1];
    const res = await del(`/api/rubric/presets/${created.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().rubric.activeId).toBe(DEFAULT_PRESET_ID);
    expect(res.json().ranking.preset.version).toBe(buildRubric().version);
  });

  it('404s on a preset that is gone, for both the update and the selection', async () => {
    expect((await put('/api/rubric/presets/nope', body())).statusCode).toBe(404);
    expect((await del('/api/rubric/presets/nope')).statusCode).toBe(404);
    expect((await put('/api/rubric/active', { id: 'nope' })).statusCode).toBe(404);
    expect((await put('/api/rubric/active', {})).statusCode).toBe(400);
  });

  it('is live on a viewer with no ranking wiring at all', async () => {
    // Authoring rules is free, so a viewer that cannot RUN a paid pass can
    // still hold an opinion about what one would ask.
    const bare = buildServer(db);
    await bare.ready();
    try {
      expect((await bare.inject({ method: 'GET', url: '/api/rubric' })).statusCode).toBe(200);
      const created = await bare.inject({ method: 'POST', url: '/api/rubric/presets', payload: body() });
      expect(created.statusCode).toBe(201);
    } finally {
      await bare.close();
    }
  });
});

describe('the active preset decides which scores are current', () => {
  let db: Database;
  let app: FastifyInstance;
  let categoryId: number;

  /** A scorer that answers every question at its top level. No network. */
  const scorer: StateScorer = {
    score: async (_state, rubric) => ({
      answers: new Map(
        rubric.dimensions.map((d) => [d.id, { score: d.levels.length - 1, confidence: 0.9 }]),
      ),
      model: 'fake',
      inputTokens: 1,
    }),
  };

  const signalPreset = {
    ...validatePreset(
      { name: 'Signal only', dimensions: [dimension()] },
      [],
    ).preset,
    id: 'signal',
  };

  beforeEach(async () => {
    db = new Database(':memory:');
    categoryId = db.getOrCreateCategory('Tech', null, '2026-01-01T00:00:00.000Z').id;
    db.storeCategorizedBatch([bm('1'), bm('2')], () => [categoryId]);
    // Rank the whole library under the BUILT-IN preset only.
    await rankBookmarks({ db, scorer }, { rubric: buildRubric() });
    app = buildServer(db);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  const setup = async () => (await app.inject({ method: 'GET', url: '/api/setup' })).json();
  const list = async () =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/categories/${categoryId}/bookmarks?sort=score`,
      })
    ).json();

  it('reports the library as fully ranked under the preset it was ranked with', async () => {
    const state = await setup();
    expect(state.ranking).toMatchObject({ scored: 2, total: 2 });
    expect(state.ranking.preset.version).toBe(buildRubric().version);
    expect((await list()).bookmarks.every((b: { score: unknown }) => b.score !== null)).toBe(true);
  });

  it('reads as UNRANKED under a preset nothing has been scored with, and spends nothing to say so', async () => {
    writePresetDoc(db, { activeId: 'signal', presets: [signalPreset] });

    const state = await setup();
    // Same library, same rows - a different question, so no verdict yet. This
    // is what raises the #98 dot and offers a re-rank; it is a pure read.
    expect(state.ranking).toMatchObject({ scored: 0, total: 2 });
    expect(state.ranking.preset.version).toBe(presetRubric(signalPreset).version);
    expect((await list()).bookmarks.every((b: { score: unknown }) => b.score === null)).toBe(true);
  });

  it('keeps each preset\'s scores and shows them again instantly on the way back', async () => {
    writePresetDoc(db, { activeId: 'signal', presets: [signalPreset] });
    await rankBookmarks({ db, scorer }, { rubric: presetRubric(signalPreset) });
    expect((await setup()).ranking.scored).toBe(2);

    // Back to the built-in preset: the original verdicts are still there. No
    // run, no confirmation, no bill - which is the whole point of keying
    // scores by rubric version rather than wiping them on a switch.
    writePresetDoc(db, { activeId: DEFAULT_PRESET_ID, presets: [signalPreset] });
    const state = await setup();
    expect(state.ranking).toMatchObject({ scored: 2, total: 2 });
    expect((await list()).bookmarks.every((b: { score: unknown }) => b.score !== null)).toBe(true);
  });

  it('re-ranks only what the newly active preset is missing', async () => {
    // One bookmark arrives after the first run; selecting a preset then
    // re-ranking pays for exactly what has no verdict under those rules.
    writePresetDoc(db, { activeId: 'signal', presets: [signalPreset] });
    const rubric = presetRubric(signalPreset);
    const first = await rankBookmarks({ db, scorer }, { rubric });
    expect(first.scored).toBe(2);

    const second = await rankBookmarks({ db, scorer }, { rubric });
    expect(second.candidates).toBe(0);

    db.storeCategorizedBatch([bm('3')], () => [categoryId]);
    const third = await rankBookmarks({ db, scorer }, { rubric });
    expect(third.scored).toBe(1);
  });
});
