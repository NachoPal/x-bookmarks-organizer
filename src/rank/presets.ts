/**
 * Named rubric presets: the ranking rules as DATA the owner can author, rather
 * than a constant in this repository (issue #102).
 *
 * This file is PURE - no SDK, no database, no clock, no network - exactly like
 * `rubric.ts` and `src/categorize/typesafe/walk.ts`. A preset is a name plus an
 * ordered list of {@link RubricDimension}s; everything about what makes one
 * VALID, and what version tag its content produces, is decided here and unit
 * tested with nothing to stub. `preset-store.ts` is the only half that touches
 * a database.
 *
 * Two invariants this module exists to hold:
 *
 *  * **The built-in preset is always present and never editable in place.** It
 *    is the rubric this tool shipped with (`BASE_DIMENSIONS`), it cannot be
 *    renamed or deleted, and the editor offers it as clone-to-edit. An owner
 *    who never opens the editor therefore runs exactly today's rubric, under
 *    exactly today's version tag - no re-billing for a library already ranked.
 *  * **A preset's `rubric_version` is derived from its CONTENT**
 *    ({@link rubricVersionFor}), never from its id or its name. Renaming a
 *    preset is free; changing a question, a level or a weight makes it a
 *    different scale, which is what stops two rubrics' scores being sorted
 *    against each other and is what prompts a re-rank of just what is needed.
 *
 * Nothing here spends money. Authoring, validating and selecting a preset are
 * all free; only a rank run calls the paid API, behind the gates in
 * `src/web/rank-job.ts`.
 */
import {
  baseDimensions,
  rubricFor,
  type Rubric,
  type RubricDimension,
} from './rubric';

/** The built-in preset's id. Reserved: a custom preset can never claim it. */
export const DEFAULT_PRESET_ID = 'default';

/** The built-in preset's name, as the selector shows it. */
export const DEFAULT_PRESET_NAME = 'Learning value (built-in)';

/**
 * Caps on what an owner can author. They are cost and sanity bounds, not
 * taste: every dimension is a question in the one billed request per bookmark,
 * and a level list long enough to blow past the model's attention makes the
 * scale meaningless rather than finer.
 */
export const MIN_DIMENSIONS = 1;
export const MAX_DIMENSIONS = 12;
export const MIN_LEVELS = 2;
export const MAX_LEVELS = 10;
export const MAX_NAME_CHARS = 60;
export const MAX_QUESTION_CHARS = 400;
export const MAX_LEVEL_CHARS = 300;
export const MAX_WEIGHT = 100;

/** One saved set of ranking rules. */
export interface RubricPreset {
  /** Stable id. {@link DEFAULT_PRESET_ID} for the built-in one. */
  id: string;
  name: string;
  /** True only for the built-in preset: not renameable, not editable, not deletable. */
  builtIn: boolean;
  dimensions: RubricDimension[];
}

/** A preset plus everything the viewer needs to talk about it. */
export interface PresetView extends RubricPreset {
  /** The content-derived tag this preset's scores are stored under. */
  version: string;
}

