import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/storage.js', () => ({
  readConfig: vi.fn(),
  readWorkstream: vi.fn(() => ({ id: 'main', name: 'M', whys: [] })),
  writeWorkstream: vi.fn(),
  writeWorkstreamMd: vi.fn(),
  appendContribution: vi.fn(),
  writeRoleFile: vi.fn(),
  writeQueueItem: vi.fn(),
  readContributions: vi.fn(() => []),
  listWorkstreamIds: vi.fn(() => ['main']),
}));

vi.mock('../../src/context.js', () => ({
  updateShared: vi.fn(async () => ({
    workstream: { id: 'main', name: 'M', whys: [{ id: 'w1', text: 'x' }] },
    summary: 's',
    operations: [{ type: 'addWhy', text: 'x' }],
  })),
  generateRoleFile: vi.fn(() => Promise.resolve('# role md')),
  serializeToMd: vi.fn(() => '# md'),
}));

vi.mock('../../src/git.js', () => ({
  commitContext: vi.fn(),
  pushContext: vi.fn(),
}));

vi.mock('../../src/actor.js', () => ({
  resolveActor: vi.fn(async () => ({ key: 'github:42', name: 'Satya', login: 'satya', source: 'github' })),
}));

vi.mock('../../src/prefs.js', () => ({
  readPrefs: vi.fn(async () => ({})),
  writePrefs: vi.fn(),
  resolveActiveWorkstream: vi.fn(async ({ config }) => config?.activeWorkstream || 'main'),
  resolveDisplayName: vi.fn(async ({ actor, config }) => actor?.name || config?.me || 'unknown'),
}));

import { contributeCore } from './contribute.core.js';
import { ManagerGateError } from './review.core.js';
import { readConfig, writeWorkstream, writeQueueItem, appendContribution } from '../../src/storage.js';
import { commitContext } from '../../src/git.js';
import { resolveActor } from '../../src/actor.js';

beforeEach(() => vi.clearAllMocks());

describe('contributeCore — manager gate on apply', () => {
  it('refuses apply=true when caller is not the configured manager', async () => {
    readConfig.mockReturnValue({ project: 'p', me: 'satya', manager: 'priya', autoPush: false, roles: [] });
    await expect(contributeCore({
      text: 'note', author: 'satya', apply: true,
    })).rejects.toBeInstanceOf(ManagerGateError);
    expect(writeWorkstream).not.toHaveBeenCalled();
    expect(commitContext).not.toHaveBeenCalled();
  });

  it('allows apply=true when the resolved caller is the manager', async () => {
    // The gate reads who the caller actually resolves to (Satya, per the actor
    // mock) — not the `author` they hand us, which is attribution only.
    readConfig.mockReturnValue({ project: 'p', me: 'someone', manager: 'Satya', autoPush: false, roles: [] });
    const result = await contributeCore({ text: 'note', apply: true });
    expect(result.mode).toBe('applied');
    expect(writeWorkstream).toHaveBeenCalled();
    expect(commitContext).toHaveBeenCalled();
  });

  it('allows apply=true when no manager is configured (solo mode)', async () => {
    readConfig.mockReturnValue({ project: 'p', me: 'satya', autoPush: false, roles: [] });
    const result = await contributeCore({
      text: 'note', author: 'satya', apply: true,
    });
    expect(result.mode).toBe('applied');
    expect(writeWorkstream).toHaveBeenCalled();
  });

  it('does NOT gate the queued path — anyone can enqueue for approval', async () => {
    readConfig.mockReturnValue({ project: 'p', me: 'satya', manager: 'priya', autoPush: false, roles: [] });
    const result = await contributeCore({
      text: 'note', author: 'satya', apply: false,
    });
    expect(result.mode).toBe('queued');
    expect(writeQueueItem).toHaveBeenCalled();
    expect(writeWorkstream).not.toHaveBeenCalled();
  });
});


describe('contributeCore — attribution', () => {
  it('attributes to the calling actor, not the shared config.me', async () => {
    readConfig.mockReturnValue({ project: 'p', me: 'alice', autoPush: false, roles: [] });
    const r = await contributeCore({ text: 'note' });
    expect(r.author).toBe('Satya');
    expect(appendContribution).toHaveBeenCalledWith(
      expect.objectContaining({ author: 'Satya', authorKey: 'github:42' }),
      undefined,
    );
  });

  it('still honours an explicit author, and records no key for it', async () => {
    // Scripts and imports pass an author deliberately; that is not a claim
    // about who is calling, so it must not be recorded as an identity.
    readConfig.mockReturnValue({ project: 'p', me: 'alice', autoPush: false, roles: [] });
    const r = await contributeCore({ text: 'note', author: 'importer' });
    expect(r.author).toBe('importer');
    expect(appendContribution).toHaveBeenCalledWith(
      expect.not.objectContaining({ authorKey: expect.anything() }),
      undefined,
    );
  });

  it('falls back to config.me when nothing can identify the caller', async () => {
    resolveActor.mockResolvedValueOnce({ key: 'name:alice', name: 'alice', login: null, source: 'config' });
    readConfig.mockReturnValue({ project: 'p', me: 'alice', autoPush: false, roles: [] });
    const r = await contributeCore({ text: 'note' });
    expect(r.author).toBe('alice');
  });
});


describe('contributeCore — the apply gate ignores the claimed author', () => {
  it('refuses apply=true on a legacy name gate even when author matches the manager', async () => {
    // The resolved caller is Satya (see the actor mock). Claiming to be the
    // manager must not grant the right to write straight to shared context.
    readConfig.mockReturnValue({ project: 'p', me: 'someone', manager: 'priya', autoPush: false, roles: [] });
    await expect(contributeCore({ text: 'note', author: 'priya', apply: true }))
      .rejects.toBeInstanceOf(ManagerGateError);
    expect(writeWorkstream).not.toHaveBeenCalled();
  });

  it('refuses apply=true on an identity gate the caller is not in', async () => {
    readConfig.mockReturnValue({ project: 'p', me: 'someone', managerKey: 'github:9999', autoPush: false, roles: [] });
    await expect(contributeCore({ text: 'note', apply: true }))
      .rejects.toBeInstanceOf(ManagerGateError);
  });

  it('allows apply=true when the resolved caller is a manager', async () => {
    readConfig.mockReturnValue({ project: 'p', me: 'someone', managerKey: 'github:42', autoPush: false, roles: [] });
    const r = await contributeCore({ text: 'note', apply: true });
    expect(r.mode).toBe('applied');
  });
});
