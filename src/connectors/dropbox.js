import { DEFAULT_MAX_BYTES } from '../import.js';

/**
 * Dropbox connector: files in, documents out.
 *
 * #25 calls this the simplest file-store connector, and having written the
 * others it is worth recording *why*, because each reason is a place another
 * connector had to do real work:
 *
 *   1. The whole tree arrives in one call. `files/list_folder` takes
 *      `recursive: true`, so the breadth-first walk Drive, Graph and Notion all
 *      need — with a seen-set, because a Drive file can have several parents —
 *      simply does not exist here.
 *   2. The API says how to fetch each file. Every entry carries
 *      `is_downloadable`, and when it is false, `export_info.export_as` names
 *      the format. Drive needed a hardcoded mimeType table; M365 has to sniff
 *      extensions. Here the routing is data-driven and cannot drift when
 *      Dropbox adds a file type.
 *   3. One rate-limit rule: a 429 always carries `Retry-After`. No per-verb
 *      buckets (Coda), no pacing to avoid a limit reached by walking normally
 *      (Notion), no invisible dynamic quota (Graph).
 *
 * What it cannot do is the flip side of being a plain file store. `files/export`
 * does not produce text — a Google Doc kept in Dropbox exports as `docx`, so the
 * one path that looks like Drive's markdown export lands on OOXML after all.
 * Only `.paper` exports as markdown. Word documents are therefore skipped with a
 * reason until `src/formats/docx.js` exists; when it does, two rows in
 * `classify` change and nothing else here does.
 *
 * No AI logic lives here — see src/connectors/index.js for the contract.
 */

/** Two hostnames, and mixing them up returns a confusing error rather than a
 *  clear one: arguments-in-JSON go to one, file bytes come from the other. */
const RPC = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
const TOKEN_URL = 'https://api.dropbox.com/oauth2/token';

/** Entries per listing page. The ceiling is high because one recursive call
 *  already covers the tree — this only controls how it is chunked. */
const PAGE_LIMIT = 500;

/** Documents pulled from one run. The listing is cheap, so this protects the
 *  review queue rather than the API: every file becomes a human decision. */
const MAX_FILES = 200;

const MAX_BACKOFF_MS = 32000;

export const name = 'dropbox';
export const describe = 'Dropbox — a folder of documents, a file, or a shared link';

const HELP = 'run `teamctx auth dropbox` — it walks through creating the app, then '
  + 'saves DROPBOX_APP_KEY, DROPBOX_APP_SECRET and DROPBOX_REFRESH_TOKEN to .env.local. '
  + 'You only do it once; the login does not expire. '
  + 'If you would rather set them by hand, or just want to try this out, the app '
  + 'console\'s "Generate access token" button gives a DROPBOX_ACCESS_TOKEN that works '
  + 'on its own for about four hours.';

/**
 * Synchronous, like every other connector's, so a misconfigured run spends no
 * request here. The refresh token is exchanged lazily on the first call.
 */
export function auth(env = process.env) {
  const accessToken = env.DROPBOX_ACCESS_TOKEN || '';
  const appKey = env.DROPBOX_APP_KEY || '';
  const appSecret = env.DROPBOX_APP_SECRET || '';
  const refreshToken = env.DROPBOX_REFRESH_TOKEN || '';

  if (!accessToken && !(appKey && appSecret && refreshToken)) {
    return { ok: false, help: HELP };
  }
  return {
    ok: true,
    accessToken,
    appKey,
    appSecret,
    refreshToken,
    // A pasted token cannot be renewed, so it is used until Dropbox rejects it.
    expiresAt: accessToken && !refreshToken ? Infinity : 0,
  };
}

