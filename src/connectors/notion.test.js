import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as notion from './notion.js';

const PAGE = '1a2b3c4d5e6f47788899aabbccddeeff';
const DASHED = '1a2b3c4d-5e6f-4778-8899-aabbccddeeff';

const json = body => ({ ok: true, status: 200, json: async () => body });
const fail = (status, body) => ({ ok: false, status, json: async () => body });
const tooMany = (retryAfter = '1') => ({
  ok: false, status: 429,
  headers: { get: h => (h.toLowerCase() === 'retry-after' ? retryAfter : null) },
  json: async () => ({ code: 'rate_limited' }),
});

/** The auth object the contract hands to list/fetch. Paced at zero so the
 *  throttle does not make the suite wait for itself. */
const authed = () => ({ ok: true, token: 'ntn_test', blocks: new Map(), minIntervalMs: 0, lastCallAt: 0 });

const rt = s => [{ type: 'text', plain_text: s, text: { content: s } }];
const block = (type, data = {}, extra = {}) =>
  ({ object: 'block', id: 'blk', type, [type]: data, has_children: false, ...extra });
const results = (items, more = false, cursor = null) =>
  json({ object: 'list', results: items, has_more: more, next_cursor: cursor });
const page = (id, title, extra = {}) => ({
  object: 'page', id, last_edited_time: '2026-08-01T00:00:00.000Z',
  url: `https://www.notion.so/${title.replace(/\s/g, '-')}-${id}`,
  properties: { 'Some Custom Name': { type: 'title', title: rt(title) } },
  ...extra,
});

let calls;
const route = handlers => vi.fn(async (url, init) => {
  calls.push({ url: String(url), method: init?.method || 'GET', body: init?.body && JSON.parse(init.body) });
  for (const [pattern, handler] of handlers) {
    if (String(url).includes(pattern)) return typeof handler === 'function' ? handler(String(url)) : handler;
  }
  return results([]);
});

beforeEach(() => { calls = []; });
afterEach(() => { vi.restoreAllMocks(); });

describe('auth', () => {
  it('explains how to get a token when there is none', () => {
    const r = notion.auth({});
    expect(r.ok).toBe(false);
    expect(r.help).toMatch(/NOTION_TOKEN/);
    // The overwhelmingly common first-run failure is a valid token that can
    // see nothing, so the help has to name the sharing step.
    expect(r.help, 'must mention sharing the page').toMatch(/Add connections/);
  });

  it('accepts a token from the environment', () => {
    expect(notion.auth({ NOTION_TOKEN: 'ntn_1' })).toMatchObject({ ok: true, token: 'ntn_1' });
  });
});

describe('parseSelector', () => {
  it('accepts a pasted page link with a title slug', () => {
    expect(notion.parseSelector(`https://www.notion.so/Billing-Migration-${PAGE}`))
      .toEqual({ pageId: DASHED });
  });

  it('ignores a view query parameter', () => {
    // "Copy link" on a page inside a database view appends ?v=…, which is
    // another 32-hex id — taking the last one in the string would be wrong.
    expect(notion.parseSelector(`https://www.notion.so/Team-${PAGE}?v=ffffffffffffffffffffffffffffffff`))
      .toEqual({ pageId: DASHED });
  });

  it('accepts a bare id in either form', () => {
    expect(notion.parseSelector(PAGE)).toEqual({ pageId: DASHED });
    expect(notion.parseSelector(DASHED)).toEqual({ pageId: DASHED });
  });

  it('treats nothing at all as "everything shared with the integration"', () => {
    expect(notion.parseSelector('')).toEqual({ all: true });
    expect(notion.parseSelector(undefined)).toEqual({ all: true });
  });

  it('refuses anything else rather than guessing', () => {
    expect(() => notion.parseSelector('my page')).toThrow(/not a Notion page link or id/);
  });
});

describe('richText', () => {
  it('joins plain text', () => {
    expect(notion.richText([...rt('we are moving '), ...rt('off Stripe')])).toBe('we are moving off Stripe');
  });

  it('keeps a link target, because it is often the point of the sentence', () => {
    expect(notion.richText([{ plain_text: 'the RFC', href: 'https://x.dev/rfc' }]))
      .toBe('[the RFC](https://x.dev/rfc)');
  });

  it('survives an empty or missing array', () => {
    expect(notion.richText()).toBe('');
    expect(notion.richText([])).toBe('');
  });
});

