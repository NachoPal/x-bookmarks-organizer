import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../db/database';
import {
  activePreset,
  listPresets,
  readPresetDoc,
  resolveActiveRubric,
  RUBRIC_PRESETS_KEY,
  writePresetDoc,
} from './preset-store';
import { DEFAULT_PRESET_ID, presetRubric, validatePreset, type RubricPreset } from './presets';
import { buildRubric } from './rubric';

/**
 * Preset persistence (issue #102). Everything here is a `run_state` read or
 * write - free, offline, and never a call to the paid API.
 */

const custom = (name: string, id: string, weight = 2): RubricPreset => ({
  ...validatePreset(
    {
      name,
      dimensions: [
        {
          id: 'signal',
          instructions: 'How much signal is in this post?',
          levels: ['None.', 'Some.', 'A lot.'],
          weight,
        },
      ],
    },
    [],
  ).preset,
  id,
});

describe('rubric preset store', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => db.close());

  it('starts with only the built-in preset, active', () => {
    expect(listPresets(db).map((p) => p.id)).toEqual([DEFAULT_PRESET_ID]);
    expect(activePreset(db).builtIn).toBe(true);
    expect(resolveActiveRubric(db).version).toBe(buildRubric().version);
  });

  it('round-trips saved presets and the active choice', () => {
    const a = custom('Signal', 'signal');
    writePresetDoc(db, { activeId: 'signal', presets: [a] });

    const doc = readPresetDoc(db);
    expect(doc.activeId).toBe('signal');
    expect(doc.presets).toEqual([a]);
    // The built-in one is synthesized, never stored, so it is always offered
    // and always first.
    expect(listPresets(db).map((p) => p.id)).toEqual([DEFAULT_PRESET_ID, 'signal']);
    expect(resolveActiveRubric(db).version).toBe(presetRubric(a).version);
  });

  it('survives a reopen of the same database file', () => {
    // Durability is the reason this lives in `run_state` rather than in the
    // browser: the process that SPENDS has to be able to read the choice, and
    // it has to still be there after a restart.
    const file = path.join(os.tmpdir(), `xbo-presets-${Date.now()}-${Math.random()}.db`);
    const a = custom('Signal', 'signal');
    const first = new Database(file);
    try {
      writePresetDoc(first, { activeId: 'signal', presets: [a] });
    } finally {
      first.close();
    }

    const second = new Database(file);
    try {
      expect(readPresetDoc(second).activeId).toBe('signal');
      expect(resolveActiveRubric(second).version).toBe(presetRubric(a).version);
    } finally {
      second.close();
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
  });

  it('falls back to the built-in preset when the active one is gone', () => {
    writePresetDoc(db, { activeId: 'vanished', presets: [] });
    expect(activePreset(db).id).toBe(DEFAULT_PRESET_ID);
    expect(resolveActiveRubric(db).version).toBe(buildRubric().version);
  });

  it('degrades to the built-in preset on a corrupt or hand-edited document', () => {
    db.setState(RUBRIC_PRESETS_KEY, 'not json at all');
    expect(listPresets(db).map((p) => p.id)).toEqual([DEFAULT_PRESET_ID]);

    // A single unreadable entry is DROPPED; the readable ones survive.
    db.setState(
      RUBRIC_PRESETS_KEY,
      JSON.stringify({ activeId: 'signal', presets: [{ id: 'broken' }, custom('Signal', 'signal')] }),
    );
    expect(listPresets(db).map((p) => p.id)).toEqual([DEFAULT_PRESET_ID, 'signal']);
  });

  it('never lets a stored entry shadow the built-in preset', () => {
    db.setState(
      RUBRIC_PRESETS_KEY,
      JSON.stringify({ activeId: DEFAULT_PRESET_ID, presets: [custom('Fake', DEFAULT_PRESET_ID)] }),
    );
    const presets = listPresets(db);
    expect(presets).toHaveLength(1);
    expect(presets[0]!.builtIn).toBe(true);
  });

  it('keeps each preset on its own version, so two presets never share a scale', () => {
    const a = custom('Signal', 'signal', 2);
    const b = custom('Signal heavy', 'signal_heavy', 5);
    writePresetDoc(db, { activeId: 'signal', presets: [a, b] });
    expect(resolveActiveRubric(db).version).toBe(presetRubric(a).version);

    writePresetDoc(db, { activeId: 'signal_heavy', presets: [a, b] });
    expect(resolveActiveRubric(db).version).toBe(presetRubric(b).version);
    expect(presetRubric(a).version).not.toBe(presetRubric(b).version);
  });

  it('follows XBOOKMARKS_RANKER_INTERESTS for the built-in preset only', () => {
    // The built-in rubric gains a relevance question from the environment; a
    // custom preset shows every question it asks in the editor, so nothing is
    // appended to it behind the owner's back.
    expect(activePreset(db, 'rust').dimensions.map((d) => d.id)).toContain('relevance');

    const a = custom('Signal', 'signal');
    writePresetDoc(db, { activeId: 'signal', presets: [a] });
    expect(activePreset(db, 'rust').dimensions.map((d) => d.id)).toEqual(['signal']);
    expect(resolveActiveRubric(db, 'rust').version).toBe(presetRubric(a).version);
  });
});
