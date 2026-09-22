import { describe, expect, it } from 'vitest';
import {
  builtInPreset,
  DEFAULT_PRESET_ID,
  MAX_DIMENSIONS,
  newPresetId,
  parseStoredPreset,
  presetRubric,
  slugifyKey,
  validatePreset,
  type RubricPreset,
} from './presets';
import { BASE_DIMENSIONS, buildRubric, rubricVersionFor, type RubricDimension } from './rubric';

/**
 * Rubric presets, offline and free by construction (issue #102): nothing in
 * this file constructs a client, and authoring rules never calls the paid API
 * at all - that is the feature's central safety claim, enforced structurally by
 * this module having no SDK dependency to call.
 */

const dimension = (over: Partial<RubricDimension> = {}): Record<string, unknown> => ({
  id: 'signal',
  instructions: 'How much signal is in this post?',
  levels: ['None at all.', 'Some.', 'A lot.'],
  weight: 2,
  ...over,
});

const preset = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Signal only',
  dimensions: [dimension()],
  ...over,
});

describe('version derivation', () => {
  it('leaves the BUILT-IN rubric on the tag it has always carried', () => {
    // An owner who never opens the editor must not be re-billed for a library
    // already ranked, so the default preset aliases to today's version.
    expect(rubricVersionFor(BASE_DIMENSIONS)).toBe('v1');
    expect(presetRubric(builtInPreset()).version).toBe(buildRubric().version);
    expect(presetRubric(builtInPreset('rust'), 'rust').version).toBe(buildRubric('rust').version);
  });

  it('gives two different rubrics two different versions', () => {
    const a = validatePreset(preset(), []).preset;
    const b = validatePreset(
      preset({ dimensions: [dimension({ weight: 3 })] }),
      [],
    ).preset;
    expect(presetRubric(a).version).not.toBe(presetRubric(b).version);
    expect(presetRubric(a).version).not.toBe(buildRubric().version);
  });

  it('reacts to a changed question, a changed level and a changed weight alike', () => {
    const base = presetRubric(validatePreset(preset(), []).preset).version;
    const versions = [
      preset({ dimensions: [dimension({ instructions: 'A different question?' })] }),
      preset({ dimensions: [dimension({ levels: ['None at all.', 'Some.', 'Masses.'] })] }),
      preset({ dimensions: [dimension({ weight: 5 })] }),
      preset({ dimensions: [dimension({ id: 'other' })] }),
    ].map((raw) => presetRubric(validatePreset(raw, []).preset).version);

    expect(new Set([base, ...versions]).size).toBe(5);
  });

  it('gives identical rules the same version, whatever the preset is called', () => {
    // Content, never identity: two presets with the same rules are the same
    // scale, so the owner pays once and both show the same verdicts.
    const a = validatePreset(preset({ name: 'One' }), []).preset;
    const b = validatePreset(preset({ name: 'Two' }), []).preset;
    expect(presetRubric(a).version).toBe(presetRubric(b).version);
  });

  it('survives a JSON round trip, so a stored preset keeps its scores', () => {
    const saved = validatePreset(preset(), []).preset;
    const reloaded = parseStoredPreset({ ...JSON.parse(JSON.stringify(saved)), id: 'p1' })!;
    expect(presetRubric(reloaded).version).toBe(presetRubric(saved).version);
  });

  it('aliases a hand-authored copy of the built-in rules onto the built-in version', () => {
    const clone = validatePreset(
      preset({ name: 'My copy', dimensions: BASE_DIMENSIONS.map((d) => ({ ...d })) }),
      [],
    ).preset;
    // Same rules, same scale: re-activating this costs nothing on a library
    // already ranked under the default.
    expect(presetRubric(clone).version).toBe(buildRubric().version);
  });
});

