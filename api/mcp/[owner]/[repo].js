import { handleMcpHttp } from '../../../mcp/http.js';
import { runWithAiKey } from '../../../src/ai-context.js';
import { runWithActor, actorFromGithubUser } from '../../../src/actor.js';
import { providerFromEnv } from '../../../src/oauth/provider.js';
import { kvGet, keys } from '../../../src/oauth/kv.js';

/**
 * Hosted MCP endpoint.  POST /api/mcp/<owner>/<repo>
 *
 * Credential resolution, in priority order:
 *
 *   1. `Authorization: Bearer <token>` — the OAuth path. The token was minted
 *      by our authorization server; we look it up to recover the user's
 *      GitHub token and their stored AI provider key. This is the only path
 *      claude.ai and other web clients will use.
 *
 *   2. `X-Github-Token` / `X-Anthropic-Api-Key` headers — for Claude's
 *      `static_headers` mode and for local development.
 *
 *   3. `?gh_token=&api_key=` query params — legacy, local development only.
 *      Disabled unless TEAMCTX_ALLOW_URL_TOKENS=1, because the MCP spec
 *      prohibits credentials in the query string and Claude ignores them.
 *
 * With no usable credential we return 401 plus a WWW-Authenticate header
 * pointing at this repo's protected resource metadata, which is what starts
 * the OAuth flow in the client.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.end(JSON.stringify({ error: 'method_not_allowed', message: 'MCP endpoint accepts POST only' }));
    return;
  }

  const owner = readParam(req, 'owner');
  const repo = readParam(req, 'repo');
  if (!owner || !repo) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'bad_url', message: 'expected /api/mcp/<owner>/<repo>' }));
    return;
  }

  let ghToken = null;
  let apiKey = null;
  let aiProvider = null;
  let actor = null;

  // 1 — OAuth bearer token
  const bearer = readBearer(req);
  if (bearer) {
    const provider = providerFromEnv();
    if (!provider) return unauthorized(req, res, owner, repo, 'OAuth is not configured on this deployment');
    try {
      const auth = await provider.verifyAccessToken(bearer);
      ghToken = auth.extra?.githubToken ?? null;
      // The identity behind the token. This is what contributions get attributed
      // to and what the manager gate compares against, instead of the shared
      // `config.me` sitting in the repo.
      actor = actorFromGithubUser(auth.extra?.githubUser);
      const stored = auth.extra?.githubUser?.id
        ? await kvGet(keys.aiKey(auth.extra.githubUser.id))
        : null;
      apiKey = stored?.apiKey ?? null;
      // The settings page stores the provider alongside the key. Dropping it
      // meant an OpenAI key was handed to whatever provider the repo's config
      // named — usually Anthropic.
      aiProvider = stored?.provider ?? null;
    } catch {
      return unauthorized(req, res, owner, repo, 'The access token is invalid or has expired');
    }
  }

  // 2 — request headers
  if (!ghToken) ghToken = firstHeader(req, 'x-github-token');
  if (!apiKey) apiKey = firstHeader(req, 'x-anthropic-api-key') || firstHeader(req, 'x-api-key');

  // 3 — query params (opt-in, local dev)
  if (process.env.TEAMCTX_ALLOW_URL_TOKENS === '1') {
    if (!ghToken) ghToken = readParam(req, 'gh_token');
    if (!apiKey) apiKey = readParam(req, 'api_key');
  }

  if (!ghToken) {
    return unauthorized(req, res, owner, repo, 'Authentication required');
  }

  const ref = readParam(req, 'ref') || null;
  const projectContext = { __backend: 'github', owner, repo, ref, ghToken };

  // Header-token mode (local dev, `static_headers`) carries no identity, so it
  // is resolved lazily: a GitHub round trip that most tool calls never need, run
  // at most once per request and only if something asks who the caller is.
  const actorSeed = actor || (() => githubUserFromToken(ghToken).then(actorFromGithubUser));

  const dispatch = () => runWithActor(actorSeed, () => handleMcpHttp(req, res, projectContext));
  if (apiKey) await runWithAiKey(apiKey, dispatch, aiProvider);
  else await dispatch();
}

async function githubUserFromToken(ghToken) {
  try {
    const r = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return { id: String(u.id), login: u.login, name: u.name ?? null };
  } catch {
    return null;   // fall through to config.me
  }
}

/**
 * A 401 here is what kicks off OAuth in the client, so the WWW-Authenticate
 * header has to be exactly right: Claude does not honour it on a 200, and the
 * `resource` in the metadata document must match this URL including its path.
 */
function unauthorized(req, res, owner, repo, description) {
  const base = baseUrl(req);
  const prm = `${base}/.well-known/oauth-protected-resource/api/mcp/${owner}/${repo}`;
  res.statusCode = 401;
  res.setHeader('WWW-Authenticate',
    `Bearer realm="teamctx", resource_metadata="${prm}", scope="mcp:tools"`);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    error: 'unauthorized',
    error_description: description,
    resource_metadata: prm,
  }));
}

function baseUrl(req) {
  if (process.env.TEAMCTX_BASE_URL) return process.env.TEAMCTX_BASE_URL.replace(/\/$/, '');
  const host = firstHeader(req, 'x-forwarded-host') || firstHeader(req, 'host');
  const proto = firstHeader(req, 'x-forwarded-proto') || 'https';
  return `${proto}://${host}`;
}

function firstHeader(req, name) {
  const v = req.headers?.[name];
  return Array.isArray(v) ? v[0] : (v || null);
}

function readParam(req, name) {
  const v = req.query?.[name];
  if (Array.isArray(v)) return v[0];
  return v || undefined;
}

function readBearer(req) {
  const raw = firstHeader(req, 'authorization');
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1] : null;
}
