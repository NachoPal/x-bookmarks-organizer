/**
 * What a model call will cost, described for the point of spending (security
 * review 2, #20).
 *
 * The CLI and the `serve` console already announce billing, but the owner
 * presses Summarize and Sync in the browser. `/api/summary-status` and
 * `/api/setup` carry these descriptions so the viewer can say "this is paid"
 * on the control itself and confirm a paid sync before it starts - the same
 * standard the in-app ranking run already meets. Everything here is a local
 * read of data the providers ship: no request, no key, no spend.
 */
import type { LlmFactory } from '../llm/factory';
import { getProvider } from '../llm/registry';
import type { Billing, LlmRole } from '../llm/types';
import type { SettingsCatalog } from '../settings/catalog';
import { findCatalogModel, type ModelBrowser } from '../settings/model-browser';

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
}

/** How one role's calls are billed - never a key or any other secret. */
export interface RoleSpend {
  providerId: string;
  providerLabel: string;
  model: string;
  modelLabel: string;
  billing: Billing;
  /** Present when the provider's catalog states it. */
  price?: ModelPrice;
}

/** Which sync pass a paid call belongs to. `filing-fallback` is Jev's new-category LLM fallback. */
export type SyncPassId = 'taxonomy' | 'filing' | 'filing-fallback';

/** One pass of the NEXT sync that will be billed per token. */
export interface PaidPass {
  pass: SyncPassId;
  /** The pass, in the settings panel's own words. */
  label: string;
  providerId: string;
  providerLabel: string;
  model: string;
  modelLabel: string;
  price?: ModelPrice;
}

/**
 * Describe the role's billing, or undefined when its provider does not exist
 * (a run would refuse on that before spending anything anyway).
 */
export async function describeRoleSpend(
  llm: LlmFactory,
  role: LlmRole,
  catalog: SettingsCatalog,
  browser: ModelBrowser,
): Promise<RoleSpend | undefined> {
  let described;
  try {
    described = llm.describe(role);
  } catch {
    return undefined;
  }
  const entry = await findCatalogModel(catalog, browser, described.providerId, described.model);
  return {
    providerId: described.providerId,
    providerLabel: getProvider(described.providerId)?.label ?? described.providerId,
    model: described.model,
    modelLabel: entry?.label ?? described.model,
    billing: described.billing,
    ...(entry?.price ? { price: entry.price } : {}),
  };
}

/** A role's spend as a paid pass of a sync, or undefined when it is not billed per token. */
export function asPaidPass(spend: RoleSpend | undefined, pass: SyncPassId, label: string): PaidPass | undefined {
  if (!spend || spend.billing !== 'per-token') return undefined;
  return {
    pass,
    label,
    providerId: spend.providerId,
    providerLabel: spend.providerLabel,
    model: spend.model,
    modelLabel: spend.modelLabel,
    ...(spend.price ? { price: spend.price } : {}),
  };
}
