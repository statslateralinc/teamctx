import * as anthropic from './anthropic.js';

const PROVIDERS = { anthropic };

export function getProvider(config = {}) {
  const id = config.provider || 'anthropic';
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

export function knownProviderIds() {
  return Object.keys(PROVIDERS);
}
