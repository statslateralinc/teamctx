/**
 * Slack connector: threads in, documents out.
 *
 * A thread is the unit, not a channel and not a day. A thread has a topic, a
 * beginning and an end, and it is where the reasoning actually lives — which is
 * the thing that gets lost. Channels are mostly standups and deploy bots, and a
 * manager who rejects forty proposals in a row stops reading them.
 *
 * Credentials are the user's own token, never a shipped app. That was a
 * position about not running a server; since 29 May 2025 it is also the only
 * version that works. Slack rate-limits `conversations.history` and
 * `conversations.replies` to 1 request per minute and 15 objects for
 * distributed non-Marketplace apps, against 50+/minute and 1000 for an
 * internal app the user created themselves. A shipped teamctx Slack app would
 * take hours to read one channel.
 *
 * No AI logic lives here — see src/connectors/index.js for the contract.
 */

const API = 'https://slack.com/api';

/** Slack's own permalink shape: p + the ts with the dot removed. */
const permalinkTs = ts => `p${String(ts).replace('.', '')}`;
const tsFromPermalink = p => {
  const digits = String(p).replace(/^p/, '');
  return `${digits.slice(0, 10)}.${digits.slice(10)}`;
};

export const name = 'slack';
export const describe = 'Slack threads from a channel or a message link';

export function auth(env = process.env) {
  const token = env.SLACK_TOKEN || env.SLACK_USER_TOKEN;
  if (!token) {
    return {
      ok: false,
      help: 'set SLACK_TOKEN in .env.local. Create a Slack app at api.slack.com/apps '
        + 'in your own workspace, add the user-token scopes channels:history (and '
        + 'groups:history for private channels), install it, and copy the User OAuth Token.',
    };
  }
  return { ok: true, token, users: new Map() };
}

class SlackError extends Error {
  constructor(method, code) {
    const hint = {
      invalid_auth: 'the token is not valid — check SLACK_TOKEN',
      not_authed: 'no token was sent',
      token_revoked: 'the token has been revoked',
      missing_scope: 'the app is missing a scope — add channels:history (or groups:history)',
      channel_not_found: 'no such channel, or your token cannot see it',
      not_in_channel: 'the token owner is not a member of that channel',
    }[code];
    super(hint ? `slack ${method}: ${hint} (${code})` : `slack ${method} failed: ${code}`);
    this.code = code;
  }
}

/**
 * One Web API call.
 *
 * A 429 carries Retry-After; honouring it matters more than usual here because
 * a misconfigured app lands in the 1-request-per-minute tier, where ignoring
 * the header turns a slow import into a failed one.
 */
async function call(token, method, params, { retries = 2, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const body = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]),
  );

  for (let attempt = 0; ; attempt++) {
    const res = await globalThis.fetch(`${API}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body,
    });

    if (res.status === 429 && attempt < retries) {
      // `Retry-After: 0` is a legitimate "go again now", so a truthiness check
      // here would turn it into a minute of waiting.
      const header = Number(res.headers?.get?.('retry-after'));
      const wait = Number.isFinite(header) && header >= 0 ? header : 60;
      await sleep(wait * 1000);
      continue;
    }
    const json = await res.json();
    if (!json.ok) throw new SlackError(method, json.error || `http ${res.status}`);
    return json;
  }
}

async function* paged(token, method, params, opts) {
  let cursor;
  do {
    const page = await call(token, method, { ...params, cursor }, opts);
    yield page;
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

// ---- selector ----------------------------------------------------------

/**
 * Accepts a bare channel id, a channel link, or a link to a single message.
 * "Copy link" in Slack produces the latter two, which is how someone imports
 * the one conversation they already know mattered.
 */
export function parseSelector(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('slack needs a channel id or a message link');

  const link = /slack\.com\/archives\/([A-Z0-9]+)(?:\/(p\d+))?/i.exec(s);
  if (link) {
    return { channel: link[1], ts: link[2] ? tsFromPermalink(link[2]) : undefined };
  }
  if (/^[A-Z][A-Z0-9]{2,}$/i.test(s)) return { channel: s.toUpperCase() };
  throw new Error(`not a Slack channel id or link: "${s}"`);
}

// ---- rendering ---------------------------------------------------------

const unescape = t => String(t)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Slack's wire format is not prose. The distiller reads what a human would,
 * so mentions become names and links keep their label.
 */
export function renderText(text, users = new Map()) {
  const resolved = String(text || '').replace(/<(.*?)>/g, (_m, inner) => {
    if (inner.startsWith('@')) {
      const id = inner.slice(1).split('|')[0];
      return `@${users.get(id) || id}`;
    }
    if (inner.startsWith('#')) {
      const [id, label] = inner.slice(1).split('|');
      return `#${label || id}`;
    }
    if (inner.startsWith('!')) return `@${inner.slice(1).split('|')[0]}`;
    const [url, label] = inner.split('|');
    return label ? `${label} (${url})` : url;
  });
  return unescape(resolved);
}

