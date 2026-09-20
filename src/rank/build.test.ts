import { describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config';
import type { CredentialStore, ResolvedCredential } from '../creds/resolve';
import { buildRanker, reportRankerBilling } from './build';
import { buildRubric } from './rubric';

/**
 * The paid-safety gate. Nothing here constructs a client that could call the
 * API - every test asserts a refusal, or asserts that the refusal's reason was
 * announced - so the whole file is offline and free by construction.
 */

function store(values: Record<string, string> = {}): CredentialStore {
  return {
    get: (key): ResolvedCredential =>
      values[key] ? { value: values[key]!, source: 'env' } : { value: undefined },
    set: () => {},
    clear: () => {},
  };
}

function config(env: NodeJS.ProcessEnv): Config {
  return loadConfig(env);
}

describe('ranking opt-in', () => {
  it('is off with an empty environment', () => {
    expect(config({}).ranker.id).toBe('off');
  });

  it('treats an unrecognized XBOOKMARKS_RANKER as off, never as an opt-in', () => {
    // The failure mode of a typo must be "no ranking", not "unexpected spend".
    expect(config({ XBOOKMARKS_RANKER: 'jev' }).ranker.id).toBe('off');
    expect(config({ XBOOKMARKS_RANKER: 'typesafe ' }).ranker.id).toBe('typesafe');
  });

  it('refuses to build while off, even with a key sitting in the environment', () => {
    expect(() => buildRanker(config({}), store({ TYPESAFE_API_KEY: 'k' }))).toThrow(
      /Ranking is off/,
    );
  });

  it('refuses to build with the opt-in but no resolvable key', () => {
    expect(() => buildRanker(config({ XBOOKMARKS_RANKER: 'typesafe' }), store())).toThrow(
      /TYPESAFE_API_KEY/,
    );
  });

  it('builds the scorer and the rubric once both gates pass', () => {
    const built = buildRanker(
      config({ XBOOKMARKS_RANKER: 'typesafe', XBOOKMARKS_RANKER_INTERESTS: 'compilers' }),
      store({ TYPESAFE_API_KEY: 'k' }),
    );
    expect(built.scorer).toBeDefined();
    expect(built.rubric.dimensions.map((d) => d.id)).toContain('relevance');
  });
});

describe('reportRankerBilling', () => {
  it('states the per-token price and the way out, before any call is made', () => {
    const lines: string[] = [];
    reportRankerBilling(config({ XBOOKMARKS_RANKER: 'typesafe' }), buildRubric(), (m) => lines.push(m));
    const text = lines.join('\n');
    expect(text).toContain('pay-per-token');
    expect(text).toContain('XBOOKMARKS_RANKER');
  });

  it('names the model override so the owner sees what they are about to be billed for', () => {
    const lines: string[] = [];
    reportRankerBilling(
      config({ XBOOKMARKS_RANKER: 'typesafe', XBOOKMARKS_RANKER_MODEL: 'jev-preview' }),
      buildRubric(),
      (m) => lines.push(m),
    );
    expect(lines.join('\n')).toContain('jev-preview');
  });
});
