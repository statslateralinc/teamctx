import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as coda from './coda.js';

const DOC = 'AbCd1234';
const PAGE = 'canvas-xyz';

const json = body => ({ ok: true, status: 200, json: async () => body });
const fail = (status, body = {}) => ({ ok: false, status, json: async () => body });
const tooMany = (retryAfter = '1') => ({
  ok: false, status: 429,
  headers: { get: h => (h.toLowerCase() === 'retry-after' ? retryAfter : null) },
  json: async () => ({ statusCode: 429 }),
});
const text = body => ({ ok: true, status: 200, text: async () => body });

/** The auth object the contract hands to list/fetch. Every bucket is paced at
 *  zero so the suite does not wait on its own rate limiter. */
const authed = () => ({ ok: true, token: 'coda-test', lastCallAt: {} });
const nowait = { sleep: () => {} };

const codaPage = (id, name, extra = {}) => ({
  id, name, contentType: 'canvas',
  browserLink: `https://coda.io/d/Doc_d${DOC}/${name}_su1`,
  ...extra,
});

let calls;
const route = handlers => vi.fn(async (url, init) => {
  calls.push({ url: String(url), method: init?.method || 'GET', headers: init?.headers, body: init?.body && JSON.parse(init.body) });
  for (const [pattern, handler] of handlers) {
    if (String(url).includes(pattern)) return typeof handler === 'function' ? handler(String(url)) : handler;
  }
  return json({ items: [] });
});