describe('pageTitle', () => {
  it('finds the title property whatever the user named it', () => {
    // The key is the user's column name, so it cannot be looked up by key.
    expect(notion.pageTitle(page(PAGE, 'Billing Migration'))).toBe('Billing Migration');
  });

  it('falls back rather than returning an empty title', () => {
    expect(notion.pageTitle({ properties: { Name: { type: 'title', title: [] } } })).toBe('Untitled');
    expect(notion.pageTitle({})).toBe('Untitled');
  });
});

describe('renderBlocks', () => {
  it('renders the block types that carry prose', () => {
    const md = notion.renderBlocks([
      block('heading_1', { rich_text: rt('Billing') }),
      block('paragraph', { rich_text: rt('We are moving off Stripe.') }),
      block('bulleted_list_item', { rich_text: rt('fees') }),
      block('numbered_list_item', { rich_text: rt('first') }),
      block('to_do', { rich_text: rt('migrate'), checked: true }),
      block('to_do', { rich_text: rt('cancel'), checked: false }),
      block('quote', { rich_text: rt('cheaper') }),
      block('divider', {}),
    ]);
    expect(md).toBe([
      '# Billing',
      'We are moving off Stripe.',
      '- fees',
      '1. first',
      '- [x] migrate',
      '- [ ] cancel',
      '> cheaper',
      '---',
    ].join('\n'));
  });

  it('numbers an ordered list by position, and restarts after a break', () => {
    // Notion stores no number — position in the run is the number. Emitting a
    // literal "1." each time is valid markdown but reads as wrong to both the
    // distiller and the reviewer, who see the raw text.
    const md = notion.renderBlocks([
      block('numbered_list_item', { rich_text: rt('first') }),
      block('numbered_list_item', { rich_text: rt('second') }),
      block('numbered_list_item', { rich_text: rt('third') }),
      block('paragraph', { rich_text: rt('an aside') }),
      block('numbered_list_item', { rich_text: rt('one again') }),
    ]);
    expect(md).toBe('1. first\n2. second\n3. third\nan aside\n1. one again');
  });

  it('numbers each nesting level independently', () => {
    const md = notion.renderBlocks([
      block('numbered_list_item', { rich_text: rt('outer') }, {
        __children: [
          block('numbered_list_item', { rich_text: rt('inner a') }),
          block('numbered_list_item', { rich_text: rt('inner b') }),
        ],
      }),
    ]);
    expect(md).toBe('1. outer\n  1. inner a\n  2. inner b');
  });

  it('renders a callout with its emoji and a code block with its language', () => {
    expect(notion.renderBlocks([block('callout', { rich_text: rt('careful'), icon: { emoji: '⚠️' } })]))
      .toBe('> ⚠️ careful');
    expect(notion.renderBlocks([block('code', { rich_text: rt('a = 1'), language: 'python' })]))
      .toBe('```python\na = 1\n```');
  });

  it('indents nested children under their parent', () => {
    const md = notion.renderBlocks([
      block('bulleted_list_item', { rich_text: rt('parent') }, {
        __children: [block('bulleted_list_item', { rich_text: rt('child') })],
      }),
    ]);
    expect(md).toBe('- parent\n  - child');
  });

  it('links a child page instead of inlining it', () => {
    // The decision the connector turns on: inline these and importing a wiki
    // root produces one document the size of a wiki.
    const md = notion.renderBlocks([block('child_page', { title: 'Sub Page' }, { id: PAGE, has_children: true })]);
    expect(md).toBe(`- [Sub Page](https://www.notion.so/${PAGE})`);
  });

  it('renders a table with the separator row markdown needs', () => {
    const table = block('table', { table_width: 2, has_column_header: true }, {
      __children: [
        block('table_row', { cells: [rt('Vendor'), rt('Cost')] }),
        block('table_row', { cells: [rt('Stripe'), rt('2.9%')] }),
      ],
    });
    expect(notion.renderBlocks([table])).toBe('| Vendor | Cost |\n| --- | --- |\n| Stripe | 2.9% |');
  });

  it('escapes a pipe inside a cell so one value cannot split the row', () => {
    const table = block('table', {}, {
      __children: [block('table_row', { cells: [rt('a|b'), rt('c')] })],
    });
    expect(notion.renderBlocks([table])).toContain('a\\|b');
  });

  it('drops blocks that carry no text, and keeps unknown ones that do', () => {
    const md = notion.renderBlocks([
      block('image', { file: { url: 'https://x/y.png' } }),
      block('table_of_contents', {}),
      block('paragraph', { rich_text: [] }),
      // A block type that did not exist when this was written still has prose
      // worth keeping; inventing a rendering for it does not.
      block('some_future_block', { rich_text: rt('still prose') }),
    ]);
    expect(md).toBe('still prose');
  });
});

