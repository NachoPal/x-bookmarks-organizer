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
import { catalogProvider, type SettingsCatalog } from './catalog';

/** `run_state` key holding the settings document. */
export const SETTINGS_KEY = 'app_settings';

/**
 * How the owner chose to categorize.
 *
 * A model field left undefined means "whatever the provider suggests for that
 * role" - the Recommended option - so the Opus-pass-1 / Haiku-pass-2 economics
 * survive an owner who never touches the dropdowns, and a provider that later
 * changes its suggestion is followed rather than pinned.
 */
export interface AppSettings {
  /** Which implementation runs the assignment pass (pass 2). */
  categorizer: CategorizerId;
  /** LLM provider id backing the model passes. */
  provider: string;
  /** Pass 1 (taxonomy design) model; undefined = the provider's suggestion. */
  taxonomyModel?: string;
  /** Pass 2 (assignment) model; undefined = the provider's suggestion. Unused by Jev. */
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
 * default provider, every model left at the provider's own suggestion.
 */
export function defaultSettings(catalog: SettingsCatalog): AppSettings {
  const provider = catalog.providers[0];
  return {
    categorizer: CATEGORIZER_IDS[0],
    provider: provider ? provider.id : '',
  };
}

/**
 * Validate a raw settings document against the catalog, fixowl-style: every
 * problem is reported as its own actionable sentence naming what IS available,
 * and an invalid field falls back to the default rather than being persisted.
 * Callers reject the write when `errors` is non-empty; the returned
 * `settings` are still safe to use, which is what lets a document stored by an
 * older version (or hand-edited) degrade instead of breaking a sync.
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

  const rawProvider = str(input.provider);
  let providerId = fallback.provider;
  if (rawProvider) {
    const match = catalogProvider(catalog, rawProvider);
    if (match) providerId = match.id;
    else {
      errors.push(
        `Unknown model provider "${rawProvider}" ` +
          `(available: ${catalog.providers.map((p) => p.id).join(', ')}).`,
      );
    }
  }

  const provider = catalogProvider(catalog, providerId);
  const modelIds = provider ? provider.models.map((m) => m.id) : [];

  const model = (key: 'taxonomyModel' | 'assignmentModel', label: string): string | undefined => {
    const value = str(input[key]);
    if (!value) return undefined;
    if (modelIds.includes(value)) return value;
    errors.push(
      `${label} "${value}" is not available for provider "${providerId}" ` +
        `(available: ${modelIds.join(', ')}).`,
    );
    return undefined;
  };

  // Evaluated before the effort check so the messages read in field order -
  // the order the dropdowns are laid out in.
  const taxonomyModel = model('taxonomyModel', 'Taxonomy model');
  const assignmentModel = model('assignmentModel', 'Filing model');

  const rawEffort = str(input.effort);
  let effort: string | undefined;
  if (rawEffort) {
    const efforts = provider ? provider.efforts : [];
    if (efforts.length === 0) {
      errors.push(`Provider "${providerId}" has no reasoning-effort levels.`);
    } else if (!efforts.includes(rawEffort)) {
      errors.push(`Effort "${rawEffort}" is not available for provider "${providerId}" (available: ${efforts.join(', ')}).`);
    } else {
      effort = rawEffort;
    }
  }

  return {
    settings: {
      categorizer,
      provider: providerId,
      taxonomyModel,
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

/** Persist settings verbatim. Callers validate first; this only writes. */
export function writeSettings(db: Database, settings: AppSettings): void {
  db.setState(SETTINGS_KEY, JSON.stringify(settings));
}

/** The stored settings, or the catalog defaults when nothing is stored yet. */
export function effectiveSettings(db: Database, catalog: SettingsCatalog): AppSettings {
  return readSettings(db, catalog) ?? defaultSettings(catalog);
}

/**
 * The env var that owns each stored setting, for {@link applySettingsToConfig}'s
 * CLI precedence rule. Naming them here keeps "which variable overrides this
 * field" in one place next to the mapping it governs.
 */
const ENV_OWNER: Record<'categorizer' | 'provider' | 'taxonomyModel' | 'assignmentModel' | 'effort', string> = {
  categorizer: 'XBOOKMARKS_CATEGORIZER',
  provider: 'XBOOKMARKS_LLM_PROVIDER',
  taxonomyModel: 'XBOOKMARKS_TAXONOMY_MODEL',
  assignmentModel: 'XBOOKMARKS_MODEL',
  effort: 'XBOOKMARKS_TAXONOMY_EFFORT',
};

/**
 * Layer the owner's stored choice onto the env-shaped baseline config, so an
 * in-app sync needs no `XBOOKMARKS_*` variable set on the process that started
 * the viewer. The mapping is deliberately narrow - it touches only what the
 * selector offers:
 *
 * - `categorizer` <- the chosen method, exactly as `XBOOKMARKS_CATEGORIZER` would.
 * - `llm.defaultProvider` <- the chosen provider, as `XBOOKMARKS_LLM_PROVIDER` would.
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
  /** The stored value, unless the environment explicitly claims that field. */
  const pick = <K extends keyof typeof ENV_OWNER>(field: K): AppSettings[K] | undefined =>
    env && env[ENV_OWNER[field]]?.trim() ? undefined : settings[field];

  const categorizer = pick('categorizer') ?? config.categorizer;
  const provider = pick('provider');
  const effort = pick('effort');
  return {
    ...config,
    categorizer,
    llm: {
      ...config.llm,
      defaultProvider: provider || config.llm.defaultProvider,
      roles: {
        ...roles,
        taxonomy: {
          ...roles.taxonomy,
          model: pick('taxonomyModel') ?? roles.taxonomy.model,
          params: {
            ...roles.taxonomy.params,
            effort: effort ?? roles.taxonomy.params?.effort,
          },
        },
        assignment: {
          ...roles.assignment,
          model: pick('assignmentModel') ?? roles.assignment.model,
        },
      },
    },
  };
}