beforeEach(() => {
  calls = [];
  // The pacer reads Date.now(); with real gaps the suite would sit out its own
  // 650ms write budget on every export.
  vi.spyOn(Date, 'now').mockReturnValue(1e12);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('auth', () => {
  it('explains how to get a token when there is none', () => {
    const r = coda.auth({});
    expect(r.ok).toBe(false);
    expect(r.help).toMatch(/CODA_TOKEN/);
    expect(r.help, 'must say where the token comes from').toMatch(/API settings/);
  });

  it('accepts a token from the environment', () => {
    expect(coda.auth({ CODA_TOKEN: 'c1' })).toMatchObject({ ok: true, token: 'c1' });
  });
});

describe('parseSelector', () => {
  it('takes both ids out of a pasted page link', () => {
    // A Coda URL carries the doc id after _d and the short page id after _su,
    // which the API accepts directly as pageIdOrName.
    expect(coda.parseSelector(`https://coda.io/d/Handbook_d${DOC}/Onboarding_su42`))
      .toEqual({ docId: DOC, pageId: 'su42' });
  });

  it('takes the doc id from a doc link with no page', () => {
    expect(coda.parseSelector(`https://coda.io/d/Handbook_d${DOC}`))
      .toEqual({ docId: DOC, pageId: undefined });
  });

  it('does not let the doc match run into the page segment', () => {
    // `_d([A-Za-z0-9_-]+)` would swallow `_su42` and produce a doc id that does
    // not exist, which fails later and confusingly.
    expect(coda.parseSelector(`https://coda.io/d/H_d${DOC}/P_su42`).docId).toBe(DOC);
  });

  it('ignores a query string and an anchor', () => {
    expect(coda.parseSelector(`https://coda.io/d/H_d${DOC}/P_su42?mode=x#Table_tu9`))
      .toEqual({ docId: DOC, pageId: 'su42' });
  });

  it('accepts bare ids', () => {
    expect(coda.parseSelector(DOC)).toEqual({ docId: DOC, pageId: undefined });
    expect(coda.parseSelector(`${DOC}/${PAGE}`)).toEqual({ docId: DOC, pageId: PAGE });
  });

  it('treats nothing at all as "every doc the token can see"', () => {
    expect(coda.parseSelector('')).toEqual({ all: true });
    expect(coda.parseSelector(undefined)).toEqual({ all: true });
  });

  it('refuses anything else rather than guessing', () => {
    expect(() => coda.parseSelector('https://example.com/page')).toThrow(/not a Coda doc or page link/);
    expect(() => coda.parseSelector('my doc')).toThrow(/not a Coda doc or page link/);
  });
});

describe('list', () => {
  it('returns every canvas page in a doc from a single read', async () => {
    // Coda hands back the whole page tree, so listing costs one request and no
    // export jobs — which is what makes --dry-run free here.
    globalThis.fetch = route([
      [`docs/${DOC}/pages`, json({ items: [codaPage('p1', 'Onboarding'), codaPage('p2', 'Runbook')] })],
    ]);
    const { items } = await coda.list(authed(), DOC, nowait);
    expect(items.map(i => i.title)).toEqual(['Onboarding', 'Runbook']);
    expect(items.map(i => i.id)).toEqual([`coda:${DOC}/p1`, `coda:${DOC}/p2`]);
    expect(calls).toHaveLength(1);
  });

  it('says why a page with no exportable content was skipped', async () => {
    // Emitting an empty document that normalizeDocument then rejects reads
    // like a bug; naming the reason does not.
    globalThis.fetch = route([
      [`docs/${DOC}/pages`, json({ items: [codaPage('p1', 'Embedded', { contentType: 'embed' })] })],
    ]);
    const { items, skipped } = await coda.list(authed(), DOC, nowait);
    expect(items).toEqual([]);
    expect(skipped[0].reason).toMatch(/no exportable content \(embed\)/);
  });

  it('follows nextPageToken', async () => {
    let n = 0;
    globalThis.fetch = route([
      [`docs/${DOC}/pages`, () => (++n === 1
        ? json({ items: [codaPage('p1', 'One')], nextPageToken: 'tok2' })
        : json({ items: [codaPage('p2', 'Two')] }))],
    ]);
    const { items } = await coda.list(authed(), DOC, nowait);
    expect(items).toHaveLength(2);
    expect(calls[1].url).toContain('pageToken=tok2');
  });

  it('drops pages edited before --since but keeps ones with no timestamp', async () => {
    // Silently importing nothing because a field was missing is the failure
    // worth avoiding.
    globalThis.fetch = route([
      [`docs/${DOC}/pages`, json({
        items: [
          codaPage('p1', 'Recent', { updatedAt: '2026-08-10T00:00:00.000Z' }),
          codaPage('p2', 'Ancient', { updatedAt: '2020-01-01T00:00:00.000Z' }),
          codaPage('p3', 'Undated'),
        ],
      })],
    ]);
    const { items } = await coda.list(authed(), DOC, { ...nowait, since: '2026-08-01' });
    expect(items.map(i => i.title)).toEqual(['Recent', 'Undated']);
  });

  it('resolves a pasted page link by its browser link, not by guessing the id', async () => {
    // Observed on a real doc: for six of seven pages the URL's `_su…` fragment
    // was the id's last six characters, and for the seventh it was unrelated
    // (`canvas-6Ba8UKzinj` ↔ `_su6tOu7G`). Deriving the id would pass a test
    // suite and fail in production, so the match is on browserLink.
    globalThis.fetch = route([
      [`docs/${DOC}/pages`, json({ items: [
        codaPage('canvas-6Ba8UKzinj', 'Company Overview', { browserLink: `https://coda.io/d/D_d${DOC}/Company-Overview_su6tOu7G` }),
        codaPage('canvas-MNca05ceKS', 'Products', { browserLink: `https://coda.io/d/D_d${DOC}/Products_su05ceKS` }),
      ] })],
    ]);
    const { items } = await coda.list(authed(), `https://coda.io/d/D_d${DOC}/Company-Overview_su6tOu7G`, nowait);
    expect(items).toHaveLength(1);
    expect(items[0].ref.pageId, 'must use the real id, not the URL fragment').toBe('canvas-6Ba8UKzinj');
    expect(items[0].title, 'the listing also gives the real title').toBe('Company Overview');
  });

  it('takes a named page with everything beneath it, however deep', async () => {
    // Matches the Notion connector: pasting a link to a section and getting
    // only its opening paragraph would be useless. Free here, because Coda
    // returns the whole doc flat with a parent link on every page.
    const kid = (id, name, parent) => codaPage(id, name, { parent: { id: parent, type: 'page' } });
    globalThis.fetch = route([
      [`docs/${DOC}/pages`, json({ items: [
        codaPage('p-top', 'Products'),
        kid('p-mid', 'AxisCore Deep Dive', 'p-top'),
        kid('p-low', 'Benchmarks', 'p-mid'),
        codaPage('p-other', 'Unrelated'),
      ] })],
    ]);
    const { items } = await coda.list(authed(), `${DOC}/p-top`, nowait);
    expect(items.map(i => i.title)).toEqual(['Products', 'AxisCore Deep Dive', 'Benchmarks']);
    expect(items.map(i => i.title), 'a sibling subtree must not be swept in').not.toContain('Unrelated');
  });

  it('does not loop when pages are arranged in a cycle', async () => {
    globalThis.fetch = route([
      [`docs/${DOC}/pages`, json({ items: [
        codaPage('a', 'A', { parent: { id: 'b', type: 'page' } }),
        codaPage('b', 'B', { parent: { id: 'a', type: 'page' } }),
      ] })],
    ]);
    const { items } = await coda.list(authed(), `${DOC}/a`, nowait);
    expect(items).toHaveLength(2);
  });

  it('still accepts a canonical page id directly', async () => {
    globalThis.fetch = route([
      [`docs/${DOC}/pages`, json({ items: [codaPage(PAGE, 'Products')] })],
    ]);
    const { items } = await coda.list(authed(), `${DOC}/${PAGE}`, nowait);
    expect(items[0].ref.pageId).toBe(PAGE);
  });

  it('says which page could not be found rather than 404ing later', async () => {
    globalThis.fetch = route([
      [`docs/${DOC}/pages`, json({ items: [codaPage(PAGE, 'Products')] })],
    ]);
    await expect(coda.list(authed(), `${DOC}/su-nope`, nowait))
      .rejects.toThrow(/no page "su-nope" in doc/);
  });

  it('reports a named page that cannot export, instead of returning it empty', async () => {
    globalThis.fetch = route([
      [`docs/${DOC}/pages`, json({ items: [codaPage(PAGE, 'Embedded', { contentType: 'embed' })] })],
    ]);
    const { items, skipped } = await coda.list(authed(), `${DOC}/${PAGE}`, nowait);
    expect(items).toEqual([]);
    expect(skipped[0].reason).toMatch(/no exportable content \(embed\)/);
  });
});

describe('fetch — the async export job', () => {
  // The download host itself contains "export", so it has to be matched first
  // or it is mistaken for the status endpoint.
  const exportRoute = (statuses, body = '# Onboarding\n\nStart here.') => {
    let poll = 0;
    return route([
      ['export.coda.io', text(body)],
      ['/export/', () => json(statuses[Math.min(poll++, statuses.length - 1)])],
      ['/export', json({ id: 'req-1', status: 'inProgress' })],
    ]);
  };

  it('begins the export, polls until complete, then downloads', async () => {
    globalThis.fetch = exportRoute([
      { status: 'inProgress' },
      { status: 'complete', downloadLink: 'https://export.coda.io/signed/1' },
    ]);
    const doc = await coda.fetch(authed(), { docId: DOC, pageId: PAGE, title: 'Onboarding' }, nowait);
    expect(doc).toMatchObject({ id: `coda:${DOC}/${PAGE}`, title: 'Onboarding' });
    expect(doc.text).toContain('Start here.');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ outputFormat: 'markdown' });
  });

  it('never sends the token to the download host', async () => {
    // The export lands on signed storage, not coda.io. Attaching the header
    // would hand a user's Coda token to whatever host the API names.
    globalThis.fetch = exportRoute([{ status: 'complete', downloadLink: 'https://export.coda.io/signed/1' }]);
    await coda.fetch(authed(), { docId: DOC, pageId: PAGE }, nowait);
    const download = calls.find(c => c.url.startsWith('https://export.coda.io/'));
    expect(download.headers, 'the download must carry no Authorization header').toBeUndefined();
    expect(calls.filter(c => c.headers?.Authorization).every(c => c.url.startsWith('https://coda.io/apis/'))).toBe(true);
  });

  it('fails the document when the export fails', async () => {
    globalThis.fetch = exportRoute([{ status: 'failed', error: 'too large' }]);
    await expect(coda.fetch(authed(), { docId: DOC, pageId: PAGE }, nowait))
      .rejects.toThrow(/export failed.*too large/);
  });

  it('gives up rather than polling forever', async () => {
    // A job stuck inProgress must fail its own document, not stall the import.
    globalThis.fetch = exportRoute([{ status: 'inProgress' }]);
    await expect(coda.fetch(authed(), { docId: DOC, pageId: PAGE }, nowait))
      .rejects.toThrow(/did not finish/);
  });

  it('reports a download that fails rather than returning an empty document', async () => {
    globalThis.fetch = route([
      ['export.coda.io', fail(403)],
      ['/export/', json({ status: 'complete', downloadLink: 'https://export.coda.io/signed/1' })],
      ['/export', json({ id: 'req-1' })],
    ]);
    await expect(coda.fetch(authed(), { docId: DOC, pageId: PAGE }, nowait))
      .rejects.toThrow(/could not download the export \(403\)/);
  });
});

