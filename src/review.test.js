import { describe, it, expect } from 'vitest';
import { applyQueueItem, buildRejected, canApprove, matchesActor, isLegacyManagerRef } from './review.js';

const emptyWorkstream = () => ({ id: 'main', name: 'Demo', whys: [] });

describe('applyQueueItem', () => {
  it('applies addWhy op and returns updated workstream', () => {
    const ws = emptyWorkstream();
    const item = {
      id: 'c-1',
      operations: [{ type: 'addWhy', text: 'Ship faster', summary: '...' }],
    };
    const next = applyQueueItem(ws, item);
    expect(next.whys).toHaveLength(1);
    expect(next.whys[0].text).toBe('Ship faster');
    expect(next.whys[0].sourceContributionIds).toEqual(['c-1']);
  });

  it('returns unchanged workstream when operations is empty', () => {
    const ws = emptyWorkstream();
    const next = applyQueueItem(ws, { id: 'c-1', operations: [] });
    expect(next).toEqual(ws);
  });

  it('returns unchanged workstream when operations is missing', () => {
    const ws = emptyWorkstream();
    const next = applyQueueItem(ws, { id: 'c-1' });
    expect(next).toEqual(ws);
  });

  it('silently skips ops referencing non-existent parents (stale queue)', () => {
    const ws = emptyWorkstream();
    const item = {
      id: 'c-1',
      operations: [{ type: 'addWhat', parentWhyId: 'ghost', text: 'orphan', summary: '...' }],
    };
    expect(() => applyQueueItem(ws, item)).not.toThrow();
    expect(applyQueueItem(ws, item)).toEqual(ws);
  });
});

describe('buildRejected', () => {
  it('sets status=rejected, rejectedBy, rejectedAt, and optional reason', () => {
    const item = { id: 'c-1', status: 'pending', author: 'alice', operations: [] };
    const r = buildRejected(item, 'manager-bob', 'off-topic');
    expect(r.status).toBe('rejected');
    expect(r.rejectedBy).toBe('manager-bob');
    expect(r.reason).toBe('off-topic');
    expect(r.rejectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.id).toBe('c-1');
    expect(r.author).toBe('alice');
  });

  it('sets reason=null when not provided', () => {
    const item = { id: 'c-1', status: 'pending' };
    const r = buildRejected(item, 'manager-bob');
    expect(r.reason).toBeNull();
  });
});

const ALICE = { key: 'github:1001', name: 'Alice', login: 'alice' };
const BOB = { key: 'github:2002', name: 'Bob', login: 'bob' };

describe('matchesActor', () => {
  it('matches on the stable actor key', () => {
    expect(matchesActor('github:1001', ALICE)).toBe(true);
    expect(matchesActor('github:2002', ALICE)).toBe(false);
    expect(matchesActor('GitHub:1001', ALICE)).toBe(true);
  });

  it('matches on a GitHub login', () => {
    expect(matchesActor('@alice', ALICE)).toBe(true);
    expect(matchesActor('@Alice', ALICE)).toBe(true);
    expect(matchesActor('@bob', ALICE)).toBe(false);
  });

  it('never matches a bare display name', () => {
    // The point of the whole change: display names are settable by their owner,
    // so they must not be a credential.
    expect(matchesActor('Alice', ALICE)).toBe(false);
  });

  it('handles missing inputs', () => {
    expect(matchesActor('', ALICE)).toBe(false);
    expect(matchesActor('github:1001', null)).toBe(false);
    expect(matchesActor('@alice', { key: 'git:a@b.com' })).toBe(false);
  });
});

describe('canApprove', () => {
  it('returns true when no gate is configured', () => {
    expect(canApprove({}, { actor: ALICE })).toBe(true);
    expect(canApprove({ manager: '' }, { actor: ALICE })).toBe(true);
  });

  it('matches the pinned identity', () => {
    const config = { managerKey: 'github:1001' };
    expect(canApprove(config, { actor: ALICE })).toBe(true);
    expect(canApprove(config, { actor: BOB })).toBe(false);
  });

  it('refuses a display name that impersonates the manager', () => {
    // Bob sets his own name to "Alice" — this must not pass.
    const config = { managerKey: 'github:1001' };
    expect(canApprove(config, { actor: BOB, displayName: 'Alice' })).toBe(false);
  });

  it('refuses when the caller cannot be identified at all', () => {
    expect(canApprove({ managerKey: 'github:1001' }, { displayName: 'Alice' })).toBe(false);
    expect(canApprove({ managerKey: 'github:1001' }, {})).toBe(false);
  });

  it('still honours a legacy display-name gate', () => {
    // Existing projects store a name; they keep working rather than locking out.
    const config = { manager: 'alice' };
    expect(canApprove(config, { actor: ALICE, displayName: 'alice' })).toBe(true);
    expect(canApprove(config, { actor: BOB, displayName: 'bob' })).toBe(false);
  });

  it('prefers the pinned identity over a stale legacy name', () => {
    const config = { managerKey: 'github:1001', manager: 'bob' };
    expect(canApprove(config, { actor: ALICE, displayName: 'alice' })).toBe(true);
    expect(canApprove(config, { actor: BOB, displayName: 'bob' })).toBe(false);
  });
});

describe('isLegacyManagerRef', () => {
  it('flags a name-only gate so callers can warn', () => {
    expect(isLegacyManagerRef({ manager: 'alice' })).toBe(true);
    expect(isLegacyManagerRef({ managerKey: 'github:1', manager: 'alice' })).toBe(false);
    expect(isLegacyManagerRef({})).toBe(false);
  });
});
