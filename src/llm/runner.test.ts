import { describe, it, expect } from 'vitest';
import { toRunner } from './runner';
import type { CompletionRequest, LlmClient } from './types';

function fakeClient(seen: CompletionRequest[]): LlmClient {
  return {
    providerId: 'fake',
    model: 'fake-model',
    billing: 'local',
    async complete(req) {
      seen.push(req);
      return { text: `echo:${req.prompt}`, model: 'fake-model', providerId: 'fake' };
    },
  };
}

describe('toRunner', () => {
  it('bridges a provider client to the narrow LlmRunner port', async () => {
    const seen: CompletionRequest[] = [];
    const runner = toRunner(fakeClient(seen));
    expect(await runner('hello')).toBe('echo:hello');
    expect(seen[0]?.prompt).toBe('hello');
    expect(seen[0]?.responseFormat).toBe('text');
  });

  it('passes the json hint through when the caller will parse JSON', async () => {
    const seen: CompletionRequest[] = [];
    await toRunner(fakeClient(seen), { json: true })('p');
    expect(seen[0]?.responseFormat).toBe('json');
  });
});
