import { describe, expect, it } from 'vitest';
import { loadConfig, requireEvalCategorizersCredentials, type Config } from '../config';
import type { CredentialStore, ResolvedCredential } from '../creds/resolve';
import { createLlmFactory } from '../llm/factory';
import '../llm/providers';
import { buildEvalJev, reportEvalBilling } from './build';

/**
 * The paid-safety gate. Nothing here constructs anything that could reach the
 * API - every test asserts a refusal, or asserts that the price was announced -
 * so the whole file is offline and free by construction.
 */

/** Records every credential lookup, so the ORDER of the two gates is assertable. */
function store(values: Record<string, string> = {}): CredentialStore & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    get: (key): ResolvedCredential => {
      reads.push(key);
      return values[key] ? { value: values[key]!, source: 'env' } : { value: undefined };
    },
    set: () => {},
    clear: () => {},
  };
}

function config(env: NodeJS.ProcessEnv): Config {
  return loadConfig(env);
}

describe('comparison opt-in', () => {
  it('is off with an empty environment', () => {
    expect(config({}).evalCategorizers).toBe('off');
  });

  it('treats an unrecognized XBOOKMARKS_EVAL_CATEGORIZERS as off, never as an opt-in', () => {
    // The failure mode of a typo must be "no comparison", not "unexpected spend".
    expect(config({ XBOOKMARKS_EVAL_CATEGORIZERS: 'jev' }).evalCategorizers).toBe('off');
    expect(config({ XBOOKMARKS_EVAL_CATEGORIZERS: 'yes' }).evalCategorizers).toBe('off');
    expect(config({ XBOOKMARKS_EVAL_CATEGORIZERS: ' typesafe ' }).evalCategorizers).toBe('typesafe');
  });

  it('is NOT turned on by selecting the Jev categorizer for real syncs', () => {
    // Two different decisions. Running paid syncs must not silently authorize a
    // second, full-library paid pass.
    expect(config({ XBOOKMARKS_CATEGORIZER: 'typesafe' }).evalCategorizers).toBe('off');
  });

  it('refuses while off, even with a key sitting in the environment', () => {
    expect(() => buildEvalJev(config({}), store({ TYPESAFE_API_KEY: 'k' }))).toThrow(
      /comparison is off/,
    );
  });

  it('checks the opt-in BEFORE the key, so a leftover key can never open the gate', () => {
    const credentials = store({ TYPESAFE_API_KEY: 'k' });

    expect(() => requireEvalCategorizersCredentials(config({}), credentials)).toThrow();
    // The refusal happened without the key ever being looked at.
    expect(credentials.reads).toEqual([]);
  });

  it('refuses with the opt-in but no resolvable key', () => {
    expect(() =>
      buildEvalJev(config({ XBOOKMARKS_EVAL_CATEGORIZERS: 'typesafe' }), store()),
    ).toThrow(/TYPESAFE_API_KEY/);
  });

  it('builds the asker and a zeroed usage tally once both gates pass', () => {
    const built = buildEvalJev(
      config({ XBOOKMARKS_EVAL_CATEGORIZERS: 'typesafe' }),
      store({ TYPESAFE_API_KEY: 'k' }),
    );

    expect(built.asker).toBeDefined();
    expect(built.usage).toEqual({ requests: 0, inputTokens: 0 });
  });
});

describe('reportEvalBilling', () => {
  function lines(env: NodeJS.ProcessEnv): string {
    const out: string[] = [];
    const cfg = config(env);
    reportEvalBilling(cfg, createLlmFactory(cfg, env), (m) => out.push(m));
    return out.join('\n');
  }

  it('states the per-token price of the Jev half and the way out, before any call', () => {
    const text = lines({ XBOOKMARKS_EVAL_CATEGORIZERS: 'typesafe' });

    expect(text).toContain('pay-per-token');
    expect(text).toContain('XBOOKMARKS_EVAL_CATEGORIZERS');
  });

  it('names the free Claude half too, so the price is not read as the whole run', () => {
    const text = lines({ XBOOKMARKS_EVAL_CATEGORIZERS: 'typesafe' });

    expect(text).toContain('claude-cli');
    expect(text).toContain('Taxonomy design');
  });

  it('names the Jev model override, so the owner sees what they are billed for', () => {
    expect(
      lines({ XBOOKMARKS_EVAL_CATEGORIZERS: 'typesafe', XBOOKMARKS_TYPESAFE_MODEL: 'jev-preview' }),
    ).toContain('jev-preview');
  });

  it('promises the library is untouched, which is the whole premise of the command', () => {
    expect(lines({ XBOOKMARKS_EVAL_CATEGORIZERS: 'typesafe' })).toContain('never modified');
  });
});
