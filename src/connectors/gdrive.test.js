import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as gdrive from './gdrive.js';

const FOLDER = '1AbCdEfGhIjKlMnOpQrStUvWxYz01234';
const SUB = '1SubFolderIdAaaaaaaaaaaaaaaaaaaa';
const DOC = '1DocumentIdBbbbbbbbbbbbbbbbbbbbb';

const MIME = {
  folder: 'application/vnd.google-apps.folder',
  doc: 'application/vnd.google-apps.document',
  slides: 'application/vnd.google-apps.presentation',
  sheet: 'application/vnd.google-apps.spreadsheet',
};

const json = body => ({ ok: true, status: 200, json: async () => body });
const text = body => ({ ok: true, status: 200, text: async () => body });
const fail = (status, body) => ({ ok: false, status, json: async () => body });
const googleError = (status, reason, message = '') =>
  fail(status, { error: { code: status, message, errors: [{ reason, message }] } });

/** Credentials as `auth` hands them over, already holding a live token so the
 *  refresh exchange does not have to be mocked in every listing test. */
const authed = () => ({
  ok: true, accessToken: 'ya29.test', clientId: '', clientSecret: '', refreshToken: '',
  expiresAt: Infinity,
});

const file = (id, name, mimeType, extra = {}) => ({
  id, name, mimeType,
  modifiedTime: '2026-08-01T00:00:00.000Z',
  webViewLink: `https://drive.google.com/file/d/${id}/view`,
  ...extra,
});

let calls;
const route = handlers => vi.fn(async (url, init) => {
  calls.push({ url: String(url), method: init?.method || 'GET', body: init?.body });
  for (const [pattern, handler] of handlers) {
    if (String(url).includes(pattern)) return typeof handler === 'function' ? handler(String(url)) : handler;
  }
  return json({ files: [] });
});

/** Backoff without the wall-clock wait. */
const nowait = { sleep: async () => {} };

/** URLSearchParams form-encodes spaces as `+`, which decodeURIComponent leaves
 *  alone — so reading a `q` back needs both steps. */
const decoded = url => decodeURIComponent(String(url).replace(/\+/g, '%20'));

beforeEach(() => { calls = []; });
afterEach(() => { vi.restoreAllMocks(); });

