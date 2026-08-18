import { DEFAULT_MAX_BYTES } from '../import.js';
import { docxToText } from '../formats/docx.js';

/**
 * Microsoft 365 connector: OneDrive and SharePoint document libraries in,
 * documents out.
 *
 * This is the connector where the pattern the other five share breaks. Slack,
 * Notion, Coda, Drive and Dropbox all end with an API handing back text.
 * Microsoft Graph never does: its format endpoint offers pdf, jpg and html, and
 * html only for Loop and Whiteboard files. A `.docx` is not a pointer to
 * something a server can render the way a Google Doc is — the bytes *are* the
 * document, and the bytes are a ZIP. So the text comes out locally, in
 * src/formats/docx.js.
 *
 * Two other things differ from Drive, and both are easy to get quietly wrong:
 *
 *   - `children` supports no `$filter`, so `--since` is applied in memory. It
 *     still saves the download, which is the expensive part.
 *   - There are two account populations. A work or school account reaches
 *     SharePoint; a personal Microsoft account does not, signs in through a
 *     different tenant endpoint, and cannot hold Sites.Read.All at all —
 *     requesting it fails the whole consent rather than degrading. `authorize`
 *     therefore asks which kind of account it is.
 *
 * No AI logic lives here — see src/connectors/index.js for the contract.
 */

const API = 'https://graph.microsoft.com/v1.0';
const AUTH_HOST = 'https://login.microsoftonline.com';

const PAGE_SIZE = 200;
const MAX_FILES = 200;
const MAX_BACKOFF_MS = 32000;

/** Enough to decide what a file is and where it came from. Graph returns a
 *  great deal more per item, and paging a library with `$select` unset is
 *  measurably slower on a big one. */
const SELECT = 'id,name,size,file,folder,webUrl,lastModifiedDateTime,parentReference';

export const name = 'm365';
export const describe = 'Microsoft 365 — a OneDrive or SharePoint document library';

/**
 * Two populations, two endpoints, two scope sets.
 *
 * Getting this wrong does not degrade — a personal account asked for
 * Sites.Read.All cannot consent at all, so it could never log in.
 */
export const ACCOUNTS = {
  work: {
    tenant: 'organizations',
    scopes: 'offline_access Files.Read.All Sites.Read.All',
    label: 'Work or school (Microsoft 365 / SharePoint)',
  },
  personal: {
    tenant: 'consumers',
    // Sites.Read.All is deliberately absent: GET /sites is documented as "Not
    // supported" for personal accounts, and asking for it breaks consent.
    scopes: 'offline_access Files.Read.All',
    label: 'Personal Microsoft account (OneDrive)',
  },
};

const HELP = 'run `teamctx auth m365` — it walks through registering the Entra app, '
  + 'then saves M365_CLIENT_ID, M365_CLIENT_SECRET, M365_TENANT and M365_REFRESH_TOKEN '
  + 'to .env.local. An M365_ACCESS_TOKEN on its own also works for about an hour, '
  + 'which is enough to try this out.';

export function auth(env = process.env) {
  const accessToken = env.M365_ACCESS_TOKEN || '';
  const clientId = env.M365_CLIENT_ID || '';
  const clientSecret = env.M365_CLIENT_SECRET || '';
  const refreshToken = env.M365_REFRESH_TOKEN || '';
  // Which endpoint the refresh has to go back to. `common` accepts both and is
  // the safe default for a token whose origin was not recorded.
  const tenant = env.M365_TENANT || 'common';

  if (!accessToken && !(clientId && refreshToken)) return { ok: false, help: HELP };

  return {
    ok: true,
    accessToken,
    clientId,
    clientSecret,
    refreshToken,
    tenant,
    expiresAt: accessToken && !refreshToken ? Infinity : 0,
  };
}