export interface PresetValidation {
  /** The normalized preset. Only meaningful when `errors` is empty. */
  preset: RubricPreset;
  /** One actionable sentence per problem, empty when the input was valid. */
  errors: string[];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** A multi-line field (a question, a level): collapse runs of blanks, keep the rest. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A stable key from a human label: lower case, words joined by `_`.
 *
 * The key is what a stored row's per-dimension breakdown is keyed by, so it
 * must be machine-shaped. The owner never has to type one - the editor derives
 * it from the label and only surfaces it when two dimensions would collide.
 */
export function slugifyKey(label: string): string {
  return String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** The built-in preset, which is always offered and always first. */
export function builtInPreset(interests?: string): RubricPreset {
  return {
    id: DEFAULT_PRESET_ID,
    name: DEFAULT_PRESET_NAME,
    builtIn: true,
    dimensions: baseDimensions(interests),
  };
}

/** A preset's rubric - its dimensions under its content-derived version tag. */
export function presetRubric(preset: RubricPreset, interests?: string): Rubric {
  return rubricFor(preset.dimensions, interests);
}

/** A preset as the API reports it, carrying the version its scores are keyed by. */
export function toPresetView(preset: RubricPreset, interests?: string): PresetView {
  return { ...preset, version: presetRubric(preset, interests).version };
}

/**
 * Generate an id for a new preset that no existing one already uses.
 *
 * Derived from the name so a hand-inspected `run_state` document is readable,
 * with a numeric suffix as the collision break. `DEFAULT_PRESET_ID` is reserved
 * for the built-in preset, so a custom preset literally named "Default" still
 * gets a distinct id.
 */
export function newPresetId(name: string, taken: readonly string[]): string {
  const used = new Set(taken);
  const base = slugifyKey(name) || 'preset';
  let candidate = base === DEFAULT_PRESET_ID ? `${base}_1` : base;
  let n = 1;
  while (used.has(candidate)) candidate = `${base}_${++n}`;
  return candidate;
}

/**
 * Validate an owner-authored preset, fixowl-style: every problem is its own
 * actionable sentence naming the field it is about, so the editor can show
 * them all at once instead of one per save.
 *
 * `others` is every OTHER preset (the built-in included), which is what the
 * name-uniqueness check runs against - a caller updating a preset passes the
 * list with that preset already excluded, so re-saving it under its own name
 * is not a collision.
 */
export function validatePreset(raw: unknown, others: readonly RubricPreset[]): PresetValidation {
  const errors: string[] = [];
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  const name = str(input.name);
  if (!name) errors.push('Give these ranking rules a name.');
  else if (name.length > MAX_NAME_CHARS) {
    errors.push(`The name is too long (${name.length} characters; the limit is ${MAX_NAME_CHARS}).`);
  } else if (others.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    errors.push(`Another set of ranking rules is already called "${name}". Pick a different name.`);
  }

  const rawDimensions = Array.isArray(input.dimensions) ? input.dimensions : [];
  if (rawDimensions.length < MIN_DIMENSIONS) {
    errors.push('Add at least one dimension - a rubric with no questions cannot score anything.');
  } else if (rawDimensions.length > MAX_DIMENSIONS) {
    errors.push(
      `There are ${rawDimensions.length} dimensions; the limit is ${MAX_DIMENSIONS}. ` +
        'Each one is a question in the billed request for every bookmark.',
    );
  }

  const dimensions: RubricDimension[] = [];
  const seenIds = new Set<string>();

  rawDimensions.slice(0, MAX_DIMENSIONS).forEach((entry, index) => {
    const d = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const position = `Dimension ${index + 1}`;

    const label = str(d.label);
    let id = slugifyKey(str(d.id) || label);
    if (!id) {
      errors.push(`${position} needs a name.`);
      id = `dimension_${index + 1}`;
    }
    if (seenIds.has(id)) {
      errors.push(
        `${position} has the same key ("${id}") as an earlier dimension. ` +
          'Two dimensions cannot share a key - rename one of them.',
      );
    }
    seenIds.add(id);

    const instructions = text(d.instructions ?? d.question);
    if (!instructions) errors.push(`${position} needs a question for the model to answer.`);
    else if (instructions.length > MAX_QUESTION_CHARS) {
      errors.push(
        `${position}'s question is too long (${instructions.length} characters; ` +
          `the limit is ${MAX_QUESTION_CHARS}).`,
      );
    }

    const rawLevels = Array.isArray(d.levels) ? d.levels : [];
    const levels = rawLevels.map(text).filter((level) => level.length > 0);
    if (levels.length < MIN_LEVELS) {
      errors.push(
        `${position} needs at least ${MIN_LEVELS} levels - they are what tell the model ` +
          'what each score means.',
      );
    } else if (levels.length > MAX_LEVELS) {
      errors.push(`${position} has ${levels.length} levels; the limit is ${MAX_LEVELS}.`);
    }
    if (levels.some((level) => level.length > MAX_LEVEL_CHARS)) {
      errors.push(`${position} has a level longer than ${MAX_LEVEL_CHARS} characters.`);
    }

    const weight = typeof d.weight === 'number' ? d.weight : Number(d.weight);
    if (!Number.isFinite(weight) || weight <= 0) {
      errors.push(`${position}'s weight must be a number greater than zero. Only ratios matter.`);
    } else if (weight > MAX_WEIGHT) {
      errors.push(`${position}'s weight is ${weight}; the limit is ${MAX_WEIGHT}.`);
    }

    dimensions.push({
      id,
      instructions,
      // The tuple type is the SDK's "at least two levels" requirement stated in
      // the type system; the length check above is what actually enforces it,
      // and an invalid preset is never persisted or run.
      levels: levels.slice(0, MAX_LEVELS) as unknown as RubricDimension['levels'],
      weight: Number.isFinite(weight) && weight > 0 ? Math.min(weight, MAX_WEIGHT) : 1,
    });
  });

  return {
    preset: { id: str(input.id), name, builtIn: false, dimensions },
    errors,
  };
}

/**
 * Read a stored preset back tolerantly.
 *
 * A document written by a future version, or hand-edited, must never stop the
 * viewer starting: an entry that does not validate is DROPPED rather than
 * thrown on, exactly as `readSettings` degrades a corrupt settings row to
 * "unconfigured". The built-in preset is synthesized, not stored, so there is
 * always at least one preset to fall back to.
 */
export function parseStoredPreset(raw: unknown): RubricPreset | undefined {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const id = str(input.id);
  if (!id || id === DEFAULT_PRESET_ID) return undefined;
  const { preset, errors } = validatePreset(input, []);
  if (errors.length > 0) return undefined;
  return { ...preset, id };
}
