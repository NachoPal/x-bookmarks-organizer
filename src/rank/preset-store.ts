/**
 * Where the owner's rubric presets live (issue #102).
 *
 * `run_state`, the same durable key/value table `app_settings` (issue #71), the
 * sync cursor and `root_order` (issue #82) use, and for the same reason: a
 * choice that decides what a PAID run scores against has to survive a restart
 * and be readable by the process doing the spending, which `localStorage` is
 * neither. One JSON document under {@link RUBRIC_PRESETS_KEY} holds the custom
 * presets and which one is active.
 *
 * The built-in preset is SYNTHESIZED, never stored. That is what makes it
 * impossible to lose, keeps it following `XBOOKMARKS_RANKER_INTERESTS` the way
 * it always has, and means a fresh install with no document at all already has
 * a complete, correct answer to "what does a run score against".
 *
 * Every read here is free - no API call, no spend - which is what lets the
 * viewer poll the ranking state and the dialog name a run's scope before the
 * owner authorizes the bill.
 */
import type { Database } from '../db/database';
import {
  builtInPreset,
  DEFAULT_PRESET_ID,
  parseStoredPreset,
  presetRubric,
  type RubricPreset,
} from './presets';
import type { Rubric } from './rubric';

/** `run_state` key holding the presets document. */
export const RUBRIC_PRESETS_KEY = 'rubric_presets';

/** The stored document: custom presets, plus which preset ranks. */
export interface PresetDoc {
  /** The active preset's id. {@link DEFAULT_PRESET_ID} when none was chosen. */
  activeId: string;
  /** Custom presets only, in the order the selector lists them. */
  presets: RubricPreset[];
}

/**
 * The stored document, or an empty one. Never throws: a corrupt or hand-edited
 * row degrades to "the built-in preset, active" rather than breaking the viewer
 * or a run.
 */
export function readPresetDoc(db: Database): PresetDoc {
  const raw = db.getState(RUBRIC_PRESETS_KEY);
  if (!raw) return { activeId: DEFAULT_PRESET_ID, presets: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { activeId: DEFAULT_PRESET_ID, presets: [] };
  }
  const doc = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const presets: RubricPreset[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(doc.presets) ? doc.presets : []) {
    const preset = parseStoredPreset(entry);
    if (!preset || seen.has(preset.id)) continue;
    seen.add(preset.id);
    presets.push(preset);
  }
  const activeId = typeof doc.activeId === 'string' && seen.has(doc.activeId)
    ? doc.activeId
    : DEFAULT_PRESET_ID;
  return { activeId, presets };
}

/** Persist the document verbatim. Callers validate first; this only writes. */
export function writePresetDoc(db: Database, doc: PresetDoc): void {
  db.setState(RUBRIC_PRESETS_KEY, JSON.stringify(doc));
}

/**
 * Every preset the owner can choose between: the built-in one first, then the
 * custom ones in their stored order.
 */
export function listPresets(db: Database, interests?: string): RubricPreset[] {
  return [builtInPreset(interests), ...readPresetDoc(db).presets];
}

/**
 * The preset a run scores against and "Top score" sorts by.
 *
 * Falls back to the built-in preset whenever the stored choice is missing or
 * names a preset that is gone - the ranker must always have a rubric, and
 * failing closed onto the rubric this tool shipped with is the answer that can
 * never be wrong about what it is.
 */
export function activePreset(db: Database, interests?: string): RubricPreset {
  const doc = readPresetDoc(db);
  if (doc.activeId === DEFAULT_PRESET_ID) return builtInPreset(interests);
  return doc.presets.find((p) => p.id === doc.activeId) ?? builtInPreset(interests);
}

/**
 * The rubric a run scores against - the single place the CLI, the in-app run
 * and the viewer's own "which scores count" question all resolve it, so the
 * three can never disagree about which scale is current.
 *
 * `interests` is the process's `XBOOKMARKS_RANKER_INTERESTS`, which augments
 * the BUILT-IN preset only (`src/rank/rubric.ts`): a custom preset shows every
 * question it asks in the editor, so nothing is appended to it behind the
 * owner's back.
 */
export function resolveActiveRubric(db: Database, interests?: string): Rubric {
  return presetRubric(activePreset(db, interests), interests);
}
