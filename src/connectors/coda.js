/**
 * Coda connector: pages in, documents out.
 *
 * Coda is Notion's neighbour — structured docs, written deliberately — but it
 * inverts Notion's cost model in both directions, and copying the Notion
 * connector with the nouns swapped would get both halves wrong.
 *
 *   Listing   Notion: search returns titles and no hierarchy, so discovering a
 *             child page meant reading its parent's blocks — the same work
 *             `fetch` does. Coda returns the whole page tree, with parents and
 *             children, in one read. Listing a doc is nearly free, which is
 *             the first time the contract's list/fetch split actually pays.
 *
 *   Content   Notion: a tree walk we render ourselves. Coda: an asynchronous
 *             export job — POST, poll, download — that produces the markdown
 *             for us. The riskiest half of the Notion connector, the block
 *             renderer, simply does not exist here.
 *
 * The cost lands on `fetch`, and on the scarce budget: beginning an export is a
 * POST, and Coda allows ~10 writes per 6 seconds against ~100 reads. So pacing
 * is per bucket rather than one global gap — pace reads at write speed and an
 * import crawls; pace writes at read speed and it is rejected.
 *
 * A page is a document, as in Notion. Here that needs no rule: Coda already
 * returns subpages as their own entries.
 *
 * No AI logic lives here — see src/connectors/index.js for the contract.
 */

const API = 'https://coda.io/apis/v1';

/**
 * Per-user limits, and they differ sharply by verb — so a single gap cannot
 * serve both. Values are the documented rates with a little headroom, since
 * they are shared with anything else the user's token is doing.
 */
const PACE = {
  read: 70,      // 100 / 6s
  write: 650,    // 10 / 6s  — beginning an export lands here
  docs: 1600,    // 4 / 6s   — listing docs is the tightest bucket in the API
};

/** An export that never finishes must fail its document, not hang the run. */
const POLL_INTERVAL_MS = 700;
const MAX_POLLS = 40;

/** Only relevant with no selector, where "everything" is otherwise unbounded. */
const MAX_DOCS = 25;

export const name = 'coda';
export const describe = 'Coda pages, by doc or page link';

export function auth(env = process.env) {
  const token = env.CODA_TOKEN || env.CODA_API_TOKEN;
  if (!token) {
    return {
      ok: false,
      help: 'set CODA_TOKEN in .env.local. Generate one in Coda under '
        + 'Account settings → API settings → Generate API token. The token can reach '
        + 'every doc your account can, so scope it to the docs you mean to import if '
        + 'Coda offers that at creation time.',
    };
  }
  return { ok: true, token, lastCallAt: {} };
}

class CodaError extends Error {
  constructor(status, body) {
    const hint = {
      401: 'the token is not valid — check CODA_TOKEN',
      403: 'the token is not allowed to read that doc',
      404: 'no such doc or page — check the link, or whether your account can open it',
    }[status];
    const detail = body?.message || body?.statusMessage || '';
    super(hint ? `coda: ${hint} (${status})` : `coda ${status}: ${detail}`.trim());
    this.status = status;
  }
}

const wait = ms => new Promise(r => setTimeout(r, ms));

/**
 * One API call, paced against its own bucket and retried on 429.
 *
 * `bucket` picks the gap: reads are cheap, an export POST is not, and listing
 * docs is tighter than either. Keeping the last-call time per bucket means a
 * run that lists once and then exports fifty pages waits only where it must.
 */