/**
 * Walk the user through getting a refresh token, once.
 *
 * The `help` above ends with "exchange it once for a refresh token", and until
 * this existed that meant writing a curl command — an instruction that works
 * for whoever wrote it and nobody else. This is the whole flow, and it is short
 * because Dropbox makes it short: no redirect URI, so no listener, no port to
 * pick, and nothing on this machine is reachable from outside while it runs.
 *
 * The app itself has to be the user's own. teamctx ships no client id, which
 * means no shared quota, no app to get suspended, and no third party in the
 * path between a team and their own files.
 */
export async function authorize({ ask, askSecret = ask, env = process.env, log = () => {} } = {}) {
  log(`
Dropbox needs an app of your own — teamctx ships none, so nothing is shared
between installs and no quota is pooled.

  1. Open https://www.dropbox.com/developers/apps  →  Create app
  2. Choose "Scoped access", then "Full Dropbox", and name it anything
  3. Permissions tab: tick files.metadata.read, files.content.read and
     sharing.read, then Submit
  4. Settings tab: copy the App key and App secret
`);

  // The app key is a client id — public by design, and worth showing in full so
  // it can be checked against the console. The secret is not.
  const appKey = (await ask('App key', env.DROPBOX_APP_KEY || '')) || '';
  if (!appKey) throw new Error('dropbox: an app key is required');
  const appSecret = (await askSecret('App secret', env.DROPBOX_APP_SECRET || '')) || '';
  if (!appSecret) throw new Error('dropbox: an app secret is required');

  const url = `https://www.dropbox.com/oauth2/authorize?client_id=${encodeURIComponent(appKey)}`
    + '&response_type=code&token_access_type=offline';

  log(`
Open this, sign in, and click Allow. Dropbox will show you a code on screen —
leaving out redirect_uri is deliberate, so nothing on your machine is listening
and the code goes only where you paste it.

  ${url}
`);

  const code = (await ask('Authorization code')) || '';
  if (!code) throw new Error('dropbox: an authorization code is required');

  const res = await globalThis.fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: appKey,
      client_secret: appSecret,
      // No redirect_uri, and that is not an omission: Dropbox requires the
      // exchange to match the authorize call, which did not set one either.
    }).toString(),
  });
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    // In *this* context invalid_grant means the code, not the refresh token —
    // codes are single-use and expire in minutes, which is easily the most
    // common way this step fails.
    if (String(json?.error || '') === 'invalid_grant') {
      throw new Error('dropbox: that authorization code was rejected. They are single-use and '
        + 'expire after a few minutes — open the link again for a fresh one.');
    }
    throw new DropboxError(res.status, json);
  }
  if (!json.refresh_token) {
    throw new Error('dropbox: no refresh token came back, so the login would expire in hours. '
      + 'The authorize URL needs token_access_type=offline.');
  }

  return {
    DROPBOX_APP_KEY: appKey,
    DROPBOX_APP_SECRET: appSecret,
    DROPBOX_REFRESH_TOKEN: json.refresh_token,
  };
}

