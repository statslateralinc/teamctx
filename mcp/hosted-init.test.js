import { describe, it, expect, beforeEach } from 'vitest';
import { makeHandlers } from './server.js';
import { initProject } from '../cli/commands/init.core.js';
import { runWithSession } from '../src/session-context.js';
import { runWithActor } from '../src/actor.js';
import { __resetMemory } from '../src/oauth/kv.js';

/**
 * Bootstrapping a project through the hosted MCP server (#32).
 *
 * `initProject` was the one write path with no hosted branch: it ran
 * `join(projectDir, '.teamctx')` first, and in hosted mode `projectDir` is the
 * `{__backend:'github'}` context object, so it threw
 * `The "path" argument must be of type string` before touching anything.
 *
 * Only the GitHub network is faked here — the storage dispatch, session
 * buffering and commit path are real.
 */

const OWNER = 'acme';
const REPO = 'ledger';
const ALICE = { key: 'github:1001', name: 'Alice Example', login: 'alice', source: 'github' };
const HOSTED_ROOT = { __backend: 'github', owner: OWNER, repo: REPO };

/** An empty repo — nothing under .teamctx/ yet, which is the point. */
function emptySession() {
  const files = new Map();
  const commits = [];
  return {
    owner: OWNER,
    repo: REPO,
    commits,
    files,
    read: p => files.get(p) || null,
    write: (p, c) => files.set(p, { content: String(c), sha: null }),
    del: p => files.delete(p),
    listDir: dirPath => {
      const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
      return [...files.keys()]
        .filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(p => p.slice(prefix.length))
        .sort();
    },
    commit: async msg => { commits.push(msg); return { committed: true }; },
  };
}

const asUser = (session, fn) =>
  runWithSession(session, () => runWithActor(ALICE, () => fn(makeHandlers(HOSTED_ROOT))));

const json = async (p) => JSON.parse((await p).content[0].text);

beforeEach(() => __resetMemory());

describe('init over the hosted MCP server', () => {
  it('bootstraps a project instead of crashing on a path join', async () => {
    const session = emptySession();
    const r = await asUser(session, h => json(h.init({ project: 'Ledger', me: 'alice' })));
    expect(r.config).toMatchObject({ project: 'Ledger', me: 'alice', activeWorkstream: 'main' });
  });

  it('writes the project files through the session, not the filesystem', async () => {
    const session = emptySession();
    await asUser(session, h => h.init({ project: 'Ledger', me: 'alice' }));

    expect([...session.files.keys()].sort()).toEqual([
      '.teamctx/config.json',
      '.teamctx/context/workstreams/main.md',
      '.teamctx/workstreams/main.json',
    ]);
  });

  it('does not commit an empty contributions log', async () => {
    // appendContribution creates it on first write and readContributions treats
    // absence as empty, so an empty blob would be noise in the history.
    const session = emptySession();
    await asUser(session, h => h.init({ project: 'Ledger', me: 'alice' }));
    expect(session.files.has('.teamctx/contributions.jsonl')).toBe(false);
  });

  it('commits once, with a message naming the project and the source', async () => {
    // "(via mcp)" matches what contributeCore already appends. A repo bootstrapped
    // from a chat client has no other trace of where the commit came from.
    const session = emptySession();
    await asUser(session, h => h.init({ project: 'Ledger', me: 'alice' }));
    expect(session.commits).toEqual(['chore: initialize teamctx for "Ledger" (via mcp)']);
  });

  it('leaves the note off when the source is not mcp', async () => {
    // Guards the default: flipping it would rewrite the message every local
    // `teamctx init` writes, which nothing else asserts.
    const session = emptySession();
    await runWithSession(session, () => runWithActor(ALICE, () =>
      initProject({ project: 'Ledger', me: 'alice' })));
    expect(session.commits).toEqual(['chore: initialize teamctx for "Ledger"']);
  });

  it('refuses a second init rather than overwriting the project', async () => {
    // Locally this is an existsSync check; hosted it has to ask the storage
    // layer whether a config is readable, which is what the check really means.
    const session = emptySession();
    await asUser(session, h => h.init({ project: 'Ledger', me: 'alice' }));
    await expect(asUser(session, h => h.init({ project: 'Again', me: 'alice' })))
      .rejects.toThrow(/already initialized/);
  });

  it('leaves the project usable immediately', async () => {
    const session = emptySession();
    await asUser(session, h => h.init({ project: 'Ledger', me: 'alice' }));

    const status = await asUser(session, h => json(h.get_status()));
    expect(status).toMatchObject({ project: 'Ledger', activeWorkstream: 'main' });
    expect(status.workstreams.map(w => w.id)).toEqual(['main']);
  });
});