describe('auth', () => {
  it('explains the whole procedure when there are no credentials', () => {
    const r = gdrive.auth({});
    expect(r.ok).toBe(false);
    expect(r.help).toMatch(/GOOGLE_REFRESH_TOKEN/);
    // Point at the command rather than reciting the OAuth dance.
    expect(r.help, 'must name the command that fixes this').toMatch(/teamctx auth gdrive/);
    // The seven-day expiry is the failure that shows up a week after
    // everything worked, so it has to be said before the choice is made.
    expect(r.help, 'must warn about the Testing-mode expiry').toMatch(/seven days/);
  });

  it('accepts a client id, secret and refresh token', () => {
    expect(gdrive.auth({
      GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REFRESH_TOKEN: 'r1',
    })).toMatchObject({ ok: true, refreshToken: 'r1' });
  });

  it('accepts a bare access token, for trying it out without a client', () => {
    const r = gdrive.auth({ GOOGLE_ACCESS_TOKEN: 'ya29.x' });
    expect(r).toMatchObject({ ok: true, accessToken: 'ya29.x' });
    // Nothing can renew it, so it is used until Google rejects it rather than
    // refreshed against a clock we have no token for.
    expect(r.expiresAt).toBe(Infinity);
  });

  it('rejects a partial set rather than failing later with a confusing error', () => {
    expect(gdrive.auth({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_REFRESH_TOKEN: 'r1' }).ok).toBe(false);
  });

  it('does not make a network call', () => {
    // Every other connector's auth is synchronous, and a --dry-run that is
    // misconfigured elsewhere should not spend a request here.
    const spy = vi.spyOn(globalThis, 'fetch');
    gdrive.auth({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('authorize', () => {
  const answers = list => { const q = [...list]; return async () => q.shift() ?? ''; };
  const loopback = (over = {}) => async ({ buildUrl }) => ({
    code: 'the-code',
    redirectUri: 'http://127.0.0.1:54321',
    url: buildUrl('http://127.0.0.1:54321', 'st4te'),
    ...over,
  });
  /** Capture the authorize URL the connector asks the listener to show. */
  const captureUrl = () => {
    const seen = {};
    return [seen, async ({ buildUrl }) => {
      seen.url = buildUrl('http://127.0.0.1:54321', 'st4te');
      return { code: 'the-code', redirectUri: 'http://127.0.0.1:54321' };
    }];
  };
  const exchanged = body => vi.fn(async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body });
    return { ok: true, status: 200, json: async () => body };
  });

  it('returns the three variables the connector reads', async () => {
    globalThis.fetch = exchanged({ refresh_token: 'r-live', access_token: 'ya29.x' });
    const values = await gdrive.authorize({
      ask: answers(['cid', 'csecret']), loopback: loopback(),
    });
    expect(values).toEqual({
      GOOGLE_CLIENT_ID: 'cid',
      GOOGLE_CLIENT_SECRET: 'csecret',
      GOOGLE_REFRESH_TOKEN: 'r-live',
    });
  });

  it('asks for offline access and forces the consent screen', async () => {
    // access_type=offline is what produces a refresh token at all. prompt=consent
    // is what makes Google produce one *again* — without it, re-running this to
    // repair a broken login appears to work and hands back nothing.
    const [seen, lb] = captureUrl();
    globalThis.fetch = exchanged({ refresh_token: 'r' });
    await gdrive.authorize({ ask: answers(['cid', 's']), loopback: lb });

    expect(seen.url).toContain('access_type=offline');
    expect(seen.url).toContain('prompt=consent');
    expect(decodeURIComponent(seen.url)).toContain(gdrive.SCOPE);
    expect(seen.url).toContain('state=st4te');
  });

  it('sends the same redirect_uri it was authorized with', async () => {
    // Google compares them exactly, port included, and the port is not known
    // until the listener has bound.
    globalThis.fetch = exchanged({ refresh_token: 'r' });
    await gdrive.authorize({ ask: answers(['cid', 's']), loopback: loopback() });

    expect(calls[0].body).toContain(encodeURIComponent('http://127.0.0.1:54321'));
    expect(calls[0].body).toContain('grant_type=authorization_code');
  });

  it('routes the client secret through the masking prompt', async () => {
    const plain = [];
    const masked = [];
    globalThis.fetch = exchanged({ refresh_token: 'r' });
    await gdrive.authorize({
      ask: async (q, d) => { plain.push(q); return d || 'x'; },
      askSecret: async (q, d) => { masked.push(q); return d || 'x'; },
      loopback: loopback(),
      env: { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'the-real-secret' },
    });
    expect(masked).toContain('Client secret');
    expect(plain, 'a client id is public; the secret is not').not.toContain('Client secret');
  });

  it('explains a response with no refresh token instead of saving a one-hour login', async () => {
    // Google omits it when this account has already consented to the client.
    globalThis.fetch = exchanged({ access_token: 'ya29.short' });
    await expect(gdrive.authorize({ ask: answers(['c', 's']), loopback: loopback() }))
      .rejects.toThrow(/revoke it at myaccount\.google\.com\/permissions/);
  });

  it('explains a stale authorization code', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }),
    }));
    await expect(gdrive.authorize({ ask: answers(['c', 's']), loopback: loopback() }))
      .rejects.toThrow(/single-use/);
  });

  it('says so when run without the loopback listener', async () => {
    // Google removed the paste-a-code flow, so there is no fallback path.
    await expect(gdrive.authorize({ ask: answers(['c', 's']) }))
      .rejects.toThrow(/teamctx auth gdrive/);
  });

  it('stops before opening a listener if the client details are missing', async () => {
    const lb = vi.fn();
    await expect(gdrive.authorize({ ask: answers(['', '']), loopback: lb }))
      .rejects.toThrow(/client ID is required/);
    expect(lb, 'no port should be opened for a login that cannot proceed').not.toHaveBeenCalled();
  });
});