describe('validatePreset', () => {
  it('accepts a well-formed preset and normalizes it', () => {
    const { preset: parsed, errors } = validatePreset(
      preset({ dimensions: [dimension({ id: '', label: 'Signal density' })] }),
      [],
    );
    expect(errors).toEqual([]);
    expect(parsed.name).toBe('Signal only');
    expect(parsed.builtIn).toBe(false);
    expect(parsed.dimensions[0]!.id).toBe('signal_density');
  });

  it('rejects a rubric with no dimensions', () => {
    const { errors } = validatePreset(preset({ dimensions: [] }), []);
    expect(errors.join(' ')).toMatch(/at least one dimension/i);
  });

  it('rejects a dimension with fewer than two levels', () => {
    const { errors } = validatePreset(
      preset({ dimensions: [dimension({ levels: ['Only one.'] })] }),
      [],
    );
    expect(errors.join(' ')).toMatch(/at least 2 levels/i);
  });

  it('rejects an empty question', () => {
    const { errors } = validatePreset(
      preset({ dimensions: [dimension({ instructions: '   ' })] }),
      [],
    );
    expect(errors.join(' ')).toMatch(/needs a question/i);
  });

  it('rejects a weight that is not a positive number', () => {
    for (const weight of [0, -1, 'heavy', Number.NaN]) {
      const { errors } = validatePreset(
        preset({ dimensions: [dimension({ weight: weight as number })] }),
        [],
      );
      expect(errors.join(' ')).toMatch(/weight must be a number greater than zero/i);
    }
  });

  it('rejects an unnamed preset and a name another preset already has', () => {
    expect(validatePreset(preset({ name: '  ' }), []).errors.join(' ')).toMatch(/give these/i);

    const existing: RubricPreset = { id: 'p1', name: 'Signal only', builtIn: false, dimensions: [] };
    expect(validatePreset(preset(), [existing]).errors.join(' ')).toMatch(/already called/i);
    // Case-insensitively, the same way category siblings collide.
    expect(validatePreset(preset({ name: 'SIGNAL ONLY' }), [existing]).errors).toHaveLength(1);
  });

  it('rejects two dimensions sharing a key - the breakdown is keyed by it', () => {
    const { errors } = validatePreset(
      preset({ dimensions: [dimension(), dimension({ instructions: 'Another?' })] }),
      [],
    );
    expect(errors.join(' ')).toMatch(/same key/i);
  });

  it('caps how many dimensions a preset may hold - each one is billed per bookmark', () => {
    const many = Array.from({ length: MAX_DIMENSIONS + 1 }, (_, i) => dimension({ id: `d${i}` }));
    expect(validatePreset(preset({ dimensions: many }), []).errors.join(' ')).toMatch(
      new RegExp(`limit is ${MAX_DIMENSIONS}`),
    );
  });

  it('reports every problem at once, so the editor can show them together', () => {
    const { errors } = validatePreset(
      { name: '', dimensions: [{ id: 'a', instructions: '', levels: [], weight: 0 }] },
      [],
    );
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });
});

describe('ids', () => {
  it('slugifies a label into a machine key', () => {
    expect(slugifyKey('Signal density!')).toBe('signal_density');
    expect(slugifyKey('  ')).toBe('');
  });

  it('never hands out the built-in id, and never collides', () => {
    expect(newPresetId('Default', [DEFAULT_PRESET_ID])).not.toBe(DEFAULT_PRESET_ID);
    expect(newPresetId('Signal', ['signal'])).toBe('signal_2');
    expect(newPresetId('!!', [])).toBe('preset');
  });
});

describe('parseStoredPreset', () => {
  it('drops an entry this build cannot read rather than throwing', () => {
    // A hand-edited or future document must never stop the viewer starting -
    // the built-in preset is synthesized, so there is always a fallback.
    expect(parseStoredPreset({ id: 'p', name: '', dimensions: [] })).toBeUndefined();
    expect(parseStoredPreset({ name: 'no id', dimensions: [dimension()] })).toBeUndefined();
    expect(parseStoredPreset(null)).toBeUndefined();
    // The built-in id is reserved: a stored preset can never shadow it.
    expect(parseStoredPreset({ ...preset(), id: DEFAULT_PRESET_ID })).toBeUndefined();
  });
});
