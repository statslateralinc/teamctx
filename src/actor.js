import { AsyncLocalStorage } from 'async_hooks';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getCurrentSession } from './session-context.js';

/**
 * Who is acting right now.
 *
 * `config.me` is committed to the repo, so it names one person for the whole
 * team. That is fine for a single user and wrong the moment two people share a
 * project: every contribution is attributed to whoever ran `init`, and the
 * manager gate compares that same shared string against itself.
 *
 * The actor is resolved per call instead, from whatever the surface actually
 * knows:
 *
 *   hosted MCP  → the GitHub account that completed OAuth (authoritative)
 *   CLI / stdio → `git config user.name` / `user.email` (per clone)
 *   fallback    → `config.me`, so existing repos behave exactly as before
 *
 * Same AsyncLocalStorage shape as src/session-context.js and src/ai-context.js:
 * the HTTP layer seeds it per request, everything downstream reads it without
 * threading an argument through every call.
 *
 * Actor shape: { key, name, login, source }
 *   key    stable identifier used for grouping — `github:<id>`, `git:<email>`
 *          or `name:<me>`. Survives display-name changes.
 *   name   display only. Never empty.
 */

const execFileAsync = promisify(execFile);
const store = new AsyncLocalStorage();

/**
 * Seed the ambient actor for the duration of `fn`.
 *
 * `seed` is either a resolved actor or a function returning one (possibly
 * async). The function form exists for the header-token path, where working
 * out who the caller is costs a GitHub round trip that most tool calls never
 * need — it runs at most once, on first use.
 */
export function runWithActor(seed, fn) {
  return store.run({ seed, resolved: null }, fn);
}

export function actorFromGithubUser(user) {
  if (!user || user.id === undefined || user.id === null) return null;
  // GitHub's display name is optional; the login never is.
  const name = user.name || user.login;
  if (!name) return null;
  return { key: `github:${user.id}`, name, login: user.login || null, source: 'github' };
}

export function actorFromConfig(config) {
  const me = (config?.me || '').trim();
  if (!me) return { key: 'name:unknown', name: 'unknown', login: null, source: 'fallback' };
  return { key: `name:${me}`, name: me, login: null, source: 'config' };
}

async function gitConfigValue(key, cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['config', '--get', key], cwd ? { cwd } : undefined);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Local surfaces only. Returns null in hosted mode — there is no git binary. */
export async function actorFromGit({ cwd } = {}) {
  if (getCurrentSession()) return null;
  const [name, email] = await Promise.all([
    gitConfigValue('user.name', cwd),
    gitConfigValue('user.email', cwd),
  ]);
  if (!name && !email) return null;
  return {
    // Email is the stable half — git identities change display names freely.
    key: email ? `git:${email.toLowerCase()}` : `name:${name}`,
    name: name || email.split('@')[0],
    login: null,
    source: 'git',
  };
}

/**
 * The actor for this call. Memoized per `runWithActor` scope so the header-token
 * lookup and the git subprocess each happen at most once per request.
 *
 * Always returns an actor — the ladder bottoms out at `config.me` and then at
 * 'unknown', so callers never have to handle an empty author.
 */
export async function resolveActor({ config, cwd } = {}) {
  const ctx = store.getStore();
  if (ctx?.resolved) return ctx.resolved;

  const remember = (actor) => {
    if (ctx) ctx.resolved = actor;
    return actor;
  };

  if (ctx?.seed) {
    const seeded = typeof ctx.seed === 'function' ? await ctx.seed() : ctx.seed;
    if (seeded) return remember(seeded);
  }

  const fromGit = await actorFromGit({ cwd });
  if (fromGit) return remember(fromGit);

  return remember(actorFromConfig(config));
}

/** Test/debug helper — the actor already resolved in this scope, if any. */
export function peekActor() {
  return store.getStore()?.resolved || null;
}