describe('parseSelector', () => {
  it('accepts a folder link', () => {
    expect(gdrive.parseSelector(`https://drive.google.com/drive/folders/${FOLDER}`))
      .toEqual({ folderId: FOLDER });
  });

  it('accepts a folder link with an account prefix and a sharing suffix', () => {
    // What Drive actually puts on the clipboard for someone with two accounts.
    expect(gdrive.parseSelector(`https://drive.google.com/drive/u/1/folders/${FOLDER}?usp=sharing`))
      .toEqual({ folderId: FOLDER });
  });

  it('accepts a Docs, Slides or Sheets link', () => {
    for (const kind of ['document', 'presentation', 'spreadsheets']) {
      expect(gdrive.parseSelector(`https://docs.google.com/${kind}/d/${DOC}/edit?usp=sharing`))
        .toEqual({ fileId: DOC });
    }
  });

  it('accepts a link to an uploaded file', () => {
    expect(gdrive.parseSelector(`https://drive.google.com/file/d/${DOC}/view`))
      .toEqual({ fileId: DOC });
  });

  it('ignores a heading fragment', () => {
    expect(gdrive.parseSelector(`https://docs.google.com/document/d/${DOC}/edit#heading=h.abc123`))
      .toEqual({ fileId: DOC });
  });

  it('leaves a bare id unresolved, because folders and files share an id space', () => {
    expect(gdrive.parseSelector(DOC)).toEqual({ unresolvedId: DOC });
    expect(gdrive.parseSelector(`https://drive.google.com/open?id=${DOC}`))
      .toEqual({ unresolvedId: DOC });
  });

  it('refuses an empty selector rather than importing the whole Drive', () => {
    // Notion allows the bare form because the user already chose, in Notion's
    // UI, what the integration can see. drive.readonly sees everything, so the
    // command line is the only place that choice can happen.
    expect(() => gdrive.parseSelector('')).toThrow(/needs a folder or file/);
    expect(() => gdrive.parseSelector(undefined)).toThrow(/needs a folder or file/);
  });

  it('rejects a link that is not Drive', () => {
    expect(() => gdrive.parseSelector('https://example.com/whatever')).toThrow(/not a Google Drive link/);
    expect(() => gdrive.parseSelector('../../etc/passwd')).toThrow(/not a Google Drive link/);
  });
});

describe('classify', () => {
  it('exports a Google Doc as markdown', () => {
    expect(gdrive.classify(file(DOC, 'Spec', MIME.doc))).toEqual({ exportAs: 'text/markdown' });
  });

  it('exports Slides as plain text', () => {
    // The "first-slide only" caveat in Google's export table is on the image
    // formats, not on text — a deck exports whole.
    expect(gdrive.classify(file(DOC, 'Deck', MIME.slides))).toEqual({ exportAs: 'text/plain' });
  });

  it('downloads uploaded text as-is', () => {
    expect(gdrive.classify(file(DOC, 'notes.md', 'text/markdown'))).toEqual({ download: true });
    expect(gdrive.classify(file(DOC, 'notes.txt', 'text/plain'))).toEqual({ download: true });
  });

  it('skips a spreadsheet with a reason rather than exporting CSV', () => {
    expect(gdrive.classify(file(DOC, 'Budget', MIME.sheet)).skip).toMatch(/records, not prose/);
  });

  it('names what a real Drive is actually full of', () => {
    for (const mime of ['image/jpeg', 'video/mp4', 'application/vnd.android.package-archive', 'application/pdf']) {
      expect(gdrive.classify(file(DOC, 'thing', mime)).skip, mime).toMatch(/unsupported type/);
    }
  });

  it('treats a missing mimeType as unsupported rather than guessing', () => {
    expect(gdrive.classify({ id: DOC }).skip).toMatch(/unknown/);
  });
});

