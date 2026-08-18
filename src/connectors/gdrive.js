/**
 * Google Drive connector: files in, documents out.
 *
 * The first two connectors each had one hard part — Slack's was selection (a
 * channel is mostly noise), Notion's was structure (content is a block tree,
 * not a document). Drive has neither. Google Docs export as markdown natively,
 * so there is no renderer here and no heuristic about what is worth importing.
 *
 * Drive's hard part is authentication, and it is worse than both:
 *
 *   1. There is no token to copy. `drive.readonly` is a *restricted* scope,
 *      reachable only through a three-legged OAuth flow against a client the
 *      user creates in their own Google Cloud project. The device-code flow —
 *      the one designed for a program with no browser — supports a fixed scope
 *      list that Drive's read scopes are not on, so it is not an option.
 *   2. An OAuth client left in "Testing" publishing status issues refresh
 *      tokens that expire after seven days. A connector that works all week and
 *      fails the following Monday is a bad connector, so `auth` says this out
 *      loud rather than letting it be discovered.
 *
 * teamctx does not run the browser flow. Owning it would mean an HTTP listener,
 * a browser launch and somewhere to persist the result — three things a thin
 * pull-based adapter has no business doing, and a line the other connectors all
 * hold. Credentials arrive through the environment; `auth` explains how to get
 * them. (rclone decided the other way. It is a defensible position, not an
 * obvious one.)
 *
 * The other decision worth knowing before reading: **the mimeType filter runs
 * in `list`, not in `fetch`.** A real Drive is mostly photos, video and
 * installers. Every file's type arrives as metadata from `files.list`, so a 2GB
 * video is skipped before a byte of it is requested, and `--dry-run` costs one
 * listing call for a whole folder.
 *
 * No AI logic lives here — see src/connectors/index.js for the contract.
 */

const API = 'https://www.googleapis.com/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Drive returns `id, name, mimeType` and nothing else unless asked. Everything
 * this connector decides — what to do with a file, whether `--since` covers it,
 * where to link the reviewer — comes out of this projection, so forgetting it
 * does not fail loudly, it just makes every file look untyped.
 */
const FIELDS = 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)';
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,webViewLink';

const PAGE_SIZE = 100;

/** A folder tree can be enormous and every file is a queue entry a human has
 *  to decide on. Better to stop and say so than to drown the review queue. */
const MAX_FILES = 200;

/** Google's guidance is truncated exponential backoff with jitter. These
 *  retries are defensive: the quota is ~1,600 exports a minute, far past
 *  anything an import will reach, unlike Slack where backoff was survival. */
const MAX_BACKOFF_MS = 32000;

const MIME = {
  folder: 'application/vnd.google-apps.folder',
  doc: 'application/vnd.google-apps.document',
  slides: 'application/vnd.google-apps.presentation',
  sheet: 'application/vnd.google-apps.spreadsheet',
};

/** Drive ids are URL-safe base64-ish. Validating rather than escaping means an
 *  id can never break out of the `q` string it is interpolated into. */
const ID = /^[A-Za-z0-9_-]{10,}$/;

export const name = 'gdrive';
export const describe = 'Google Drive — a folder of documents, or a single file';

const HELP = 'run `teamctx auth gdrive` — it walks through creating the Google Cloud '
  + 'project and OAuth client, then saves GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET and '
  + 'GDRIVE_REFRESH_TOKEN to .env.local. Set the consent screen\'s user type to Internal '
  + 'if you are on Google Workspace — an External client left in "Testing" hands back '
  + 'refresh tokens that stop working after seven days. A GDRIVE_ACCESS_TOKEN on its own '
  + 'also works for about an hour, which is enough to try this out.';

/**
 * Synchronous on purpose, though a refresh token is not a usable credential.
 *
 * The contract's `auth` reports whether the user *can* authenticate, and every
 * other connector answers that without a network call. Exchanging the refresh
 * token here would make this the one connector whose auth is async, and would
 * spend a request even on `--dry-run` runs that turn out to be misconfigured
 * elsewhere. The exchange happens lazily, on the first call that needs it.
 */
