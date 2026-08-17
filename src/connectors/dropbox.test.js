import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as dropbox from './dropbox.js';

const json = body => ({ ok: true, status: 200, json: async () => body });
const text = body => ({ ok: true, status: 200, text: async () => body });
const fail = (status, summary) => ({
  ok: false, status,
  text: async () => JSON.stringify({ error_summary: summary }),
  json: async () => ({ error_summary: summary }),
});
const tooMany = (retryAfter = '1') => ({
  ok: false, status: 429,
  headers: { get: h => (h.toLowerCase() === 'retry-after' ? retryAfter : null) },
  text: async () => '{"error_summary": "too_many_requests/.."}',
});

/** Credentials as `auth` hands them over, holding a live token so the refresh
 *  exchange does not have to be mocked in every listing test. */
const authed = () => ({
  ok: true, accessToken: 'sl.test', appKey: '', appSecret: '', refreshToken: '',
  expiresAt: Infinity,
});

const file = (name, over = {}) => ({
  '.tag': 'file',
  name,
  id: `id:${name}`,
  path_lower: `/specs/${name.toLowerCase()}`,
  path_display: `/Specs/${name}`,
  server_modified: '2026-08-01T00:00:00Z',
  size: 1024,
  is_downloadable: true,
  ...over,
});
const folder = name => ({
  '.tag': 'folder', name, id: `id:${name}`,
  path_lower: `/specs/${name.toLowerCase()}`, path_display: `/Specs/${name}`,
});
/** A Paper doc: not downloadable, and Dropbox names the export format. */
const paper = name => file(name, { is_downloadable: false, export_info: { export_as: 'markdown' } });

let calls;
const route = handlers => vi.fn(async (url, init) => {
  calls.push({
    url: String(url),
    method: init?.method || 'GET',
    body: init?.body && typeof init.body === 'string' && init.body.startsWith('{')
      ? JSON.parse(init.body) : init?.body,
    arg: init?.headers?.['Dropbox-API-Arg'],
  });
  for (const [pattern, handler] of handlers) {
    if (String(url).includes(pattern)) return typeof handler === 'function' ? handler(String(url)) : handler;
  }
  return json({ entries: [], has_more: false });
});

/** Backoff without the wall-clock wait. */
const nowait = { sleep: async () => {} };

/** The common case: a folder whose recursive listing returns these entries. */
const listing = entries => route([
  ['files/get_metadata', json({ '.tag': 'folder', name: 'Specs' })],
  ['files/list_folder', json({ entries, has_more: false })],
]);

beforeEach(() => { calls = []; });
afterEach(() => { vi.restoreAllMocks(); });