describe('list — a folder', () => {
  it('returns one item per document and skips the rest', async () => {
    globalThis.fetch = route([['files?', json({
      files: [
        file('1docAaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Architecture', MIME.doc),
        file('1picAaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'team.jpg', 'image/jpeg'),
        file('1apkAaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'app.apk', 'application/vnd.android.package-archive'),
      ],
    })]]);

    const r = await gdrive.list(authed(), `https://drive.google.com/drive/folders/${FOLDER}`, nowait);
    expect(r.items.map(i => i.title)).toEqual(['Architecture']);
    expect(r.skipped.map(s => s.reason)).toEqual([
      'unsupported type (image/jpeg)',
      'unsupported type (application/vnd.android.package-archive)',
    ]);
  });

  it('never requests the content of a file it is going to skip', async () => {
    // The whole reason the mimeType filter lives in list: a real Drive is
    // mostly video and installers, and deciding from metadata means none of it
    // is ever downloaded.
    globalThis.fetch = route([['files?', json({
      files: [file('1vidAaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'demo.mp4', 'video/mp4')],
    })]]);

    await gdrive.list(authed(), `https://drive.google.com/drive/folders/${FOLDER}`, nowait);
    expect(calls).toHaveLength(1);
    expect(calls.every(c => !c.url.includes('alt=media'))).toBe(true);
  });

  it('descends into subfolders, which Drive will not do for us', async () => {
    globalThis.fetch = route([['files?', url => json(
      url.includes(SUB)
        ? { files: [file(DOC, 'Nested spec', MIME.doc)] }
        : { files: [file(SUB, 'Specs', MIME.folder)] },
    )]]);

    const r = await gdrive.list(authed(), `https://drive.google.com/drive/folders/${FOLDER}`, nowait);
    expect(r.items.map(i => i.title)).toEqual(['Nested spec']);
    // A folder is a container, never a document of its own.
    expect(r.skipped).toEqual([]);
  });

  it('follows several levels down', async () => {
    const level = ['1lvl1aaaaaaaaaaaaaaaaaaaaaaaaaaaa', '1lvl2aaaaaaaaaaaaaaaaaaaaaaaaaaaa', '1lvl3aaaaaaaaaaaaaaaaaaaaaaaaaaaa'];
    globalThis.fetch = route([['files?', url => {
      const at = level.findIndex(id => url.includes(id));
      if (at === -1) return json({ files: [file(level[0], 'one', MIME.folder)] });
      if (at < level.length - 1) return json({ files: [file(level[at + 1], `level ${at + 2}`, MIME.folder)] });
      return json({ files: [file(DOC, 'Deep decision', MIME.doc)] });
    }]]);

    const r = await gdrive.list(authed(), `https://drive.google.com/drive/folders/${FOLDER}`, nowait);
    expect(r.items.map(i => i.title)).toEqual(['Deep decision']);
  });

  it('does not loop when a file sits in two folders at once', async () => {
    // Drive is a graph, not a tree — a folder can have several parents, so a
    // walk without a seen-set can revisit forever.
    globalThis.fetch = route([['files?', url => json({
      files: url.includes(SUB)
        ? [file(FOLDER, 'back up', MIME.folder), file(DOC, 'Spec', MIME.doc)]
        : [file(SUB, 'down', MIME.folder)],
    })]]);

    const r = await gdrive.list(authed(), `https://drive.google.com/drive/folders/${FOLDER}`, nowait);
    expect(r.items.map(i => i.title)).toEqual(['Spec']);
  });

  it('follows pageToken to the end of a folder', async () => {
    let page = 0;
    globalThis.fetch = route([['files?', () => json(page++ === 0
      ? { files: [file('1p1Aaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'One', MIME.doc)], nextPageToken: 'more' }
      : { files: [file('1p2Aaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Two', MIME.doc)] })]]);

    const r = await gdrive.list(authed(), `https://drive.google.com/drive/folders/${FOLDER}`, nowait);
    expect(r.items.map(i => i.title)).toEqual(['One', 'Two']);
    expect(calls[1].url).toContain('pageToken=more');
  });

  it('asks for the fields it needs and for shared drives', async () => {
    globalThis.fetch = route([['files?', json({ files: [] })]]);
    await gdrive.list(authed(), `https://drive.google.com/drive/folders/${FOLDER}`, nowait);

    const url = decoded(calls[0].url);
    // Drive returns id, name and mimeType only unless asked — without this
    // projection every file would look untyped and unlinkable.
    expect(url).toContain('webViewLink');
    // Without both flags a team's shared drive is simply invisible.
    expect(url).toContain('supportsAllDrives=true');
    expect(url).toContain('includeItemsFromAllDrives=true');
    expect(url).toContain('trashed = false');
  });

  it('stops at the cap with one line, not one per file', async () => {
    globalThis.fetch = route([['files?', json({
      files: Array.from({ length: 250 }, (_, i) =>
        file(`1cap${String(i).padStart(28, '0')}`, `Doc ${i}`, MIME.doc)),
    })]]);

    const r = await gdrive.list(authed(), `https://drive.google.com/drive/folders/${FOLDER}`, nowait);
    expect(r.items).toHaveLength(200);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toMatch(/stopped at 200 files/);
  });
});

describe('list — --since', () => {
  it('filters files server-side', async () => {
    globalThis.fetch = route([['files?', json({ files: [] })]]);
    await gdrive.list(authed(), `https://drive.google.com/drive/folders/${FOLDER}`,
      { since: '2026-08-01', ...nowait });

    expect(decoded(calls[0].url)).toContain("modifiedTime > '2026-08-01T00:00:00.000Z'");
  });

  it('never filters folders by modifiedTime', async () => {
    // A folder's own timestamp does not move when a document inside it
    // changes, so filtering folders would prune a subtree containing exactly
    // the new work --since was asked for.
    globalThis.fetch = route([['files?', json({ files: [] })]]);
    await gdrive.list(authed(), `https://drive.google.com/drive/folders/${FOLDER}`,
      { since: '2026-08-01', ...nowait });

    const q = decoded(calls[0].url);
    expect(q).toMatch(/mimeType = 'application\/vnd\.google-apps\.folder' or modifiedTime/);
  });

  it('rejects an unparseable date instead of silently importing everything', async () => {
    globalThis.fetch = route([['files?', json({ files: [] })]]);
    await expect(gdrive.list(authed(), `https://drive.google.com/drive/folders/${FOLDER}`,
      { since: 'last tuesday', ...nowait })).rejects.toThrow(/not a date/);
  });

  it('does not apply to a file named outright', async () => {
    // Pasting a link to one document and being handed nothing because it is a
    // fortnight old would be obtuse. The window bounds a search.
    globalThis.fetch = route([[`files/${DOC}`, json(file(DOC, 'Old spec', MIME.doc, { modifiedTime: '2020-01-01T00:00:00.000Z' }))]]);

    const r = await gdrive.list(authed(), `https://docs.google.com/document/d/${DOC}/edit`,
      { since: '2026-08-01', ...nowait });
    expect(r.items).toHaveLength(1);
  });
});

describe('list — a single file', () => {
  it('returns the one document', async () => {
    globalThis.fetch = route([[`files/${DOC}`, json(file(DOC, 'Billing decision', MIME.doc))]]);

    const r = await gdrive.list(authed(), `https://docs.google.com/document/d/${DOC}/edit`, nowait);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ id: `gdrive:${DOC}`, title: 'Billing decision' });
    expect(r.items[0].ref.exportAs).toBe('text/markdown');
  });

  it('carries the API\'s own link, rather than one we constructed', async () => {
    globalThis.fetch = route([[`files/${DOC}`, json(file(DOC, 'Spec', MIME.doc, {
      webViewLink: 'https://docs.google.com/document/d/REAL/edit?usp=drivesdk',
    }))]]);

    const r = await gdrive.list(authed(), DOC, nowait);
    expect(r.items[0].ref.url).toBe('https://docs.google.com/document/d/REAL/edit?usp=drivesdk');
  });

  it('walks it when a bare id turns out to be a folder', async () => {
    globalThis.fetch = route([
      [`files/${FOLDER}?`, json(file(FOLDER, 'Specs', MIME.folder))],
      ['files?', json({ files: [file(DOC, 'Inside', MIME.doc)] })],
    ]);

    const r = await gdrive.list(authed(), FOLDER, nowait);
    expect(r.items.map(i => i.title)).toEqual(['Inside']);
  });

  it('reports why a named file cannot be imported', async () => {
    // Asking for a spreadsheet by name and getting silence reads as a bug.
    globalThis.fetch = route([[`files/${DOC}`, json(file(DOC, 'Budget', MIME.sheet))]]);

    const r = await gdrive.list(authed(), `https://docs.google.com/spreadsheets/d/${DOC}/edit`, nowait);
    expect(r.items).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/records, not prose/);
  });
});

describe('fetch', () => {
  it('exports a Google Doc as markdown', async () => {
    globalThis.fetch = route([['/export', text('# Spec\n\nWe chose Postgres.')]]);

    const doc = await gdrive.fetch(authed(),
      { id: DOC, title: 'Spec', exportAs: 'text/markdown' }, nowait);
    expect(doc).toEqual({ id: `gdrive:${DOC}`, title: 'Spec', text: '# Spec\n\nWe chose Postgres.' });
    expect(decoded(calls[0].url)).toContain('mimeType=text/markdown');
  });

  it('downloads uploaded text through alt=media instead of exporting it', async () => {
    // A blob has no export — asking for one returns 403 fileNotExportable.
    globalThis.fetch = route([['alt=media', text('plain notes')]]);

    const doc = await gdrive.fetch(authed(), { id: DOC, title: 'notes.md' }, nowait);
    expect(doc.text).toBe('plain notes');
    expect(calls[0].url).not.toContain('/export');
  });

  it('falls back to the id when a file has no name', async () => {
    globalThis.fetch = route([['/export', text('body')]]);
    const doc = await gdrive.fetch(authed(), { id: DOC, exportAs: 'text/plain' }, nowait);
    expect(doc.title).toBe(DOC);
  });

  it('refuses an id that is not shaped like a Drive id', async () => {
    // The id reaches a URL path; nothing that could escape it gets that far.
    await expect(gdrive.fetch(authed(), { id: '../../etc/passwd' }, nowait))
      .rejects.toThrow(/not a Google Drive file id/);
  });
});

describe('errors', () => {
  it('names the seven-day expiry when the refresh token is dead', async () => {
    // The single most likely failure after a week of everything working, and
    // "invalid_grant" on its own explains nothing.
    globalThis.fetch = vi.fn(async () => fail(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));

    const a = gdrive.auth({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r' });
    await expect(gdrive.list(a, `https://drive.google.com/drive/folders/${FOLDER}`, nowait))
      .rejects.toThrow(/seven days/);
  });

  it('explains a document too large for Drive to export', async () => {
    globalThis.fetch = route([['/export', googleError(403, 'exportSizeLimitExceeded')]]);
    await expect(gdrive.fetch(authed(), { id: DOC, exportAs: 'text/markdown' }, nowait))
      .rejects.toThrow(/10MB limit/);
  });

  it('points at the scope when the client cannot see the file', async () => {
    // The classic drive.file mistake: a valid token that can reach nothing.
    globalThis.fetch = route([[`files/${DOC}`, googleError(403, 'appNotAuthorizedToFile')]]);
    await expect(gdrive.list(authed(), DOC, nowait)).rejects.toThrow(/drive\.readonly/);
  });

  it('retries a rate-limit 403 and succeeds', async () => {
    let n = 0;
    globalThis.fetch = route([['files?', () => (n++ === 0
      ? googleError(403, 'userRateLimitExceeded')
      : json({ files: [file(DOC, 'Spec', MIME.doc)] }))]]);

    const r = await gdrive.list(authed(), `https://drive.google.com/drive/folders/${FOLDER}`, nowait);
    expect(r.items).toHaveLength(1);
    expect(n).toBe(2);
  });

  it('does not retry a permissions 403, which will never succeed', async () => {
    let n = 0;
    globalThis.fetch = route([[`files/${DOC}`, () => { n++; return googleError(403, 'insufficientFilePermissions'); }]]);

    await expect(gdrive.list(authed(), DOC, nowait)).rejects.toThrow(/cannot read that file/);
    expect(n).toBe(1);
  });

  it('retries a 429 and a 5xx', async () => {
    for (const status of [429, 503]) {
      calls = [];
      let n = 0;
      globalThis.fetch = route([['files?', () => (n++ === 0
        ? fail(status, {})
        : json({ files: [] }))]]);

      await gdrive.list(authed(), `https://drive.google.com/drive/folders/${FOLDER}`, nowait);
      expect(n, `status ${status}`).toBe(2);
    }
  });

  it('says which credential is wrong on a 401', async () => {
    globalThis.fetch = route([['files?', fail(401, {})]]);
    await expect(gdrive.list(authed(), `https://drive.google.com/drive/folders/${FOLDER}`, nowait))
      .rejects.toThrow(/GOOGLE_ACCESS_TOKEN/);
  });
});

describe('the access token', () => {
  it('is exchanged from the refresh token on the first call, not in auth', async () => {
    globalThis.fetch = route([
      ['oauth2.googleapis.com', json({ access_token: 'ya29.fresh', expires_in: 3600 })],
      ['files?', json({ files: [] })],
    ]);

    const a = gdrive.auth({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r' });
    expect(calls).toHaveLength(0);

    await gdrive.list(a, `https://drive.google.com/drive/folders/${FOLDER}`, nowait);
    expect(calls[0].url).toContain('oauth2.googleapis.com');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toContain('grant_type=refresh_token');
    expect(calls[1].url).toContain('files?');
  });

  it('is reused across a run rather than exchanged per request', async () => {
    globalThis.fetch = route([
      ['oauth2.googleapis.com', json({ access_token: 'ya29.fresh', expires_in: 3600 })],
      ['files?', url => json(url.includes(SUB)
        ? { files: [file(DOC, 'Spec', MIME.doc)] }
        : { files: [file(SUB, 'Sub', MIME.folder)] })],
    ]);

    const a = gdrive.auth({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r' });
    await gdrive.list(a, `https://drive.google.com/drive/folders/${FOLDER}`, nowait);

    expect(calls.filter(c => c.url.includes('oauth2.googleapis.com'))).toHaveLength(1);
  });

  it('is renewed early, so it cannot expire between two documents', async () => {
    globalThis.fetch = route([['oauth2.googleapis.com', json({ access_token: 'ya29.fresh', expires_in: 3600 })]]);

    const a = gdrive.auth({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r' });
    globalThis.fetch = route([
      ['oauth2.googleapis.com', json({ access_token: 'ya29.fresh', expires_in: 3600 })],
      ['files?', json({ files: [] })],
    ]);
    await gdrive.list(a, `https://drive.google.com/drive/folders/${FOLDER}`, nowait);

    expect(a.expiresAt).toBeLessThan(Date.now() + 3600 * 1000);
  });
});
