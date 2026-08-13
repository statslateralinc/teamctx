/**
 * Notion connector: pages in, documents out.
 *
 * Notion inverts the Slack problem. A channel is mostly standups and deploy
 * bots, so the hard part there is selection. A Notion page was written on
 * purpose — a spec, a postmortem, a decision log — so it is worth importing
 * almost by definition. The hard part here is structure.
 *
 * Two API facts shape everything below:
 *
 *   1. A page's content is not in the page. `GET /v1/pages/{id}` returns
 *      properties and no body; content is `blocks/{id}/children`, which returns
 *      only the *first* level. Every block with `has_children` is another
 *      request, so fetching one document is a tree walk.
 *   2. Search matches titles, not text, and sees only what the user connected
 *      to the integration by hand. That is not an obstacle — it means the
 *      explicit selection the contract asks for has already happened, in
 *      Notion's own UI, before teamctx sees anything.
 *
 * A child page is a *different* document. The walk stops at `child_page` rather
 * than inlining it: otherwise importing a wiki root produces one document the
 * size of a wiki, which a manager reviews as a single yes/no — exactly the
 * granularity the review queue exists to avoid. (notion-to-md reached the same
 * conclusion in v2.7 and stopped inlining them too.)
 *
 * No AI logic lives here — see src/connectors/index.js for the contract.
 */

const API = 'https://api.notion.com/v1';

/**
 * Pinned rather than tracking latest: Notion versions are dated and breaking,
 * and an import silently changing shape under us is worse than being a version
 * behind. Bump deliberately.
 */
const NOTION_VERSION = '2022-06-28';

/** ~3 requests/second is the documented average, so pace at just over 1/3s. */
const MIN_INTERVAL_MS = 350;

/** Depth of *block* nesting followed inside one page. Toggles inside toggles
 *  inside lists get deep by accident; nothing readable goes past this. */
const MAX_BLOCK_DEPTH = 8;

/** Pages pulled from one subtree walk. A wiki root can be enormous, and every
 *  page is several requests — better to stop and say so than to hang. */
const MAX_PAGES = 100;

export const name = 'notion';
export const describe = 'Notion pages, by link or across everything shared with your integration';

export function auth(env = process.env) {
  const token = env.NOTION_TOKEN || env.NOTION_API_KEY;
  if (!token) {
    return {
      ok: false,
      help: 'set NOTION_TOKEN in .env.local. Create an integration at '
        + 'notion.so/my-integrations, copy its Internal Integration Secret, then open the '
        + 'page you want to import in Notion and use ••• → Add connections to share it. '
        + 'A new integration can see nothing until you do — access cascades to child pages.',
    };
  }
  return { ok: true, token, blocks: new Map(), minIntervalMs: MIN_INTERVAL_MS, lastCallAt: 0 };
}

class NotionError extends Error {
  constructor(status, body) {
    const code = body?.code || `http_${status}`;
    const hint = {
      unauthorized: 'the token is not valid — check NOTION_TOKEN',
      restricted_resource: 'the token is not allowed to do this',
      // The overwhelmingly common first-run failure: the integration exists but
      // no page has been shared with it, so everything 404s.
      object_not_found: 'no such page, or it has not been shared with your integration '
        + '(open it in Notion → ••• → Add connections)',
      validation_error: body?.message || 'the request was rejected as invalid',
    }[code];
    super(hint ? `notion: ${hint} (${code})` : `notion ${code}: ${body?.message || ''}`.trim());
    this.code = code;
    this.status = status;
  }
}

const wait = ms => new Promise(r => setTimeout(r, ms));

/**
 * One API call, paced and retried.
 *
 * Slack needed 429 handling to *recover* — one request a minute in the worst
 * tier, so ignoring Retry-After turned a slow import into a failed one. Notion
 * needs it to *pace*: each request is cheap but one page costs many, so the
 * limit is reached by walking normally rather than by doing anything unusual.
 * Hence the gap before each call, not only the backoff after a rejection.
 */
