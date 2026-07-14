import { describe, it, expect } from 'vitest';
import { newSnapshotId, buildSnapshot, buildApproved, buildRejected, buildPointer } from './snapshots.js';

describe('newSnapshotId', () => {
  it('has the snap- prefix, a timestamp, and a 5-char suffix', () => {
    const id = newSnapshotId();
    expect(id).toMatch(/^snap-\d+-[a-z0-9]{5}$/);
  });

  it('produces distinct IDs across calls', () => {
    const ids = new Set(Array.from({ length: 50 }, newSnapshotId));
    expect(ids.size).toBe(50);
  });
});

describe('buildSnapshot', () => {
  const ws = { id: 'main', name: 'demo', whys: [] };

  it('assigns id, createdAt, and status pending', () => {
    const s = buildSnapshot({ workstream: ws, author: 'alice', message: 'checkpoint' });
    expect(s.id).toMatch(/^snap-/);
    expect(s.createdBy).toBe('alice');
    expect(s.message).toBe('checkpoint');
    expect(s.status).toBe('pending');
    expect(s.shared).toEqual(ws);
    expect(new Date(s.createdAt).toISOString()).toBe(s.createdAt);
    expect(s.approvedAt).toBeNull();
    expect(s.rejectedAt).toBeNull();
  });

  it('normalizes missing message to null', () => {
    const s = buildSnapshot({ workstream: ws, author: 'alice' });
    expect(s.message).toBeNull();
  });
});

describe('buildApproved', () => {
  it('sets status approved and fills approvedAt/approvedBy', () => {
    const s = buildSnapshot({ workstream: { id: 'main', name: '', whys: [] }, author: 'alice' });
    const a = buildApproved(s, 'manager');
    expect(a.status).toBe('approved');
    expect(a.approvedBy).toBe('manager');
    expect(a.approvedAt).toBeTruthy();
    expect(a.rejectedAt).toBeNull();
    expect(a.id).toBe(s.id);
  });
});

describe('buildRejected', () => {
  const s = buildSnapshot({ workstream: { id: 'main', name: '', whys: [] }, author: 'alice' });

  it('sets status rejected and fills rejectedAt/rejectedBy/reason', () => {
    const r = buildRejected(s, 'manager', 'off-scope');
    expect(r.status).toBe('rejected');
    expect(r.rejectedBy).toBe('manager');
    expect(r.reason).toBe('off-scope');
    expect(r.rejectedAt).toBeTruthy();
  });

  it('normalizes empty reason to null', () => {
    expect(buildRejected(s, 'manager', undefined).reason).toBeNull();
    expect(buildRejected(s, 'manager', '').reason).toBeNull();
  });
});

describe('buildPointer', () => {
  it('extracts id, approvedAt, approvedBy, message from an approved snapshot', () => {
    const s = buildSnapshot({ workstream: { id: 'main', name: '', whys: [] }, author: 'alice', message: 'freeze' });
    const a = buildApproved(s, 'manager');
    expect(buildPointer(a)).toEqual({
      id: a.id,
      approvedAt: a.approvedAt,
      approvedBy: 'manager',
      message: 'freeze',
    });
  });
});
