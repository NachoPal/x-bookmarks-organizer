import { describe, it, expect } from 'vitest';
import { buildSettingsCatalog } from '../../settings/catalog';

// Plain browser JS, required directly (not compiled by tsc).
const XBO = require('./categorization.js');

/** The shape `GET /api/setup` ships, trimmed to what these helpers read. */
const catalog = {
  methods: [
    { id: 'claude-cli', label: 'Claude Code', description: 'Runs on your subscription.', billing: 'subscription' },
    {
      id: 'typesafe',
      label: 'Jev (TypeSafe)',
      description: 'PAID per token.',
      billing: 'per-token',
      requiresKey: 'TYPESAFE_API_KEY',
    },
  ],
  providers: [
    {
      id: 'claude-cli',
      label: 'Claude Code subscription',
      billing: 'subscription',
      models: [
        { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', description: 'Most capable.', suggestedFor: ['taxonomy'] },
        { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', description: 'Fastest.', suggestedFor: ['assignment'] },
      ],
      efforts: ['low', 'medium', 'high'],
      suggested: { taxonomy: 'claude-opus-4-8', assignment: 'claude-haiku-4-5' },
    },
  ],
};

describe('fieldsFor', () => {
  it('keeps the taxonomy model and effort live for BOTH methods', () => {
    // Pass 1 is always the model - Jev invents no labels, so it cannot design
    // a tree, which is why these fields never disappear.
    for (const method of ['claude-cli', 'typesafe']) {
      expect(XBO.fieldsFor(method)).toMatchObject({ taxonomyProvider: true, taxonomyModel: true, effort: true });
    }
  });

  it("drops the filing provider and model for Jev, which takes no prompt", () => {
    expect(XBO.fieldsFor('claude-cli')).toMatchObject({ assignmentProvider: true, assignmentModel: true });
    expect(XBO.fieldsFor('typesafe')).toMatchObject({ assignmentProvider: false, assignmentModel: false });
  });
});

describe('passProvider', () => {
  it("reads each pass's own provider", () => {
    const settings = { taxonomyProvider: 'pi-ai', assignmentProvider: 'claude-cli' };
    expect(XBO.passProvider(settings, 'taxonomy')).toBe('pi-ai');
    expect(XBO.passProvider(settings, 'assignment')).toBe('claude-cli');
  });

  it('falls back to the one provider a pre-#70 document stored for both passes', () => {
    expect(XBO.passProvider({ provider: 'claude-cli' }, 'taxonomy')).toBe('claude-cli');
    expect(XBO.passProvider({ provider: 'claude-cli' }, 'assignment')).toBe('claude-cli');
    expect(XBO.passProvider(null, 'taxonomy')).toBe('');
  });
});

describe('modelOptions', () => {
  const provider = catalog.providers[0];

  it('leads with a Recommended option that spells out what it resolves to', () => {
    const options = XBO.modelOptions(provider, 'taxonomy');
    expect(options[0]).toMatchObject({ value: '', label: 'Recommended (Claude Opus 4.8)' });
    expect(XBO.modelOptions(provider, 'assignment')[0].label).toBe('Recommended (Claude Haiku 4.5)');
  });

  it('offers every catalog model with its own one-line hint', () => {
    const options = XBO.modelOptions(provider, 'taxonomy');
    expect(options.map((o: { value: string }) => o.value)).toEqual([
      '',
      'claude-opus-4-8',
      'claude-haiku-4-5',
    ]);
    expect(options[1].hint).toBe('Most capable.');
  });
});

describe('providerNotice', () => {
  it("states a provider's billing, emphasizing only a paid one", () => {
    expect(XBO.providerNotice({ billing: 'subscription' })).toEqual({
      text: 'Runs on your Claude subscription - no per-call charge.',
      emphasis: false,
    });
    expect(XBO.providerNotice({ billing: 'per-token' })).toEqual({
      text: XBO.BILLING_HINTS['per-token'],
      emphasis: true,
    });
    expect(XBO.providerNotice(null)).toEqual({ text: '', emphasis: false });
  });

  it('puts a risk warning in place of the reassuring billing line, emphasized', () => {
    const viaPi = { billing: 'subscription', warning: "Account risk: Anthropic's terms prohibit this." };
    expect(XBO.providerNotice(viaPi)).toEqual({ text: viaPi.warning, emphasis: true });
  });
});

describe('effortOptions', () => {
  it("leads with the app's default and then the provider's own ascending levels", () => {
    const options = XBO.effortOptions(catalog.providers[0]);
    expect(options.map((o: { value: string }) => o.value)).toEqual(['', 'low', 'medium', 'high']);
  });

  it("names the level the Default entry stands for, from the catalog's defaultEffort", () => {
    expect(XBO.effortOptions(catalog.providers[0], 'medium')[0]).toMatchObject({ value: '', label: 'Default (medium)' });
    // No stated default: the entry does not guess one.
    expect(XBO.effortOptions(catalog.providers[0])[0].label).toBe('Default');
  });

  it('yields only the default entry for a provider with no effort axis', () => {
    expect(XBO.effortOptions({ id: 'x', models: [], efforts: [] })).toHaveLength(1);
  });
});

describe('Jev calls no language model', () => {
  it('shows no filing provider or model while Jev files, and no other language-model field', () => {
    expect(XBO.fieldsFor('typesafe')).toEqual({
      taxonomyProvider: true,
      taxonomyModel: true,
      effort: true,
      assignmentProvider: false,
      assignmentModel: false,
    });
    expect(XBO.fieldsFor('claude-cli')).toMatchObject({ assignmentProvider: true, assignmentModel: true });
  });

  it('never blocks Save over a language model Jev does not call', () => {
    expect(
      XBO.passProblems(
        { categorizer: 'typesafe', taxonomyProvider: 'claude-cli', assignmentProvider: 'pi-ai', fallbackProvider: 'pi-ai' },
        buildSettingsCatalog(),
        { ANTHROPIC_API_KEY: { present: false } },
        { 'claude-cli': { available: true } },
      ),
    ).toEqual([]);
  });
});

describe('toPayload', () => {
  it('sends only what the owner actually pinned', () => {
    expect(
      XBO.toPayload({
        categorizer: 'claude-cli',
        taxonomyProvider: 'pi-ai',
        taxonomyModel: '',
        assignmentProvider: 'claude-cli',
        assignmentModel: 'claude-haiku-4-5',
        effort: '',
      }),
    ).toEqual({
      categorizer: 'claude-cli',
      taxonomyProvider: 'pi-ai',
      assignmentProvider: 'claude-cli',
      assignmentModel: 'claude-haiku-4-5',
    });
  });

  it('never sends the (hidden) filing provider or model for Jev, nor an old fallback', () => {
    expect(
      XBO.toPayload({
        categorizer: 'typesafe',
        taxonomyProvider: 'claude-cli',
        taxonomyModel: 'claude-opus-4-8',
        assignmentProvider: 'pi-ai',
        assignmentModel: 'claude-haiku-4-5',
        fallbackProvider: 'claude-cli',
        fallbackModel: 'anthropic/claude-haiku-4-5',
        effort: 'high',
      }),
    ).toEqual({
      categorizer: 'typesafe',
      taxonomyProvider: 'claude-cli',
      taxonomyModel: 'claude-opus-4-8',
      effort: 'high',
    });
    // ...and never an old fallback while a language model files either.
    expect(
      XBO.toPayload({
        categorizer: 'claude-cli',
        taxonomyProvider: 'claude-cli',
        assignmentProvider: 'pi-ai',
        fallbackProvider: 'pi-ai',
        fallbackModel: 'opencode/gpt-5.1',
      }),
    ).toEqual({ categorizer: 'claude-cli', taxonomyProvider: 'claude-cli', assignmentProvider: 'pi-ai' });
  });
});

describe('methodBlocker', () => {
  it('passes a method that needs no credential', () => {
    expect(XBO.methodBlocker(catalog, 'claude-cli', {})).toBeNull();
  });

  it('names the missing key, and where the server can find it, before any sync runs', () => {
    const blocker = XBO.methodBlocker(catalog, 'typesafe', { typesafeApiKey: { present: false } });
    expect(blocker).toContain('TYPESAFE_API_KEY');
    expect(blocker).toContain('keychain');
  });

  it('clears once the server reports the key as present', () => {
    expect(XBO.methodBlocker(catalog, 'typesafe', { typesafeApiKey: { present: true } })).toBeNull();
  });
});

describe('syncBlockers', () => {
  const ready = {
    catalog,
    settings: { categorizer: 'claude-cli', provider: 'claude-cli' },
    credentials: {
      xClientId: { present: true },
      xClientSecret: { present: true },
      typesafeApiKey: { present: false },
    },
    x: { connected: true },
    sync: { available: true },
  };

  it('reports nothing when everything is in place', () => {
    expect(XBO.syncBlockers(ready)).toEqual([]);
  });

  it('names exactly which X credential the server cannot reach', () => {
    const blockers = XBO.syncBlockers({
      ...ready,
      credentials: { ...ready.credentials, xClientSecret: { present: false } },
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('XBOOKMARKS_CLIENT_SECRET');
    expect(blockers[0]).not.toContain('XBOOKMARKS_CLIENT_ID');
  });

  it('asks for authorization only once the credentials are there', () => {
    expect(XBO.syncBlockers({ ...ready, x: { connected: false } })[0]).toContain('not been authorized');
  });

  it('adds the paid method blocker on top of the rest', () => {
    const blockers = XBO.syncBlockers({
      ...ready,
      settings: { categorizer: 'typesafe', provider: 'claude-cli' },
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('TYPESAFE_API_KEY');
  });

  it("forwards the server's own reason when the viewer cannot sync at all", () => {
    const blockers = XBO.syncBlockers({
      ...ready,
      sync: { available: false, reason: 'Syncing is not available in this viewer.' },
    });
    expect(blockers).toContain('Syncing is not available in this viewer.');
  });
});

describe('progressLine', () => {
  it('shows the latest ingest log line while running', () => {
    expect(
      XBO.progressLine({ state: 'running', messages: ['Found 3 new bookmark(s).', 'Stored batch 1/1.'] }),
    ).toBe('Stored batch 1/1.');
  });

  it('says something even before the first line arrives', () => {
    expect(XBO.progressLine({ state: 'running', messages: [] })).toBe('Starting sync…');
  });

  it('summarizes a finished run in the owner\'s terms', () => {
    expect(
      XBO.progressLine({ state: 'done', summary: { newBookmarks: 4, batches: 1, nodesCreated: 2 } }),
    ).toBe('Synced 4 new bookmarks into 2 new categories.');
    expect(
      XBO.progressLine({ state: 'done', summary: { newBookmarks: 1, batches: 1, nodesCreated: 0 } }),
    ).toBe('Synced 1 new bookmark.');
  });

  it('says plainly when there was nothing new', () => {
    expect(
      XBO.progressLine({ state: 'done', summary: { newBookmarks: 0, batches: 0, nodesCreated: 0 } }),
    ).toBe('Up to date - no new bookmarks.');
  });

  it("shows the failure's own message, not a generic one", () => {
    expect(XBO.progressLine({ state: 'error', error: 'Missing credential: X.' })).toBe(
      'Missing credential: X.',
    );
  });
});

describe('needsAuthorizationOnly', () => {
  const creds = { xClientId: { present: true }, xClientSecret: { present: true } };

  it('is true when the credentials are there and only the consent is missing', () => {
    expect(
      XBO.needsAuthorizationOnly({ credentials: creds, x: { connected: false, canConnect: true } }),
    ).toBe(true);
  });

  it('is false once authorized', () => {
    expect(
      XBO.needsAuthorizationOnly({ credentials: creds, x: { connected: true, canConnect: true } }),
    ).toBe(false);
  });

  it('is false when a credential is missing - the guided flow cannot fix that', () => {
    expect(
      XBO.needsAuthorizationOnly({
        credentials: { ...creds, xClientSecret: { present: false } },
        x: { connected: false, canConnect: true },
      }),
    ).toBe(false);
  });

  it('is false when the viewer cannot run the consent flow at all', () => {
    expect(
      XBO.needsAuthorizationOnly({ credentials: creds, x: { connected: false, canConnect: false } }),
    ).toBe(false);
  });
});

describe('emptyStateKind', () => {
  it('shows the guided first run when the library has no bookmarks', () => {
    expect(XBO.emptyStateKind(0, null)).toBe('first-run');
    expect(XBO.emptyStateKind(0, 5)).toBe('first-run');
  });
  it('keeps the plain prompt when there are bookmarks but no selection', () => {
    expect(XBO.emptyStateKind(12, null)).toBe('select-category');
  });
  it('leaves the pane to the category when one is selected', () => {
    expect(XBO.emptyStateKind(12, 3)).toBe('none');
  });
  it('does not guess before the setup payload has arrived', () => {
    expect(XBO.emptyStateKind(undefined, null)).toBe('none');
  });
});

describe('showFilterTabs (#95)', () => {
  it('shows the bar for an open category in a stocked library', () => {
    expect(XBO.showFilterTabs(12, 3)).toBe(true);
  });

  it('hides it in the "select a category" state - absent, not zeroed', () => {
    expect(XBO.showFilterTabs(12, null)).toBe(false);
  });

  it('hides it in the never-synced first run', () => {
    expect(XBO.showFilterTabs(0, null)).toBe(false);
  });

  it('hides it right after a reset, even with the old category still selected', () => {
    // A reset empties the library; there is nothing left for a tab to filter,
    // so no stale badge can survive it.
    expect(XBO.showFilterTabs(0, 3)).toBe(false);
  });

  it('still shows it for an open category when the count is unknown', () => {
    // The viewer could not reach its own server: the tabs are correct for
    // whatever is rendered, which is all the bar claims.
    expect(XBO.showFilterTabs(undefined, 3)).toBe(true);
  });
});

/** A provider with a full catalog, shaped like pi-ai in `GET /api/setup`. */
const pi = {
  id: 'pi-ai',
  label: 'pi-ai',
  billing: 'per-token',
  models: [
    { id: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8 (Anthropic API)', suggestedFor: ['taxonomy'] },
    { id: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5 (Anthropic API)', suggestedFor: ['assignment'] },
    { id: 'openrouter/google/gemini-2.5-flash', label: 'Gemini 2.5 Flash (OpenRouter)', suggestedFor: [] },
  ],
  sources: [
    { id: 'anthropic', label: 'Anthropic API', kind: 'direct', billing: 'per-token', requiresKey: 'ANTHROPIC_API_KEY' },
    { id: 'openrouter', label: 'OpenRouter', kind: 'gateway', billing: 'per-token', requiresKey: 'OPENROUTER_API_KEY' },
    { id: 'opencode', label: 'OpenCode Zen', kind: 'gateway', billing: 'per-token', requiresKey: 'OPENCODE_API_KEY' },
    { id: 'local', label: 'Local endpoint', kind: 'local', billing: 'local', freeform: true },
  ],
  efforts: [],
  suggested: { taxonomy: 'anthropic/claude-opus-4-8', assignment: 'anthropic/claude-haiku-4-5' },
};
const piCatalog = { methods: catalog.methods, providers: [...catalog.providers, pi] };

const orModels = [
  { id: 'openrouter/z-ai/glm-5', label: 'Z.ai: GLM 5', suggestedFor: [], contextWindow: 202_752, price: { input: 0.6, output: 2.2 } },
  { id: 'openrouter/google/gemini-2.5-flash', label: 'Google: Gemini 2.5 Flash', suggestedFor: [], contextWindow: 1_048_576, price: { input: 0.3, output: 2.5 } },
  { id: 'openrouter/google/gemini-2.5-pro', label: 'Google: Gemini 2.5 Pro', suggestedFor: ['taxonomy'], contextWindow: 1_048_576, price: { input: 1.25, output: 10 } },
];

describe('catalog sources (the full pi catalog)', () => {
  it('reads a model id\'s source off its prefix, and nothing else', () => {
    expect(XBO.sourceOfModel(pi, 'openrouter/google/gemini-2.5-flash').id).toBe('openrouter');
    expect(XBO.sourceOfModel(pi, 'bedrock/x')).toBeNull();
    expect(XBO.sourceOfModel(pi, 'opencode/')).toBeNull();
    expect(XBO.sourceOfModel(pi, 'claude-opus-4-8')).toBeNull();
  });

  it('opens a pass on its model\'s source, else on the one hosting the suggestion', () => {
    expect(XBO.passSource(pi, 'taxonomy', 'opencode/kimi-k2')).toBe('opencode');
    expect(XBO.passSource(pi, 'taxonomy', '')).toBe('anthropic');
    expect(XBO.passSource({ ...pi, suggested: {} }, 'taxonomy', '')).toBe('anthropic');
  });

  it('matches every typed term against the name or the id, case-insensitively', () => {
    const m = orModels[1];
    expect(XBO.matchesQuery(m, 'GEMINI flash')).toBe(true);
    expect(XBO.matchesQuery(m, 'google/gemini')).toBe(true);
    expect(XBO.matchesQuery(m, 'gemini pro')).toBe(false);
    expect(XBO.matchesQuery(m, '   ')).toBe(true);
  });

  it('states context and price per model, and a $0 listing as such', () => {
    expect(XBO.modelMeta(orModels[1])).toBe('1.05M context · $0.30 in · $2.50 out');
    expect(XBO.modelMeta({ contextWindow: 200_000, price: { input: 0, output: 0 } })).toBe(
      '200k context · listed at $0 per token',
    );
  });

  it('orders the picker: the provider\'s picks on this source first, then the catalog as listed', () => {
    const entries = XBO.pickerEntries(pi, 'openrouter', orModels, 'assignment', '');
    expect(entries.map((e: { value: string }) => e.value)).toEqual([
      'openrouter/google/gemini-2.5-flash',
      'openrouter/z-ai/glm-5',
      'openrouter/google/gemini-2.5-pro',
    ]);
    // No "Recommended" here: pass 2's suggestion lives on another source.
    expect(entries.some((e: { value: string }) => e.value === '')).toBe(false);
    const pro = XBO.pickerEntries(pi, 'openrouter', orModels, 'taxonomy', 'pro');
    expect(pro).toHaveLength(1);
    expect(pro[0].badge).toBe('Suggested for tree design');
  });

  it('offers "Recommended" only on the source that hosts the suggestion', () => {
    const models = [{ id: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8', suggestedFor: ['taxonomy'] }];
    const entries = XBO.pickerEntries(pi, 'anthropic', models, 'taxonomy', '');
    expect(entries[0]).toMatchObject({ value: '', label: 'Recommended: Claude Opus 4.8 (Anthropic API)' });
    expect(XBO.pickerEntries(pi, 'anthropic', models, 'taxonomy', 'recommended')[0].value).toBe('');
    expect(XBO.pickerEntries(pi, 'anthropic', models, 'taxonomy', 'zzz')).toEqual([]);
  });

  it('says in words whether a source\'s key is there - browsing never needs it', () => {
    const [anthropic, , opencode, local] = pi.sources;
    expect(XBO.sourceNotice(opencode, {})).toMatchObject({ state: 'missing' });
    expect(XBO.sourceNotice(opencode, {}).text).toMatch(/^Needs OPENCODE_API_KEY - not found\. PAID per token/);
    expect(XBO.sourceNotice(opencode, {}).text).toContain('You can still browse and pick a model.');
    expect(XBO.sourceNotice(anthropic, { ANTHROPIC_API_KEY: { present: true, source: 'keychain' } })).toEqual({
      text: 'ANTHROPIC_API_KEY found (keychain). PAID per token, billed to your Anthropic API key.',
      state: 'present',
    });
    expect(XBO.sourceNotice(local, {}).state).toBe('none');
    expect(XBO.sourceNotice(null, {})).toEqual({ text: '', state: 'none' });
  });

  it('flags a source with no model picked, and a missing key - both block a save', () => {
    const values = {
      categorizer: 'claude-cli',
      taxonomyProvider: 'pi-ai',
      taxonomyModel: '',
      taxonomySource: 'opencode',
      assignmentProvider: 'pi-ai',
      assignmentModel: 'openrouter/google/gemini-2.5-flash',
      assignmentSource: 'openrouter',
    };
    const problems = XBO.passProblems(values, piCatalog, {});
    expect(problems).toEqual([
      { text: 'Phase 1: choose a model from OpenCode Zen.', blocksSave: true },
      expect.objectContaining({ blocksSave: true }),
    ]);
    expect(problems[1].text).toMatch(/^Phase 2 runs on OpenRouter, which needs OPENROUTER_API_KEY\./);

    // Recommended on its own source is a real choice; its key is what counts.
    const recommended = { ...values, taxonomySource: 'anthropic' };
    const keys = { ANTHROPIC_API_KEY: { present: true }, OPENROUTER_API_KEY: { present: true } };
    expect(XBO.passProblems(recommended, piCatalog, keys)).toEqual([]);

    // Jev has no filing model, so pass 2 is never judged.
    expect(XBO.passProblems({ ...recommended, categorizer: 'typesafe' }, piCatalog, {})).toHaveLength(1);
    // A local source needs a typed name.
    expect(XBO.passProblems({ ...values, taxonomySource: 'local' }, piCatalog, keys)[0].text).toBe(
      'Phase 1: type the model name your local server serves.',
    );
  });

  it('leaves a provider with no catalog out of all of it', () => {
    const values = { categorizer: 'claude-cli', taxonomyProvider: 'claude-cli', assignmentProvider: 'claude-cli' };
    expect(XBO.passProblems(values, piCatalog, {})).toEqual([]);
    expect(XBO.sourcesOf(catalog.providers[0])).toEqual([]);
  });
});

describe('hasSaveBlocker', () => {
  it('disables Save for exactly the conditions passProblems marks blocksSave: true', () => {
    const values = {
      categorizer: 'claude-cli',
      taxonomyProvider: 'pi-ai',
      taxonomyModel: '',
      taxonomySource: 'opencode',
      assignmentProvider: 'pi-ai',
      assignmentModel: 'openrouter/google/gemini-2.5-flash',
      assignmentSource: 'openrouter',
    };
    const keys = { OPENROUTER_API_KEY: { present: true } };
    expect(XBO.hasSaveBlocker(values, piCatalog, keys)).toBe(true);
  });

  it('disables Save when a chosen provider/source needs a key the server reports absent (reversed from #120)', () => {
    const values = {
      categorizer: 'claude-cli',
      taxonomyProvider: 'pi-ai',
      taxonomyModel: 'anthropic/claude-opus-4-8',
      taxonomySource: 'anthropic',
      assignmentProvider: 'pi-ai',
      assignmentModel: 'openrouter/google/gemini-2.5-flash',
      assignmentSource: 'openrouter',
    };
    // Both passes name a real model, but neither key is present.
    expect(XBO.hasSaveBlocker(values, piCatalog, {})).toBe(true);
  });

  it('re-enables once the missing key becomes present', () => {
    const values = {
      categorizer: 'claude-cli',
      taxonomyProvider: 'pi-ai',
      taxonomyModel: 'anthropic/claude-opus-4-8',
      taxonomySource: 'anthropic',
      assignmentProvider: 'pi-ai',
      assignmentModel: 'openrouter/google/gemini-2.5-flash',
      assignmentSource: 'openrouter',
    };
    expect(XBO.hasSaveBlocker(values, piCatalog, {})).toBe(true);
    const keys = { ANTHROPIC_API_KEY: { present: true }, OPENROUTER_API_KEY: { present: true } };
    expect(XBO.hasSaveBlocker(values, piCatalog, keys)).toBe(false);
  });

  it('re-enables once a keyless provider (claude-cli) is chosen instead', () => {
    const values = {
      categorizer: 'claude-cli',
      taxonomyProvider: 'pi-ai',
      taxonomyModel: 'anthropic/claude-opus-4-8',
      taxonomySource: 'anthropic',
      assignmentProvider: 'claude-cli',
    };
    expect(XBO.hasSaveBlocker(values, piCatalog, {})).toBe(true);
    const switched = { ...values, taxonomyProvider: 'claude-cli', taxonomyModel: 'claude-opus-4-8' };
    expect(XBO.hasSaveBlocker(switched, piCatalog, {})).toBe(false);
  });

  it('re-enables the instant an incomplete selection becomes valid again', () => {
    const blocked = {
      categorizer: 'claude-cli',
      taxonomyProvider: 'pi-ai',
      taxonomyModel: '',
      taxonomySource: 'opencode',
      assignmentProvider: 'claude-cli',
    };
    expect(XBO.hasSaveBlocker(blocked, piCatalog, {})).toBe(true);
    const fixed = {
      ...blocked,
      taxonomySource: 'anthropic',
      taxonomyModel: 'anthropic/claude-opus-4-8',
    };
    const keys = { ANTHROPIC_API_KEY: { present: true } };
    expect(XBO.hasSaveBlocker(fixed, piCatalog, keys)).toBe(false);
  });

  it('is false whenever no pass uses a catalog provider - claude-cli is never blocked for a key', () => {
    const values = { categorizer: 'claude-cli', taxonomyProvider: 'claude-cli', assignmentProvider: 'claude-cli' };
    expect(XBO.hasSaveBlocker(values, catalog, {})).toBe(false);
  });
});

describe('providerAvailability (claude-cli, issue #35 generalization)', () => {
  // claude-cli has no credential-chain key, so `providerKeys` cannot say
  // whether it can run - `providerAvailability` carries its own `check()`
  // result instead (the CLI installed and logged in, or not).
  const values = { categorizer: 'claude-cli', taxonomyProvider: 'claude-cli', assignmentProvider: 'claude-cli' };

  it('blocks Save when the CLI check reports unavailable, with the reason in the note', () => {
    const availability = { 'claude-cli': { available: false, reason: 'The `claude` CLI is not installed.' } };
    const problems = XBO.passProblems(values, catalog, {}, availability);
    expect(problems).toEqual([
      {
        text: 'Phase 1 runs on Claude Code subscription, which is not available right now: The `claude` CLI is not installed.',
        blocksSave: true,
      },
      {
        text: 'Phase 2 runs on Claude Code subscription, which is not available right now: The `claude` CLI is not installed.',
        blocksSave: true,
      },
    ]);
    expect(XBO.hasSaveBlocker(values, catalog, {}, availability)).toBe(true);
  });

  it('never blocks Save when the check reports available, or when no availability info is given at all', () => {
    const available = { 'claude-cli': { available: true } };
    expect(XBO.passProblems(values, catalog, {}, available)).toEqual([]);
    expect(XBO.hasSaveBlocker(values, catalog, {}, available)).toBe(false);
    // No `providerAvailability` argument at all (e.g. an older caller) must
    // never block - this is additive, not a new default requirement.
    expect(XBO.hasSaveBlocker(values, catalog)).toBe(false);
  });

  it('only judges the pass whose provider is actually reported', () => {
    const values2 = { categorizer: 'claude-cli', taxonomyProvider: 'claude-cli', assignmentProvider: 'claude-cli' };
    const availability = { 'some-other-provider': { available: false, reason: 'irrelevant' } };
    expect(XBO.passProblems(values2, catalog, {}, availability)).toEqual([]);
  });
});

describe('isUnchanged (issue #122, the dirty check)', () => {
  const saved = {
    categorizer: 'claude-cli',
    taxonomyProvider: 'claude-cli',
    taxonomyModel: 'claude-opus-4-8',
    assignmentProvider: 'claude-cli',
    assignmentModel: 'claude-haiku-4-5',
    effort: 'high',
  };

  it('is true when the selection matches the saved configuration exactly', () => {
    expect(XBO.isUnchanged({ ...saved }, saved)).toBe(true);
  });

  it('flips false the instant any persisted field changes, and true again on revert', () => {
    const changed = { ...saved, taxonomyModel: 'claude-haiku-4-5' };
    expect(XBO.isUnchanged(changed, saved)).toBe(false);
    expect(XBO.isUnchanged({ ...changed, taxonomyModel: saved.taxonomyModel }, saved)).toBe(true);
  });

  it('ignores a field a save never persists, such as a catalog pass source', () => {
    expect(XBO.isUnchanged({ ...saved, taxonomySource: 'anthropic' }, saved)).toBe(true);
  });

  it('never lets a stray filing-model value read as a change for Jev, which has none', () => {
    const jevSaved = {
      categorizer: 'typesafe',
      taxonomyProvider: 'claude-cli',
      taxonomyModel: '',
      assignmentProvider: 'claude-cli',
      assignmentModel: 'claude-haiku-4-5',
      effort: '',
    };
    // toPayload drops the filing model for Jev on both sides, so a leftover
    // assignmentModel value in the form must not itself read as a change.
    expect(
      XBO.isUnchanged({ ...jevSaved, fallbackProvider: 'claude-cli', assignmentModel: 'something-else' }, jevSaved),
    ).toBe(true);
  });

  it('reads a document saved with an old Jev fallback as unchanged: that field is gone', () => {
    const owner = { categorizer: 'typesafe', taxonomyProvider: 'claude-cli', fallbackProvider: 'pi-ai' };
    expect(XBO.isUnchanged({ categorizer: 'typesafe', taxonomyProvider: 'claude-cli' }, owner)).toBe(true);
  });

  it('reads the legacy single `provider` document the same as a per-pass one', () => {
    const legacy = {
      categorizer: 'claude-cli',
      provider: 'claude-cli',
      taxonomyModel: 'claude-opus-4-8',
      assignmentModel: 'claude-haiku-4-5',
      effort: 'high',
    };
    expect(XBO.isUnchanged(saved, legacy)).toBe(true);
  });

  it('is never "unchanged" from nothing - a config that has never been saved', () => {
    expect(XBO.isUnchanged(saved, null)).toBe(false);
    expect(XBO.isUnchanged(saved, undefined)).toBe(false);
  });
});

describe('passProblems / hasSaveBlocker compose with the unchanged check (issue #122)', () => {
  const values = {
    categorizer: 'claude-cli',
    taxonomyProvider: 'claude-cli',
    taxonomyModel: '',
    assignmentProvider: 'claude-cli',
    assignmentModel: '',
    effort: '',
  };

  it('adds a SILENT "No changes to save" reason and blocks Save when the selection equals the baseline', () => {
    // `silent: true` is what `updateFormNote` filters on to keep this reason
    // out of the visible note (the owner found the text ugly and pointless)
    // while `hasSaveBlocker` still disables Save - it composes on `blocksSave`
    // alone, unaffected by `silent`.
    expect(XBO.passProblems(values, catalog, {}, {}, values)).toEqual([
      { text: 'No changes to save.', blocksSave: true, silent: true },
    ]);
    expect(XBO.hasSaveBlocker(values, catalog, {}, {}, values)).toBe(true);
  });

  it('enables Save the instant the selection differs, and disables it again on revert', () => {
    const changed = { ...values, taxonomyModel: 'claude-opus-4-8' };
    expect(XBO.hasSaveBlocker(changed, catalog, {}, {}, values)).toBe(false);
    expect(XBO.hasSaveBlocker({ ...changed, taxonomyModel: values.taxonomyModel }, catalog, {}, {}, values)).toBe(
      true,
    );
  });

  it('never blocks Save for being unchanged when no baseline is given (existing callers)', () => {
    expect(XBO.hasSaveBlocker(values, catalog, {}, {})).toBe(false);
    expect(XBO.hasSaveBlocker(values, catalog, {})).toBe(false);
  });

  it('still blocks a changed-but-unsaveable selection: the invalid-choice reason composes with the unchanged one', () => {
    const invalidChange = { ...values, taxonomyProvider: 'pi-ai', taxonomySource: 'opencode', taxonomyModel: '' };
    // Differs from the baseline, so "unchanged" never fires - a catalog
    // source picked with no model in it is its own, independent blocker.
    expect(XBO.hasSaveBlocker(invalidChange, piCatalog, {}, {}, values)).toBe(true);
  });

  it('still blocks a changed-but-unrunnable selection: the missing-key reason composes too, and clears with the key', () => {
    const missingKey = {
      categorizer: 'claude-cli',
      taxonomyProvider: 'pi-ai',
      taxonomyModel: 'anthropic/claude-opus-4-8',
      taxonomySource: 'anthropic',
      assignmentProvider: 'claude-cli',
    };
    expect(XBO.hasSaveBlocker(missingKey, piCatalog, {}, {}, values)).toBe(true);
    const keyed = { ANTHROPIC_API_KEY: { present: true } };
    expect(XBO.hasSaveBlocker(missingKey, piCatalog, keyed, {}, values)).toBe(false);
  });

  it('shows both reasons at once when a saved-and-unchanged selection has since lost its key', () => {
    const saved = {
      categorizer: 'claude-cli',
      taxonomyProvider: 'pi-ai',
      taxonomyModel: 'anthropic/claude-opus-4-8',
      assignmentProvider: 'claude-cli',
      assignmentModel: '',
      effort: '',
    };
    const current = { ...saved, taxonomySource: 'anthropic' };
    const problems = XBO.passProblems(current, piCatalog, {}, {}, saved);
    expect(problems).toHaveLength(2);
    expect(problems.some((p: { text: string }) => p.text === 'No changes to save.')).toBe(true);
    expect(problems.some((p: { text: string }) => /ANTHROPIC_API_KEY/.test(p.text))).toBe(true);
  });
});

describe('filingOptions / filingSelection / applyFilingSelection (the single phase-2 selector)', () => {
  // Bug: "Method" (LLM vs Jev) and "Filing provider" used to be two
  // independently-settable fields. `buildCategorizers` (src/categorize/build.ts)
  // decides the method FIRST and ignores the assignment provider entirely
  // once the method is Jev, so a chosen LLM provider could sit on screen
  // while Jev silently ran. These three functions are what make that
  // combination structurally impossible: ONE control now owns both fields.

  it('lists Jev first, then every LLM provider - never the generic "claude-cli" method entry', () => {
    const options = XBO.filingOptions(piCatalog);
    expect(options.map((o: { value: string }) => o.value)).toEqual(['typesafe', 'claude-cli', 'pi-ai']);
    expect(options[0].label).toBe('Jev (TypeSafe)');
    expect(options[1].label).toBe('Claude Code subscription');
    expect(options[2].label).toBe('pi-ai');
  });

  it('resolves a settings document to Jev, or to its filing provider', () => {
    expect(XBO.filingSelection({ categorizer: 'typesafe', assignmentProvider: 'pi-ai' })).toBe('typesafe');
    expect(XBO.filingSelection({ categorizer: 'claude-cli', assignmentProvider: 'pi-ai' })).toBe('pi-ai');
    expect(XBO.filingSelection({ categorizer: 'claude-cli', assignmentProvider: '' })).toBe('');
    expect(XBO.filingSelection(null)).toBe('');
  });

  it('picking an LLM provider sets the language-model method AND that provider together', () => {
    expect(XBO.applyFilingSelection('pi-ai', 'claude-cli')).toEqual({
      categorizer: 'claude-cli',
      assignmentProvider: 'pi-ai',
    });
  });

  it('picking Jev sets ONLY the method - the prior provider survives for switching back', () => {
    expect(XBO.applyFilingSelection('typesafe', 'pi-ai')).toEqual({
      categorizer: 'typesafe',
      assignmentProvider: 'pi-ai',
    });
  });

  it('round-trips: whatever the selector resolves to reapplies to the same pair', () => {
    for (const values of [
      { categorizer: 'claude-cli', assignmentProvider: 'pi-ai' },
      { categorizer: 'claude-cli', assignmentProvider: 'claude-cli' },
      { categorizer: 'typesafe', assignmentProvider: 'pi-ai' },
    ]) {
      const selected = XBO.filingSelection(values);
      expect(XBO.applyFilingSelection(selected, values.assignmentProvider)).toEqual(values);
    }
  });

  it('never resolves a saved LLM-provider choice to categorizer "typesafe"', () => {
    for (const providerId of ['claude-cli', 'pi-ai']) {
      const { categorizer } = XBO.applyFilingSelection(providerId, 'typesafe-leftover');
      expect(categorizer).not.toBe('typesafe');
    }
  });
});
