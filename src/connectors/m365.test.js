import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as m365 from './m365.js';
import { buildDocx, wordDocument, para, run } from '../formats/zip-fixture.js';

const json = body => ({ ok: true, status: 200, json: async () => body });
const bytes = buf => ({ ok: true, status: 200, arrayBuffer: async () => buf });
const text = s => bytes(Buffer.from(s, 'utf8'));
const fail = (status, code, message = '') =>
  ({ ok: false, status, json: async () => ({ error: { code, message } }) });
const tooMany = (retryAfter = '1') => ({
  ok: false, status: 429,
  headers: { get: h => (h.toLowerCase() === 'retry-after' ? retryAfter : null) },
  json: async () => ({ error: { code: 'activityLimitReached' } }),
});

const authed = () => ({
  ok: true, accessToken: 'ey.test', clientId: '', clientSecret: '', refreshToken: '',
  tenant: 'common', expiresAt: Infinity,
});

const file = (name, over = {}) => ({
  id: `01${name.replace(/\W/g, '').toUpperCase()}`,
  name,
  size: 1024,
  file: { mimeType: 'application/octet-stream' },
  webUrl: `https://contoso.sharepoint.com/x/${encodeURIComponent(name)}`,
  lastModifiedDateTime: '2026-08-01T00:00:00Z',
  parentReference: { driveId: 'b!DRIVE', path: '/drive/root:/Specs' },
  ...over,
});
const folder = (name, over = {}) => ({
  id: `01F${name.replace(/\W/g, '').toUpperCase()}`,
  name,
  folder: { childCount: 1 },
  parentReference: { driveId: 'b!DRIVE', path: '/drive/root:/Specs' },
  ...over,
});

let calls;
const route = handlers => vi.fn(async (url, init) => {
  calls.push({ url: String(url), method: init?.method || 'GET', body: init?.body });
  for (const [pattern, handler] of handlers) {
    if (String(url).includes(pattern)) return typeof handler === 'function' ? handler(String(url)) : handler;
  }
  return json({ value: [] });
});

const nowait = { sleep: async () => {} };

/** A OneDrive folder whose children are these items. */
const listing = items => route([
  ['me/drive/root', json(folder('root', { id: 'ROOT' }))],
  ['/children', json({ value: items })],
]);

beforeEach(() => { calls = []; });
afterEach(() => { vi.restoreAllMocks(); });

