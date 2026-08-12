import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as slack from './slack.js';

const ok = body => ({ ok: true, status: 200, json: async () => ({ ok: true, ...body }) });
const err = code => ({ ok: false, status: 200, json: async () => ({ ok: false, error: code }) });
const tooMany = (retryAfter = '1') => ({
  ok: false, status: 429,
  headers: { get: h => (h.toLowerCase() === 'retry-after' ? retryAfter : null) },
  json: async () => ({ ok: false, error: 'ratelimited' }),
});

/** The auth object the contract hands to list/fetch, with users pre-resolved. */
const authed = (users = [['U1', 'alice'], ['U2', 'bob']]) => ({
  ok: true, token: 'xoxp-test', users: new Map(users),
});

let calls;
beforeEach(() => {
  calls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ method: String(url).split('/api/')[1], body: Object.fromEntries(new URLSearchParams(init.body)) });
    return ok({});
  });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('auth', () => {
  it('explains how to get a token when there is none', () => {
    const r = slack.auth({});
    expect(r.ok).toBe(false);
    expect(r.help).toMatch(/SLACK_TOKEN/);
    expect(r.help, 'must say which scopes').toMatch(/channels:history/);
  });

  it('accepts a token from the environment', () => {
    expect(slack.auth({ SLACK_TOKEN: 'xoxp-1' })).toMatchObject({ ok: true, token: 'xoxp-1' });
  });
});

describe('parseSelector', () => {
  it('accepts a bare channel id', () => {
    expect(slack.parseSelector('C0421ABCD')).toEqual({ channel: 'C0421ABCD', ts: undefined });
  });

  it('accepts a channel link', () => {
    expect(slack.parseSelector('https://team.slack.com/archives/C0421ABCD'))
      .toEqual({ channel: 'C0421ABCD', ts: undefined });
  });

  it('accepts a message link and recovers the timestamp', () => {
    // Slack's permalink drops the dot from the ts; putting it back is what
    // makes "Copy link" a usable selector.
    expect(slack.parseSelector('https://team.slack.com/archives/C0421/p1699887654123456'))
      .toEqual({ channel: 'C0421', ts: '1699887654.123456' });
  });

  it('refuses anything else rather than guessing', () => {
    expect(() => slack.parseSelector('#engineering')).toThrow(/not a Slack channel id or link/);
    expect(() => slack.parseSelector('')).toThrow(/needs a channel id or a message link/);
  });
});

describe('renderText', () => {
  const users = new Map([['U1', 'alice']]);

  it('turns user mentions into names', () => {
    expect(slack.renderText('ping <@U1> please', users)).toBe('ping @alice please');
  });

  it('falls back to the id when a name is unknown', () => {
    expect(slack.renderText('<@U9>', users)).toBe('@U9');
  });

  it('keeps a link label and its url', () => {
    expect(slack.renderText('see <https://x.com/a|the doc>', users)).toBe('see the doc (https://x.com/a)');
    expect(slack.renderText('<https://x.com/a>', users)).toBe('https://x.com/a');
  });

  it('renders channel references readably', () => {
    expect(slack.renderText('in <#C1|eng>', users)).toBe('in #eng');
    expect(slack.renderText('in <#C1>', users)).toBe('in #C1');
  });

  it('renders @here and @channel', () => {
    expect(slack.renderText('<!here> look', users)).toBe('@here look');
  });

  it('unescapes the three entities Slack escapes', () => {
    expect(slack.renderText('a &amp; b &lt;c&gt;', users)).toBe('a & b <c>');
  });
});

describe('renderThread', () => {
  const users = new Map([['U1', 'alice'], ['U2', 'bob']]);

  it('writes one attributed line per message, in order', () => {
    const text = slack.renderThread([
      { user: 'U1', text: 'we should move off Stripe' },
      { user: 'U2', text: 'agreed, <@U1> can you scope it' },
    ], users);
    expect(text).toBe('@alice: we should move off Stripe\n@bob: agreed, @alice can you scope it');
  });

  it('drops joins, leaves and other subtype noise', () => {
    // Every channel is full of these and none of them are team context.
    const text = slack.renderThread([
      { user: 'U1', text: 'real content' },
      { user: 'U2', text: 'has joined the channel', subtype: 'channel_join' },
    ], users);
    expect(text).toBe('@alice: real content');
  });

  it('keeps a thread_broadcast, which is a real message', () => {
    const text = slack.renderThread([{ user: 'U1', text: 'also posting to channel', subtype: 'thread_broadcast' }], users);
    expect(text).toContain('also posting to channel');
  });

  it('drops empty messages', () => {
    expect(slack.renderThread([{ user: 'U1', text: '   ' }], users)).toBe('');
  });
});