export function auth(env = process.env) {
  // GDRIVE_* is the primary form, because every other connector's variables
  // carry its own name — SLACK_TOKEN, NOTION_TOKEN, DROPBOX_APP_KEY. GOOGLE_*
  // is accepted too: it is what Google's own documentation and most other
  // tooling use, so it is the other name a reader would reasonably guess.
  const accessToken = env.GDRIVE_ACCESS_TOKEN || env.GOOGLE_ACCESS_TOKEN || '';
  const clientId = env.GDRIVE_CLIENT_ID || env.GOOGLE_CLIENT_ID || '';
  const clientSecret = env.GDRIVE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || '';
  const refreshToken = env.GDRIVE_REFRESH_TOKEN || env.GOOGLE_REFRESH_TOKEN || '';

  if (!accessToken && !(clientId && clientSecret && refreshToken)) {
    return { ok: false, help: HELP };
  }
  return {
    ok: true,
    accessToken,
    clientId,
    clientSecret,
    refreshToken,
    // A pasted access token cannot be renewed, so it is treated as valid until
    // Google says otherwise rather than refreshed on a schedule we cannot keep.
    expiresAt: accessToken && !refreshToken ? Infinity : 0,
  };
}

export const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

/**
 * Walk the user through getting a refresh token, once.
 *
 * Dropbox can do this without a redirect URI at all — it shows the user a code
 * to paste back. Google allowed the same until it
 * [removed the out-of-band flow in January 2023](https://developers.google.com/identity/protocols/oauth2/resources/oob-migration),
 * so a loopback listener is the only supported route for a desktop app. That
 * listener is shared (`cli/oauth-loopback.js`) rather than built here: a
 * connector that opens a socket has stopped being a fetch adapter.
 *
 * `access_type=offline` and `prompt=consent` are both load-bearing. Without the
 * first there is no refresh token; without the second Google silently omits it
 * on every authorization after the first, so re-running this command to fix a
 * broken login would appear to work and change nothing.
 */
export async function authorize({ ask, askSecret = ask, loopback, env = process.env, log = () => {} } = {}) {
  if (typeof loopback !== 'function') {
    throw new Error('gdrive: this login needs the loopback helper — run it through `teamctx auth gdrive`');
  }

  log(`
Google Drive needs an OAuth client of your own. teamctx ships none, so no quota
is pooled and no third party sits between your team and your files.

  1. Open https://console.cloud.google.com/projectcreate and make a project
  2. Enable the Drive API:
     https://console.cloud.google.com/apis/library/drive.googleapis.com
  3. OAuth consent screen: choose Internal if you are on Google Workspace.
     Choosing External leaves the app in "Testing", and Google then expires
     your login after seven days.
  4. Credentials → Create credentials → OAuth client ID → type "Desktop app"
  5. Copy the Client ID and Client secret
`);

  const clientId = (await ask('Client ID', env.GDRIVE_CLIENT_ID || env.GOOGLE_CLIENT_ID || '')) || '';
  if (!clientId) throw new Error('gdrive: a client ID is required');
  const clientSecret = (await askSecret('Client secret', env.GDRIVE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || '')) || '';
  if (!clientSecret) throw new Error('gdrive: a client secret is required');

  const { code, redirectUri } = await loopback({
    log,
    buildUrl: (uri, state) => 'https://accounts.google.com/o/oauth2/v2/auth?'
      + new URLSearchParams({
        client_id: clientId,
        redirect_uri: uri,
        response_type: 'code',
        scope: SCOPE,
        // Without this there is no refresh token and the login dies in an hour.
        access_type: 'offline',
        // Google returns a refresh token only on the *first* consent unless
        // asked again — so without this, re-running to repair a broken login
        // would look like it worked and hand back nothing.
        prompt: 'consent',
        state,
      }).toString(),
  });

  const res = await globalThis.fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      // Must match the authorize call exactly, port included.
      redirect_uri: redirectUri,
    }).toString(),
  });
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (String(json?.error || '') === 'invalid_grant') {
      throw new Error('gdrive: that authorization code was rejected. Codes are single-use '
        + 'and expire within minutes — run the command again for a fresh one.');
    }
    throw new DriveError(res.status, json);
  }
  if (!json.refresh_token) {
    throw new Error('gdrive: Google returned no refresh token, so the login would expire in '
      + 'an hour. That happens when this account has already authorized the client — revoke '
      + 'it at myaccount.google.com/permissions and run this again.');
  }

  return {
    GDRIVE_CLIENT_ID: clientId,
    GDRIVE_CLIENT_SECRET: clientSecret,
    GDRIVE_REFRESH_TOKEN: json.refresh_token,
  };
}

