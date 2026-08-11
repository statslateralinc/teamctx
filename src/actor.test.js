import { describe, it, expect, vi, beforeEach } from 'vitest';

const getCurrentSession = vi.fn(() => null);
vi.mock('./session-context.js', () => ({
  getCurrentSession: (...a) => getCurrentSession(...a),
  runWithSession: (s, fn) => fn(),
}));

const execFileMock = vi.fn();
vi.mock('child_process', () => ({ execFile: (...args) => execFileMock(...args) }));

import {
  runWithActor, resolveActor, actorFromGithubUser, actorFromConfig, actorFromGit, peekActor,
} from './actor.js';

/** promisify(execFile) calls the callback with (err, { stdout, stderr }). */
function gitAnswers(map) {
  execFileMock.mockImplementation((_cmd, args, optsOrCb, maybeCb) => {
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
    const key = args[args.length - 1];
    if (map[key] === undefined) return cb(new Error('not set'));
    cb(null, { stdout: `${map[key]}\n`, stderr: '' });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentSession.mockReturnValue(null);
  gitAnswers({});
});

describe('actorFromGithubUser', () => {
  it('uses the display name when GitHub has one', () => {
    expect(actorFromGithubUser({ id: '42', login: 'satyagyasingh', name: 'Satyagya Singh' }))
      .toEqual({ key: 'github:42', name: 'Satyagya Singh', login: 'satyagyasingh', source: 'github' });
  });

  it('falls back to the login when the display name is null', () => {
    // GitHub's display name is optional; plenty of accounts never set one.
    expect(actorFromGithubUser({ id: '42', login: 'satyagyasingh', name: null }))
      .toMatchObject({ key: 'github:42', name: 'satyagyasingh' });
  });

  it('returns null when there is no user', () => {
    expect(actorFromGithubUser(null)).toBeNull();
    expect(actorFromGithubUser({})).toBeNull();
  });
});

describe('actorFromConfig', () => {
  it('uses config.me', () => {
    expect(actorFromConfig({ me: 'alice' })).toMatchObject({ key: 'name:alice', name: 'alice', source: 'config' });
  });

  it('never yields an empty name', () => {
    expect(actorFromConfig({}).name).toBe('unknown');
    expect(actorFromConfig({ me: '   ' }).name).toBe('unknown');
  });
});

describe('actorFromGit', () => {
  it('keys on the email, which is the stable half of a git identity', async () => {
    gitAnswers({ 'user.name': 'Satyagya Singh', 'user.email': 'Satya@Example.COM' });
    expect(await actorFromGit({})).toMatchObject({
      key: 'git:satya@example.com', name: 'Satyagya Singh', source: 'git',
    });
  });

  it('falls back to the email local-part when only the email is set', async () => {
    gitAnswers({ 'user.email': 'satya@example.com' });
    expect(await actorFromGit({})).toMatchObject({ name: 'satya' });
  });

  it('returns null when git has no identity configured', async () => {
    expect(await actorFromGit({})).toBeNull();
  });

  it('never shells out to git in hosted mode — there is no git binary there', async () => {
    getCurrentSession.mockReturnValue({ owner: 'o', repo: 'r' });
    expect(await actorFromGit({})).toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('resolveActor', () => {
  it('prefers the seeded actor over git and config', async () => {
    gitAnswers({ 'user.name': 'Git Name', 'user.email': 'git@example.com' });
    const seeded = actorFromGithubUser({ id: '7', login: 'bob', name: 'Bob' });
    const got = await runWithActor(seeded, () => resolveActor({ config: { me: 'alice' } }));
    expect(got).toMatchObject({ key: 'github:7', name: 'Bob' });
  });

  it('accepts a lazy seed and resolves it at most once', async () => {
    const seed = vi.fn(async () => actorFromGithubUser({ id: '7', login: 'bob', name: 'Bob' }));
    await runWithActor(seed, async () => {
      await resolveActor({ config: {} });
      await resolveActor({ config: {} });
      await resolveActor({ config: {} });
    });
    // The header-token path costs a GitHub round trip — it must not repeat.
    expect(seed).toHaveBeenCalledTimes(1);
  });

  it('memoizes within a scope', async () => {
    gitAnswers({ 'user.name': 'Git Name', 'user.email': 'git@example.com' });
    await runWithActor(null, async () => {
      const a = await resolveActor({ config: {} });
      const b = await resolveActor({ config: {} });
      expect(a).toBe(b);
      expect(peekActor()).toBe(a);
    });
  });

  it('falls back to git when nothing is seeded', async () => {
    gitAnswers({ 'user.name': 'Git Name', 'user.email': 'git@example.com' });
    expect(await resolveActor({ config: { me: 'alice' } })).toMatchObject({ name: 'Git Name', source: 'git' });
  });

  it('falls back to config.me when git has no identity', async () => {
    expect(await resolveActor({ config: { me: 'alice' } })).toMatchObject({ name: 'alice', source: 'config' });
  });

  it('always returns an actor, so callers never handle an empty author', async () => {
    expect((await resolveActor({})).name).toBe('unknown');
  });

  it('falls through to config when the lazy seed cannot resolve anyone', async () => {
    // e.g. the header-token GET /user call failed.
    const got = await runWithActor(async () => null, () => resolveActor({ config: { me: 'alice' } }));
    expect(got).toMatchObject({ name: 'alice', source: 'config' });
  });
});
