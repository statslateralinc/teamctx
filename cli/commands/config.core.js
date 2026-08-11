import { readConfig, writeConfig } from '../../src/storage.js';
import { getModelsFor, getDefaultModelFor } from '../../src/ai.js';
import { resolveActor } from '../../src/actor.js';
import { writePrefs, resolveDisplayName, resolveIdentity, resolveActiveWorkstream } from '../../src/prefs.js';

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

const WRITABLE = new Set(['provider', 'model', 'githubRawBase', 'manager', 'managerKey', 'managerEmail', 'deployUrl', 'autoPush']);

/**
 * Keys that describe the person rather than the project. They are stored
 * against the caller (see src/prefs.js) and never written to the repo, so one
 * teammate setting them does not change what anyone else sees.
 */
const PERSONAL = new Set(['name']);

export class UnknownConfigKeyError extends Error {
  constructor(key) { super(`unknown config key "${key}". Writable: ${[...WRITABLE, ...PERSONAL].join(', ')}.`); this.code = 'UNKNOWN_CONFIG_KEY'; }
}
export class InvalidConfigValueError extends Error {
  constructor(msg) { super(msg); this.code = 'INVALID_CONFIG_VALUE'; }
}

export async function getConfig({ teamctxDir, projectDir } = {}) {
  const c = readConfig(teamctxDir);
  const actor = await resolveActor({ config: c, cwd: projectDir });
  return {
    me: await resolveDisplayName({ actor, config: c, teamctxDir }),
    activeWorkstream: await resolveActiveWorkstream({ actor, config: c, teamctxDir }),
    projectDefaults: { me: c.me, activeWorkstream: c.activeWorkstream || 'main' },
    project: c.project, provider: c.provider || 'anthropic', model: c.model,
    manager: c.manager || null, managerKey: c.managerKey || null, managerEmail: c.managerEmail || '',
    deployUrl: c.deployUrl || '', githubRawBase: c.githubRawBase || '',
    autoPush: !!c.autoPush,
    workstreams: c.workstreams || [], roles: c.roles || [],
  };
}

export async function setConfig({ key, value, teamctxDir, projectDir } = {}) {
  if (PERSONAL.has(key)) {
    const config = readConfig(teamctxDir);
    const actor = await resolveActor({ config, cwd: projectDir });
    // Empty clears the override, so the name goes back to being derived from
    // the caller's identity — and keeps following it if that identity changes.
    const raw = value === null || value === undefined ? '' : String(value);
    const v = (raw === '""' || raw === "''" ? '' : raw).trim();
    if (!v) {
      await writePrefs(actor, { name: null }, teamctxDir);
      const restored = await resolveIdentity({ actor, config, teamctxDir });
      return {
        key, value: restored.name, cleared: true,
        notes: [`override cleared — your name is derived again (from: ${restored.source}).`],
      };
    }
    await writePrefs(actor, { name: v }, teamctxDir);
    return { key, value: v, cleared: false, notes: ['personal setting — stored against you, not written to the repo.'] };
  }
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
  } else if (key === 'manager' || key === 'managerKey') {
    const raw = value === '' || value === '""' || value === "''" ? '' : String(value).trim();
    const actor = await resolveActor({ config, cwd: projectDir });

    if (!raw) {
      next.manager = '';
      next.managerKey = '';
      notes.push('manager gate cleared — anyone may approve or reject.');
    } else if (raw === '--me' || raw === 'me' || key === 'managerKey') {
      // Pin the gate to a stable identity. `--me` means whoever is running this.
      const ref = (raw === '--me' || raw === 'me') ? actor.key : raw;
      next.managerKey = ref;
      next.manager = '';
      notes.push(`gate pinned to ${ref}. Display names no longer grant approval.`);
    } else if (raw.startsWith('@') || raw.includes(':')) {
      next.managerKey = raw;
      next.manager = '';
      notes.push(`gate pinned to ${raw}.`);
    } else {
      // Legacy: a bare display name. Kept working so existing projects do not
      // break, but anyone can set that name as their own, so it is advisory.
      next.manager = raw;
      next.managerKey = '';
      const you = await resolveDisplayName({ actor, config, teamctxDir });
      notes.push('a display name is not a secure gate — anyone can set that name as their own. Prefer `managerKey` (or `manager --me`).');
      if (you !== raw) notes.push(`your current identity (${you}) will no longer be able to approve/reject.`);
    }
  } else if (key === 'autoPush') {
    next.autoPush = value === true || value === 'true' || value === 'y' || value === 'yes' || value === 1;
  } else {
    next[key] = String(value);
  }

  writeConfig(next, teamctxDir);
  return { key, value: next[key], notes };
}

export { PROVIDER_KEYS };