export class DriveError extends Error {
  constructor(status, body) {
    const reason = body?.error?.errors?.[0]?.reason || body?.error;
    const detail = body?.error?.message || body?.error_description || '';
    const hint = {
      // The seven-day cliff, and by far the most likely failure after a week of
      // everything working. Naming it beats a bare "invalid_grant".
      invalid_grant: 'the refresh token is no longer valid. If your OAuth consent screen '
        + 'is External and still in "Testing", Google expires refresh tokens after seven '
        + 'days — set the user type to Internal, or publish the app, then re-authorize',
      invalid_client: 'GDRIVE_CLIENT_ID or GDRIVE_CLIENT_SECRET is wrong',
      insufficientFilePermissions: 'the token cannot read that file',
      exportSizeLimitExceeded: 'the document is too large for Drive to export (10MB limit)',
      notFound: 'no such file or folder — check the link, and that this account can open it',
      appNotAuthorizedToFile: 'this OAuth client was not granted access to that file — '
        + 'check the scope is drive.readonly and not drive.file',
    }[reason];

    if (hint) super(`gdrive: ${hint}`);
    else if (status === 401) super('gdrive: the credentials were rejected (401) — check GDRIVE_ACCESS_TOKEN, or re-authorize');
    else super(`gdrive ${status}${reason ? ` ${reason}` : ''}: ${detail}`.trim());

    this.status = status;
    this.reason = reason;
  }
}

const wait = ms => new Promise(r => setTimeout(r, ms));

/** 429 and 5xx are always worth another go; 403 only for the rate-limit
 *  reasons — a 403 for permissions will never succeed on retry. */
const RETRYABLE_403 = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'sharingRateLimitExceeded']);

function retryable(status, body) {
  if (status === 429 || status >= 500) return true;
  return status === 403 && RETRYABLE_403.has(body?.error?.errors?.[0]?.reason);
}

/** Google's formula: min(2^n seconds + up to a second of jitter, cap). The
 *  jitter matters when several documents fail together. */
const backoffMs = attempt => Math.min(2 ** attempt * 1000 + Math.floor(Math.random() * 1000), MAX_BACKOFF_MS);

/**
 * A usable access token, refreshed on demand.
 *
 * Renewed a minute early: a token that expires mid-import would otherwise fail
 * one arbitrary document, which is the kind of flake nobody can reproduce.
 */
async function accessTokenFor(a) {
  if (a.accessToken && Date.now() < a.expiresAt) return a.accessToken;
  if (!a.refreshToken) return a.accessToken;

  const res = await globalThis.fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: a.clientId,
      client_secret: a.clientSecret,
      refresh_token: a.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new DriveError(res.status, json);

  a.accessToken = json.access_token;
  a.expiresAt = Date.now() + ((json.expires_in ?? 3600) * 1000) - 60000;
  return a.accessToken;
}