export class DropboxError extends Error {
  constructor(status, body) {
    // Dropbox puts a slash-separated path in `error_summary`, e.g.
    // "path/not_found/..". The first two segments are the useful part.
    const summary = String(body?.error_summary || body?.error_description || '').replace(/\.+$/, '');
    const tag = summary.split('/').filter(Boolean).slice(0, 2).join('/');
    const hint = {
      'path/not_found': 'no such path — check the spelling, and that it starts with /',
      'path/not_folder': 'that path is a file, not a folder',
      'path/restricted_content': 'Dropbox will not serve that file over the API',
      'path/malformed_path': 'that is not a valid Dropbox path — paths start with / and the root is /',
      shared_link_not_found: 'that shared link does not exist, or has been revoked',
      shared_link_access_denied: 'that shared link needs a password, or is not shared with this account',
      invalid_grant: 'the refresh token is no longer valid — re-authorize the app',
      expired_access_token: 'the access token has expired; set DROPBOX_REFRESH_TOKEN so it can be renewed',
      invalid_access_token: 'the token is not valid — check DROPBOX_ACCESS_TOKEN',
      // The overwhelmingly common first-run failure: the app exists but was
      // created without the read scopes, so everything comes back 401.
      missing_scope: 'the app is missing a scope — it needs files.metadata.read, '
        + 'files.content.read and sharing.read, and scopes added after authorizing '
        + 'require re-authorizing',
    }[tag] || {
      401: 'the credentials were rejected — check the token, or re-authorize',
    }[status];

    super(hint ? `dropbox: ${hint}` : `dropbox ${status}${tag ? ` ${tag}` : ''}: ${summary}`.trim());
    this.status = status;
    this.tag = tag;
  }
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const backoffMs = attempt => Math.min(2 ** attempt * 1000 + Math.floor(Math.random() * 1000), MAX_BACKOFF_MS);

/**
 * JSON, escaped so it can travel in an HTTP header.
 *
 * The content endpoints take their arguments in `Dropbox-API-Arg` rather than in
 * a body, and headers are ASCII. A file called `Café notes.md` breaks the
 * request outright unless every non-ASCII character is escaped first — which is
 * the kind of thing that passes every fixture and fails on the first real
 * folder.
 */
export function apiArg(value) {
  // Anything outside printable ASCII, which is control characters as well as
  // the accents and emoji people actually put in filenames.
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, c =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

async function accessTokenFor(a) {
  if (a.accessToken && Date.now() < a.expiresAt) return a.accessToken;
  if (!a.refreshToken) return a.accessToken;

  const res = await globalThis.fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: a.refreshToken,
      client_id: a.appKey,
      client_secret: a.appSecret,
    }).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new DropboxError(res.status, json);

  a.accessToken = json.access_token;
  // Renewed a minute early, so a token cannot expire between two documents and
  // fail one arbitrary file in a way nobody can reproduce.
  a.expiresAt = Date.now() + ((json.expires_in ?? 14400) * 1000) - 60000;
  return a.accessToken;
}

/**
 * One request, retried on the errors worth retrying.
 *
 * A 429 always carries `Retry-After` and the docs are explicit that rejected
 * requests still count against the limit, so a retry loop that ignores the
 * header actively makes things worse.
 */
async function request(a, url, init, { retries = 3, sleep = wait, raw = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const token = await accessTokenFor(a);
    const res = await globalThis.fetch(url, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
    });

    if (res.ok) return raw ? res.text() : res.json();

    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const header = Number(res.headers?.get?.('retry-after'));
      // `Retry-After: 0` is Dropbox's documented "just try again" on write
      // contention, so a truthiness check would turn it into a needless wait.
      const seconds = Number.isFinite(header) && header >= 0 ? header : null;
      await sleep(seconds === null ? backoffMs(attempt) : seconds * 1000);
      continue;
    }
    if (res.status === 401 && a.refreshToken && attempt < retries) {
      a.expiresAt = 0;                       // expired early; mint a new one
      continue;
    }

    // Endpoint errors come back as 409 with JSON; auth errors sometimes as
    // plain text, hence the fallback.
    const text = await res.text().catch(() => '');
    let body;
    try { body = JSON.parse(text); } catch { body = { error_summary: text }; }
    throw new DropboxError(res.status, body);
  }
}

