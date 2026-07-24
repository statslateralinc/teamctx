import { describe, it, expect } from 'vitest';
import { newSnapshotId, buildSnapshot, buildApproved, buildRejected, buildPointer, snapshotWorkstreams } from './snapshots.js';

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
  const wsMain = { id: 'main', name: 'demo', whys: [] };
  const wsTech = { id: 'tech', name: 'Tech', whys: [] };

  it('assigns id, createdAt, and status pending', () => {
    const s = buildSnapshot({ workstreams: [{ id: 'main', tree: wsMain }], author: 'alice', message: 'checkpoint' });
    expect(s.id).toMatch(/^snap-/);
    expect(s.createdBy).toBe('alice');
    expect(s.message).toBe('checkpoint');
    expect(s.status).toBe('pending');
    expect(s.workstreams).toEqual([{ id: 'main', tree: wsMain }]);
    expect(new Date(s.createdAt).toISOString()).toBe(s.createdAt);
    expect(s.approvedAt).toBeNull();
    expect(s.rejectedAt).toBeNull();
  });

  it('normalizes missing message to null', () => {
    const s = buildSnapshot({ workstreams: [{ id: 'main', tree: wsMain }], author: 'alice' });
    expect(s.message).toBeNull();
  });

  it('captures multiple workstreams in a single snapshot', () => {
    const s = buildSnapshot({
      workstreams: [{ id: 'main', tree: wsMain }, { id: 'tech', tree: wsTech }],
      author: 'alice',
    });
    expect(s.workstreams).toHaveLength(2);
    expect(s.workstreams.map(w => w.id)).toEqual(['main', 'tech']);
  });
});

describe('snapshotWorkstreams (legacy-read fallback)', () => {
  it('returns the workstreams array from a new-format snapshot', () => {
    const s = { workstreams: [{ id: 'a', tree: { whys: [] } }, { id: 'b', tree: { whys: [] } }] };
    expect(snapshotWorkstreams(s)).toEqual(s.workstreams);
  });

  it('interprets a legacy shared field as a single-workstream snapshot', () => {
    const legacy = { shared: { id: 'main', name: 'demo', whys: [] } };
    expect(snapshotWorkstreams(legacy)).toEqual([{ id: 'main', tree: legacy.shared }]);
  });

  it('falls back to id "main" when legacy shared has no id', () => {
    const legacy = { shared: { name: 'demo', whys: [] } };
    expect(snapshotWorkstreams(legacy)[0].id).toBe('main');
  });

  it('returns [] for an empty snapshot', () => {
    expect(snapshotWorkstreams({})).toEqual([]);
    expect(snapshotWorkstreams(null)).toEqual([]);
  });
});

describe('buildApproved', () => {
  it('sets status approved and fills approvedAt/approvedBy', () => {
    const s = buildSnapshot({ workstreams: [{ id: 'main', tree: { id: 'main', name: '', whys: [] } }], author: 'alice' });
    const a = buildApproved(s, 'manager');
    expect(a.status).toBe('approved');
    expect(a.approvedBy).toBe('manager');
    expect(a.approvedAt).toBeTruthy();
    expect(a.rejectedAt).toBeNull();
    expect(a.id).toBe(s.id);
  });
});

describe('buildRejected', () => {
  const s = buildSnapshot({ workstreams: [{ id: 'main', tree: { id: 'main', name: '', whys: [] } }], author: 'alice' });

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
    const s = buildSnapshot({ workstreams: [{ id: 'main', tree: { id: 'main', name: '', whys: [] } }], author: 'alice', message: 'freeze' });
    const a = buildApproved(s, 'manager');
    expect(buildPointer(a)).toEqual({
      id: a.id,
      approvedAt: a.approvedAt,
      approvedBy: 'manager',
      message: 'freeze',
    });
  });
});
