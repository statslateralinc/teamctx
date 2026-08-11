import { describe, it, expect, beforeEach } from 'vitest';
import { makeHandlers } from './server.js';
import { runWithSession } from '../src/session-context.js';
import { runWithActor } from '../src/actor.js';
import { __resetMemory } from '../src/oauth/kv.js';

/**
 * Two people on the hosted server at the same time.
 *
 * This is the claim the whole change rests on and the one that cannot be made
 * from the CLI: that when Alice switches workstream, Bob — a different GitHub
 * account, hitting the same repo — still sees his own. Everything else is
 * circumstantial evidence for it.
 *
 * The GitHub network layer is faked (a Map standing in for the prefetched
 * repo); the actor context, the storage dispatch, the preference store and
 * the resolution ladder are all the real thing.
 */

const OWNER = 'acme';
const REPO = 'ledger';

const ALICE = { key: 'github:1001', name: 'Alice Example', login: 'alice', source: 'github' };
const BOB = { key: 'github:2002', name: 'Bob Example', login: 'bob', source: 'github' };

const CONFIG = {
  project: 'Ledger',
  me: 'whoever-ran-init',
  // Gate pinned to Alice's GitHub identity.
  managerKey: 'github:1001',
  model: 'claude-sonnet-4-6',
  autoPush: false,
  roles: [],
  workstreams: [
    { id: 'main', name: 'Ledger' },
    { id: 'engineering-hiring', name: 'Engineering Hiring' },
  ],
  activeWorkstream: 'main',
  workstreamsMigrated: true,
};

/** Stands in for a prefetched GithubSession — same surface storage.js uses. */
function fakeSession() {
  const files = new Map([
    ['.teamctx/config.json', { content: JSON.stringify(CONFIG), sha: 'a' }],
    ['.teamctx/contributions.jsonl', { content: '', sha: 'b' }],
    ['.teamctx/workstreams/main.json', { content: JSON.stringify({ id: 'main', name: 'Ledger', whys: [] }), sha: 'c' }],
    ['.teamctx/workstreams/engineering-hiring.json', { content: JSON.stringify({ id: 'engineering-hiring', name: 'Engineering Hiring', whys: [] }), sha: 'd' }],
  ]);
  const commits = [];
  return {
    owner: OWNER,
    repo: REPO,
    commits,
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
    configJson: () => JSON.parse(files.get('.teamctx/config.json').content),
  };
}

const HOSTED_ROOT = { __backend: 'github', owner: OWNER, repo: REPO };

/** One request: an actor, inside a session, against the hosted handlers. */
function asUser(session, actor, fn) {
  return runWithSession(session, () => runWithActor(actor, () => fn(makeHandlers(HOSTED_ROOT))));
}

const json = async (promise) => JSON.parse((await promise).content[0].text);

beforeEach(() => __resetMemory());