const rpc = (a, path, body, opts) => request(a, `${RPC}/${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}, opts);

const content = (a, path, arg, opts) => request(a, `${CONTENT}/${path}`, {
  method: 'POST',
  // No Content-Type: the content endpoints take an empty body, and sending one
  // makes Dropbox reject the request.
  headers: { 'Dropbox-API-Arg': apiArg(arg) },
}, { ...opts, raw: true });

// ---- selector ----------------------------------------------------------

/**
 * A Dropbox path, a file id, or a shared link.
 *
 * There is deliberately no "everything" form. The root *is* a legal path here —
 * which is exactly why it has to be typed rather than defaulted into. Someone
 * who means their whole Dropbox can say `/`; nobody gets it by omission.
 */
export function parseSelector(input) {
  const s = String(input ?? '').trim();
  if (!s) {
    throw new Error('dropbox needs a path, a file id or a shared link — '
      + 'e.g. /Specs, or paste a dropbox.com link. Use / for your whole Dropbox.');
  }

  if (/^https?:\/\//i.test(s)) {
    if (!/(^|\.)dropbox\.com\//i.test(s)) throw new Error(`not a Dropbox link: "${s}"`);
    return { link: s };
  }
  // `id:` and `ns:` are Dropbox's own addressing forms and every path-taking
  // endpoint accepts them in place of a path.
  if (/^(id|ns|rev):/.test(s)) return { path: s };
  // The API wants the root as "", not "/".
  if (s === '/') return { path: '' };
  return { path: s.startsWith('/') ? s : `/${s}` };
}

// ---- classification ----------------------------------------------------

const TEXT = /\.(md|markdown|txt|text)$/i;

/**
 * What an entry is, decided from the listing alone.
 *
 * `is_downloadable` and `export_info.export_as` are the API telling us how to
 * fetch each file, so the non-downloadable branch reads Dropbox's answer rather
 * than guessing from a name. That is the part of this connector worth copying.
 */
export function classify(entry) {
  const tag = entry?.['.tag'];
  if (tag === 'folder') return { folder: true };
  if (tag === 'deleted') return { skip: 'deleted' };

  const name = String(entry?.name || '');

  if (entry?.is_downloadable === false) {
    const as = entry?.export_info?.export_as;
    if (as === 'markdown') return { exportAs: 'markdown' };
    // A Google Doc kept in Dropbox reports `docx` here, so the export path is
    // not a way around the OOXML problem — it lands in the same place.
    return {
      skip: as
        ? `exports only as ${as} — needs the Word reader, which is not built yet`
        : 'cannot be downloaded, and Dropbox names no export format',
    };
  }

  if (TEXT.test(name)) return { download: true };
  if (/\.docx$/i.test(name)) {
    return { skip: 'Word documents need the OOXML reader, which is not built yet' };
  }
  const ext = /\.([^.]+)$/.exec(name)?.[1];
  return { skip: `unsupported type (${ext ? `.${ext}` : 'no extension'})` };
}

const idFor = entry => `dropbox:${entry.id || entry.path_lower}`;

const itemFor = (entry, kind, link) => ({
  ref: {
    // `path_lower` is the addressable form; `path_display` keeps the casing a
    // human typed, so it is what the reviewer should see.
    path: entry.path_lower || entry.path_display,
    display: entry.path_display,
    title: entry.name,
    exportAs: kind.exportAs,
    link,
  },
  id: idFor(entry),
  title: entry.name || 'Untitled',
});

// ---- listing -----------------------------------------------------------

/**
 * Every entry beneath a path, at every depth, in one call.
 *
 * This is the whole reason this connector is small. `recursive: true` does what
 * Drive, Graph and Notion each need a hand-written tree walk to achieve, and
 * `list_folder/continue` pages it with a cursor.
 */
async function* entries(a, body, opts) {
  let page = await rpc(a, 'files/list_folder', { recursive: true, limit: PAGE_LIMIT, ...body }, opts);
  for (;;) {
    yield* page.entries || [];
    if (!page.has_more) return;
    page = await rpc(a, 'files/list_folder/continue', { cursor: page.cursor }, opts);
  }
}

function collect(source, { since, link }) {
  const cutoff = since ? new Date(since).getTime() : null;
  if (since && !Number.isFinite(cutoff)) throw new Error(`not a date: "${since}"`);

  const items = [];
  const skipped = [];

  for (const entry of source) {
    const kind = classify(entry);
    // Folders carry no content and the recursive listing already returned their
    // children, so they are neither an item nor worth a skip line.
    if (kind.folder) continue;

    // Client-side, because `list_folder` has no time filter — but unlike M365
    // that costs nothing here: the listing was a single call either way.
    // An entry missing the field is kept rather than dropped; importing nothing
    // because a timestamp was absent is the failure worth avoiding.
    if (cutoff && entry.server_modified && new Date(entry.server_modified).getTime() < cutoff) continue;

    if (kind.skip) { skipped.push({ id: idFor(entry), reason: kind.skip }); continue; }

    // A shared link can be downloaded but not exported, so a Paper doc reached
    // that way has to say so rather than fail later at fetch time.
    if (link && kind.exportAs) {
      skipped.push({ id: idFor(entry), reason: 'cannot be exported through a shared link — import it by path instead' });
      continue;
    }
    // The size in the listing is the file's own bytes, which for plain text is
    // what normalizeDocument will measure. Skipping here costs the same skip
    // line and saves the download. Not applied to exports: there the size is
    // the stub's, not the rendered markdown's.
    if (kind.download && entry.size > DEFAULT_MAX_BYTES) {
      skipped.push({
        id: idFor(entry),
        reason: `too large (${Math.round(entry.size / 1024)}KB, limit ${Math.round(DEFAULT_MAX_BYTES / 1024)}KB)`,
      });
      continue;
    }

    // One skip line for the cap rather than one per file left behind.
    if (items.length >= MAX_FILES) {
      skipped.push({
        id: 'dropbox:*',
        reason: `stopped at ${MAX_FILES} files — import a smaller folder, or narrow it with --since`,
      });
      break;
    }
    items.push(itemFor(entry, kind, link));
  }
  return { items, skipped };
}

export async function list(a, selector, { since, ...opts } = {}) {
  const target = parseSelector(Array.isArray(selector) ? selector[0] : selector);

  if (target.link) {
    const meta = await rpc(a, 'sharing/get_shared_link_metadata', { url: target.link }, opts);
    if (meta['.tag'] !== 'folder') {
      // A link to a single file: no listing needed, and no --since check —
      // pasting a link and being handed nothing because the file is a fortnight
      // old would be obtuse. The window bounds a search.
      return collect([{ ...meta, server_modified: null }], { link: target.link });
    }
    const all = [];
    // `path: ''` with a shared_link means "the root of what this link points
    // at", which is how a shared folder is walked without owning it.
    for await (const entry of entries(a, { path: '', shared_link: { url: target.link } }, opts)) all.push(entry);
    return collect(all, { since, link: target.link });
  }

  const meta = await rpc(a, 'files/get_metadata', { path: target.path }, opts).catch(err => {
    // The root has no metadata of its own; treat it as the folder it is.
    if (target.path === '') return { '.tag': 'folder' };
    throw err;
  });
  if (meta['.tag'] !== 'folder') return collect([meta], {});

  const all = [];
  for await (const entry of entries(a, { path: target.path }, opts)) all.push(entry);
  return collect(all, { since });
}

// ---- fetching ----------------------------------------------------------

/**
 * One document's text.
 *
 * Three endpoints, chosen in `list`: `files/export` renders a Paper doc as
 * markdown, `files/download` returns plain text verbatim, and a file reached
 * through a shared link has its own endpoint because it may not be in this
 * account's Dropbox at all.
 */
export async function fetch(a, ref, opts = {}) {
  if (!ref?.path && !ref?.link) throw new Error('dropbox: nothing to fetch — the item has no path');

  let text;
  if (ref.link) {
    text = await content(a, 'sharing/get_shared_link_file', { url: ref.link, path: ref.path }, opts);
  } else if (ref.exportAs) {
    text = await content(a, 'files/export', { path: ref.path, export_format: ref.exportAs }, opts);
  } else {
    text = await content(a, 'files/download', { path: ref.path }, opts);
  }

  return {
    id: `dropbox:${ref.path || ref.link}`,
    title: ref.title || ref.display || String(ref.path),
    text,
  };
}
