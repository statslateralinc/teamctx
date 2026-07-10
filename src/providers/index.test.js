import { describe, it, expect } from 'vitest';
import { getProvider, knownProviderIds } from './index.js';

describe('getProvider', () => {
  it('returns anthropic when config.provider is missing', () => {
    expect(getProvider({}).id).toBe('anthropic');
  });

  it('returns anthropic when no config is passed at all', () => {
    expect(getProvider().id).toBe('anthropic');
  });

  it('returns anthropic when explicitly requested', () => {
    expect(getProvider({ provider: 'anthropic' }).id).toBe('anthropic');
  });

  it('returns openai', () => {
    expect(getProvider({ provider: 'openai' }).id).toBe('openai');
  });

  it('returns gemini', () => {
    expect(getProvider({ provider: 'gemini' }).id).toBe('gemini');
  });

  it('throws with a clear message on unknown provider', () => {
    expect(() => getProvider({ provider: 'bogus' })).toThrow(/Unknown provider: bogus/);
  });

  it('every resolved provider exposes a complete() function', () => {
    for (const id of knownProviderIds()) {
      const provider = getProvider({ provider: id });
      expect(typeof provider.complete).toBe('function');
    }
  });
});

describe('knownProviderIds', () => {
  it('includes anthropic, openai, and gemini', () => {
    const ids = knownProviderIds();
    expect(ids).toContain('anthropic');
    expect(ids).toContain('openai');
    expect(ids).toContain('gemini');
  });
});
