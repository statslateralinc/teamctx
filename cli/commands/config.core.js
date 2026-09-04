import { readConfig, writeConfig } from '../../src/storage.js';
import { getModelsFor, getDefaultModelFor } from '../../src/ai.js';
import { resolveActor } from '../../src/actor.js';
import { managerKeys } from '../../src/review.js';
import { repairDecision } from '../../src/manager-repair.js';
import { projectCreator } from '../../src/project-creator.js';
import { assertManager } from './review.core.js';
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

/**
 * Keys `config_set` will write.
 *
 * `manager` / `managerKey` are deliberately absent. The gate decides who may
 * approve, so a caller able to write it can grant themselves approval and sign
 * off their own submissions — which is precisely the trust a member is invited
 * with less of. It is pinned at `init` to whoever set the project up and is not
 * reachable afterwards; the branch below still handles it, and is still gated,
 * so re-exposing it is safe rather than a trap.
 */
const WRITABLE = new Set(['provider', 'model', 'githubRawBase', 'managerEmail', 'deployUrl', 'autoPush']);

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
    // `manager` is the legacy display-name field and is usually empty, so a
    // caller reading it alone reports "no manager" for a project that has one.
    // `manager` now answers the question that was asked.
    manager: c.manager || managerKeys(c)[0] || null,
    managerDisplayName: c.manager || null,
    managerKey: c.managerKey || null, managerKeys: managerKeys(c), managerEmail: c.managerEmail || '',
    deployUrl: c.deployUrl || '', githubRawBase: c.githubRawBase || '',
    autoPush: !!c.autoPush,
    workstreams: c.workstreams || [], roles: c.roles || [],
  };
}

/**
 * Re-pin a manager gate that nobody can match.
 *
 * Deliberately not routed through `setConfig`: `managerKey` is off `WRITABLE`
 * so that no caller can set the gate (see #49), and it must stay that way. This
 * is the one narrow exception, and it carries its own precondition — the gate
 * must already be one nobody can pass — rather than borrowing a general write
 * path that would then be a general write path.
 *
 * Safe on either surface because the check is on *who is asking*, not on which
 * credential carried the request: a member reaching the repo on the project's
 * lent token still is not the person who created it. The creator comes from the
 * repository — `git log` locally, the commits API when hosted, since a hosted
 * caller has no clone to read.
 */
export async function repairManagerGate({ teamctxDir, projectDir } = {}) {
  const config = readConfig(teamctxDir);
  const actor = await resolveActor({ config, cwd: projectDir });
  const displayName = await resolveDisplayName({ actor, config, teamctxDir });
  const decision = repairDecision({
    config, actor, displayName,
    creatorEmail: await projectCreator(projectDir),
  });
  if (!decision.ok) throw new InvalidConfigValueError(decision.why);

  writeConfig({ ...config, managerKey: decision.to, managerKeys: [], manager: '' }, teamctxDir);
  return { from: decision.from, to: decision.to, name: actor.name };
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
        key, value: restored.name, cleared: true, wroteRepo: false,
        notes: [`override cleared — your name is derived again (from: ${restored.source}).`],
      };
    }
    await writePrefs(actor, { name: v }, teamctxDir);
    return { key, value: v, cleared: false, wroteRepo: false, notes: ['personal setting — stored against you, not written to the repo.'] };
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
    // Unreachable while `manager` is off WRITABLE, and gated regardless: the
    // check belongs with the branch it protects, not with whatever exposes it.
    // The empty gate is the bootstrap case — a project with no manager yet is
    // how the first one gets set.
    if (managerKeys(config).length > 0 || config.manager) {
      assertManager(config, {
        actor,
        displayName: await resolveDisplayName({ actor, config, teamctxDir }),
      });
    }
    const raw = value === '' || value === '""' || value === "''" ? '' : String(value).trim();
    const actor = await resolveActor({ config, cwd: projectDir });

    if (!raw) {
      next.manager = '';
      next.managerKey = '';
      next.managerKeys = [];
      notes.push('manager gate cleared — anyone may approve or reject.');
    } else if (raw.startsWith('--add')) {
      // The same person is a different key depending on how they connected: a
      // clone knows them as git:<email>, the hosted server as github:<id>.
      // Without this, setting the gate from a laptop locks you out of your own
      // project from a chat client — which is where the work now happens.
      //
      // `--add <ref>` rather than only `--add-me`, because the identity you
      // need to add is usually the one you are *not* currently using: adding it
      // from the surface it belongs to would require already being recognised
      // there, which is the lockout itself. Authorising the add on the surface
      // where you are recognised is what breaks that circle.
      const explicit = raw === '--add-me' || raw === 'add-me' ? '' : raw.replace(/^--add[= ]?/, '').trim();
      const ref = explicit || actor.key;
      if (explicit && !(explicit.includes(':') || explicit.startsWith('@'))) {
        throw new Error(`"${explicit}" is not an identity — use github:<id>, git:<email> or @login.`);
      }
      const existing = managerKeys(next);
      if (existing.length === 0) {
        next.managerKey = ref;
        notes.push(`gate pinned to ${ref}.`);
      } else if (existing.includes(ref)) {
        notes.push(`${ref} is already on the gate — nothing to do.`);
      } else {
        next.managerKeys = [...existing.slice(1), ref];
        notes.push(`${ref} added to the gate, which now recognises ${existing.length + 1} identities for the manager.`);
      }
      next.manager = '';
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
  return { key, value: next[key], wroteRepo: true, notes };
}

export { PROVIDER_KEYS };
