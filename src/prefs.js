import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { getCurrentSession } from './session-context.js';
import { getTeamctxDir } from './storage.js';
import { kvGet, kvSet, keys } from './oauth/kv.js';

/**
 * Per-user settings.
 *
 * Some of what lives in `.teamctx/config.json` is not a property of the project
 * at all — it is a property of the person using it. The active workstream is the
 * clearest case: it is a pointer, the same way git's HEAD is a pointer, and git
 * pointedly does not push HEAD. Committing it means one person switching
 * workstream switches it for everyone.
 *
 * So those fields move here, and never into the repo:
 *
 *   hosted MCP  → KV, keyed by actor + project
 *   CLI / stdio → <teamctxDir>/.local/prefs.json, gitignored
 *
 * Resolution order everywhere is: explicit argument → user preference →
 * project default (config.json) → built-in. The bottom two layers are exactly
 * today's behavior, so a project whose users have set no preferences behaves
 * identically to before.
 *
 * Stored shape: { name?, activeWorkstream? }
 */

const LOCAL_DIR = '.local';
const PREFS_FILE = 'prefs.json';
const IGNORE_ENTRY = '.teamctx/.local/';

/**
 * CLI callers usually omit `teamctxDir` and let the storage layer find it, so
 * mirror that here rather than making every call site pass one.
 */
function localDir(teamctxDir) {
  return typeof teamctxDir === 'string' && teamctxDir ? teamctxDir : getTeamctxDir();
}

function localPrefsPath(teamctxDir) {
  return join(localDir(teamctxDir), LOCAL_DIR, PREFS_FILE);
}

function readLocalFile(teamctxDir) {
  try {
    const parsed = JSON.parse(readFileSync(localPrefsPath(teamctxDir), 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The local file is keyed by actor rather than holding a bare settings object.
 * One clone is normally one person, but shared machines and `su` sessions exist,
 * and keying costs nothing.
 */
function readLocal(actorKey, teamctxDir) {
  const byActor = readLocalFile(teamctxDir);
  const entry = byActor[actorKey];
  return entry && typeof entry === 'object' ? entry : {};
}

function writeLocal(actorKey, next, teamctxDir) {
  const byActor = readLocalFile(teamctxDir);
  byActor[actorKey] = next;
  const file = localPrefsPath(teamctxDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(byActor, null, 2)}\n`);
  ensureGitignored(teamctxDir);
}

/**
 * Add the ignore entry when the file is first written, not at `init`.
 *
 * Anyone who clones an already-initialized project never runs `init`, so an
 * entry written there would not exist on their machine — and their personal
 * settings would be committed and pushed to the whole team.
 */
export function ensureGitignored(teamctxDir) {
  const projectDir = dirname(localDir(teamctxDir));
  const gitignorePath = join(projectDir, '.gitignore');
  let current = '';
  try { current = readFileSync(gitignorePath, 'utf-8'); } catch { /* no .gitignore yet */ }

  const alreadyIgnored = current
    .split('\n')
    .map(l => l.trim())
    .some(l => l === IGNORE_ENTRY || l === '.teamctx/.local' || l === '.teamctx/.local/*');
  if (alreadyIgnored) return false;

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${IGNORE_ENTRY}\n`);
    return true;
  }
  appendFileSync(gitignorePath, `${current.endsWith('\n') || current === '' ? '' : '\n'}${IGNORE_ENTRY}\n`);
  return true;
}

/** Read this actor's preferences. Returns {} when none are set. */
export async function readPrefs(actor, teamctxDir) {
  const actorKey = actor?.key;
  if (!actorKey) return {};

  const session = getCurrentSession();
  if (session) {
    // No KV configured falls back to an in-process Map inside kv.js, which on
    // serverless means preferences do not persist. Degraded, but never fatal.
    try {
      return (await kvGet(keys.prefs(actorKey, session.owner, session.repo))) || {};
    } catch {
      return {};
    }
  }
  return readLocal(actorKey, teamctxDir);
}

/** Merge `patch` into this actor's preferences and persist. Returns the merged set. */
export async function writePrefs(actor, patch, teamctxDir) {
  const actorKey = actor?.key;
  if (!actorKey) throw new Error('cannot save preferences without an actor');

  const merged = { ...(await readPrefs(actor, teamctxDir)), ...patch };
  // A null/undefined value clears the preference rather than storing a blank,
  // so the setting falls back to the derived value again instead of shadowing
  // it forever with an identical-looking string.
  const next = Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== null && v !== undefined),
  );

  const session = getCurrentSession();
  if (session) {
    await kvSet(keys.prefs(actorKey, session.owner, session.repo), next);
    return next;
  }
  writeLocal(actorKey, next, teamctxDir);
  return next;
}

/**
 * The workstream this actor is working in.
 *
 * `config.activeWorkstream` survives as the *project default* — what a person
 * who has never switched sees — so nothing changes for an existing project.
 */
export async function resolveActiveWorkstream({ actor, config, teamctxDir } = {}) {
  const prefs = await readPrefs(actor, teamctxDir);
  return prefs.activeWorkstream || config?.activeWorkstream || 'main';
}

/**
 * Display name for this actor, with where it came from.
 *
 * The source describes the *name*, not the actor: someone authenticated via
 * GitHub who has set their own handle is `override`, not `github`. Callers that
 * surface provenance (get_status, teamctx status) would otherwise claim the
 * name came from GitHub when it did not.
 */
export async function resolveIdentity({ actor, config, teamctxDir } = {}) {
  const prefs = await readPrefs(actor, teamctxDir);
  if (prefs.name) return { name: prefs.name, source: 'override' };
  if (actor?.name) return { name: actor.name, source: actor.source };
  if (config?.me) return { name: config.me, source: 'config' };
  return { name: 'unknown', source: 'fallback' };
}

/** Display name for this actor: their own override wins over the derived one. */
export async function resolveDisplayName({ actor, config, teamctxDir } = {}) {
  return (await resolveIdentity({ actor, config, teamctxDir })).name;
}
