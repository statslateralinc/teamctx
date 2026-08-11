/**
 * Tiny KV abstraction for the hosted OAuth layer.
 *
 * Talks the Upstash Redis REST protocol over plain `fetch` — which is also
 * exactly what Vercel KV exposes — so we add no npm dependency. Falls back
 * to an in-process Map when no KV is configured, which keeps local dev and
 * the test suite working without any external service.
 *
 * Env vars (either pair works):
 *   KV_REST_API_URL / KV_REST_API_TOKEN            ← Vercel KV
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN ← Upstash direct
 */

function restConfig(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

export function isPersistent(env = process.env) {
  return restConfig(env) !== null;
}

// --- in-memory fallback -------------------------------------------------

const memory = new Map();          // key -> { value, expiresAt|null }

function memGet(key) {
  const rec = memory.get(key);
  if (!rec) return null;
  if (rec.expiresAt && Date.now() > rec.expiresAt) {
    memory.delete(key);
    return null;
  }
  return rec.value;
}

function memSet(key, value, ttlSeconds) {
  memory.set(key, {
    value,
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
  });
}

/** Test helper — wipe the in-memory store between cases. */
export function __resetMemory() {
  memory.clear();
}

// --- REST transport -----------------------------------------------------

async function restCommand(cfg, command) {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`kv ${command[0]} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.result;
}

// --- public API ---------------------------------------------------------

/** Read a JSON value. Returns null when absent or expired. */
export async function kvGet(key, env = process.env) {
  const cfg = restConfig(env);
  if (!cfg) return memGet(key);
  const raw = await restCommand(cfg, ['GET', key]);
  if (raw === null || raw === undefined) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return raw; }
}

/** Write a JSON value, optionally with a TTL in seconds. */
export async function kvSet(key, value, { ttlSeconds } = {}, env = process.env) {
  const cfg = restConfig(env);
  if (!cfg) return memSet(key, value, ttlSeconds);
  const payload = JSON.stringify(value);
  const cmd = ttlSeconds
    ? ['SET', key, payload, 'EX', String(ttlSeconds)]
    : ['SET', key, payload];
  await restCommand(cfg, cmd);
}

export async function kvDelete(key, env = process.env) {
  const cfg = restConfig(env);
  if (!cfg) { memory.delete(key); return; }
  await restCommand(cfg, ['DEL', key]);
}

/**
 * Read-and-delete. Used for one-shot artefacts (authorization codes,
 * pending-authorization state) so they can't be replayed.
 */
export async function kvTake(key, env = process.env) {
  const cfg = restConfig(env);
  if (!cfg) {
    // In-memory: read and delete happen in one synchronous turn, so no
    // interleaving is possible.
    const value = memGet(key);
    if (value !== null) memory.delete(key);
    return value;
  }
  // GETDEL is a single round trip, so two concurrent exchanges of the same
  // code cannot both see it. Redis < 6.2 lacks the command — fall back to the
  // non-atomic pair rather than failing the request outright.
  let raw;
  try {
    raw = await restCommand(cfg, ['GETDEL', key]);
  } catch {
    const value = await kvGet(key, env);
    if (value !== null) await kvDelete(key, env);
    return value;
  }
  if (raw === null || raw === undefined) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return raw; }
}

// --- key namespaces -----------------------------------------------------
// Kept in one place so the shape of what we persist is easy to audit.

export const keys = {
  /** DCR-registered OAuth client. Long-lived. */
  client: id => `oauth:client:${id}`,
  /** In-flight /authorize state, consumed by the GitHub callback. 10 min. */
  pending: state => `oauth:pending:${state}`,
  /** Authorization code awaiting exchange at /token. 10 min, one-shot. */
  code: code => `oauth:code:${code}`,
  /** Access token → { githubToken, githubUser, clientId }. Matches token TTL. */
  token: token => `oauth:token:${token}`,
  /** Refresh token → same payload. Long-lived, rotated on use. */
  refresh: token => `oauth:refresh:${token}`,
  /** Per-user AI provider key, set via the settings page. Long-lived. */
  aiKey: githubUserId => `teamctx:aikey:${githubUserId}`,
  /**
   * Per-user, per-project settings (display name, active workstream). These are
   * personal, so they deliberately live here rather than in the repo's
   * config.json — see src/prefs.js. Long-lived.
   */
  prefs: (actorKey, owner, repo) => `teamctx:prefs:${actorKey}:${owner}/${repo}`,
  /** Browser session for the settings page. 1 hour. */
  session: sid => `teamctx:session:${sid}`,
};

export const TTL = {
  pending: 10 * 60,          // 10 min — user is mid-consent
  code: 10 * 60,             // 10 min — RFC 6749 says ≤10 min
  accessToken: 60 * 60,      // 1 hour — Claude refreshes reactively on 401
  refreshToken: 90 * 24 * 60 * 60,
  session: 60 * 60,
};
