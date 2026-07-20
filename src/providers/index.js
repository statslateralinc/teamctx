import * as anthropic from './anthropic.js';
import * as openai from './openai.js';
import * as gemini from './gemini.js';

const PROVIDERS = { anthropic, openai, gemini };

export function getProvider(config = {}) {
  const id = config.provider || 'anthropic';
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

export function knownProviderIds() {
  return Object.keys(PROVIDERS);
}
