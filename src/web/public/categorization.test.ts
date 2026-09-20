import { describe, it, expect } from 'vitest';

// Plain browser JS, required directly (not compiled by tsc).
const XBO = require('./categorization.js');

/** The shape `GET /api/setup` ships, trimmed to what these helpers read. */
const catalog = {
  methods: [
    { id: 'claude-cli', label: 'Claude model', description: 'Runs on your subscription.', billing: 'subscription' },
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
      expect(XBO.fieldsFor(method)).toMatchObject({ provider: true, taxonomyModel: true, effort: true });
    }
  });

  it('drops the filing model for Jev, which takes no prompt', () => {
    expect(XBO.fieldsFor('claude-cli').assignmentModel).toBe(true);
    expect(XBO.fieldsFor('typesafe').assignmentModel).toBe(false);
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
        provider: 'claude-cli',
        taxonomyModel: '',
        assignmentModel: 'claude-haiku-4-5',
        effort: '',
      }),
    ).toEqual({
      categorizer: 'claude-cli',
      provider: 'claude-cli',
      assignmentModel: 'claude-haiku-4-5',
    });
  });

  it('never sends a filing model for Jev, which has none', () => {
    expect(
      XBO.toPayload({
        categorizer: 'typesafe',
        provider: 'claude-cli',
        taxonomyModel: 'claude-opus-4-8',
        assignmentModel: 'claude-haiku-4-5',
        effort: 'high',
      }),
    ).toEqual({
      categorizer: 'typesafe',
      provider: 'claude-cli',
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