describe('two identities on the hosted server', () => {
  it('keeps each person on their own workstream', async () => {
    const session = fakeSession();

    const alice = await asUser(session, ALICE, h => json(h.get_status()));
    const bob = await asUser(session, BOB, h => json(h.get_status()));
    expect(alice.activeWorkstream).toBe('main');
    expect(bob.activeWorkstream).toBe('main');

    // Alice switches.
    await asUser(session, ALICE, h => h.workstream_use({ id: 'engineering-hiring' }));

    const aliceAfter = await asUser(session, ALICE, h => json(h.get_status()));
    const bobAfter = await asUser(session, BOB, h => json(h.get_status()));

    expect(aliceAfter.activeWorkstream).toBe('engineering-hiring');
    // The whole point of the change.
    expect(bobAfter.activeWorkstream).toBe('main');
  });

  it('does not write the switch to the repo or make a commit', async () => {
    const session = fakeSession();
    await asUser(session, ALICE, h => h.workstream_use({ id: 'engineering-hiring' }));

    expect(session.configJson().activeWorkstream).toBe('main');
    expect(session.commits).toEqual([]);
  });

  it('identifies each caller by their own GitHub account, not config.me', async () => {
    const session = fakeSession();
    const alice = await asUser(session, ALICE, h => json(h.get_status()));
    const bob = await asUser(session, BOB, h => json(h.get_status()));

    expect(alice.me).toBe('Alice Example');
    expect(bob.me).toBe('Bob Example');
    expect(alice.meSource).toBe('github');
    expect(alice.projectDefaults.me).toBe('whoever-ran-init');
  });

  it('keeps display-name overrides separate', async () => {
    const session = fakeSession();
    await asUser(session, ALICE, h => h.config_set({ key: 'name', value: 'alice' }));

    const alice = await asUser(session, ALICE, h => json(h.get_status()));
    const bob = await asUser(session, BOB, h => json(h.get_status()));

    expect(alice.me).toBe('alice');
    expect(alice.meSource).toBe('override');
    // Bob never set one, so he still resolves from his own GitHub account.
    expect(bob.me).toBe('Bob Example');
    expect(bob.meSource).toBe('github');
    expect(session.configJson().me).toBe('whoever-ran-init');
  });

  it('interleaves concurrent requests without leaking identity between them', async () => {
    // Vercel reuses an instance across overlapping requests; AsyncLocalStorage
    // is what keeps them apart. Run both users' work at once and check neither
    // sees the other's actor.
    const session = fakeSession();
    await asUser(session, ALICE, h => h.workstream_use({ id: 'engineering-hiring' }));

    const [a, b, a2, b2] = await Promise.all([
      asUser(session, ALICE, h => json(h.get_status())),
      asUser(session, BOB, h => json(h.get_status())),
      asUser(session, ALICE, h => json(h.get_config())),
      asUser(session, BOB, h => json(h.get_config())),
    ]);

    expect([a.me, a.activeWorkstream]).toEqual(['Alice Example', 'engineering-hiring']);
    expect([b.me, b.activeWorkstream]).toEqual(['Bob Example', 'main']);
    expect([a2.me, a2.activeWorkstream]).toEqual(['Alice Example', 'engineering-hiring']);
    expect([b2.me, b2.activeWorkstream]).toEqual(['Bob Example', 'main']);
  });
});


describe('the manager gate cannot be talked around', () => {
  it('lets the pinned manager approve', async () => {
    const session = fakeSession();
    session.write('.teamctx/queue/q-1.json', JSON.stringify({
      id: 'q-1', status: 'pending', workstream: 'main', author: 'bob',
      operations: [{ type: 'addWhy', text: 't', summary: 's' }],
    }));
    const r = await asUser(session, ALICE, h => json(h.review_approve({ id: 'q-1' })));
    expect(r.approvedBy).toBe('Alice Example');
  });

  it('refuses someone who is not the manager', async () => {
    const session = fakeSession();
    await expect(asUser(session, BOB, h => h.review_approve({ id: 'q-1' })))
      .rejects.toThrow(/only the configured manager/);
  });

  it("refuses even when the caller claims the manager's name", async () => {
    // The old hole: `author` was taken at face value and used for the gate.
    const session = fakeSession();
    await expect(asUser(session, BOB, h => h.review_approve({ id: 'q-1', author: 'Alice Example' })))
      .rejects.toThrow(/only the configured manager/);
  });

  it('refuses even after the caller renames themselves to the manager', async () => {
    // The hole this PR would otherwise have opened: config_set name is
    // self-service, so a name-based gate would hand Bob the keys.
    const session = fakeSession();
    await asUser(session, BOB, h => h.config_set({ key: 'name', value: 'Alice Example' }));

    const bob = await asUser(session, BOB, h => json(h.get_status()));
    expect(bob.me).toBe('Alice Example');          // he really is called that now

    await expect(asUser(session, BOB, h => h.review_approve({ id: 'q-1' })))
      .rejects.toThrow(/only the configured manager/);   // and it buys him nothing
  });
});