/**
 * Walk the user through registering the app and signing in, once.
 *
 * Reuses the loopback listener Drive introduced — Microsoft supports the same
 * desktop redirect, so this connector adds no auth machinery of its own.
 *
 * The account-type question is not a nicety. A personal Microsoft account
 * cannot hold Sites.Read.All, and asking for it fails consent outright rather
 * than granting what it can, so a hardcoded work/school scope set would lock
 * every consumer account out permanently.
 */
export async function authorize({ ask, askSecret = ask, loopback, env = process.env, log = () => {} } = {}) {
  if (typeof loopback !== 'function') {
    throw new Error('m365: this login needs the loopback helper — run it through `teamctx auth m365`');
  }

  log(`
Microsoft 365 needs an app registration of your own. teamctx ships none, so no
quota is pooled and no third party sits between your team and your files.

  1. Open https://entra.microsoft.com -> Applications -> App registrations -> New
  2. Supported account types: choose
     "Accounts in any organizational directory and personal Microsoft accounts"
     — anything narrower locks out half the people who will use this
  3. Redirect URI: platform "Mobile and desktop applications",
     value http://localhost  (the port is chosen per run and does not matter)
  4. Copy the Application (client) ID from the Overview page
  5. Leave the client secret blank unless your tenant requires one
`);

  const accountKind = (await ask('Account type — "work" or "personal"', 'work')).toLowerCase();
  const account = ACCOUNTS[accountKind.startsWith('p') ? 'personal' : 'work'];
  log(`
Using ${account.label}
  scopes: ${account.scopes}
`);

  const clientId = (await ask('Application (client) ID', env.M365_CLIENT_ID || '')) || '';
  if (!clientId) throw new Error('m365: a client ID is required');
  // Blank is normal and correct for a public client, so this must not insist.
  const clientSecret = (await askSecret('Client secret (blank if none)', env.M365_CLIENT_SECRET || '')) || '';

  const { code, redirectUri } = await loopback({
    log,
    buildUrl: (uri, state) => `${AUTH_HOST}/${account.tenant}/oauth2/v2.0/authorize?`
      + new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: uri,
        response_mode: 'query',
        scope: account.scopes,
        state,
      }).toString(),
  });

  const body = {
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: account.scopes,
  };
  if (clientSecret) body.client_secret = clientSecret;

  const res = await globalThis.fetch(`${AUTH_HOST}/${account.tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (String(json?.error || '') === 'invalid_grant') {
      throw new Error('m365: that authorization code was rejected. Codes are single-use '
        + 'and expire within minutes — run the command again for a fresh one.');
    }
    throw new GraphError(res.status, json);
  }
  if (!json.refresh_token) {
    throw new Error('m365: no refresh token came back, so the login would expire in an '
      + 'hour. The consent request needs the offline_access scope.');
  }

  const values = {
    M365_CLIENT_ID: clientId,
    // Recorded so the refresh goes back to the endpoint that issued the token.
    M365_TENANT: account.tenant,
    M365_REFRESH_TOKEN: json.refresh_token,
  };
  if (clientSecret) values.M365_CLIENT_SECRET = clientSecret;
  return values;
}

export class GraphError extends Error {
  constructor(status, body) {
    const code = body?.error?.code || body?.error || '';
    const detail = body?.error?.message || body?.error_description || '';
    const hint = {
      itemNotFound: 'no such file, folder or site — check the link, and that this '
        + 'account can open it',
      accessDenied: 'this account is not allowed to read that',
      invalid_grant: 'the refresh token is no longer valid — run `teamctx auth m365` again',
      invalid_client: 'M365_CLIENT_ID or M365_CLIENT_SECRET is wrong',
      // The characteristic personal-account failure: the app asked for a scope
      // a consumer account cannot hold, so consent never completed.
      invalid_scope: 'this account cannot grant one of the requested permissions. '
        + 'Sites.Read.All is not available to personal Microsoft accounts — '
        + 'run `teamctx auth m365` and choose the personal option',
      resourceNotFound: 'that site or drive does not exist for this account',
      activityLimitReached: 'Microsoft is throttling this request; it will be retried',
    }[code];

    if (hint) super(`m365: ${hint}`);
    else if (status === 401) super('m365: the credentials were rejected (401) — run `teamctx auth m365` again');
    else super(`m365 ${status}${code ? ` ${code}` : ''}: ${detail}`.trim());

    this.status = status;
    this.code = code;
  }
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const backoffMs = attempt => Math.min(2 ** attempt * 1000 + Math.floor(Math.random() * 1000), MAX_BACKOFF_MS);

async function accessTokenFor(a) {
  if (a.accessToken && Date.now() < a.expiresAt) return a.accessToken;
  if (!a.refreshToken) return a.accessToken;

  const body = {
    grant_type: 'refresh_token',
    refresh_token: a.refreshToken,
    client_id: a.clientId,
  };
  // A public client has no secret, and sending an empty one is rejected rather
  // than ignored.
  if (a.clientSecret) body.client_secret = a.clientSecret;

  const res = await globalThis.fetch(`${AUTH_HOST}/${a.tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new GraphError(res.status, json);

  a.accessToken = json.access_token;
  a.expiresAt = Date.now() + ((json.expires_in ?? 3600) * 1000) - 60000;
  // Microsoft rotates refresh tokens; keeping the old one works until it does
  // not, and then fails a week later for no visible reason.
  if (json.refresh_token) a.refreshToken = json.refresh_token;
  return a.accessToken;
}

/**
 * One Graph call, retried on the errors worth retrying.
 *
 * Microsoft publishes no fixed rate for SharePoint and OneDrive — throttling is
 * dynamic, and requests against different sites still draw on shared backend
 * buckets. So `Retry-After` is authoritative and this loop is load-bearing,
 * unlike Drive where the quota sat far past anything an import could reach.
 */
async function call(a, path, { retries = 3, sleep = wait, raw = false } = {}) {
  const url = path.startsWith('http') ? path : `${API}/${path}`;

  for (let attempt = 0; ; attempt++) {
    const token = await accessTokenFor(a);
    const res = await globalThis.fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (res.ok) return raw ? Buffer.from(await res.arrayBuffer()) : res.json();

    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const header = Number(res.headers?.get?.('retry-after'));
      const seconds = Number.isFinite(header) && header >= 0 ? header : null;
      await sleep(seconds === null ? backoffMs(attempt) : seconds * 1000);
      continue;
    }
    if (res.status === 401 && a.refreshToken && attempt < retries) {
      a.expiresAt = 0;
      continue;
    }
    const json = await res.json().catch(() => ({}));
    throw new GraphError(res.status, json);
  }
}