describe('auth', () => {
  it('points at the command when there are no credentials', () => {
    const r = m365.auth({});
    expect(r.ok).toBe(false);
    expect(r.help).toMatch(/teamctx auth m365/);
  });

  it('accepts a client id and refresh token without a secret', () => {
    // A public client has no secret, which is the recommended shape.
    expect(m365.auth({ M365_CLIENT_ID: 'c', M365_REFRESH_TOKEN: 'r' }))
      .toMatchObject({ ok: true, clientSecret: '' });
  });

  it('remembers which tenant issued the token', () => {
    // Refreshing against the wrong endpoint fails, and a personal token
    // refreshed at /organizations is exactly that.
    expect(m365.auth({ M365_CLIENT_ID: 'c', M365_REFRESH_TOKEN: 'r', M365_TENANT: 'consumers' }).tenant)
      .toBe('consumers');
    expect(m365.auth({ M365_CLIENT_ID: 'c', M365_REFRESH_TOKEN: 'r' }).tenant).toBe('common');
  });

  it('accepts a bare access token for trying it out', () => {
    expect(m365.auth({ M365_ACCESS_TOKEN: 'ey.x' })).toMatchObject({ ok: true, expiresAt: Infinity });
  });

  it('makes no network call', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    m365.auth({ M365_CLIENT_ID: 'c', M365_REFRESH_TOKEN: 'r' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('account types', () => {
  it('never asks a personal account for Sites.Read.All', () => {
    // The whole reason authorize asks. A consumer account cannot hold this
    // scope, and requesting it fails consent outright rather than granting the
    // rest — so a hardcoded work scope set would lock every personal account
    // out permanently.
    expect(m365.ACCOUNTS.personal.scopes).not.toMatch(/Sites\.Read\.All/);
    expect(m365.ACCOUNTS.work.scopes).toMatch(/Sites\.Read\.All/);
  });

  it('sends each account type to its own endpoint', () => {
    expect(m365.ACCOUNTS.personal.tenant).toBe('consumers');
    expect(m365.ACCOUNTS.work.tenant).toBe('organizations');
  });

  it('asks both for offline access, or the login expires in an hour', () => {
    for (const a of Object.values(m365.ACCOUNTS)) expect(a.scopes).toMatch(/offline_access/);
  });
});

describe('parseSelector', () => {
  it('decomposes a SharePoint site URL rather than using /shares', () => {
    // /shares names Files.ReadWrite as its least privileged permission, and a
    // read-only tool has no business asking for a write scope.
    expect(m365.parseSelector('https://contoso.sharepoint.com/sites/Eng/Shared%20Documents/Specs'))
      .toEqual({ host: 'contoso.sharepoint.com', sitePath: '/sites/Eng', drivePath: 'Shared Documents/Specs' });
  });

  it('handles a teams site and a personal library', () => {
    expect(m365.parseSelector('https://contoso.sharepoint.com/teams/Design/Docs'))
      .toMatchObject({ sitePath: '/teams/Design', drivePath: 'Docs' });
    expect(m365.parseSelector('https://contoso-my.sharepoint.com/personal/sam_contoso_com/Documents'))
      .toMatchObject({ sitePath: '/personal/sam_contoso_com', drivePath: 'Documents' });
  });

  it('takes a site root with no drive path', () => {
    expect(m365.parseSelector('https://contoso.sharepoint.com/sites/Eng'))
      .toEqual({ host: 'contoso.sharepoint.com', sitePath: '/sites/Eng', drivePath: '' });
  });

  it('falls back to /shares only for links it cannot decompose', () => {
    expect(m365.parseSelector('https://1drv.ms/w/s!AbCdEf')).toEqual({ link: 'https://1drv.ms/w/s!AbCdEf' });
  });

  it('takes a OneDrive path', () => {
    expect(m365.parseSelector('/Documents/Specs')).toEqual({ drivePath: 'Documents/Specs' });
    expect(m365.parseSelector('Documents/Specs')).toEqual({ drivePath: 'Documents/Specs' });
  });

  it('treats / as the whole OneDrive, but only when typed', () => {
    expect(m365.parseSelector('/')).toEqual({ drivePath: '' });
    expect(() => m365.parseSelector('')).toThrow(/needs a folder/);
    expect(() => m365.parseSelector(undefined)).toThrow(/needs a folder/);
  });

  it('rejects a path containing a colon, which is structural in Graph', () => {
    // root:/a/b: — a colon in the path would change what the URL addresses.
    expect(() => m365.parseSelector('/Docs/weird:name')).toThrow(/may not contain/);
  });

  it('rejects something that is not a URL', () => {
    expect(() => m365.parseSelector('https://')).toThrow(/not a URL/);
  });
});

describe('encodeSharingUrl', () => {
  it('produces Graph\'s u! base64url form', () => {
    const encoded = m365.encodeSharingUrl('https://1drv.ms/w/s!AbC+d/e');
    expect(encoded.startsWith('u!')).toBe(true);
    expect(encoded, 'must be url-safe and unpadded').not.toMatch(/[+/=]/);
    expect(Buffer.from(encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString())
      .toBe('https://1drv.ms/w/s!AbC+d/e');
  });
});

describe('classify', () => {
  it('downloads markdown and text', () => {
    for (const n of ['spec.md', 'notes.txt', 'README.markdown']) {
      expect(m365.classify(file(n)), n).toEqual({ download: true });
    }
  });

  it('extracts a Word document', () => {
    expect(m365.classify(file('Architecture.docx'))).toEqual({ extract: 'docx' });
  });

  it('skips a spreadsheet and a deck with distinct reasons', () => {
    expect(m365.classify(file('Budget.xlsx')).skip).toMatch(/records, not prose/);
    expect(m365.classify(file('Deck.pptx')).skip).toMatch(/slide text/);
  });

  it('tells the user what to do about a legacy .doc', () => {
    // "unsupported type (.doc)" would leave someone stuck; re-saving fixes it.
    expect(m365.classify(file('Old.doc')).skip).toMatch(/re-save it as \.docx/);
  });

  it('names what a real library is full of', () => {
    for (const n of ['photo.jpg', 'demo.mp4', 'report.pdf', 'archive.zip']) {
      expect(m365.classify(file(n)).skip, n).toMatch(/unsupported type/);
    }
  });

  it('recognises a folder, and something that is neither', () => {
    expect(m365.classify(folder('Archive'))).toEqual({ folder: true });
    expect(m365.classify({ name: 'ghost' }).skip).toBe('not a file');
  });
});

describe('list — a OneDrive folder', () => {
  it('returns one item per document and skips the rest', async () => {
    globalThis.fetch = listing([
      file('architecture.md'), file('Spec.docx'), file('photo.jpg'), file('Budget.xlsx'),
    ]);

    const r = await m365.list(authed(), '/Specs', nowait);
    expect(r.items.map(i => i.title)).toEqual(['architecture.md', 'Spec.docx']);
    expect(r.skipped.map(s => s.reason)).toEqual([
      'unsupported type (.jpg)', 'a spreadsheet is records, not prose',
    ]);
  });

  it('never downloads a file it is going to skip', async () => {
    globalThis.fetch = listing([file('demo.mp4', { size: 2e9 })]);
    await m365.list(authed(), '/Specs', nowait);
    expect(calls.some(c => c.url.includes('/content'))).toBe(false);
  });

  it('descends into subfolders, which Graph will not do for us', async () => {
    globalThis.fetch = route([
      ['me/drive/root', json(folder('root', { id: 'ROOT' }))],
      ['items/01FARCHIVE/children', json({ value: [file('nested.md')] })],
      ['/children', json({ value: [folder('Archive')] })],
    ]);

    const r = await m365.list(authed(), '/Specs', nowait);
    expect(r.items.map(i => i.title)).toEqual(['nested.md']);
    expect(r.skipped).toEqual([]);
  });

  it('does not loop when a folder reaches itself', async () => {
    globalThis.fetch = route([
      ['me/drive/root', json(folder('root', { id: 'ROOT' }))],
      ['items/01FLOOP/children', json({ value: [folder('Loop', { id: '01FLOOP' }), file('a.md')] })],
      ['/children', json({ value: [folder('Loop', { id: '01FLOOP' })] })],
    ]);

    const r = await m365.list(authed(), '/Specs', nowait);
    expect(r.items.map(i => i.title)).toEqual(['a.md']);
  });

  it('follows @odata.nextLink to the end', async () => {
    let page = 0;
    globalThis.fetch = route([
      ['me/drive/root', json(folder('root', { id: 'ROOT' }))],
      ['/children', () => json(page++ === 0
        ? { value: [file('one.md')], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page' }
        : { value: [file('two.md')] })],
      ['next-page', json({ value: [file('two.md')] })],
    ]);

    const r = await m365.list(authed(), '/Specs', nowait);
    expect(r.items.map(i => i.title)).toEqual(['one.md', 'two.md']);
  });

  it('stops at the cap with one line, not one per file', async () => {
    globalThis.fetch = listing(Array.from({ length: 250 }, (_, i) => file(`doc-${i}.md`)));
    const r = await m365.list(authed(), '/Specs', nowait);
    expect(r.items).toHaveLength(200);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toMatch(/stopped at 200 files/);
  });

  it('skips an oversized text file from the listing', async () => {
    globalThis.fetch = listing([file('huge.md', { size: 900 * 1024 })]);
    const r = await m365.list(authed(), '/Specs', nowait);
    expect(r.items).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/too large/);
  });

  it('allows a Word file far bigger than its text, because it compresses', async () => {
    // A .docx is mostly embedded media; judging it by the text cap would reject
    // an ordinary document with a couple of screenshots in it.
    globalThis.fetch = listing([file('Spec.docx', { size: 3 * 1024 * 1024 })]);
    const r = await m365.list(authed(), '/Specs', nowait);
    expect(r.items).toHaveLength(1);
  });
});

describe('list — SharePoint', () => {
  it('resolves the site by hostname and path, then walks its drive', async () => {
    globalThis.fetch = route([
      ['sites/contoso.sharepoint.com:/sites/Eng', json({ id: 'SITE-ID' })],
      ['sites/SITE-ID/drive/root:', json(folder('Specs', { id: 'SPECS' }))],
      ['/children', json({ value: [file('spec.md')] })],
    ]);

    const r = await m365.list(authed(),
      'https://contoso.sharepoint.com/sites/Eng/Shared Documents/Specs', nowait);
    expect(r.items).toHaveLength(1);
    // No /shares anywhere: that endpoint's documented least-privileged
    // permission is a write scope.
    expect(calls.every(c => !c.url.includes('/shares/'))).toBe(true);
  });

  it('uses /shares only for a link it could not decompose', async () => {
    globalThis.fetch = route([
      ['shares/u!', json(file('shared.md', { parentReference: { driveId: 'b!OTHER' } }))],
    ]);

    const r = await m365.list(authed(), 'https://1drv.ms/w/s!AbCdEf', nowait);
    expect(r.items).toHaveLength(1);
    expect(calls[0].url).toContain('/shares/u!');
  });
});

describe('list — --since', () => {
  it('filters in memory, because children supports no $filter', async () => {
    globalThis.fetch = listing([
      file('new.md', { lastModifiedDateTime: '2026-08-10T00:00:00Z' }),
      file('old.md', { lastModifiedDateTime: '2026-01-01T00:00:00Z' }),
    ]);

    const r = await m365.list(authed(), '/Specs', { since: '2026-08-01', ...nowait });
    expect(r.items.map(i => i.title)).toEqual(['new.md']);
    expect(decodeURIComponent(calls.at(-1).url), 'no server-side filter exists')
      .not.toContain('$filter');
  });

  it('keeps a file with no timestamp rather than dropping it', async () => {
    globalThis.fetch = listing([file('undated.md', { lastModifiedDateTime: undefined })]);
    const r = await m365.list(authed(), '/Specs', { since: '2026-08-01', ...nowait });
    expect(r.items).toHaveLength(1);
  });

  it('rejects an unparseable date instead of importing everything', async () => {
    globalThis.fetch = listing([file('a.md')]);
    await expect(m365.list(authed(), '/Specs', { since: 'last tuesday', ...nowait }))
      .rejects.toThrow(/not a date/);
  });

  it('does not apply to a file named outright', async () => {
    globalThis.fetch = route([
      ['me/drive/root:', json(file('old.md', { lastModifiedDateTime: '2020-01-01T00:00:00Z' }))],
    ]);
    const r = await m365.list(authed(), '/Specs/old.md', { since: '2026-08-01', ...nowait });
    expect(r.items).toHaveLength(1);
  });
});

describe('fetch', () => {
  it('downloads plain text', async () => {
    globalThis.fetch = route([['/content', text('# Spec\n\nWe chose Postgres.')]]);
    const doc = await m365.fetch(authed(), { id: '01A', title: 'spec.md' }, nowait);
    expect(doc).toEqual({ id: 'm365:01A', title: 'spec.md', text: '# Spec\n\nWe chose Postgres.' });
  });

  it('extracts a Word document rather than returning its bytes', async () => {
    // The whole reason this connector needs a local reader: Graph offers no
    // conversion to text for any file type.
    const docx = buildDocx(wordDocument(para(run('We chose Postgres.'))));
    globalThis.fetch = route([['/content', bytes(docx)]]);

    const doc = await m365.fetch(authed(),
      { id: '01B', title: 'Spec.docx', extract: 'docx' }, nowait);
    expect(doc.text).toBe('We chose Postgres.');
  });

  it('reads from the drive the item was listed in', async () => {
    // A SharePoint item is not in /me/drive, and asking for it there 404s.
    globalThis.fetch = route([['/content', text('body')]]);
    await m365.fetch(authed(), { id: '01C', drive: 'b!DRIVE' }, nowait);
    expect(calls[0].url).toContain('drives/b!DRIVE/items/01C/content');
  });

  it('falls back to the signed-in user\'s own drive', async () => {
    globalThis.fetch = route([['/content', text('body')]]);
    await m365.fetch(authed(), { id: '01D' }, nowait);
    expect(calls[0].url).toContain('me/drive/items/01D/content');
  });

  it('refuses an item with no id', async () => {
    await expect(m365.fetch(authed(), {}, nowait)).rejects.toThrow(/nothing to fetch/);
  });
});

describe('errors', () => {
  it('explains a path that does not exist', async () => {
    globalThis.fetch = route([['me/drive/root:', fail(404, 'itemNotFound')]]);
    await expect(m365.list(authed(), '/Nope', nowait)).rejects.toThrow(/no such file, folder or site/);
  });

  it('names the personal-account scope trap', async () => {
    // Asking a consumer account for Sites.Read.All fails the whole consent,
    // and "invalid_scope" on its own explains nothing.
    globalThis.fetch = route([['me/drive/root', fail(400, 'invalid_scope')]]);
    await expect(m365.list(authed(), '/Specs', nowait))
      .rejects.toThrow(/personal Microsoft accounts/);
  });

  it('names the app-registration audience mistake', async () => {
    // "unauthorized_client" is what Entra returns when the registration does
    // not accept the kind of account signing in, and it explains nothing.
    globalThis.fetch = route([['me/drive/root', fail(400, 'unauthorized_client')]]);
    await expect(m365.list(authed(), '/Specs', nowait))
      .rejects.toThrow(/Supported account types/);
  });

  it('honours Retry-After rather than backing off blindly', async () => {
    const waited = [];
    let n = 0;
    globalThis.fetch = route([
      ['me/drive/root', json(folder('root', { id: 'ROOT' }))],
      ['/children', () => (n++ === 0 ? tooMany('7') : json({ value: [] }))],
    ]);

    await m365.list(authed(), '/Specs', { sleep: async ms => waited.push(ms) });
    expect(waited).toContain(7000);
    expect(n).toBe(2);
  });

  it('retries a 5xx', async () => {
    let n = 0;
    globalThis.fetch = route([
      ['me/drive/root', json(folder('root', { id: 'ROOT' }))],
      ['/children', () => (n++ === 0 ? fail(503, 'serviceNotAvailable') : json({ value: [] }))],
    ]);
    await m365.list(authed(), '/Specs', nowait);
    expect(n).toBe(2);
  });

  it('does not retry a permissions error, which will never succeed', async () => {
    let n = 0;
    globalThis.fetch = route([['me/drive/root', () => { n++; return fail(403, 'accessDenied'); }]]);
    await expect(m365.list(authed(), '/Specs', nowait)).rejects.toThrow(/not allowed to read/);
    expect(n).toBe(1);
  });
});

describe('the access token', () => {
  const refreshing = (over = {}) => route([
    ['oauth2/v2.0/token', json({ access_token: 'ey.fresh', expires_in: 3600, ...over })],
    ['me/drive/root', json(folder('root', { id: 'ROOT' }))],
    ['/children', json({ value: [] })],
  ]);

  it('is exchanged on the first call, not in auth', async () => {
    globalThis.fetch = refreshing();
    const a = m365.auth({ M365_CLIENT_ID: 'c', M365_REFRESH_TOKEN: 'r', M365_TENANT: 'consumers' });
    expect(calls).toHaveLength(0);

    await m365.list(a, '/Specs', nowait);
    expect(calls[0].url).toContain('/consumers/oauth2/v2.0/token');
    expect(calls[0].body).toContain('grant_type=refresh_token');
  });

  it('sends no client_secret for a public client', async () => {
    // Microsoft rejects an empty secret rather than ignoring it.
    globalThis.fetch = refreshing();
    const a = m365.auth({ M365_CLIENT_ID: 'c', M365_REFRESH_TOKEN: 'r' });
    await m365.list(a, '/Specs', nowait);
    expect(calls[0].body).not.toContain('client_secret');
  });

  it('keeps the rotated refresh token Microsoft hands back', async () => {
    // Microsoft rotates them. Holding the original works until it does not,
    // and then fails a week later for no visible reason.
    globalThis.fetch = refreshing({ refresh_token: 'r-rotated' });
    const a = m365.auth({ M365_CLIENT_ID: 'c', M365_REFRESH_TOKEN: 'r-original' });
    await m365.list(a, '/Specs', nowait);
    expect(a.refreshToken).toBe('r-rotated');
  });

  it('is reused across a run', async () => {
    globalThis.fetch = refreshing();
    const a = m365.auth({ M365_CLIENT_ID: 'c', M365_REFRESH_TOKEN: 'r' });
    await m365.list(a, '/Specs', nowait);
    expect(calls.filter(c => c.url.includes('oauth2/v2.0/token'))).toHaveLength(1);
  });
});

describe('authorize', () => {
  const answers = list => { const q = [...list]; return async () => q.shift() ?? ''; };
  const captureUrl = () => {
    const seen = {};
    return [seen, async ({ buildUrl, host }) => {
      seen.host = host;
      seen.url = buildUrl(`http://${host}:54321`, 'st4te');
      return { code: 'the-code', redirectUri: `http://${host}:54321` };
    }];
  };
  const exchanged = body => vi.fn(async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body });
    return { ok: true, status: 200, json: async () => body };
  });

  it('asks the listener for localhost, not the loopback IP', async () => {
    // Entra ignores the port when matching a redirect URI only for localhost.
    // For 127.0.0.1 the port must match exactly, which an ephemeral port never
    // does — and the portal will not even register http://127.0.0.1 without a
    // manifest edit. Google accepts either, so this only breaks here.
    const [seen, lb] = captureUrl();
    globalThis.fetch = exchanged({ refresh_token: 'r' });
    await m365.authorize({ ask: answers(['work', 'cid', '']), loopback: lb });
    expect(seen.host).toBe('localhost');
    expect(decodeURIComponent(seen.url)).toContain('redirect_uri=http://localhost:54321');
  });

  it('records the tenant alongside the token', async () => {
    // Refreshing a consumer token against /organizations fails, so which
    // endpoint issued it has to survive the login.
    globalThis.fetch = exchanged({ refresh_token: 'r' });
    const values = await m365.authorize({
      ask: answers(['personal', 'cid', '']), loopback: (await captureUrl())[1],
    });
    expect(values).toMatchObject({ M365_CLIENT_ID: 'cid', M365_TENANT: 'consumers' });
  });

  it('asks a personal account only for what it can hold', async () => {
    const [seen, lb] = captureUrl();
    globalThis.fetch = exchanged({ refresh_token: 'r' });
    await m365.authorize({ ask: answers(['personal', 'cid', '']), loopback: lb });

    const scope = decodeURIComponent(seen.url);
    expect(scope).toContain('/consumers/oauth2');
    expect(scope).not.toContain('Sites.Read.All');
    expect(scope).toContain('offline_access');
  });

  it('asks a work account for the SharePoint scope too', async () => {
    const [seen, lb] = captureUrl();
    globalThis.fetch = exchanged({ refresh_token: 'r' });
    await m365.authorize({ ask: answers(['work', 'cid', '']), loopback: lb });

    expect(decodeURIComponent(seen.url)).toContain('Sites.Read.All');
    expect(seen.url).toContain('/organizations/oauth2');
  });

  it('defaults to work when the answer is not understood', async () => {
    const [seen, lb] = captureUrl();
    globalThis.fetch = exchanged({ refresh_token: 'r' });
    await m365.authorize({ ask: answers(['', 'cid', '']), loopback: lb });
    expect(seen.url).toContain('/organizations/');
  });

  it('omits the secret entirely when there is none', async () => {
    // Blank is the correct, recommended shape for a desktop app.
    globalThis.fetch = exchanged({ refresh_token: 'r' });
    const values = await m365.authorize({
      ask: answers(['work', 'cid', '']), loopback: (await captureUrl())[1],
    });
    expect(values).not.toHaveProperty('M365_CLIENT_SECRET');
    expect(calls[0].body).not.toContain('client_secret');
  });

  it('keeps a secret when the tenant requires one', async () => {
    globalThis.fetch = exchanged({ refresh_token: 'r' });
    const values = await m365.authorize({
      ask: answers(['work', 'cid', 'the-secret']), loopback: (await captureUrl())[1],
    });
    expect(values.M365_CLIENT_SECRET).toBe('the-secret');
  });

  it('routes the secret through the masking prompt', async () => {
    const plain = [];
    const masked = [];
    globalThis.fetch = exchanged({ refresh_token: 'r' });
    await m365.authorize({
      ask: async (q, d) => { plain.push(q); return d || 'work'; },
      askSecret: async q => { masked.push(q); return 'shh'; },
      loopback: (await captureUrl())[1],
    });
    expect(masked.join()).toMatch(/Client secret/);
    expect(plain.join()).not.toMatch(/Client secret/);
  });

  it('refuses a response with no refresh token', async () => {
    globalThis.fetch = exchanged({ access_token: 'ey.short' });
    await expect(m365.authorize({
      ask: answers(['work', 'cid', '']), loopback: (await captureUrl())[1],
    })).rejects.toThrow(/offline_access/);
  });

  it('explains a stale authorization code', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }),
    }));
    await expect(m365.authorize({
      ask: answers(['work', 'cid', '']), loopback: (await captureUrl())[1],
    })).rejects.toThrow(/single-use/);
  });

  it('says so when run without the loopback listener', async () => {
    await expect(m365.authorize({ ask: answers(['work', 'c', '']) }))
      .rejects.toThrow(/teamctx auth m365/);
  });

  it('opens no port when the client id is missing', async () => {
    const lb = vi.fn();
    await expect(m365.authorize({ ask: answers(['work', '', '']), loopback: lb }))
      .rejects.toThrow(/client ID is required/);
    expect(lb).not.toHaveBeenCalled();
  });
});