/** Joins, leaves, channel renames, pins — noise in every channel. */
const isNoise = m => !!m.subtype && m.subtype !== 'thread_broadcast';

export function renderThread(messages, users = new Map()) {
  return messages
    .filter(m => !isNoise(m) && String(m.text || '').trim())
    .map(m => `@${users.get(m.user) || m.user || 'unknown'}: ${renderText(m.text, users)}`)
    .join('\n');
}

/** One line of the parent message, enough to recognise the thread in a list. */
function titleFrom(text, users) {
  const first = renderText(text, users).split('\n').find(l => l.trim()) || 'thread';
  return first.length > 80 ? `${first.slice(0, 77)}…` : first;
}

// ---- contract ----------------------------------------------------------

/** Resolved once per run and cached on the auth object; ids alone read as noise. */
async function loadUsers(a) {
  if (a.users.size > 0) return a.users;
  try {
    for await (const page of paged(a.token, 'users.list', { limit: 200 })) {
      for (const u of page.members || []) {
        a.users.set(u.id, u.profile?.display_name || u.profile?.real_name || u.name || u.id);
      }
    }
  } catch {
    // users:read may not be granted. Ids are worse than names but not fatal,
    // and refusing the whole import over a cosmetic scope would be wrong.
  }
  return a.users;
}

export async function list(a, selector, { since, now = Date.now() } = {}) {
  const target = parseSelector(Array.isArray(selector) ? selector[0] : selector);
  const users = await loadUsers(a);

  if (target.ts) {
    const thread = await call(a.token, 'conversations.replies', {
      channel: target.channel, ts: target.ts, limit: 1,
    });
    const parent = thread.messages?.[0];
    return {
      items: [{
        ref: { channel: target.channel, ts: target.ts },
        id: `slack:${target.channel}/${permalinkTs(target.ts)}`,
        title: titleFrom(parent?.text, users),
      }],
      skipped: [],
    };
  }

  const oldest = since ? Math.floor(new Date(since).getTime() / 1000) : Math.floor((now - 30 * 864e5) / 1000);
  const items = [];
  const skipped = [];

  for await (const page of paged(a.token, 'conversations.history', { channel: target.channel, oldest, limit: 200 })) {
    for (const m of page.messages || []) {
      // Threads only. A standalone message is usually chatter, and importing
      // every one of them is the firehose this connector exists to avoid.
      if (!m.thread_ts || m.thread_ts !== m.ts) continue;
      if (isNoise(m)) continue;
      if (!(m.reply_count > 0)) {
        skipped.push({ id: `slack:${target.channel}/${permalinkTs(m.ts)}`, reason: 'no replies' });
        continue;
      }
      items.push({
        ref: { channel: target.channel, ts: m.ts },
        id: `slack:${target.channel}/${permalinkTs(m.ts)}`,
        title: titleFrom(m.text, users),
      });
    }
  }
  return { items, skipped };
}

export async function fetch(a, ref) {
  const users = await loadUsers(a);
  const messages = [];
  for await (const page of paged(a.token, 'conversations.replies', { channel: ref.channel, ts: ref.ts, limit: 200 })) {
    messages.push(...(page.messages || []));
  }
  return {
    id: `slack:${ref.channel}/${permalinkTs(ref.ts)}`,
    title: titleFrom(messages[0]?.text, users),
    text: renderThread(messages, users),
  };
}