describe('auth', () => {
  it('explains how to get credentials when there are none', () => {
    const r = dropbox.auth({});
    expect(r.ok).toBe(false);
    expect(r.help).toMatch(/DROPBOX_REFRESH_TOKEN/);
    // Point at the command rather than reciting the OAuth dance. A help string
    // that ends "…and keep the refresh token it returns" is telling the user to
    // write their own curl, which is what `teamctx auth` exists to remove.
    expect(r.help, 'must name the command that fixes this').toMatch(/teamctx auth dropbox/);
    expect(r.help, 'must mention the quick way in').toMatch(/DROPBOX_ACCESS_TOKEN/);
  });

  it('accepts an app key, secret and refresh token', () => {
    expect(dropbox.auth({
      DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's', DROPBOX_REFRESH_TOKEN: 'r',
    })).toMatchObject({ ok: true, refreshToken: 'r' });
  });

  it('accepts the app console\'s short-lived token on its own', () => {
    const r = dropbox.auth({ DROPBOX_ACCESS_TOKEN: 'sl.x' });
    expect(r).toMatchObject({ ok: true, accessToken: 'sl.x' });
    // Nothing can renew it, so it is used until Dropbox rejects it.
    expect(r.expiresAt).toBe(Infinity);
  });

  it('rejects a partial set rather than failing later', () => {
    expect(dropbox.auth({ DROPBOX_APP_KEY: 'k', DROPBOX_REFRESH_TOKEN: 'r' }).ok).toBe(false);
  });

  it('makes no network call', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    dropbox.auth({ DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's', DROPBOX_REFRESH_TOKEN: 'r' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('authorize', () => {
  const answers = list => {
    const queue = [...list];
    return async () => queue.shift() ?? '';
  };
  const exchanged = body => vi.fn(async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body });
    return { ok: true, status: 200, json: async () => body };
  });

  it('returns the three variables the connector reads', async () => {
    globalThis.fetch = exchanged({ refresh_token: 'r-live', access_token: 'sl.x' });

    const values = await dropbox.authorize({ ask: answers(['appkey', 'appsecret', 'code123']) });
    expect(values).toEqual({
      DROPBOX_APP_KEY: 'appkey',
      DROPBOX_APP_SECRET: 'appsecret',
      DROPBOX_REFRESH_TOKEN: 'r-live',
    });
  });

  it('sends no redirect_uri, matching the authorize call', async () => {
    // Dropbox requires the two to agree. Setting one here after omitting it on
    // /authorize is rejected, and the error does not say why.
    globalThis.fetch = exchanged({ refresh_token: 'r' });
    await dropbox.authorize({ ask: answers(['k', 's', 'c']) });

    expect(calls[0].body).toContain('grant_type=authorization_code');
    expect(calls[0].body).not.toContain('redirect_uri');
  });

  it('shows a URL that asks for offline access', async () => {
    // Without token_access_type=offline the exchange returns no refresh token
    // and the login silently expires in four hours.
    const shown = [];
    globalThis.fetch = exchanged({ refresh_token: 'r' });
    await dropbox.authorize({ ask: answers(['mykey', 's', 'c']), log: m => shown.push(m) });

    const url = /https:\/\/www\.dropbox\.com\/oauth2\/authorize\S+/.exec(shown.join('\n'))?.[0];
    expect(url).toContain('token_access_type=offline');
    expect(url).toContain('client_id=mykey');
    // No listener on this machine, no port to choose, nothing reachable from
    // outside while the flow runs.
    expect(url, 'the URL itself must set no redirect').not.toContain('redirect_uri');
  });

  it('names the scopes to tick, which is the step people miss', async () => {
    const shown = [];
    globalThis.fetch = exchanged({ refresh_token: 'r' });
    await dropbox.authorize({ ask: answers(['k', 's', 'c']), log: m => shown.push(m) });
    expect(shown.join('\n')).toMatch(/files\.content\.read/);
  });

  it('offers what is already set as the default answer', async () => {
    const asked = [];
    globalThis.fetch = exchanged({ refresh_token: 'r' });
    await dropbox.authorize({
      ask: async (q, d) => { asked.push([q, d]); return d || 'typed'; },
      env: { DROPBOX_APP_KEY: 'existing-key' },
    });
    expect(asked[0]).toEqual(['App key', 'existing-key']);
  });

  it('asks for the secret through the masking prompt, not the plain one', async () => {
    // An app key is a client id — public by design, and worth showing in full
    // so it can be checked against the console. The secret is not, and echoing
    // a stored one back would put it in scrollback and shell history.
    const plain = [];
    const masked = [];
    globalThis.fetch = exchanged({ refresh_token: 'r' });

    await dropbox.authorize({
      ask: async (q, d) => { plain.push(q); return d || 'typed'; },
      askSecret: async (q, d) => { masked.push(q); return d || 'typed'; },
      env: { DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 'the-real-secret' },
    });

    expect(masked).toContain('App secret');
    expect(plain, 'the secret must not go through the echoing prompt').not.toContain('App secret');
  });

  it('keeps the real secret when the user accepts the masked default', async () => {
    // The mask is display only; pressing enter has to round-trip the true
    // value or the login silently breaks.
    globalThis.fetch = exchanged({ refresh_token: 'r' });
    const values = await dropbox.authorize({
      ask: async (q, d) => d || 'typed',
      askSecret: async (q, d) => d,
      env: { DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 'the-real-secret' },
    });
    expect(values.DROPBOX_APP_SECRET).toBe('the-real-secret');
  });

  it('explains a stale authorization code rather than passing the raw error through', async () => {
    // Codes are single-use and expire in minutes — easily the most common way
    // this step fails, and "invalid_grant" explains nothing.
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }),
    }));

    await expect(dropbox.authorize({ ask: answers(['k', 's', 'stale']) }))
      .rejects.toThrow(/single-use and expire/);
  });

  it('refuses a response with no refresh token instead of saving a 4-hour login', async () => {
    globalThis.fetch = exchanged({ access_token: 'sl.short' });
    await expect(dropbox.authorize({ ask: answers(['k', 's', 'c']) }))
      .rejects.toThrow(/token_access_type=offline/);
  });

  it('stops early rather than exchanging an empty answer', async () => {
    globalThis.fetch = vi.fn();
    await expect(dropbox.authorize({ ask: answers(['', '', '']) }))
      .rejects.toThrow(/app key is required/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('requires the code as well', async () => {
    globalThis.fetch = vi.fn();
    await expect(dropbox.authorize({ ask: answers(['k', 's', '']) }))
      .rejects.toThrow(/authorization code is required/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('parseSelector', () => {
  it('takes a path', () => {
    expect(dropbox.parseSelector('/Specs')).toEqual({ path: '/Specs' });
  });

  it('adds the leading slash people forget', () => {
    expect(dropbox.parseSelector('Specs')).toEqual({ path: '/Specs' });
  });

  it('maps the root to the empty path the API wants', () => {
    // "/" is how a human writes the root; Dropbox spells it "".
    expect(dropbox.parseSelector('/')).toEqual({ path: '' });
  });

  it('takes Dropbox\'s own addressing forms unchanged', () => {
    expect(dropbox.parseSelector('id:AbC123')).toEqual({ path: 'id:AbC123' });
    expect(dropbox.parseSelector('ns:12345/spec.md')).toEqual({ path: 'ns:12345/spec.md' });
  });

  it('takes a shared link', () => {
    const url = 'https://www.dropbox.com/scl/fo/abc123/Specs?rlkey=xyz';
    expect(dropbox.parseSelector(url)).toEqual({ link: url });
  });

  it('refuses nothing at all rather than importing the whole account', () => {
    // The root is a legal path here, which is exactly why it has to be typed.
    expect(() => dropbox.parseSelector('')).toThrow(/needs a path/);
    expect(() => dropbox.parseSelector(undefined)).toThrow(/needs a path/);
  });

  it('rejects a link that is not Dropbox', () => {
    expect(() => dropbox.parseSelector('https://example.com/s/abc')).toThrow(/not a Dropbox link/);
  });
});

describe('classify', () => {
  it('downloads markdown and text', () => {
    for (const name of ['spec.md', 'notes.txt', 'README.markdown']) {
      expect(dropbox.classify(file(name)), name).toEqual({ download: true });
    }
  });

  it('exports a Paper doc as markdown, whatever default Dropbox names', () => {
    // Every real Paper doc reports export_as: "html" — the field is the
    // default format, not a constraint, and files/export honours an
    // export_format that overrides it. Treating it as a constraint skipped the
    // best content in Dropbox, which only live testing revealed.
    expect(dropbox.classify(paper('Decisions.paper', { export_info: { export_as: 'html' } })))
      .toEqual({ exportAs: 'markdown' });
    expect(dropbox.classify(paper('Decisions.paper'))).toEqual({ exportAs: 'markdown' });
  });

  it('skips a file that only exports as docx, naming the reason', () => {
    // A Google Doc kept in Dropbox reports export_as: docx — so the export
    // path is not a way around the OOXML problem, it lands in the same place.
    const gdoc = file('Plan.gdoc', { is_downloadable: false, export_info: { export_as: 'docx' } });
    expect(dropbox.classify(gdoc).skip).toMatch(/exports only as docx/);
  });

  it('skips a Word document with a reason rather than pretending', () => {
    expect(dropbox.classify(file('Spec.docx')).skip).toMatch(/Word documents need the OOXML reader/);
  });

  it('names what a real Dropbox is actually full of', () => {
    for (const name of ['holiday.jpg', 'demo.mp4', 'app.apk', 'budget.xlsx']) {
      expect(dropbox.classify(file(name)).skip, name).toMatch(/unsupported type/);
    }
  });

  it('recognises a folder, and a deletion', () => {
    expect(dropbox.classify(folder('Archive'))).toEqual({ folder: true });
    expect(dropbox.classify({ '.tag': 'deleted', name: 'gone.md' }).skip).toBe('deleted');
  });

  it('says so when a file is neither downloadable nor exportable', () => {
    const odd = file('mystery', { is_downloadable: false });
    expect(dropbox.classify(odd).skip).toMatch(/names no export format/);
  });
});

describe('list — a folder', () => {
  it('names a skipped file by path, not by opaque id', async () => {
    // "dropbox:id:jaCD21w5Yr0AAAAAAAAABQ — unsupported type" tells the reader
    // nothing about which of their files was rejected.
    globalThis.fetch = listing([file('holiday.jpg')]);

    const r = await dropbox.list(authed(), '/Specs', nowait);
    expect(r.skipped[0].id).toBe('dropbox:/Specs/holiday.jpg');
  });

  it('reports the same id while listing as when fetching', async () => {
    // They disagreed: list said dropbox:id:… and fetch said dropbox:/path, so
    // one document was named two ways between a skip line and a queue entry.
    globalThis.fetch = listing([file('spec.md')]);
    const r = await dropbox.list(authed(), '/Specs', nowait);

    globalThis.fetch = route([['files/download', text('body')]]);
    const doc = await dropbox.fetch(authed(), r.items[0].ref, nowait);
    expect(doc.id).toBe(r.items[0].id);
  });

  it('keeps the casing a human typed', async () => {
    globalThis.fetch = listing([file('Café Notes.md')]);
    const r = await dropbox.list(authed(), '/Specs', nowait);
    expect(r.items[0].id).toBe('dropbox:/Specs/Café Notes.md');
  });

  it('returns one item per document and skips the rest', async () => {
    globalThis.fetch = listing([
      file('architecture.md'),
      paper('Decisions.paper'),
      file('holiday.jpg'),
    ]);

    const r = await dropbox.list(authed(), '/Specs', nowait);
    expect(r.items.map(i => i.title)).toEqual(['architecture.md', 'Decisions.paper']);
    expect(r.skipped.map(s => s.reason)).toEqual(['unsupported type (.jpg)']);
  });

  it('asks for the whole tree in one call instead of walking it', async () => {
    // The reason this connector is small: recursive: true does what Drive,
    // Graph and Notion each need a hand-written tree walk to achieve.
    globalThis.fetch = listing([file('a.md')]);
    await dropbox.list(authed(), '/Specs', nowait);

    const listCall = calls.find(c => c.url.includes('files/list_folder'));
    expect(listCall.body).toMatchObject({ path: '/Specs', recursive: true });
    expect(calls.filter(c => c.url.includes('files/list_folder'))).toHaveLength(1);
  });

  it('does not emit folders as documents or as skips', async () => {
    // The recursive listing already returned their children, so a folder is
    // neither an item nor worth a line of output.
    globalThis.fetch = listing([folder('Archive'), file('a.md')]);

    const r = await dropbox.list(authed(), '/Specs', nowait);
    expect(r.items).toHaveLength(1);
    expect(r.skipped).toEqual([]);
  });

  it('follows the cursor until has_more is false', async () => {
    let page = 0;
    globalThis.fetch = route([
      ['files/get_metadata', json({ '.tag': 'folder' })],
      ['files/list_folder/continue', json({ entries: [file('two.md')], has_more: false })],
      ['files/list_folder', () => json(page++ === 0
        ? { entries: [file('one.md')], has_more: true, cursor: 'CUR' }
        : { entries: [], has_more: false })],
    ]);

    const r = await dropbox.list(authed(), '/Specs', nowait);
    expect(r.items.map(i => i.title)).toEqual(['one.md', 'two.md']);
    expect(calls.find(c => c.url.includes('continue')).body).toEqual({ cursor: 'CUR' });
  });

  it('skips an oversized file from the listing, without downloading it', async () => {
    // The size is already in hand, and normalizeDocument would reject it
    // anyway — after paying for the transfer.
    globalThis.fetch = listing([file('huge.md', { size: 900 * 1024 })]);

    const r = await dropbox.list(authed(), '/Specs', nowait);
    expect(r.items).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/too large \(900KB, limit 256KB\)/);
    expect(calls.some(c => c.url.includes('content.dropboxapi'))).toBe(false);
  });

  it('does not size-check an export, whose bytes are not the document', async () => {
    // A .paper file's size is the stub's, not the rendered markdown's.
    globalThis.fetch = listing([paper('Big.paper', { size: 900 * 1024 })]);
    const r = await dropbox.list(authed(), '/Specs', nowait);
    expect(r.items).toHaveLength(1);
  });

  it('stops at the cap with one line, not one per file', async () => {
    globalThis.fetch = listing(
      Array.from({ length: 250 }, (_, i) => file(`doc-${i}.md`)));

    const r = await dropbox.list(authed(), '/Specs', nowait);
    expect(r.items).toHaveLength(200);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toMatch(/stopped at 200 files/);
  });

  it('imports a single file when the path names one', async () => {
    globalThis.fetch = route([['files/get_metadata', json(file('spec.md'))]]);

    const r = await dropbox.list(authed(), '/Specs/spec.md', nowait);
    expect(r.items).toHaveLength(1);
    expect(calls.some(c => c.url.includes('list_folder'))).toBe(false);
  });
});

describe('list — --since', () => {
  it('filters on server_modified', async () => {
    globalThis.fetch = listing([
      file('new.md', { server_modified: '2026-08-10T00:00:00Z' }),
      file('old.md', { server_modified: '2026-01-01T00:00:00Z' }),
    ]);

    const r = await dropbox.list(authed(), '/Specs', { since: '2026-08-01', ...nowait });
    expect(r.items.map(i => i.title)).toEqual(['new.md']);
  });

  it('keeps a file with no timestamp rather than dropping it', async () => {
    // Importing nothing because a field was absent is the failure worth
    // avoiding — the same rule a missing path already gets.
    globalThis.fetch = listing([file('undated.md', { server_modified: undefined })]);

    const r = await dropbox.list(authed(), '/Specs', { since: '2026-08-01', ...nowait });
    expect(r.items).toHaveLength(1);
  });

  it('rejects an unparseable date instead of importing everything', async () => {
    globalThis.fetch = listing([file('a.md')]);
    await expect(dropbox.list(authed(), '/Specs', { since: 'last tuesday', ...nowait }))
      .rejects.toThrow(/not a date/);
  });

  it('does not apply to a file named outright', async () => {
    globalThis.fetch = route([['files/get_metadata',
      json(file('old.md', { server_modified: '2020-01-01T00:00:00Z' }))]]);

    const r = await dropbox.list(authed(), '/Specs/old.md', { since: '2026-08-01', ...nowait });
    expect(r.items).toHaveLength(1);
  });
});

describe('list — a shared link', () => {
  it('lists inside a shared folder without owning it', async () => {
    const url = 'https://www.dropbox.com/scl/fo/abc/Specs?rlkey=x';
    globalThis.fetch = route([
      ['get_shared_link_metadata', json({ '.tag': 'folder', name: 'Specs' })],
      ['files/list_folder', json({ entries: [file('shared.md')], has_more: false })],
    ]);

    const r = await dropbox.list(authed(), url, nowait);
    expect(r.items).toHaveLength(1);
    // path "" plus shared_link means "the root of what this link points at".
    expect(calls.find(c => c.url.includes('list_folder')).body)
      .toMatchObject({ path: '', shared_link: { url }, recursive: true });
  });

  it('carries the link on the ref, since the file may not be in this account', async () => {
    const url = 'https://www.dropbox.com/scl/fi/abc/spec.md?rlkey=x';
    globalThis.fetch = route([['get_shared_link_metadata', json(file('spec.md'))]]);

    const r = await dropbox.list(authed(), url, nowait);
    expect(r.items[0].ref.link).toBe(url);
  });

  it('says a Paper doc cannot be exported through a link, rather than failing later', async () => {
    // There is no export endpoint for shared links — better to say so while
    // listing than to fail one arbitrary document mid-import.
    const url = 'https://www.dropbox.com/scl/fo/abc/Specs?rlkey=x';
    globalThis.fetch = route([
      ['get_shared_link_metadata', json({ '.tag': 'folder' })],
      ['files/list_folder', json({ entries: [paper('Notes.paper')], has_more: false })],
    ]);

    const r = await dropbox.list(authed(), url, nowait);
    expect(r.items).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/cannot be exported through a shared link/);
  });
});

describe('fetch', () => {
  it('downloads plain text', async () => {
    globalThis.fetch = route([['files/download', text('# Spec\n\nWe chose Postgres.')]]);

    const doc = await dropbox.fetch(authed(),
      { path: '/specs/spec.md', title: 'spec.md' }, nowait);
    expect(doc).toEqual({
      id: 'dropbox:/specs/spec.md', title: 'spec.md', text: '# Spec\n\nWe chose Postgres.',
    });
  });

  it('exports a Paper doc as markdown', async () => {
    globalThis.fetch = route([['files/export', text('# Decisions')]]);

    await dropbox.fetch(authed(),
      { path: '/specs/decisions.paper', title: 'Decisions', exportAs: 'markdown' }, nowait);
    expect(JSON.parse(calls[0].arg)).toEqual({
      path: '/specs/decisions.paper', export_format: 'markdown',
    });
  });

  it('uses the shared-link endpoint when the item came from a link', async () => {
    globalThis.fetch = route([['sharing/get_shared_link_file', text('shared body')]]);

    const doc = await dropbox.fetch(authed(),
      { link: 'https://www.dropbox.com/scl/fi/a/b.md', path: '/b.md', title: 'b.md' }, nowait);
    expect(doc.text).toBe('shared body');
  });

  it('sends arguments in a header, on the content host', async () => {
    globalThis.fetch = route([['files/download', text('x')]]);
    await dropbox.fetch(authed(), { path: '/a.md' }, nowait);

    expect(calls[0].url).toContain('content.dropboxapi.com');
    expect(calls[0].arg).toBeTruthy();
    // A body would make Dropbox reject the request outright.
    expect(calls[0].body).toBeFalsy();
  });
});

describe('Dropbox-API-Arg escaping', () => {
  it('escapes non-ASCII, because the argument travels in an HTTP header', () => {
    // The one piece of this connector that is easy to get silently wrong: a
    // file called "Café notes.md" breaks the request outright unescaped.
    const arg = dropbox.apiArg({ path: '/Café notes.md' });
    expect(arg).toBe('{"path":"/Caf\\u00e9 notes.md"}');
    expect(/^[\x20-\x7e]*$/.test(arg), 'must be pure ASCII').toBe(true);
  });

  it('escapes emoji and CJK too', () => {
    for (const name of ['/日本語.md', '/notes ✨.md']) {
      expect(/^[\x20-\x7e]*$/.test(dropbox.apiArg({ path: name })), name).toBe(true);
    }
  });

  it('leaves plain ASCII alone', () => {
    expect(dropbox.apiArg({ path: '/Specs/a.md' })).toBe('{"path":"/Specs/a.md"}');
  });

  it('is used for real when fetching a file with an accented name', async () => {
    globalThis.fetch = route([['files/download', text('body')]]);
    await dropbox.fetch(authed(), { path: '/Café.md' }, nowait);

    expect(/^[\x20-\x7e]*$/.test(calls[0].arg)).toBe(true);
    expect(JSON.parse(calls[0].arg).path).toBe('/Café.md');
  });
});

describe('errors', () => {
  it('shows what the app can actually see when a path is missing', async () => {
    // "check the spelling" is useless on its own — the whole point is that the
    // user cannot see what the token can.
    globalThis.fetch = route([
      ['files/get_metadata', fail(409, 'path/not_found/...')],
      ['files/list_folder', json({ entries: [folder('Specs'), file('readme.md')], has_more: false })],
    ]);

    await expect(dropbox.list(authed(), '/Nope', nowait))
      .rejects.toThrow(/At the top level this app can see: Specs\/, readme\.md/);
  });

  it('names the App-folder trap when nothing is visible at all', async () => {
    // An App-folder token makes every path equally missing, and nothing in the
    // error says why. This is the single most likely first-run failure and it
    // is invisible from the outside.
    globalThis.fetch = route([
      ['files/get_metadata', fail(409, 'path/not_found/...')],
      ['files/list_folder', json({ entries: [], has_more: false })],
    ]);

    const err = await dropbox.list(authed(), '/teamctx-test', nowait).catch(e => e);
    expect(err.message).toMatch(/App folder" access rather than "Full Dropbox/);
    // The access type cannot be changed after the app is made, so telling the
    // user to go and change a setting would send them hunting for one.
    expect(err.message, 'must say a new app is needed').toMatch(/make a new app/);
  });

  it('explains an empty root instead of reporting nothing to import', async () => {
    // Same sandboxed token from the other side: no error to hang an
    // explanation on, just silence.
    globalThis.fetch = route([
      // The root has no metadata of its own — Dropbox rejects the call.
      ['files/get_metadata', fail(409, 'path/malformed_path/..')],
      ['files/list_folder', json({ entries: [], has_more: false })],
    ]);

    const r = await dropbox.list(authed(), '/', nowait);
    expect(r.items).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/App folder/);
  });

  it('does not mask the real error if the explaining call also fails', async () => {
    globalThis.fetch = route([
      ['files/get_metadata', fail(409, 'path/not_found/...')],
      ['files/list_folder', fail(401, 'invalid_access_token/')],
    ]);
    await expect(dropbox.list(authed(), '/Nope', nowait)).rejects.toThrow(/no such path/);
  });

  it('names the missing-scope mistake, which is the common first run', async () => {
    globalThis.fetch = route([['files/get_metadata', fail(401, 'missing_scope/...')]]);
    await expect(dropbox.list(authed(), '/Specs', nowait)).rejects.toThrow(/files\.content\.read/);
  });

  it('explains a revoked shared link', async () => {
    globalThis.fetch = route([['get_shared_link_metadata', fail(409, 'shared_link_not_found/..')]]);
    await expect(dropbox.list(authed(), 'https://www.dropbox.com/scl/fo/x', nowait))
      .rejects.toThrow(/does not exist, or has been revoked/);
  });

  it('honours Retry-After on a 429 rather than backing off blindly', async () => {
    // Rejected requests still count against the limit, so a retry loop that
    // ignores the header actively makes things worse.
    const waited = [];
    let n = 0;
    globalThis.fetch = route([
      ['files/get_metadata', json({ '.tag': 'folder' })],
      ['files/list_folder', () => (n++ === 0 ? tooMany('7') : json({ entries: [], has_more: false }))],
    ]);

    await dropbox.list(authed(), '/Specs', { sleep: async ms => waited.push(ms) });
    expect(waited).toContain(7000);
    expect(n).toBe(2);
  });

  it('treats Retry-After: 0 as "go again now"', async () => {
    const waited = [];
    let n = 0;
    globalThis.fetch = route([
      ['files/get_metadata', json({ '.tag': 'folder' })],
      ['files/list_folder', () => (n++ === 0 ? tooMany('0') : json({ entries: [], has_more: false }))],
    ]);

    await dropbox.list(authed(), '/Specs', { sleep: async ms => waited.push(ms) });
    expect(waited).toContain(0);
  });

  it('retries a 5xx', async () => {
    let n = 0;
    globalThis.fetch = route([
      ['files/get_metadata', json({ '.tag': 'folder' })],
      ['files/list_folder', () => (n++ === 0 ? fail(503, '') : json({ entries: [], has_more: false }))],
    ]);

    await dropbox.list(authed(), '/Specs', nowait);
    expect(n).toBe(2);
  });

  it('survives an error body that is not JSON', async () => {
    // Dropbox returns plain text for some auth failures.
    globalThis.fetch = route([['files/get_metadata', {
      ok: false, status: 400, text: async () => 'Error in call to API function',
    }]]);
    await expect(dropbox.list(authed(), '/Specs', nowait)).rejects.toThrow(/dropbox 400/);
  });
});

describe('the access token', () => {
  it('is exchanged from the refresh token on the first call, not in auth', async () => {
    globalThis.fetch = route([
      ['oauth2/token', json({ access_token: 'sl.fresh', expires_in: 14400 })],
      ['files/get_metadata', json({ '.tag': 'folder' })],
      ['files/list_folder', json({ entries: [], has_more: false })],
    ]);

    const a = dropbox.auth({ DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's', DROPBOX_REFRESH_TOKEN: 'r' });
    expect(calls).toHaveLength(0);

    await dropbox.list(a, '/Specs', nowait);
    expect(calls[0].url).toContain('oauth2/token');
    expect(calls[0].body).toContain('grant_type=refresh_token');
  });

  it('is reused across a run rather than exchanged per request', async () => {
    globalThis.fetch = route([
      ['oauth2/token', json({ access_token: 'sl.fresh', expires_in: 14400 })],
      ['files/get_metadata', json({ '.tag': 'folder' })],
      ['files/list_folder', json({ entries: [file('a.md'), file('b.md')], has_more: false })],
    ]);

    const a = dropbox.auth({ DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's', DROPBOX_REFRESH_TOKEN: 'r' });
    await dropbox.list(a, '/Specs', nowait);
    expect(calls.filter(c => c.url.includes('oauth2/token'))).toHaveLength(1);
  });

  it('explains a refresh token that has been revoked', async () => {
    globalThis.fetch = vi.fn(async () => fail(400, 'invalid_grant'));
    const a = dropbox.auth({ DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's', DROPBOX_REFRESH_TOKEN: 'r' });
    await expect(dropbox.list(a, '/Specs', nowait)).rejects.toThrow(/re-authorize/);
  });
});