async function call(a, path, { method = 'GET', body, retries = 3, sleep = wait } = {}) {
  for (let attempt = 0; ; attempt++) {
    const gap = a.minIntervalMs - (Date.now() - a.lastCallAt);
    if (gap > 0) await sleep(gap);
    a.lastCallAt = Date.now();

    const res = await globalThis.fetch(`${API}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${a.token}`,
        'Notion-Version': NOTION_VERSION,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    // 529 is "overloaded" and the docs say to treat it exactly like a 429.
    if ((res.status === 429 || res.status === 529) && attempt < retries) {
      const header = Number(res.headers?.get?.('retry-after'));
      // `Retry-After: 0` is a legitimate "go again now", so a truthiness check
      // here would turn it into a full second of waiting for no reason.
      const seconds = Number.isFinite(header) && header >= 0 ? header : 1;
      await sleep(seconds * 1000);
      continue;
    }

    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new NotionError(res.status, json);
    return json;
  }
}

async function* paged(a, path, { method = 'GET', body, ...opts } = {}) {
  let cursor;
  do {
    const page = method === 'POST'
      ? await call(a, path, { method, body: { ...body, start_cursor: cursor, page_size: 100 }, ...opts })
      : await call(a, `${path}?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`, opts);
    yield page;
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
}

// ---- ids and selectors -------------------------------------------------

const undash = id => String(id).replace(/-/g, '');

/** Notion accepts both forms; ids are stored dashed so one page has one id. */
export function dashId(raw) {
  const hex = undash(raw).toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Accepts a page URL, a bare id, or nothing.
 *
 * "Copy link" produces `notion.so/Some-Title-<32 hex>`, sometimes with a `?v=`
 * view parameter — the id is the last 32 hex characters of the path, never the
 * query. Nothing at all means "everything shared with this integration", which
 * is defensible only because the user already chose that set in Notion.
 */
export function parseSelector(input) {
  const s = String(input ?? '').trim();
  if (!s) return { all: true };

  const url = /^https?:\/\//i.test(s);
  const path = url ? s.split('?')[0] : s;
  const match = /([0-9a-f]{32}|[0-9a-f-]{36})\/?$/i.exec(path);
  const id = match && dashId(match[1]);
  if (id) return { pageId: id };

  throw new Error(`not a Notion page link or id: "${s}"`);
}

/** Construct only as a fallback; the API hands back a real `url` when we have
 *  the page object, and a link nobody can open is decoration. */
const pageUrl = (page, id) => page?.url || `https://www.notion.so/${undash(id)}`;

// ---- rendering ---------------------------------------------------------

/** Every rich text object carries `plain_text`, so extraction is uniform;
 *  `href` is kept because a link's target is often the point of the sentence. */
export function richText(rich = []) {
  return rich.map(t => {
    const text = t.plain_text ?? t.text?.content ?? '';
    const href = t.href || t.text?.link?.url;
    return href ? `[${text}](${href})` : text;
  }).join('');
}

/** The title lives in whichever property has type 'title' — its name is the
 *  user's, so it cannot be looked up by key. */
export function pageTitle(page) {
  const props = Object.values(page?.properties || {});
  const prop = props.find(p => p?.type === 'title');
  return richText(prop?.title || []).trim() || 'Untitled';
}

const isPageBlock = b => b?.type === 'child_page' || b?.type === 'child_database';

function renderTable(block, indent) {
  // Cells hang off the block's own type key, like every other block's payload.
  const rows = (block.__children || [])
    .filter(r => r.type === 'table_row')
    .map(r => r.table_row?.cells || []);
  if (rows.length === 0) return [];
  const line = cells => `${indent}| ${cells.map(c => richText(c).replace(/\|/g, '\\|')).join(' | ')} |`;
  // Markdown needs a separator row to render a table at all, whether or not
  // Notion styled the first row as a header.
  return [line(rows[0]), `${indent}|${' --- |'.repeat(rows[0].length)}`, ...rows.slice(1).map(line)];
}

/**
 * Blocks to markdown, because the distiller reads prose rather than a wire
 * format. Anything carrying no text — images, embeds, breadcrumbs — is dropped
 * silently, the way `folder` walks past a .png inside a directory.
 */
export function renderBlocks(blocks = [], depth = 0) {
  const indent = '  '.repeat(depth);
  const lines = [];

  for (const block of blocks) {
    const type = block?.type;
    const data = block?.[type] || {};
    const text = richText(data.rich_text || []);
    const kids = block.__children || [];

    switch (type) {
      case 'paragraph':
        if (text.trim()) lines.push(indent + text);
        break;
      case 'heading_1': lines.push(`${indent}# ${text}`); break;
      case 'heading_2': lines.push(`${indent}## ${text}`); break;
      case 'heading_3': lines.push(`${indent}### ${text}`); break;
      case 'bulleted_list_item':
      case 'toggle':
        lines.push(`${indent}- ${text}`);
        break;
      // Always "1." — markdown renumbers on render, and the distiller reads
      // the sentence rather than counting.
      case 'numbered_list_item': lines.push(`${indent}1. ${text}`); break;
      case 'to_do': lines.push(`${indent}- [${data.checked ? 'x' : ' '}] ${text}`); break;
      case 'quote': lines.push(`${indent}> ${text}`); break;
      case 'callout': {
        const icon = data.icon?.emoji ? `${data.icon.emoji} ` : '';
        lines.push(`${indent}> ${icon}${text}`);
        break;
      }
      case 'code':
        lines.push(`${indent}\`\`\`${data.language || ''}`, ...text.split('\n').map(l => indent + l), `${indent}\`\`\``);
        break;
      case 'divider': lines.push(`${indent}---`); break;
      case 'table': lines.push(...renderTable(block, indent)); continue;   // rows handled, not children
      case 'child_page':
      case 'child_database':
        // Its own document; a link keeps the parent readable without swallowing it.
        lines.push(`${indent}- [${data.title || 'Untitled'}](https://www.notion.so/${undash(block.id)})`);
        continue;
      case 'table_row':
        continue;                                    // consumed by its table
      default:
        // Unknown or textless: keep whatever text it had rather than inventing
        // a rendering for a block type that did not exist when this was written.
        if (text.trim()) lines.push(indent + text);
    }

    if (kids.length) {
      const nested = renderBlocks(kids, depth + 1);
      if (nested) lines.push(nested);
    }
  }

  return lines.join('\n');
}

// ---- fetching ----------------------------------------------------------

/** One level of children, all pages of it. */
async function childrenOf(a, blockId, opts) {
  const out = [];
  for await (const page of paged(a, `blocks/${blockId}/children`, opts)) {
    out.push(...(page.results || []));
  }
  return out;
}

/**
 * A page's block tree, with nested children attached as `__children`.
 *
 * Child pages are returned separately rather than descended into — they are
 * their own documents. Column layouts are structural rather than nested
 * content, but they are still blocks, so they recurse like everything else.
 */
async function loadBlocks(a, pageId, opts, depth = 0) {
  const blocks = await childrenOf(a, pageId, opts);
  const childPages = [];

  for (const block of blocks) {
    if (isPageBlock(block)) {
      childPages.push({ id: block.id, title: block[block.type]?.title || 'Untitled' });
      continue;
    }
    if (!block.has_children || depth >= MAX_BLOCK_DEPTH) continue;
    const nested = await loadBlocks(a, block.id, opts, depth + 1);
    block.__children = nested.blocks;
    childPages.push(...nested.childPages);
  }

  return { blocks, childPages };
}

// ---- contract ----------------------------------------------------------

/**
 * Everything shared with the integration, newest first.
 *
 * Search costs one request per 100 pages and returns no content, which is
 * exactly the cheap listing the contract's list/fetch split exists for — a
 * `--dry-run` over a whole workspace is a request or two.
 */
async function listAll(a, { since, opts }) {
  const cutoff = since ? new Date(since).getTime() : null;
  const items = [];
  const skipped = [];

  for await (const page of paged(a, 'search', {
    method: 'POST',
    body: { filter: { property: 'object', value: 'page' }, sort: { direction: 'descending', timestamp: 'last_edited_time' } },
    ...opts,
  })) {
    for (const result of page.results || []) {
      if (result.object !== 'page') {
        skipped.push({ id: `notion:${result.id}`, reason: `not a page (${result.object}) — databases are not imported` });
        continue;
      }
      // Results are newest-first, so the first page older than the window means
      // every remaining one is too.
      if (cutoff && new Date(result.last_edited_time).getTime() < cutoff) {
        return { items: items.reverse(), skipped };
      }
      const title = pageTitle(result);
      items.push({
        ref: { pageId: result.id, url: pageUrl(result, result.id), title },
        id: `notion:${result.id}`,
        title,
      });
    }
  }

  // Oldest-first, matching Slack: a decision should be proposed by the page
  // where it was worked out, not by a later page that only mentions it.
  return { items: items.reverse(), skipped };
}

/**
 * One page and the pages beneath it.
 *
 * The subtree walk is not free — discovering a child page means reading its
 * parent's blocks, which is the same work `fetch` would do. So the blocks are
 * kept on the ref and `fetch` renders them without asking again, the way
 * `folder` hands its document straight through.
 */
async function listSubtree(a, pageId, { opts }) {
  const items = [];
  const skipped = [];
  const seen = new Set();
  const queue = [{ id: pageId, title: null }];

  while (queue.length > 0) {
    const next = queue.shift();
    const id = dashId(next.id) || next.id;
    if (seen.has(id)) continue;                       // a wiki can link in circles
    seen.add(id);

    // Reported once, not once per queued page: a wiki root would otherwise
    // produce hundreds of identical skip lines, which is noise dressed as
    // information.
    if (items.length >= MAX_PAGES) {
      skipped.push({
        id: `notion:${pageId}`,
        reason: `stopped at ${MAX_PAGES} pages (${queue.length + 1} more below this one) — import a narrower page`,
      });
      break;
    }

    let title = next.title;
    let url;
    if (!title) {
      const page = await call(a, `pages/${id}`, opts);
      title = pageTitle(page);
      url = pageUrl(page, id);
    }

    const { blocks, childPages } = await loadBlocks(a, id, opts);
    items.push({
      ref: { pageId: id, url: url || pageUrl(null, id), title, blocks },
      id: `notion:${id}`,
      title,
    });
    queue.push(...childPages);
  }

  return { items, skipped };
}

export async function list(a, selector, { since, ...opts } = {}) {
  const target = parseSelector(Array.isArray(selector) ? selector[0] : selector);
  return target.all
    ? listAll(a, { since, opts })
    : listSubtree(a, target.pageId, { opts });
}

export async function fetch(a, ref, opts = {}) {
  // `listSubtree` already read the tree to find child pages; asking again would
  // double every request on the path that costs the most.
  const blocks = ref.blocks ?? (await loadBlocks(a, ref.pageId, opts)).blocks;
  const title = ref.title ?? pageTitle(await call(a, `pages/${ref.pageId}`, opts));
  return {
    id: `notion:${ref.pageId}`,
    title,
    text: renderBlocks(blocks),
  };
}