describe('rate limits and errors', () => {
  it('paces writes and reads against separate budgets', async () => {
    // One global gap either crawls (reads at write speed) or gets 429'd
    // (writes at read speed), because Coda's limits differ by verb.
    const slept = [];
    Date.now.mockRestore();
    globalThis.fetch = route([
      ['export.coda.io', text('body')],
      ['/export/', json({ status: 'complete', downloadLink: 'https://export.coda.io/x' })],
      ['/export', json({ id: 'r1' })],
    ]);
    await coda.fetch(authed(), { docId: DOC, pageId: PAGE }, { sleep: ms => slept.push(ms) });
    // The POST waits out the write budget; the poll that follows it does not,
    // because it is charged to a different bucket that has not been used.
    expect(Math.max(...slept, 0)).toBeLessThan(700);
  });

  it('honours Retry-After on a 429 and retries', async () => {
    let n = 0;
    const slept = [];
    globalThis.fetch = vi.fn(async () => (++n === 1 ? tooMany('2') : json({ items: [] })));
    await coda.list(authed(), DOC, { sleep: ms => slept.push(ms) });
    expect(slept).toContain(2000);
    expect(n).toBe(2);
  });

  it('treats Retry-After: 0 as "go again now"', async () => {
    let n = 0;
    const slept = [];
    globalThis.fetch = vi.fn(async () => (++n === 1 ? tooMany('0') : json({ items: [] })));
    await coda.list(authed(), DOC, { sleep: ms => slept.push(ms) });
    expect(slept).toContain(0);
  });

  it('explains a bad token and an unreachable doc', async () => {
    globalThis.fetch = vi.fn(async () => fail(401));
    await expect(coda.list(authed(), DOC, nowait)).rejects.toThrow(/CODA_TOKEN/);

    globalThis.fetch = vi.fn(async () => fail(404));
    await expect(coda.list(authed(), DOC, nowait)).rejects.toThrow(/no such doc or page/);
  });
});
