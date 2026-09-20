import { describe, it, expect } from 'vitest';
import { SyncRunner, MAX_MESSAGES } from './sync';
import type { IngestSummary } from '../ingest';

const summary: IngestSummary = { newBookmarks: 3, batches: 1, nodesCreated: 2 };

/** Let the runner's detached promise settle without waiting on wall-clock time. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('SyncRunner', () => {
  it('starts idle with nothing to report', () => {
    const runner = new SyncRunner(async () => summary);
    expect(runner.status()).toMatchObject({ state: 'idle', messages: [], summary: null, error: null });
  });

  it('returns immediately, leaving the job running in the background', async () => {
    let release = () => {};
    const runner = new SyncRunner(
      () => new Promise<IngestSummary>((resolve) => (release = () => resolve(summary))),
    );

    const { started, status } = runner.start();
    expect(started).toBe(true);
    // The starting call did NOT wait for the job: that is what keeps the UI free.
    expect(status.state).toBe('running');

    release();
    await settle();
    expect(runner.status().state).toBe('done');
  });

  it('records the ingest logger output verbatim as progress, and the summary at the end', async () => {
    const runner = new SyncRunner(async (log) => {
      log('Found 3 new bookmark(s).');
      log('   Stored batch 1/1 (3 bookmark(s)).   ');
      log('  '); // blank lines are not progress
      return summary;
    });
    runner.start();
    await settle();

    const status = runner.status();
    expect(status.state).toBe('done');
    expect(status.messages).toEqual([
      'Found 3 new bookmark(s).',
      'Stored batch 1/1 (3 bookmark(s)).',
    ]);
    expect(status.summary).toEqual(summary);
    expect(status.finishedAt).not.toBeNull();
  });

  it('refuses a second start while one is running, handing back the running progress', async () => {
    let release = () => {};
    const runner = new SyncRunner(
      (log) =>
        new Promise<IngestSummary>((resolve) => {
          log('Connecting to X...');
          release = () => resolve(summary);
        }),
    );
    runner.start();

    const second = runner.start();
    expect(second.started).toBe(false);
    expect(second.status.state).toBe('running');
    expect(second.status.messages).toEqual(['Connecting to X...']);

    release();
    await settle();
    // Once finished, a new run is allowed again.
    expect(runner.start().started).toBe(true);
  });

  it("surfaces a failure as the job's own actionable message, not a generic one", async () => {
    const runner = new SyncRunner(async () => {
      throw new Error('Missing credential: XBOOKMARKS_CLIENT_ID.');
    });
    runner.start();
    await settle();

    const status = runner.status();
    expect(status.state).toBe('error');
    expect(status.error).toBe('Missing credential: XBOOKMARKS_CLIENT_ID.');
    expect(status.summary).toBeNull();
  });

  it('keeps progress bounded, retaining the tail a large first run ends on', async () => {
    const runner = new SyncRunner(async (log) => {
      for (let i = 0; i < MAX_MESSAGES + 50; i++) log(`line ${i}`);
      return summary;
    });
    runner.start();
    await settle();

    const { messages } = runner.status();
    expect(messages).toHaveLength(MAX_MESSAGES);
    expect(messages[messages.length - 1]).toBe(`line ${MAX_MESSAGES + 49}`);
  });

  it('clears the previous run before the next one, so stale progress is never shown', async () => {
    let run = 0;
    const runner = new SyncRunner(async (log) => {
      run += 1;
      await settle();
      log(`run ${run}`);
      return summary;
    });
    runner.start();
    await settle();
    await settle();
    expect(runner.status().messages).toEqual(['run 1']);
    expect(runner.status().summary).toEqual(summary);

    // The second start wipes the first run's progress and result up front, so
    // the UI never renders last week's batch lines under a fresh spinner.
    runner.start();
    expect(runner.status().messages).toEqual([]);
    expect(runner.status().summary).toBeNull();
    expect(runner.status().finishedAt).toBeNull();
  });
});