// ---- selector ----------------------------------------------------------

/** Graph addresses a path as `root:/a/b:` — the colons are structural, so a
 *  path containing one would change the meaning of the URL. */
function encodePath(path) {
  const clean = String(path).replace(/^\/+|\/+$/g, '');
  if (clean.includes(':')) throw new Error(`m365: a path may not contain ":" — got "${path}"`);
  return clean.split('/').map(encodeURIComponent).join('/');
}

/**
 * A SharePoint URL, a OneDrive path, or a sharing link.
 *
 * SharePoint URLs are decomposed rather than handed to `/shares`, because the
 * `/shares` permissions table names `Files.ReadWrite` as its least privileged
 * delegated permission — a read-only tool has no business asking for a write
 * scope. `/sites/{hostname}:/{path}` needs only Sites.Read.All.
 *
 * That leaves `/shares` for short links, which cannot be decomposed at all.
 */
export function parseSelector(input) {
  const s = String(input ?? '').trim();
  if (!s) {
    throw new Error('m365 needs a folder to import — a SharePoint URL, a OneDrive path '
      + 'like /Documents/Specs, or a sharing link. Use / for your whole OneDrive.');
  }

  if (/^https?:\/\//i.test(s)) {
    let url;
    try { url = new URL(s); } catch { throw new Error(`not a URL: "${s}"`); }

    if (/(^|\.)sharepoint\.com$/i.test(url.hostname)) {
      // /sites/Eng/Shared Documents/Specs  ->  site /sites/Eng, drive path the rest.
      // Personal OneDrive-for-Business libraries live under /personal/<user>.
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const kind = parts[0]?.toLowerCase();
      if ((kind === 'sites' || kind === 'teams' || kind === 'personal') && parts.length >= 2) {
        return {
          host: url.hostname,
          sitePath: `/${parts[0]}/${parts[1]}`,
          drivePath: parts.slice(2).join('/'),
        };
      }
      // A tenant-root document library, with no site segment.
      return { host: url.hostname, sitePath: '', drivePath: parts.join('/') };
    }

    // 1drv.ms and sharing URLs carry no addressable structure at all.
    return { link: s };
  }

  if (s === '/') return { drivePath: '' };
  return { drivePath: encodePath(s) === '' ? '' : s.replace(/^\/+/, '') };
}

