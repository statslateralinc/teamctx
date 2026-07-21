import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';
import {
  readConfig, writeConfig,
  readShared, writeShared,
  appendContribution, readContributions,
  writeRoleFile, readRoleFile,
  writeSharedMd, readSharedMd,
  writeQueueItem, readQueueItem, listQueue, deleteQueueItem,
  writeRejected,
  writeSnapshot, readSnapshot, listSnapshots, resolveSnapshotId,
  readCurrentSnapshotPointer, writeCurrentSnapshotPointer,
  readWorkstream, writeWorkstream, listWorkstreamIds,
  readWorkstreamMd, writeWorkstreamMd,
} from './storage.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'teamctx-test-'));
  mkdirSync(join(dir, 'context', 'roles'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('config', () => {
  it('writes and reads config round-trip', () => {
    const cfg = { project: 'Demo', model: 'claude-sonnet-4-6', autoPush: false, me: 'alice', roles: [] };
    writeConfig(cfg, dir);
    expect(readConfig(dir)).toEqual(cfg);
  });
});

describe('workstream', () => {
  it('returns empty workstream when shared.json does not exist', () => {
    expect(readShared(dir)).toEqual({ id: 'main', name: '', whys: [] });
  });

  it('writes and reads workstream round-trip', () => {
    const ws = { id: 'main', name: 'Q3 Launch', whys: [] };
    writeShared(ws, dir);
    expect(readShared(dir)).toEqual(ws);
  });
});

describe('contributions', () => {
  it('returns empty array when contributions.jsonl does not exist', () => {
    expect(readContributions(dir)).toEqual([]);
  });

  it('appends and reads multiple contributions', () => {
    const c1 = { id: 'c1', ts: '2026-01-01', author: 'alice', text: 'first', status: 'merged' };
    const c2 = { id: 'c2', ts: '2026-01-02', author: 'bob', text: 'second', status: 'merged' };
    appendContribution(c1, dir);
    appendContribution(c2, dir);
    expect(readContributions(dir)).toEqual([c1, c2]);
  });
});

describe('role files', () => {
  it('writes and reads a role MD file', () => {
    writeRoleFile('cpo', '# CPO Context\n\nHello', dir);
    expect(readRoleFile('cpo', dir)).toBe('# CPO Context\n\nHello');
  });

  it('throws on invalid slug with path traversal characters', () => {
    expect(() => writeRoleFile('../../config', '# bad', dir)).toThrow(/invalid role slug/i);
    expect(() => readRoleFile('../../config', dir)).toThrow(/invalid role slug/i);
  });
});

describe('workstream files', () => {
  it('returns an empty workstream when the file does not exist', () => {
    expect(readWorkstream('main', dir)).toEqual({ id: 'main', name: '', whys: [] });
  });

  it('writes and reads a workstream round-trip under workstreams/<id>.json', () => {
    const ws = { id: 'product', name: 'Product', whys: [{ id: 'w1', text: 'launch', whats: [] }] };
    writeWorkstream('product', ws, dir);
    expect(readWorkstream('product', dir)).toEqual(ws);
  });

  it('lists workstream ids sorted', () => {
    writeWorkstream('main', { id: 'main', name: 'M', whys: [] }, dir);
    writeWorkstream('product', { id: 'product', name: 'P', whys: [] }, dir);
    writeWorkstream('tech', { id: 'tech', name: 'T', whys: [] }, dir);
    expect(listWorkstreamIds(dir)).toEqual(['main', 'product', 'tech']);
  });

  it('returns [] when workstreams/ does not exist', () => {
    expect(listWorkstreamIds(dir)).toEqual([]);
  });

  it('rejects ids with path traversal or invalid characters', () => {
    expect(() => writeWorkstream('../evil', { id: 'x', name: '', whys: [] }, dir)).toThrow(/invalid workstream id/i);
    expect(() => readWorkstream('../evil', dir)).toThrow(/invalid workstream id/i);
    expect(() => writeWorkstreamMd('a b', 'x', dir)).toThrow(/invalid workstream id/i);
  });

  it('writes and reads a workstream markdown under context/workstreams/<id>.md', () => {
    writeWorkstreamMd('product', '# Product\n', dir);
    expect(readWorkstreamMd('product', dir)).toBe('# Product\n');
  });

  it('returns empty string when workstream md does not exist', () => {
    expect(readWorkstreamMd('main', dir)).toBe('');
  });
});

describe('shared.md', () => {
  it('writes shared.md into context/', async () => {
    writeSharedMd('# Project\n\n*No context.*', dir);
    const { readFileSync } = await import('fs');
    const content = readFileSync(join(dir, 'context', 'shared.md'), 'utf-8');
    expect(content).toBe('# Project\n\n*No context.*');
  });

  it('reads shared.md written previously', () => {
    writeSharedMd('# Project\n\nHello', dir);
    expect(readSharedMd(dir)).toBe('# Project\n\nHello');
  });

  it('returns empty string when shared.md does not exist', () => {
    expect(readSharedMd(dir)).toBe('');
  });
});

describe('review queue', () => {
  const mk = (id, createdAt, extras = {}) => ({
    id, status: 'pending', createdAt, author: 'alice', source: 'cli',
    text: 'raw', tagged: null, summary: 's', operations: [], ...extras,
  });

  it('writes and reads a queue item round-trip', () => {
    const q = mk('q-1', '2026-07-13T14:00:00.000Z');
    writeQueueItem(q, dir);
    expect(readQueueItem('q-1', dir)).toEqual(q);
  });

  it('preserves the workstream field on a queue item round-trip', () => {
    const q = mk('q-ws', '2026-07-13T14:00:00.000Z', { workstream: 'growth' });
    writeQueueItem(q, dir);
    expect(readQueueItem('q-ws', dir).workstream).toBe('growth');
  });

  it('listQueue returns [] when queue/ does not exist', () => {
    expect(listQueue(dir)).toEqual([]);
  });

  it('listQueue returns items sorted by createdAt ascending', () => {
    writeQueueItem(mk('q-a', '2026-07-13T15:00:00.000Z'), dir);
    writeQueueItem(mk('q-b', '2026-07-13T14:00:00.000Z'), dir);
    writeQueueItem(mk('q-c', '2026-07-13T16:00:00.000Z'), dir);
    expect(listQueue(dir).map(p => p.id)).toEqual(['q-b', 'q-a', 'q-c']);
  });

  it('deleteQueueItem removes the file', () => {
    writeQueueItem(mk('q-x', '2026-07-13T14:00:00.000Z'), dir);
    deleteQueueItem('q-x', dir);
    expect(() => readQueueItem('q-x', dir)).toThrow();
    expect(listQueue(dir)).toEqual([]);
  });

  it('writeRejected persists item to rejected/', () => {
    const item = { ...mk('q-r', '2026-07-13T14:00:00.000Z'), status: 'rejected', reason: 'off-topic' };
    writeRejected(item, dir);
    const p = join(dir, 'rejected', 'q-r.json');
    expect(existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(p, 'utf-8'))).toEqual(item);
  });

  it('rejects queue ids with path-traversal characters', () => {
    expect(() => readQueueItem('../important-secret', dir)).toThrow(/invalid queue id/i);
    expect(() => deleteQueueItem('../important-secret', dir)).toThrow(/invalid queue id/i);
    expect(() => writeQueueItem(mk('../evil', '2026-07-13T14:00:00.000Z'), dir)).toThrow(/invalid queue id/i);
  });

  it('rejects queue ids with slashes, dots, or empty string', () => {
    expect(() => readQueueItem('foo/bar', dir)).toThrow(/invalid queue id/i);
    expect(() => readQueueItem('.', dir)).toThrow(/invalid queue id/i);
    expect(() => readQueueItem('', dir)).toThrow(/invalid queue id/i);
  });
});

describe('snapshots', () => {
  const mk = (id, createdAt, extras = {}) => ({
    id, createdAt, createdBy: 'alice', message: 'm', status: 'pending',
    shared: { id: 'main', name: '', whys: [] },
    approvedAt: null, approvedBy: null, rejectedAt: null, rejectedBy: null, reason: null,
    ...extras,
  });

  it('writes and reads a snapshot round-trip', () => {
    const s = mk('snap-1720000000000-aaaaa', '2026-07-13T14:00:00.000Z');
    writeSnapshot(s, dir);
    expect(readSnapshot('snap-1720000000000-aaaaa', dir)).toEqual(s);
  });

  it('listSnapshots returns [] when snapshots/ does not exist', () => {
    expect(listSnapshots(dir)).toEqual([]);
  });

  it('listSnapshots returns items sorted by createdAt asc, excludes current.json', () => {
    writeSnapshot(mk('snap-1720000000001-bbbbb', '2026-07-13T15:00:00.000Z'), dir);
    writeSnapshot(mk('snap-1720000000002-ccccc', '2026-07-13T14:00:00.000Z'), dir);
    writeCurrentSnapshotPointer({ id: 'snap-1720000000002-ccccc' }, dir);
    const ids = listSnapshots(dir).map(s => s.id);
    expect(ids).toEqual(['snap-1720000000002-ccccc', 'snap-1720000000001-bbbbb']);
  });

  it('resolveSnapshotId returns full id for unique prefix', () => {
    writeSnapshot(mk('snap-1720000000000-aaaaa', '2026-07-13T14:00:00.000Z'), dir);
    writeSnapshot(mk('snap-1720000000001-bbbbb', '2026-07-13T15:00:00.000Z'), dir);
    expect(resolveSnapshotId('snap-1720000000000', dir)).toBe('snap-1720000000000-aaaaa');
    expect(resolveSnapshotId('snap-1720000000001-bbbbb', dir)).toBe('snap-1720000000001-bbbbb');
  });

  it('resolveSnapshotId throws when no match', () => {
    writeSnapshot(mk('snap-1720000000000-aaaaa', '2026-07-13T14:00:00.000Z'), dir);
    expect(() => resolveSnapshotId('snap-999', dir)).toThrow(/no snapshot matches/);
    expect(() => resolveSnapshotId('nope', dir)).toThrow(/no snapshot matches/);
  });

  it('resolveSnapshotId throws when ambiguous', () => {
    writeSnapshot(mk('snap-1720000000000-aaaaa', '2026-07-13T14:00:00.000Z'), dir);
    writeSnapshot(mk('snap-1720000000001-bbbbb', '2026-07-13T15:00:00.000Z'), dir);
    expect(() => resolveSnapshotId('snap-172', dir)).toThrow(/ambiguous/);
  });

  it('resolveSnapshotId prefers exact match over prefix', () => {
    writeSnapshot(mk('snap-1', '2026-07-13T14:00:00.000Z'), dir);
    writeSnapshot(mk('snap-10', '2026-07-13T15:00:00.000Z'), dir);
    expect(resolveSnapshotId('snap-1', dir)).toBe('snap-1');
  });

  it('readCurrentSnapshotPointer returns null when missing', () => {
    expect(readCurrentSnapshotPointer(dir)).toBeNull();
  });

  it('current pointer write/read round-trip', () => {
    const p = { id: 'snap-1720000000000-aaaaa', approvedAt: '2026-07-13T14:00:00.000Z', approvedBy: 'manager', message: 'freeze' };
    writeCurrentSnapshotPointer(p, dir);
    expect(readCurrentSnapshotPointer(dir)).toEqual(p);
  });
});