/** One API call, retried on the errors that are worth retrying. */
async function call(a, path, { retries = 3, sleep = wait, raw = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const token = await accessTokenFor(a);
    const res = await globalThis.fetch(`${API}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.ok) return raw ? res.text() : res.json();

    const body = await res.json().catch(() => ({}));
    if (retryable(res.status, body) && attempt < retries) {
      await sleep(backoffMs(attempt));
      continue;
    }
    // An access token that expired despite the early refresh: drop it and let
    // the next attempt mint a new one, rather than failing the whole import.
    if (res.status === 401 && a.refreshToken && attempt < retries) {
      a.expiresAt = 0;
      continue;
    }
    throw new DriveError(res.status, body);
  }
}

// ---- selector ----------------------------------------------------------

/**
 * Accepts a folder link, a file link, or a bare id.
 *
 * There is deliberately no "everything" form. Notion allows one because a
 * Notion integration only sees pages the user connected by hand — the selection
 * already happened, in Notion's UI. `drive.readonly` sees the user's entire
 * Drive, so the same form would mean "import everything I have ever owned", and
 * the command line is the only place that choice can be made.
 *
 * A bare id is genuinely ambiguous — folders and files share an id space — so
 * it comes back unresolved and `list` asks Drive which it is.
 */
export function parseSelector(input) {
  const s = String(input ?? '').trim();
  if (!s) {
    throw new Error('gdrive needs a folder or file to import — paste a Drive link, '
      + 'e.g. https://drive.google.com/drive/folders/<id>');
  }

  if (/^https?:\/\//i.test(s)) {
    const path = s.split('#')[0];
    const folder = /\/folders\/([A-Za-z0-9_-]+)/.exec(path);
    if (folder) return { folderId: folder[1] };
    // docs.google.com/{document,presentation,spreadsheets}/d/<id>/edit and
    // drive.google.com/file/d/<id>/view all share this shape.
    const file = /\/d\/([A-Za-z0-9_-]+)/.exec(path);
    if (file) return { fileId: file[1] };
    // The old share form, still what "Get link" produced for years.
    const open = /[?&]id=([A-Za-z0-9_-]+)/.exec(path);
    if (open) return { unresolvedId: open[1] };
    throw new Error(`not a Google Drive link: "${s}"`);
  }

  if (ID.test(s)) return { unresolvedId: s };
  throw new Error(`not a Google Drive link or file id: "${s}"`);
}

// ---- classification ----------------------------------------------------

/**
 * What a file is, decided from metadata alone.
 *
 * Google-native files have to be *exported* — their bytes are not a document.
 * Uploaded text is downloaded as-is. Everything else is named and skipped, the
 * way `folder` walks past a `.png` inside a directory.
 */
export function classify(file) {
  const mime = String(file?.mimeType || '');
  if (mime === MIME.folder) return { folder: true };
  if (mime === MIME.doc) return { exportAs: 'text/markdown' };
  // The "first-slide only" caveat in Google's export table is on the image
  // formats, not on text — a deck exports whole. Its plain text is bullets
  // without speaker notes, which is thin, but a decision presented to the team
  // is often only ever written down on a slide. Let the manager judge it.
  if (mime === MIME.slides) return { exportAs: 'text/plain' };
  if (mime === MIME.sheet) {
    return { skip: 'a spreadsheet is records, not prose (Drive exports it only as CSV)' };
  }
  if (/^text\/(plain|markdown|x-markdown)$/.test(mime)) return { download: true };
  return { skip: `unsupported type (${mime || 'unknown'})` };
}

const idFor = file => `gdrive:${file.id}`;

const itemFor = (file, kind) => ({
  ref: {
    id: file.id,
    title: file.name,
    // Straight from the API rather than constructed, so a queue entry links to
    // something that actually opens.
    url: file.webViewLink,
    exportAs: kind.exportAs,
  },
  id: idFor(file),
  title: file.name || 'Untitled',
});

// ---- listing -----------------------------------------------------------

/**
 * `--since` filters files but never folders.
 *
 * A folder's own `modifiedTime` does not track what happens inside it, so
 * filtering folders by it would prune a subtree that contains new documents —
 * an import that silently returns less than it should, which is the worst
 * failure this connector could have.
 */
function queryFor(folderId, since) {
  if (!ID.test(folderId)) throw new Error(`not a Google Drive folder id: "${folderId}"`);
  const parts = [`'${folderId}' in parents`, 'trashed = false'];
  if (since) {
    const at = new Date(since);
    if (!Number.isFinite(at.getTime())) throw new Error(`not a date: "${since}"`);
    parts.push(`(mimeType = '${MIME.folder}' or modifiedTime > '${at.toISOString()}')`);
  }
  return parts.join(' and ');
}

async function* paged(a, folderId, { since, opts }) {
  let pageToken;
  do {
    const params = new URLSearchParams({
      q: queryFor(folderId, since),
      pageSize: String(PAGE_SIZE),
      fields: FIELDS,
      // Without both of these, a shared drive is invisible — which is where a
      // team's actual documents live, rather than in one person's My Drive.
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      orderBy: 'folder,name',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await call(a, `files?${params.toString()}`, opts);
    yield page;
    pageToken = page.nextPageToken;
  } while (pageToken);
}

async function metadata(a, fileId, opts) {
  if (!ID.test(fileId)) throw new Error(`not a Google Drive file id: "${fileId}"`);
  const params = new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: 'true' });
  return call(a, `files/${encodeURIComponent(fileId)}?${params.toString()}`, opts);
}

/**
 * Every document beneath a folder, however deep.
 *
 * Drive has no recursive query — `'X' in parents` returns direct children only
 * — so this is a breadth-first walk, the same shape the Notion and Coda
 * connectors use. `seen` matters here for a reason those do not have: a Drive
 * file can sit in several folders at once, so a tree is really a graph.
 */
async function walk(a, rootId, { since, opts }) {
  const items = [];
  const skipped = [];
  const queue = [rootId];
  const seen = new Set();

  while (queue.length > 0) {
    const folderId = queue.shift();
    if (seen.has(folderId)) continue;
    seen.add(folderId);

    for await (const page of paged(a, folderId, { since, opts })) {
      for (const file of page.files || []) {
        const kind = classify(file);
        if (kind.folder) { queue.push(file.id); continue; }
        if (kind.skip) { skipped.push({ id: idFor(file), reason: kind.skip }); continue; }
        // One skip line for the cap, not one per file left behind: a folder of
        // ten thousand documents would otherwise bury its own explanation.
        if (items.length >= MAX_FILES) {
          skipped.push({
            id: `gdrive:${rootId}`,
            reason: `stopped at ${MAX_FILES} files — import a smaller folder, or narrow it with --since`,
          });
          return { items, skipped };
        }
        items.push(itemFor(file, kind));
      }
    }
  }
  return { items, skipped };
}

export async function list(a, selector, { since, ...opts } = {}) {
  const target = parseSelector(Array.isArray(selector) ? selector[0] : selector);

  if (target.folderId) return walk(a, target.folderId, { since, opts });

  const file = await metadata(a, target.fileId || target.unresolvedId, opts);
  const kind = classify(file);
  // A bare id or an old-style ?id= link can name either. Now that Drive has
  // told us which, a folder walks and a file is one document.
  if (kind.folder) return walk(a, file.id, { since, opts });
  // No `--since` check for a file named outright: asking for one document by
  // link and being handed nothing because it is a fortnight old would be
  // obtuse. The window bounds a search, not an instruction.
  if (kind.skip) return { items: [], skipped: [{ id: idFor(file), reason: kind.skip }] };
  return { items: [itemFor(file, kind)], skipped: [] };
}

// ---- fetching ----------------------------------------------------------

/**
 * One document's text.
 *
 * Two endpoints, decided in `list`: Google-native files go through `export`,
 * which converts them; uploaded text comes back verbatim through `alt=media`.
 * Docs export as markdown natively, which is the whole reason this connector
 * has no renderer in it.
 */
export async function fetch(a, ref, opts = {}) {
  if (!ID.test(String(ref?.id || ''))) throw new Error(`not a Google Drive file id: "${ref?.id}"`);
  const id = encodeURIComponent(ref.id);

  const params = new URLSearchParams({ supportsAllDrives: 'true' });
  let path;
  if (ref.exportAs) {
    params.set('mimeType', ref.exportAs);
    path = `files/${id}/export?${params.toString()}`;
  } else {
    params.set('alt', 'media');
    path = `files/${id}?${params.toString()}`;
  }

  return {
    id: `gdrive:${ref.id}`,
    title: ref.title || String(ref.id),
    text: await call(a, path, { ...opts, raw: true }),
  };
}