async function call(a, path, { method = 'GET', body, bucket = 'read', retries = 3, sleep = wait } = {}) {
  for (let attempt = 0; ; attempt++) {
    const last = a.lastCallAt[bucket] || 0;
    const gap = PACE[bucket] - (Date.now() - last);
    if (gap > 0) await sleep(gap);
    a.lastCallAt[bucket] = Date.now();

    const res = await globalThis.fetch(`${API}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${a.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 429 && attempt < retries) {
      const header = Number(res.headers?.get?.('retry-after'));
      // `Retry-After: 0` is a legitimate "go again now"; a truthiness check
      // would turn it into a wait for no reason.
      const seconds = Number.isFinite(header) && header >= 0 ? header : 1;
      await sleep(seconds * 1000);
      continue;
    }

    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new CodaError(res.status, json);
    return json;
  }
}

async function* paged(a, path, opts = {}) {
  let token;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const page = await call(a, `${path}${token ? `${sep}pageToken=${encodeURIComponent(token)}` : ''}`, opts);
    yield page;
    token = page.nextPageToken || undefined;
  } while (token);
}

// ---- selector ----------------------------------------------------------

/**
 * Accepts a doc link, a page link, `docId`, `docId/pageId`, or nothing.
 *
 * A Coda URL carries both ids: `coda.io/d/Handbook_dAbCd1234/Onboarding_su42`
 * — `_d` prefixes the doc id and `_su` the short page id, which the API takes
 * directly as `pageIdOrName`. The character class excludes `_` so the doc match
 * cannot run on into the page segment.
 */
export function parseSelector(input) {
  const s = String(input ?? '').trim();
  if (!s) return { all: true };

  if (/^https?:\/\//i.test(s)) {
    const path = s.split(/[?#]/)[0];
    const doc = /_d([A-Za-z0-9-]+)/.exec(path);
    const page = /_(su[A-Za-z0-9-]+)/.exec(path);
    if (doc) return { docId: doc[1], pageId: page?.[1] };
    throw new Error(`not a Coda doc or page link: "${s}"`);
  }

  const [docId, pageId] = s.split('/');
  if (/^[A-Za-z0-9_-]+$/.test(docId)) return { docId, pageId: pageId || undefined };
  throw new Error(`not a Coda doc or page link: "${s}"`);
}

// ---- pages -------------------------------------------------------------

/** Only a canvas page has exportable content; embeds and sync pages do not. */
const isCanvas = p => !p.contentType || p.contentType === 'canvas';

const itemFor = (docId, page) => ({
  ref: { docId, pageId: page.id, title: page.name, url: page.browserLink },
  id: `coda:${docId}/${page.id}`,
  title: page.name || 'Untitled',
});

/** Every page in a doc, unfiltered — the hierarchy comes back flat and cheap. */
async function allPages(a, docId, opts) {
  const out = [];
  for await (const page of paged(a, `docs/${encodeURIComponent(docId)}/pages?limit=100`, opts)) {
    out.push(...(page.items || []));
  }
  return out;
}

/**
 * Resolve the `_su…` fragment from a pasted URL to a real page id.
 *
 * The short id is *not* accepted as `pageIdOrName` — passing it back returns
 * 404. Nor can the real id be derived from it: for six pages of a seven-page
 * doc the fragment was the id's last six characters, and for the seventh it was
 * unrelated. A rule that works six times out of seven is worse than no rule, so
 * this matches on `browserLink`, which every page object carries verbatim.
 *
 * Costs one extra read, which is the cheap bucket, and pays for itself — it
 * also yields the page's real title instead of echoing the id back.
 */
function findPage(pages, docId, pageId) {
  const match = pages.find(p => p.id === pageId
    || String(p.browserLink || '').endsWith(`_${pageId}`));
  if (!match) {
    throw new Error(`no page "${pageId}" in doc ${docId} — check the link, or that the page still exists`);
  }
  return match;
}

/**
 * A page and everything beneath it, however deep.
 *
 * Pasting a link to a section and getting only its opening paragraph would be
 * useless — the same reasoning the Notion connector uses when it walks a
 * subtree. Here it is free: Coda returns every page in the doc flat, each
 * carrying `parent.id`, so the descendants are already in hand.
 */
function withDescendants(pages, rootId) {
  const out = [];
  const queue = [rootId];
  const seen = new Set();
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;          // a doc can be arranged in a cycle
    seen.add(id);
    const page = pages.find(p => p.id === id);
    if (page) out.push(page);
    for (const p of pages) if (p.parent?.id === id) queue.push(p.id);
  }
  return out;
}

async function pagesOf(a, docId, { since, opts }) {
  const cutoff = since ? new Date(since).getTime() : null;
  const items = [];
  const skipped = [];

  {
    for (const p of await allPages(a, docId, opts)) {
      if (!isCanvas(p)) {
        skipped.push({ id: `coda:${docId}/${p.id}`, reason: `no exportable content (${p.contentType})` });
        continue;
      }
      // A page without the field is kept rather than dropped: silently
      // importing nothing because a timestamp was missing is the failure worth
      // avoiding, and the same rule a missing path already gets.
      if (cutoff && p.updatedAt && new Date(p.updatedAt).getTime() < cutoff) continue;
      items.push(itemFor(docId, p));
    }
  }
  return { items, skipped };
}

// ---- contract ----------------------------------------------------------

export async function list(a, selector, { since, ...opts } = {}) {
  const target = parseSelector(Array.isArray(selector) ? selector[0] : selector);

  if (target.pageId) {
    const pages = await allPages(a, target.docId, opts);
    const root = findPage(pages, target.docId, target.pageId);
    const items = [];
    const skipped = [];
    for (const p of withDescendants(pages, root.id)) {
      // Worth saying out loud for the page the user named; for a subpage
      // swept up along the way it is the same nicety the doc listing gives.
      if (!isCanvas(p)) {
        skipped.push({ id: `coda:${target.docId}/${p.id}`, reason: `no exportable content (${p.contentType})` });
        continue;
      }
      items.push(itemFor(target.docId, p));
    }
    return { items, skipped };
  }

  if (target.docId) return pagesOf(a, target.docId, { since, opts });

  const items = [];
  const skipped = [];
  let docs = 0;

  for await (const page of paged(a, 'docs?limit=100', { ...opts, bucket: 'docs' })) {
    for (const doc of page.items || []) {
      if (++docs > MAX_DOCS) {
        skipped.push({ id: `coda:${doc.id}`, reason: `stopped at ${MAX_DOCS} docs — name a doc to import` });
        return { items, skipped };
      }
      const inDoc = await pagesOf(a, doc.id, { since, opts });
      items.push(...inDoc.items);
      skipped.push(...inDoc.skipped);
    }
  }
  return { items, skipped };
}

/**
 * Run the export job for one page.
 *
 * Three requests at minimum — begin, poll, download — of which only the first
 * is a write. Polling is bounded: a job stuck `inProgress` fails its document
 * rather than stalling the whole import.
 */
async function exportMarkdown(a, docId, pageId, opts) {
  const { sleep = wait } = opts;
  const path = `docs/${encodeURIComponent(docId)}/pages/${encodeURIComponent(pageId)}/export`;

  const started = await call(a, path, {
    method: 'POST', body: { outputFormat: 'markdown' }, bucket: 'write', ...opts,
  });

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    const status = await call(a, `${path}/${encodeURIComponent(started.id)}`, opts);
    if (status.status === 'failed') throw new Error(`coda: export failed for ${pageId}${status.error ? ` (${status.error})` : ''}`);
    if (status.status === 'complete' && status.downloadLink) return download(status.downloadLink);
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`coda: export did not finish for ${pageId} after ${MAX_POLLS} checks`);
}

/**
 * The export lands on signed storage, not on coda.io — so this request must go
 * out *without* the Authorization header. Attaching it would hand the user's
 * Coda token to whatever host the API happens to name.
 */
async function download(link) {
  const res = await globalThis.fetch(link);
  if (!res.ok) throw new Error(`coda: could not download the export (${res.status})`);
  return res.text();
}

export async function fetch(a, ref, opts = {}) {
  return {
    id: `coda:${ref.docId}/${ref.pageId}`,
    title: ref.title || String(ref.pageId),
    text: await exportMarkdown(a, ref.docId, ref.pageId, opts),
  };
}
