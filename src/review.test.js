import { describe, it, expect } from 'vitest';
import { applyQueueItem, buildRejected, canApprove } from './review.js';

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

describe('canApprove', () => {
  it('returns true when manager is unset (solo mode)', () => {
    expect(canApprove({ me: 'alice' })).toBe(true);
    expect(canApprove({ me: 'alice', manager: '' })).toBe(true);
  });

  it('returns true when me matches manager', () => {
    expect(canApprove({ me: 'alice', manager: 'alice' })).toBe(true);
  });

  it('returns false when me differs from manager', () => {
    expect(canApprove({ me: 'bob', manager: 'alice' })).toBe(false);
  });
});