describe('list — a page and the pages beneath it', () => {
  it('walks child pages into their own items rather than one document', async () => {
    globalThis.fetch = route([
      [`pages/${DASHED}`, json(page(DASHED, 'Handbook'))],
      [`blocks/${DASHED}/children`, results([
        block('paragraph', { rich_text: rt('Welcome.') }),
        block('child_page', { title: 'Onboarding' }, { id: 'child-1', has_children: true }),
      ])],
      ['blocks/child-1/children', results([block('paragraph', { rich_text: rt('Day one.') })])],
    ]);

    const { items } = await notion.list(authed(), DASHED);
    expect(items.map(i => i.title)).toEqual(['Handbook', 'Onboarding']);
    expect(items.map(i => i.id)).toEqual([`notion:${DASHED}`, 'notion:child-1']);
  });

  it('keeps descending: a grandchild and a great-grandchild are their own documents', async () => {
    // A wiki is pages inside pages inside pages. The walk is breadth-first over
    // a queue rather than a single pass, so depth is unbounded — but the real
    // test doc was only two levels deep, so nothing exercised this live.
    globalThis.fetch = route([
      [`pages/${DASHED}`, json(page(DASHED, 'Root'))],
      [`blocks/${DASHED}/children`, results([block('child_page', { title: 'Child' }, { id: 'c1', has_children: true })])],
      ['blocks/c1/children', results([block('child_page', { title: 'Grandchild' }, { id: 'c2', has_children: true })])],
      ['blocks/c2/children', results([block('child_page', { title: 'Great-grandchild' }, { id: 'c3', has_children: true })])],
      ['blocks/c3/children', results([block('paragraph', { rich_text: rt('the bottom') })])],
    ]);

    const { items } = await notion.list(authed(), DASHED);
    expect(items.map(i => i.title)).toEqual(['Root', 'Child', 'Grandchild', 'Great-grandchild']);
  });

  it('finds a child page buried inside a block, not just at the top level', async () => {
    // People nest pages inside toggles and columns constantly; only scanning a
    // page's first level of blocks would silently drop those.
    globalThis.fetch = route([
      [`pages/${DASHED}`, json(page(DASHED, 'Root'))],
      [`blocks/${DASHED}/children`, results([
        block('toggle', { rich_text: rt('Archive') }, { id: 'tog', has_children: true }),
      ])],
      ['blocks/tog/children', results([block('child_page', { title: 'Buried' }, { id: 'deep', has_children: true })])],
      ['blocks/deep/children', results([block('paragraph', { rich_text: rt('found me') })])],
    ]);

    const { items } = await notion.list(authed(), DASHED);
    expect(items.map(i => i.title)).toEqual(['Root', 'Buried']);
  });

  it('does not re-request blocks that listing already read', async () => {
    // Discovering a child page means reading its parent's blocks — the same
    // work fetch would do. Paying for it twice is the easiest mistake here.
    globalThis.fetch = route([
      [`pages/${DASHED}`, json(page(DASHED, 'Handbook'))],
      [`blocks/${DASHED}/children`, results([block('paragraph', { rich_text: rt('Welcome.') })])],
    ]);

    const a = authed();
    const { items } = await notion.list(a, DASHED);
    const before = calls.length;
    const doc = await notion.fetch(a, items[0].ref);

    expect(doc.text).toBe('Welcome.');
    expect(calls.length, 'fetch should not call the API again').toBe(before);
  });

  it('recurses into nested blocks but not past the child-page boundary', async () => {
    globalThis.fetch = route([
      [`pages/${DASHED}`, json(page(DASHED, 'Handbook'))],
      [`blocks/${DASHED}/children`, results([
        block('toggle', { rich_text: rt('Why') }, { id: 'tog', has_children: true }),
      ])],
      ['blocks/tog/children', results([block('paragraph', { rich_text: rt('Because fees.') })])],
    ]);

    const a = authed();
    const { items } = await notion.list(a, DASHED);
    expect((await notion.fetch(a, items[0].ref)).text).toBe('- Why\n  Because fees.');
  });

  it('does not loop when pages link in a circle', async () => {
    globalThis.fetch = route([
      [`pages/${DASHED}`, json(page(DASHED, 'A'))],
      [`blocks/${DASHED}/children`, results([block('child_page', { title: 'A again' }, { id: DASHED })])],
    ]);
    const { items } = await notion.list(authed(), DASHED);
    expect(items).toHaveLength(1);
  });
});

