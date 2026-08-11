import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const getCurrentSession = vi.fn(() => null);
vi.mock('./session-context.js', () => ({
  getCurrentSession: (...a) => getCurrentSession(...a),
  runWithSession: (s, fn) => fn(),
}));

const kvStore = new Map();
vi.mock('./oauth/kv.js', () => ({
  kvGet: vi.fn(async (k) => (kvStore.has(k) ? kvStore.get(k) : null)),
  kvSet: vi.fn(async (k, v) => { kvStore.set(k, v); }),
  keys: { prefs: (actorKey, owner, repo) => `teamctx:prefs:${actorKey}:${owner}/${repo}` },
}));

import { readPrefs, writePrefs, resolveActiveWorkstream, resolveDisplayName, resolveIdentity, ensureGitignored } from './prefs.js';

const ALICE = { key: 'git:alice@example.com', name: 'Alice' };
const BOB = { key: 'github:99', name: 'Bob' };

let projectDir;
let teamctxDir;

beforeEach(() => {
  vi.clearAllMocks();
  kvStore.clear();
  getCurrentSession.mockReturnValue(null);
  projectDir = mkdtempSync(join(tmpdir(), 'teamctx-prefs-'));
  teamctxDir = join(projectDir, '.teamctx');
  mkdirSync(teamctxDir, { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

const gitignore = () => {
  const p = join(projectDir, '.gitignore');
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
};

describe('local prefs', () => {
  it('returns {} when nothing has ever been written', async () => {
    expect(await readPrefs(ALICE, teamctxDir)).toEqual({});
  });

  it('round-trips and merges rather than replacing', async () => {
    await writePrefs(ALICE, { activeWorkstream: 'tech' }, teamctxDir);
    await writePrefs(ALICE, { name: 'Ali' }, teamctxDir);
    expect(await readPrefs(ALICE, teamctxDir)).toEqual({ activeWorkstream: 'tech', name: 'Ali' });
  });

  it('keys by actor, so two people on one machine do not collide', async () => {
    await writePrefs(ALICE, { activeWorkstream: 'tech' }, teamctxDir);
    await writePrefs(BOB, { activeWorkstream: 'design' }, teamctxDir);
    expect(await readPrefs(ALICE, teamctxDir)).toEqual({ activeWorkstream: 'tech' });
    expect(await readPrefs(BOB, teamctxDir)).toEqual({ activeWorkstream: 'design' });
  });

  it('survives a corrupt prefs file instead of throwing', async () => {
    mkdirSync(join(teamctxDir, '.local'), { recursive: true });
    writeFileSync(join(teamctxDir, '.local', 'prefs.json'), '{ not json');
    expect(await readPrefs(ALICE, teamctxDir)).toEqual({});
  });

  it('refuses to write without an actor', async () => {
    await expect(writePrefs(null, { name: 'x' }, teamctxDir)).rejects.toThrow(/without an actor/);
  });
});

describe('gitignore', () => {
  it('is written when prefs are first saved, not at init', async () => {
    // Someone who clones an initialized project never runs init, so the entry
    // has to appear the moment their own prefs file does.
    expect(gitignore()).toBeNull();
    await writePrefs(ALICE, { activeWorkstream: 'tech' }, teamctxDir);
    expect(gitignore()).toContain('.teamctx/.local/');
  });

  it('appends to an existing .gitignore without clobbering it', async () => {
    writeFileSync(join(projectDir, '.gitignore'), 'node_modules\n.env.local\n');
    await writePrefs(ALICE, { name: 'Ali' }, teamctxDir);
    const out = gitignore();
    expect(out).toContain('node_modules');
    expect(out).toContain('.env.local');
    expect(out).toContain('.teamctx/.local/');
  });

  it('adds a missing trailing newline before appending', async () => {
    writeFileSync(join(projectDir, '.gitignore'), 'node_modules');
    await writePrefs(ALICE, { name: 'Ali' }, teamctxDir);
    expect(gitignore()).toBe('node_modules\n.teamctx/.local/\n');
  });

  it('does not duplicate the entry on repeated writes', async () => {
    await writePrefs(ALICE, { name: 'a' }, teamctxDir);
    await writePrefs(ALICE, { name: 'b' }, teamctxDir);
    await writePrefs(BOB, { name: 'c' }, teamctxDir);
    expect(gitignore().match(/\.teamctx\/\.local\//g)).toHaveLength(1);
  });

  it('recognises equivalent existing entries', () => {
    writeFileSync(join(projectDir, '.gitignore'), '.teamctx/.local\n');
    expect(ensureGitignored(teamctxDir)).toBe(false);
  });
});

describe('hosted prefs', () => {
  beforeEach(() => getCurrentSession.mockReturnValue({ owner: 'acme', repo: 'monorepo' }));

  it('reads and writes KV scoped to actor and project', async () => {
    await writePrefs(BOB, { activeWorkstream: 'tech' }, teamctxDir);
    expect([...kvStore.keys()]).toEqual(['teamctx:prefs:github:99:acme/monorepo']);
    expect(await readPrefs(BOB, teamctxDir)).toEqual({ activeWorkstream: 'tech' });
  });

  it('never touches the local file in hosted mode', async () => {
    await writePrefs(BOB, { activeWorkstream: 'tech' }, teamctxDir);
    expect(existsSync(join(teamctxDir, '.local', 'prefs.json'))).toBe(false);
  });

  it('degrades to empty prefs rather than failing the request when KV errors', async () => {
    const { kvGet } = await import('./oauth/kv.js');
    kvGet.mockRejectedValueOnce(new Error('upstash unreachable'));
    expect(await readPrefs(BOB, teamctxDir)).toEqual({});
  });
});

describe('resolution layering', () => {
  it('prefers the user preference over the project default', async () => {
    await writePrefs(ALICE, { activeWorkstream: 'tech' }, teamctxDir);
    const got = await resolveActiveWorkstream({
      actor: ALICE, config: { activeWorkstream: 'main' }, teamctxDir,
    });
    expect(got).toBe('tech');
  });

  it('falls back to the project default — unchanged behavior for existing repos', async () => {
    const got = await resolveActiveWorkstream({
      actor: ALICE, config: { activeWorkstream: 'design' }, teamctxDir,
    });
    expect(got).toBe('design');
  });

  it('bottoms out at main', async () => {
    expect(await resolveActiveWorkstream({ actor: ALICE, config: {}, teamctxDir })).toBe('main');
  });

  it('one person switching does not move anyone else', async () => {
    await writePrefs(ALICE, { activeWorkstream: 'tech' }, teamctxDir);
    const bobSees = await resolveActiveWorkstream({
      actor: BOB, config: { activeWorkstream: 'main' }, teamctxDir,
    });
    expect(bobSees).toBe('main');
  });
});

describe('display name', () => {
  it('lets the user override the derived name', async () => {
    await writePrefs(ALICE, { name: 'satya' }, teamctxDir);
    expect(await resolveDisplayName({ actor: ALICE, config: { me: 'config-me' }, teamctxDir })).toBe('satya');
  });

  it('uses the derived actor name when no override is set', async () => {
    expect(await resolveDisplayName({ actor: ALICE, config: { me: 'config-me' }, teamctxDir })).toBe('Alice');
  });

  it('falls back to config.me, then to unknown', async () => {
    expect(await resolveDisplayName({ actor: null, config: { me: 'config-me' }, teamctxDir })).toBe('config-me');
    expect(await resolveDisplayName({ actor: null, config: {}, teamctxDir })).toBe('unknown');
  });
});


describe('name provenance and clearing', () => {
  const GH = { key: 'github:42', name: 'Satyagya Singh', source: 'github' };

  it('reports where the name came from, not where the actor did', async () => {
    // Authenticated via GitHub but using their own handle: the name is an
    // override, and saying "github" would misreport its provenance.
    expect(await resolveIdentity({ actor: GH, config: {}, teamctxDir }))
      .toEqual({ name: 'Satyagya Singh', source: 'github' });

    await writePrefs(GH, { name: 'satya' }, teamctxDir);
    expect(await resolveIdentity({ actor: GH, config: {}, teamctxDir }))
      .toEqual({ name: 'satya', source: 'override' });
  });

  it('falls back through config and then to unknown', async () => {
    expect(await resolveIdentity({ actor: null, config: { me: 'alice' }, teamctxDir }))
      .toEqual({ name: 'alice', source: 'config' });
    expect(await resolveIdentity({ actor: null, config: {}, teamctxDir }))
      .toEqual({ name: 'unknown', source: 'fallback' });
  });

  it('clears the override so the name is derived again', async () => {
    await writePrefs(GH, { name: 'satya' }, teamctxDir);
    await writePrefs(GH, { name: null }, teamctxDir);
    // Not stored as an empty string — the key is gone, so the derived value
    // wins again and keeps following the identity if it changes.
    expect(await readPrefs(GH, teamctxDir)).toEqual({});
    expect(await resolveIdentity({ actor: GH, config: {}, teamctxDir }))
      .toEqual({ name: 'Satyagya Singh', source: 'github' });
  });

  it('clearing one preference leaves the others intact', async () => {
    await writePrefs(GH, { name: 'satya', activeWorkstream: 'tech' }, teamctxDir);
    await writePrefs(GH, { name: null }, teamctxDir);
    expect(await readPrefs(GH, teamctxDir)).toEqual({ activeWorkstream: 'tech' });
  });

  it('resolveDisplayName still returns just the name', async () => {
    await writePrefs(GH, { name: 'satya' }, teamctxDir);
    expect(await resolveDisplayName({ actor: GH, config: {}, teamctxDir })).toBe('satya');
  });
});
