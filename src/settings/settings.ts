/**
 * Durable, server-side categorization settings (issue #71).
 *
 * The owner picks how categorization runs once - in the first-run setup, or
 * later in the Settings panel - and every in-app sync reuses that choice. The
 * values live in the local database (`run_state`, the same durable key/value
 * table the sync cursor and the X refresh token use), NOT in the browser: a
 * setting that decides whether a run spends money has to survive a restart and
 * be readable by the server that does the spending, which `localStorage`
 * satisfies neither of.
 *
 * Reading them never requires a browser or a terminal, so the CLI and the
 * viewer agree on one answer: `loadConfig` builds the env-shaped baseline, and
 * {@link applySettingsToConfig} layers the stored choice on top of it. An
 * explicit env var therefore still describes a CLI run that sets one, while the
 * in-app path needs none - which is the point of the issue.
 */
import type { Config } from '../config';
import { CATEGORIZER_IDS, type CategorizerId } from '../config';
import type { Database } from '../db/database';
import { catalogProvider, sourceOfModel, type SettingsCatalog } from './catalog';

/** `run_state` key holding the settings document. */
export const SETTINGS_KEY = 'app_settings';

/**
 * How the owner chose to categorize.
 *
 * Each pass names its OWN provider and model (issue #70): the taxonomy pass
 * wants the most capable model the owner will pay for once, the filing pass
 * the cheapest one that files well, and those can live on different
 * providers. A model field left undefined means "whatever that pass's provider
 * suggests for it" - the Recommended option - so the Opus-pass-1 /
 * Haiku-pass-2 economics survive an owner who never touches the dropdowns, and
 * a provider that later changes its suggestion is followed rather than pinned.
 */
export interface AppSettings {
  /** Which implementation runs the assignment pass (pass 2). */
  categorizer: CategorizerId;
  /** LLM provider id for pass 1 (taxonomy design). */
  taxonomyProvider: string;
  /** Pass 1 model; undefined = the taxonomy provider's suggestion. */
  taxonomyModel?: string;
  /**
   * LLM provider id for pass 2 (assignment) when a language model files
   * (`categorizer` is not Jev). Never read while Jev is the method: Jev files
   * on its own and calls no language model at all.
   */
  assignmentProvider: string;
  /** Pass 2 model; undefined = the assignment provider's suggestion. Never read while Jev files. */
  assignmentModel?: string;
  /** Reasoning effort for the taxonomy pass; undefined = the app default. */
  effort?: string;
  /** When first-run setup was completed. Absent means the owner never finished it. */
  configuredAt?: string;
}