describe('list — everything shared with the integration', () => {
  it('searches for pages and returns them oldest-first', async () => {
    // Matching Slack: a decision should be proposed by the page where it was
    // worked out, not by a later page that only mentions it.
    globalThis.fetch = route([
      ['search', results([page('p-new', 'Newer'), page('p-old', 'Older')])],
    ]);
    const { items } = await notion.list(authed(), '');
    expect(items.map(i => i.title)).toEqual(['Older', 'Newer']);
    expect(calls[0].body.filter).toEqual({ property: 'object', value: 'page' });
  });

  it('stops paging once results fall outside --since', async () => {
    // Search has no time filter, only a sort — so the window is enforced by
    // stopping, which also caps the request count on a large workspace.
    globalThis.fetch = route([
      ['search', results([
        { ...page('p-1', 'Recent'), last_edited_time: '2026-08-10T00:00:00.000Z' },
        { ...page('p-2', 'Ancient'), last_edited_time: '2020-01-01T00:00:00.000Z' },
      ], true, 'cursor-2')],
    ]);
    const { items } = await notion.list(authed(), '', { since: '2026-08-01' });
    expect(items.map(i => i.title)).toEqual(['Recent']);
    expect(calls, 'should not have paged past the cutoff').toHaveLength(1);
  });

  it('follows the cursor while results are still in the window', async () => {
    let n = 0;
    globalThis.fetch = route([
      ['search', () => (++n === 1 ? results([page('p-1', 'One')], true, 'c2') : results([page('p-2', 'Two')]))],
    ]);
    const { items } = await notion.list(authed(), '');
    expect(items).toHaveLength(2);
    expect(calls[1].body.start_cursor).toBe('c2');
  });

  it('says why a database was not imported instead of dropping it', async () => {
    globalThis.fetch = route([
      ['search', results([{ object: 'data_source', id: 'db-1' }])],
    ]);
    const { items, skipped } = await notion.list(authed(), '');
    expect(items).toEqual([]);
    expect(skipped[0].reason).toMatch(/databases are not imported/);
  });
});

describe('rate limits and errors', () => {
  it('honours Retry-After on a 429 and retries', async () => {
    let n = 0;
    const slept = [];
    globalThis.fetch = vi.fn(async () => (++n === 1 ? tooMany('2') : results([])));
    await notion.list(authed(), '', { sleep: ms => { slept.push(ms); } });
    expect(slept).toContain(2000);
    expect(n).toBe(2);
  });

  it('treats Retry-After: 0 as "go again now"', async () => {
    // A truthiness check here turns a legitimate zero into a full second of
    // waiting for no reason.
    let n = 0;
    const slept = [];
    globalThis.fetch = vi.fn(async () => (++n === 1 ? tooMany('0') : results([])));
    await notion.list(authed(), '', { sleep: ms => { slept.push(ms); } });
    expect(slept).toContain(0);
  });

  it('retries a 529 overload the same way', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => (++n === 1
      ? { ok: false, status: 529, headers: { get: () => null }, json: async () => ({}) }
      : results([])));
    await notion.list(authed(), '', { sleep: () => {} });
    expect(n).toBe(2);
  });

  it('explains an unshared page rather than reporting a bare 404', async () => {
    globalThis.fetch = vi.fn(async () => fail(404, { code: 'object_not_found', message: 'Could not find page' }));
    await expect(notion.list(authed(), DASHED)).rejects.toThrow(/Add connections/);
  });

  it('explains a bad token', async () => {
    globalThis.fetch = vi.fn(async () => fail(401, { code: 'unauthorized' }));
    await expect(notion.list(authed(), '')).rejects.toThrow(/NOTION_TOKEN/);
  });

  it('sends the pinned API version on every request', async () => {
    // Notion versions are dated and breaking; an import quietly changing shape
    // under us is worse than being a version behind.
    globalThis.fetch = vi.fn(async (_u, init) => {
      expect(init.headers['Notion-Version']).toBe('2022-06-28');
      return results([]);
    });
    await notion.list(authed(), '');
  });
});