describe('list — a channel', () => {
  it('returns threads and skips messages with no replies', async () => {
    // A message nobody replied to is not a conversation; saying so is more
    // useful than silently dropping it.
    globalThis.fetch = vi.fn(async () => ok({
      messages: [
        { ts: '1699887654.123456', thread_ts: '1699887654.123456', reply_count: 3, user: 'U1', text: 'move off Stripe?' },
        { ts: '1699887000.000100', user: 'U2', text: 'standup notes' },
        { ts: '1699886000.000200', thread_ts: '1699886000.000200', reply_count: 0, user: 'U2', text: 'lonely' },
      ],
    }));
    const r = await slack.list(authed(), 'C0421');

    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      id: 'slack:C0421/p1699887654123456',
      title: 'move off Stripe?',
      ref: { channel: 'C0421', ts: '1699887654.123456' },
    });
    expect(r.skipped).toEqual([{ id: 'slack:C0421/p1699886000000200', reason: 'no replies' }]);
  });

  it('defaults to a recent window rather than all history', async () => {
    let seen;
    globalThis.fetch = vi.fn(async (_u, init) => {
      seen = Object.fromEntries(new URLSearchParams(init.body));
      return ok({ messages: [] });
    });
    const now = Date.UTC(2026, 0, 31);
    await slack.list(authed(), 'C0421ABCD', { now });
    // 30 days back — importing a year of a busy channel would drown the queue.
    expect(Number(seen.oldest)).toBe(Math.floor((now - 30 * 864e5) / 1000));
  });

  it('honours an explicit since', async () => {
    let seen;
    globalThis.fetch = vi.fn(async (_u, init) => {
      seen = Object.fromEntries(new URLSearchParams(init.body));
      return ok({ messages: [] });
    });
    await slack.list(authed(), 'C0421ABCD', { since: '2026-01-01' });
    expect(Number(seen.oldest)).toBe(Math.floor(Date.UTC(2026, 0, 1) / 1000));
  });

  it('follows pagination to the end', async () => {
    const pages = [
      ok({ messages: [{ ts: '1.1', thread_ts: '1.1', reply_count: 1, user: 'U1', text: 'a' }], response_metadata: { next_cursor: 'c2' } }),
      ok({ messages: [{ ts: '2.2', thread_ts: '2.2', reply_count: 1, user: 'U1', text: 'b' }] }),
    ];
    let i = 0;
    globalThis.fetch = vi.fn(async () => pages[i++]);
    const r = await slack.list(authed(), 'C0421ABCD');
    expect(r.items.map(x => x.title)).toEqual(['a', 'b']);
  });
});

describe('list — a single message link', () => {
  it('returns just that thread, without reading the channel', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      expect(String(url)).toContain('conversations.replies');
      return ok({ messages: [{ ts: '1699887654.123456', user: 'U1', text: 'the decision thread' }] });
    });
    const r = await slack.list(authed(), 'https://team.slack.com/archives/C0421/p1699887654123456');
    expect(r.items).toHaveLength(1);
    expect(r.items[0].title).toBe('the decision thread');
  });
});

describe('fetch', () => {
  it('renders the whole thread as attributed prose', async () => {
    globalThis.fetch = vi.fn(async () => ok({
      messages: [
        { user: 'U1', text: 'we should move billing off <#C9|billing>' },
        { user: 'U2', text: 'agreed' },
        { user: 'U2', text: 'joined', subtype: 'channel_join' },
      ],
    }));
    const doc = await slack.fetch(authed(), { channel: 'C0421', ts: '1699887654.123456' });

    expect(doc.id).toBe('slack:C0421/p1699887654123456');
    expect(doc.text).toBe('@alice: we should move billing off #billing\n@bob: agreed');
  });

  it('pages through a long thread', async () => {
    const pages = [
      ok({ messages: [{ user: 'U1', text: 'one' }], response_metadata: { next_cursor: 'c2' } }),
      ok({ messages: [{ user: 'U2', text: 'two' }] }),
    ];
    let i = 0;
    globalThis.fetch = vi.fn(async () => pages[i++]);
    const doc = await slack.fetch(authed(), { channel: 'C0421ABCD', ts: '1.1' });
    expect(doc.text).toBe('@alice: one\n@bob: two');
  });
});

describe('errors and limits', () => {
  it('turns a Slack error code into something actionable', async () => {
    globalThis.fetch = vi.fn(async () => err('missing_scope'));
    await expect(slack.list(authed(), 'C0421ABCD')).rejects.toThrow(/channels:history/);
  });

  it('explains an unusable token rather than echoing a code', async () => {
    globalThis.fetch = vi.fn(async () => err('invalid_auth'));
    await expect(slack.list(authed(), 'C0421ABCD')).rejects.toThrow(/token is not valid/);
  });

  it('waits out a 429 and retries', async () => {
    // A misconfigured app lands in the 1-request-per-minute tier, where
    // ignoring Retry-After turns a slow import into a failed one.
    let n = 0;
    globalThis.fetch = vi.fn(async () => (n++ === 0 ? tooMany('1') : ok({ messages: [] })));
    const r = await slack.list(authed(), 'C0421ABCD');
    expect(n).toBe(2);
    expect(r.items).toEqual([]);
  });

  it('gives up rather than retrying a 429 forever', async () => {
    globalThis.fetch = vi.fn(async () => tooMany('0'));
    await expect(slack.list(authed(), 'C0421ABCD')).rejects.toThrow(/ratelimited/);
  });

  it('sends the token as a bearer header, never in the query string', async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      expect(String(url)).not.toContain('token');
      expect(init.headers.Authorization).toBe('Bearer xoxp-test');
      return ok({ messages: [] });
    });
    await slack.list(authed(), 'C0421ABCD');
  });
});
