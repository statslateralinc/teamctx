import { readConfig, writeConfig } from '../../src/storage.js';
import { getModelsFor, getDefaultModelFor } from '../../src/ai.js';

const ALIASES = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
};

const PROVIDER_KEYS = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

const WRITABLE = new Set(['provider', 'model', 'githubRawBase', 'manager', 'managerEmail', 'deployUrl', 'autoPush']);

export class UnknownConfigKeyError extends Error {
  constructor(key) { super(`unknown config key "${key}". Writable: ${[...WRITABLE].join(', ')}.`); this.code = 'UNKNOWN_CONFIG_KEY'; }
}
export class InvalidConfigValueError extends Error {
  constructor(msg) { super(msg); this.code = 'INVALID_CONFIG_VALUE'; }
}

export function getConfig({ teamctxDir } = {}) {
  const c = readConfig(teamctxDir);
  return {
    project: c.project, me: c.me, provider: c.provider || 'anthropic', model: c.model,
    manager: c.manager || null, managerEmail: c.managerEmail || '',
    deployUrl: c.deployUrl || '', githubRawBase: c.githubRawBase || '',
    autoPush: !!c.autoPush, activeWorkstream: c.activeWorkstream || 'main',
    workstreams: c.workstreams || [], roles: c.roles || [],
  };
}

export function setConfig({ key, value, teamctxDir } = {}) {
  if (!WRITABLE.has(key)) throw new UnknownConfigKeyError(key);
  const config = readConfig(teamctxDir);
  const next = { ...config };
  const notes = [];

  if (key === 'provider') {
    const v = String(value).toLowerCase();
    if (!PROVIDER_KEYS[v]) throw new InvalidConfigValueError(`unknown provider "${value}". Valid: ${Object.keys(PROVIDER_KEYS).join(', ')}.`);
    next.provider = v;
    const currentModel = config.model;
    const knownForNew = getModelsFor(v);
    if (!knownForNew.some(m => m.id === currentModel)) {
      next.model = getDefaultModelFor(v);
      notes.push(`model reset to ${next.model} (was "${currentModel}", not valid for ${v}).`);
    }
    if (!process.env[PROVIDER_KEYS[v]]) {
      notes.push(`${PROVIDER_KEYS[v]} is not set in the environment.`);
    }
  } else if (key === 'model') {
    const providerId = config.provider || 'anthropic';
    const models = getModelsFor(providerId);
    const resolved = ALIASES[String(value).toLowerCase()] || String(value);
    if (models.length && !models.find(m => m.id === resolved)) {
      notes.push(`"${resolved}" is not in the known model list for ${providerId} (accepted anyway).`);
    }
    next.model = resolved;
  } else if (key === 'manager') {
    const v = value === '' || value === '""' || value === "''" ? '' : String(value);
    next.manager = v;
    if (v && config.me !== v) notes.push(`your current identity (${config.me}) will no longer be able to approve/reject.`);
  } else if (key === 'autoPush') {
    next.autoPush = value === true || value === 'true' || value === 'y' || value === 'yes' || value === 1;
  } else {
    next[key] = String(value);
  }

  writeConfig(next, teamctxDir);
  return { key, value: next[key], notes };
}

export { PROVIDER_KEYS };
