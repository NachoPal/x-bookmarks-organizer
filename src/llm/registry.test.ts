import { describe, it, expect } from 'vitest';
import { getProvider, listProviders, providerIds, registerProvider } from './registry';
import { claudeCliProvider } from './providers';

describe('provider registry', () => {
  it('resolves the claude-cli provider by id', () => {
    const provider = getProvider('claude-cli');
    expect(provider).toBe(claudeCliProvider);
    expect(provider?.billing).toBe('subscription');
  });

  it('lists claude-cli and returns undefined for an id nobody registered', () => {
    expect(providerIds()).toContain('claude-cli');
    expect(listProviders().map((p) => p.id)).toContain('claude-cli');
    expect(getProvider('nope-api')).toBeUndefined();
  });

  it('accepts a newly registered provider', () => {
    registerProvider({ ...claudeCliProvider, id: 'claude-cli-clone' });
    expect(getProvider('claude-cli-clone')?.id).toBe('claude-cli-clone');
  });

  it('declares CLAUDE_CODE_OAUTH_TOKEN as optional - a logged-in CLI needs no token', () => {
    const token = claudeCliProvider.configKeys.find((k) => k.key === 'CLAUDE_CODE_OAUTH_TOKEN');
    expect(token?.required).toBe(false);
    expect(token?.secret).toBe(true);
    expect(claudeCliProvider.configKeys.every((k) => !k.required)).toBe(true);
  });
});
