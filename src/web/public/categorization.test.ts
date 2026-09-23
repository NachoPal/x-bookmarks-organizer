import { describe, it, expect } from 'vitest';

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

  it('yields only the default entry for a provider with no effort axis', () => {
    expect(XBO.effortOptions({ id: 'x', models: [], efforts: [] })).toHaveLength(1);
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

  it('never sends a filing model for Jev, which has none', () => {
    expect(
      XBO.toPayload({
        categorizer: 'typesafe',
        taxonomyProvider: 'claude-cli',
        taxonomyModel: 'claude-opus-4-8',
        assignmentProvider: 'claude-cli',
        assignmentModel: 'claude-haiku-4-5',
        effort: 'high',
      }),
    ).toEqual({
      categorizer: 'typesafe',
      taxonomyProvider: 'claude-cli',
      assignmentProvider: 'claude-cli',
      taxonomyModel: 'claude-opus-4-8',
      effort: 'high',
    });
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

  it('flags a source with no model picked (blocks a save) and a missing key (does not)', () => {
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
      expect.objectContaining({ blocksSave: false }),
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
    expect(XBO.hasSaveBlocker(values, piCatalog)).toBe(true);
  });

  it('never disables Save for a missing key alone - only a genuinely invalid selection does', () => {
    const values = {
      categorizer: 'claude-cli',
      taxonomyProvider: 'pi-ai',
      taxonomyModel: 'anthropic/claude-opus-4-8',
      taxonomySource: 'anthropic',
      assignmentProvider: 'pi-ai',
      assignmentModel: 'openrouter/google/gemini-2.5-flash',
      assignmentSource: 'openrouter',
    };
    // ANTHROPIC_API_KEY / OPENROUTER_API_KEY are both absent here, but every
    // pass names a real model, so this is a valid, saveable choice.
    expect(XBO.hasSaveBlocker(values, piCatalog)).toBe(false);
  });

  it('re-enables the instant the selection becomes valid again', () => {
    const blocked = {
      categorizer: 'claude-cli',
      taxonomyProvider: 'pi-ai',
      taxonomyModel: '',
      taxonomySource: 'opencode',
      assignmentProvider: 'claude-cli',
    };
    expect(XBO.hasSaveBlocker(blocked, piCatalog)).toBe(true);
    const fixed = { ...blocked, taxonomySource: 'anthropic' };
    expect(XBO.hasSaveBlocker(fixed, piCatalog)).toBe(false);
  });

  it('is false whenever no pass uses a catalog provider', () => {
    const values = { categorizer: 'claude-cli', taxonomyProvider: 'claude-cli', assignmentProvider: 'claude-cli' };
    expect(XBO.hasSaveBlocker(values, catalog)).toBe(false);
  });
});