/** Base64url with a `u!` prefix — Graph's own encoding for a sharing URL. */
export function encodeSharingUrl(url) {
  return `u!${Buffer.from(String(url), 'utf8').toString('base64')
    .replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
}

// ---- classification ----------------------------------------------------

const TEXT = /\.(md|markdown|txt|text)$/i;
const WORD = /\.docx$/i;

/**
 * What an item is, from the listing alone.
 *
 * Graph has no mimeType worth trusting here — a `.md` upload is reported as
 * `text/markdown` by some clients and `application/octet-stream` by others —
 * so the extension is the honest signal, unlike Drive where the mimeType names
 * a real server-side type.
 */
export function classify(item) {
  if (item?.folder) return { folder: true };
  if (!item?.file) return { skip: 'not a file' };

  const fileName = String(item.name || '');
  if (TEXT.test(fileName)) return { download: true };
  if (WORD.test(fileName)) return { extract: 'docx' };
  if (/\.(xlsx|xlsm|csv)$/i.test(fileName)) {
    return { skip: 'a spreadsheet is records, not prose' };
  }
  if (/\.pptx?$/i.test(fileName)) {
    return { skip: 'slide text needs a reader that is not built yet' };
  }
  if (/\.docb?$/i.test(fileName)) {
    return { skip: 'the pre-2007 .doc format is not supported — re-save it as .docx' };
  }
  const ext = /\.([^.]+)$/.exec(fileName)?.[1];
  return { skip: `unsupported type (${ext ? `.${ext}` : 'no extension'})` };
}

const idFor = item => `m365:${item.parentReference?.path
  ? `${String(item.parentReference.path).replace(/^\/drive\/root:/, '')}/${item.name}`
  : item.id}`;

const itemFor = (item, kind, drive) => ({
  ref: {
    id: item.id,
    drive: drive || item.parentReference?.driveId,
    title: item.name,
    url: item.webUrl,
    extract: kind.extract,
  },
  id: idFor(item),
  title: item.name || 'Untitled',
});

// ---- listing -----------------------------------------------------------

/** Where a selector's root lives, as a Graph path prefix. */
async function resolveRoot(a, target, opts) {
  if (target.link) {
    const item = await call(a, `shares/${encodeSharingUrl(target.link)}/driveItem?$select=${SELECT}`, opts);
    return { item, base: `drives/${item.parentReference?.driveId}` };
  }

  if (target.host) {
    const sitePath = target.sitePath ? `${target.host}:${target.sitePath}` : target.host;
    const site = await call(a, `sites/${sitePath}`, opts);
    const base = `sites/${site.id}/drive`;
    const item = target.drivePath
      ? await call(a, `${base}/root:/${encodePath(target.drivePath)}?$select=${SELECT}`, opts)
      : await call(a, `${base}/root?$select=${SELECT}`, opts);
    return { item, base };
  }

  const base = 'me/drive';
  const item = target.drivePath
    ? await call(a, `${base}/root:/${encodePath(target.drivePath)}?$select=${SELECT}`, opts)
    : await call(a, `${base}/root?$select=${SELECT}`, opts);
  return { item, base };
}

async function* children(a, base, itemId, opts) {
  let next = `${base}/items/${encodeURIComponent(itemId)}/children?$top=${PAGE_SIZE}&$select=${SELECT}`;
  while (next) {
    const page = await call(a, next, opts);
    yield* page.value || [];
    // Graph hands back an absolute URL, already carrying the paging token.
    next = page['@odata.nextLink'];
  }
}

/**
 * Every document beneath a folder, however deep.
 *
 * Graph has no recursive listing — the same breadth-first walk Drive and Notion
 * need. `seen` guards against a library arranged so a folder reaches itself,
 * which Graph permits through shortcuts.
 */
async function walk(a, base, rootId, { since, opts }) {
  const cutoff = since ? new Date(since).getTime() : null;
  if (since && !Number.isFinite(cutoff)) throw new Error(`not a date: "${since}"`);

  const items = [];
  const skipped = [];
  const queue = [rootId];
  const seen = new Set();

  while (queue.length > 0) {
    const folderId = queue.shift();
    if (seen.has(folderId)) continue;
    seen.add(folderId);

    for await (const item of children(a, base, folderId, opts)) {
      const kind = classify(item);
      if (kind.folder) { queue.push(item.id); continue; }
      if (kind.skip) { skipped.push({ id: idFor(item), reason: kind.skip }); continue; }

      // In memory, because children supports no $filter. It still saves the
      // download, which is what actually costs. An item with no timestamp is
      // kept rather than dropped.
      if (cutoff && item.lastModifiedDateTime
        && new Date(item.lastModifiedDateTime).getTime() < cutoff) continue;

      // A 40MB Word file is 40MB of embedded images around 20KB of prose, and
      // normalizeDocument would reject the result after paying for all of it.
      // Word compresses, so the ceiling is generous rather than exact.
      const limit = kind.extract === 'docx' ? DEFAULT_MAX_BYTES * 40 : DEFAULT_MAX_BYTES;
      if (item.size > limit) {
        skipped.push({
          id: idFor(item),
          reason: `too large (${Math.round(item.size / 1024)}KB)`,
        });
        continue;
      }

      if (items.length >= MAX_FILES) {
        skipped.push({
          id: 'm365:*',
          reason: `stopped at ${MAX_FILES} files — import a smaller folder, or narrow it with --since`,
        });
        return { items, skipped };
      }
      items.push(itemFor(item, kind, base.startsWith('drives/') ? base.slice(7) : undefined));
    }
  }
  return { items, skipped };
}

export async function list(a, selector, { since, ...opts } = {}) {
  const target = parseSelector(Array.isArray(selector) ? selector[0] : selector);
  const { item, base } = await resolveRoot(a, target, opts);

  // A link or path naming one file imports that file. No --since check: asking
  // for one document by name and being handed nothing because it is a
  // fortnight old would be obtuse.
  if (!item.folder) {
    const kind = classify(item);
    if (kind.skip) return { items: [], skipped: [{ id: idFor(item), reason: kind.skip }] };
    return { items: [itemFor(item, kind, base.startsWith('drives/') ? base.slice(7) : undefined)], skipped: [] };
  }

  return walk(a, base, item.id, { since, opts });
}

// ---- fetching ----------------------------------------------------------

/**
 * One document's text.
 *
 * `/content` returns the file's own bytes; there is no server-side conversion
 * worth using, so a `.docx` is unpacked here. Everything else was already
 * rejected while listing.
 */
export async function fetch(a, ref, opts = {}) {
  if (!ref?.id) throw new Error('m365: nothing to fetch — the item has no id');

  const base = ref.drive ? `drives/${encodeURIComponent(ref.drive)}` : 'me/drive';
  const bytes = await call(a, `${base}/items/${encodeURIComponent(ref.id)}/content`,
    { ...opts, raw: true });

  return {
    id: `m365:${ref.id}`,
    title: ref.title || String(ref.id),
    text: ref.extract === 'docx' ? docxToText(bytes) : bytes.toString('utf8'),
  };
}