export interface SettingsValidation {
  settings: AppSettings;
  /** One human-readable message per problem, empty when the input was valid. */
  errors: string[];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The settings a fresh install starts from: the default categorizer and the
 * default (first-registered, no per-call charge) provider for BOTH passes,
 * every model left at the provider's own suggestion.
 */
export function defaultSettings(catalog: SettingsCatalog): AppSettings {
  const provider = catalog.providers[0];
  const id = provider ? provider.id : '';
  return {
    categorizer: CATEGORIZER_IDS[0],
    taxonomyProvider: id,
    assignmentProvider: id,
  };
}

type Pass = 'taxonomy' | 'assignment';

const PASS_LABEL: Record<Pass, { provider: string; model: string }> = {
  taxonomy: { provider: 'Taxonomy provider', model: 'Taxonomy model' },
  assignment: { provider: 'Filing provider', model: 'Filing model' },
};

/**
 * Validate a raw settings document against the catalog, fixowl-style: every
 * problem is reported as its own actionable sentence naming what IS available,
 * and an invalid field falls back to the default rather than being persisted.
 * Callers reject the write when `errors` is non-empty; the returned
 * `settings` are still safe to use, which is what lets a document stored by an
 * older version (or hand-edited) degrade instead of breaking a sync.
 *
 * A document from before issue #70 carries one `provider` for both passes; it
 * is read as each pass's provider when that pass names none of its own, so an
 * existing install keeps exactly the choice it made. Fields this version no
 * longer has (Jev's old `fallbackProvider`/`fallbackModel`) are ignored, so
 * they vanish from the document on its next save.
 */
export function validateSettings(raw: unknown, catalog: SettingsCatalog): SettingsValidation {
  const errors: string[] = [];
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const fallback = defaultSettings(catalog);

  const rawCategorizer = str(input.categorizer);
  let categorizer = fallback.categorizer;
  if (rawCategorizer) {
    const match = catalog.methods.find((m) => m.id === rawCategorizer);
    if (match) categorizer = match.id;
    else {
      errors.push(
        `Unknown categorization method "${rawCategorizer}" ` +
          `(available: ${catalog.methods.map((m) => m.id).join(', ')}).`,
      );
    }
  }

  const legacyProvider = str(input.provider);
  const providerFor = (pass: Pass): string => {
    const value = str(input[`${pass}Provider`]) ?? legacyProvider;
    if (!value) return fallback[`${pass}Provider`];
    const match = catalogProvider(catalog, value);
    if (match) return match.id;
    errors.push(
      `Unknown ${PASS_LABEL[pass].provider.toLowerCase()} "${value}" ` +
        `(available: ${catalog.providers.map((p) => p.id).join(', ')}).`,
    );
    return fallback[`${pass}Provider`];
  };

  const modelFor = (pass: Pass, providerId: string): string | undefined => {
    const value = str(input[`${pass}Model`]);
    if (!value) return undefined;
    const provider = catalogProvider(catalog, providerId);
    const modelIds = provider?.models.map((m) => m.id) ?? [];
    if (modelIds.includes(value)) return value;
    // A provider with a full catalog (pi's upstreams) accepts any model of it.
    // This is the SHAPE check that a stored document can be read back with;
    // whether pi really lists the model is checked on save, against the
    // catalog itself (`verifyCatalogModels`).
    if (provider && sourceOfModel(provider, value)) return value;
    if (provider?.sources?.length) {
      errors.push(
        `${PASS_LABEL[pass].model} "${value}" names no model source of provider "${providerId}": ` +
          `use "<source>/<model>" with one of ${provider.sources.map((src) => src.id).join(', ')}.`,
      );
      return undefined;
    }
    errors.push(
      `${PASS_LABEL[pass].model} "${value}" is not available for provider "${providerId}" ` +
        `(available: ${modelIds.join(', ')}).`,
    );
    return undefined;
  };

  // Evaluated in the order the dropdowns are laid out in, so the messages read
  // top to bottom: pass 1's provider, model, effort; then pass 2's.
  const taxonomyProvider = providerFor('taxonomy');
  const taxonomyModel = modelFor('taxonomy', taxonomyProvider);

  const rawEffort = str(input.effort);
  let effort: string | undefined;
  if (rawEffort) {
    const efforts = catalogProvider(catalog, taxonomyProvider)?.efforts ?? [];
    if (efforts.length === 0) {
      errors.push(`Provider "${taxonomyProvider}" has no reasoning-effort levels.`);
    } else if (!efforts.includes(rawEffort)) {
      errors.push(
        `Effort "${rawEffort}" is not available for provider "${taxonomyProvider}" ` +
          `(available: ${efforts.join(', ')}).`,
      );
    } else {
      effort = rawEffort;
    }
  }

  const assignmentProvider = providerFor('assignment');
  const assignmentModel = modelFor('assignment', assignmentProvider);

  return {
    settings: {
      categorizer,
      taxonomyProvider,
      taxonomyModel,
      assignmentProvider,
      assignmentModel,
      effort,
      configuredAt: str(input.configuredAt),
    },
    errors,
  };
}

/**
 * The stored settings, or undefined when the owner has never saved any. Never
 * throws: a corrupt or hand-edited document degrades to "unconfigured" so the
 * viewer still starts and the first-run setup can write a clean one.
 */
export function readSettings(db: Database, catalog: SettingsCatalog): AppSettings | undefined {
  const raw = db.getState(SETTINGS_KEY);
  if (!raw) return undefined;
  try {
    return validateSettings(JSON.parse(raw), catalog).settings;
  } catch {
    return undefined;
  }
}

/**
 * Persist settings. Callers validate first. Only the fields the chosen method
 * actually reads are stored - no filing provider or model under Jev, which
 * calls no language model - so the document never carries a choice that no
 * screen shows for the method in force.
 */
export function writeSettings(db: Database, settings: AppSettings): void {
  db.setState(SETTINGS_KEY, JSON.stringify(storedShape(settings)));
}

/** {@link writeSettings}'s document: the method's own fields, nothing it ignores. */
export function storedShape(settings: AppSettings): Partial<AppSettings> {
  const { assignmentProvider, assignmentModel, ...rest } = settings;
  return settings.categorizer === 'typesafe'
    ? rest
    : { ...rest, assignmentProvider, ...(assignmentModel ? { assignmentModel } : {}) };
}

/** The stored settings, or the catalog defaults when nothing is stored yet. */
export function effectiveSettings(db: Database, catalog: SettingsCatalog): AppSettings {
  return readSettings(db, catalog) ?? defaultSettings(catalog);
}

/**
 * The env vars that own each stored setting, for {@link applySettingsToConfig}'s
 * CLI precedence rule: when ANY of a field's variables is set, the environment
 * claims that field. A pass's provider is claimed by its own
 * `XBOOKMARKS_*_PROVIDER` and also by `XBOOKMARKS_LLM_PROVIDER`, which has
 * always meant "every role's provider". Naming them here keeps "which variable
 * overrides this field" in one place next to the mapping it governs.
 */
const ENV_OWNERS: Record<
  'categorizer' | 'taxonomyProvider' | 'assignmentProvider' | 'taxonomyModel' | 'assignmentModel' | 'effort',
  readonly string[]
> = {
  categorizer: ['XBOOKMARKS_CATEGORIZER'],
  taxonomyProvider: ['XBOOKMARKS_TAXONOMY_PROVIDER', 'XBOOKMARKS_LLM_PROVIDER'],
  assignmentProvider: ['XBOOKMARKS_ASSIGNMENT_PROVIDER', 'XBOOKMARKS_LLM_PROVIDER'],
  taxonomyModel: ['XBOOKMARKS_TAXONOMY_MODEL'],
  assignmentModel: ['XBOOKMARKS_MODEL'],
  effort: ['XBOOKMARKS_TAXONOMY_EFFORT'],
};

/**
 * Layer the owner's stored choice onto the env-shaped baseline config, so an
 * in-app sync needs no `XBOOKMARKS_*` variable set on the process that started
 * the viewer. The mapping is deliberately narrow - it touches only what the
 * selector offers:
 *
 * - `categorizer` <- the chosen method, exactly as `XBOOKMARKS_CATEGORIZER` would.
 * - the taxonomy / assignment role PROVIDERS <- each pass's own choice, as
 *   `XBOOKMARKS_TAXONOMY_PROVIDER` / `XBOOKMARKS_ASSIGNMENT_PROVIDER` would.
 *   The default provider (what summaries and chat run on) is left alone: the
 *   selector is about categorization, and choosing a paid model to design the
 *   tree must not quietly move summaries onto it too.
 * - the taxonomy/assignment role MODELS, only when the owner pinned one. Left at
 *   Recommended they stay undefined, and the factory falls through to the
 *   provider's own per-role suggestion - which is what keeps the expensive
 *   pass 1 / cheap pass 2 split intact.
 * - the taxonomy role's `effort`, same rule.
 *
 * Everything else (batch size, depth, page size, the TypeSafe thresholds) is
 * untouched tuning that stays on the environment.
 *
 * Precedence differs by caller, deliberately. Omit `env` (what the viewer does)
 * and the stored choice WINS: the selector is the app's visible control, and a
 * stray `XBOOKMARKS_CATEGORIZER=typesafe` in the shell that launched `serve`
 * must never quietly bill per token while the panel reads "Claude model". Pass
 * `env` (what the CLI does) and an explicitly set variable wins instead, so a
 * one-off `XBOOKMARKS_MODEL=... node dist/index.js run` still means what it
 * always did.
 */
export function applySettingsToConfig(
  config: Config,
  settings: AppSettings,
  env?: NodeJS.ProcessEnv,
): Config {
  const roles = config.llm.roles;
  const claimed = (field: keyof typeof ENV_OWNERS): boolean =>
    !!env && ENV_OWNERS[field].some((name) => env[name]?.trim());
  /** The stored value, unless the environment explicitly claims that field. */
  const pick = <K extends keyof typeof ENV_OWNERS>(field: K): AppSettings[K] | undefined =>
    claimed(field) ? undefined : settings[field];
  /**
   * A stored model belongs to the stored provider: once the environment moves
   * a pass to another provider, that model id means nothing there, so the
   * pass falls back to its env model or the new provider's suggestion.
   */
  const pickModel = (pass: Pass): string | undefined =>
    claimed(`${pass}Provider`) ? undefined : pick(`${pass}Model`);

  const categorizer = pick('categorizer') ?? config.categorizer;
  const effort = pick('effort');
  return {
    ...config,
    categorizer,
    llm: {
      ...config.llm,
      roles: {
        ...roles,
        taxonomy: {
          ...roles.taxonomy,
          provider: pick('taxonomyProvider') || roles.taxonomy.provider,
          model: pickModel('taxonomy') ?? roles.taxonomy.model,
          params: {
            ...roles.taxonomy.params,
            effort: effort ?? roles.taxonomy.params?.effort,
          },
        },
        // While Jev files, nothing runs on the assignment role - Jev calls no
        // language model - so whatever it maps to here is never checked,
        // billed or called.
        assignment: {
          ...roles.assignment,
          provider: pick('assignmentProvider') || roles.assignment.provider,
          model: pickModel('assignment') ?? roles.assignment.model,
        },
      },
    },
  };
}
