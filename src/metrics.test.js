import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { collectStats, queueTimeline, median, DEFAULT_WINDOW_DAYS } from './metrics.js';

const UNTIL = new Date('2026-08-29T00:00:00.000Z');
const SINCE = new Date('2026-08-01T00:00:00.000Z');

const contribution = (over = {}) => ({
  id: 'c-1', ts: '2026-08-10T00:00:00.000Z', author: 'Alice',
  workstream: 'main', tagged: null, ...over,
});
const stats = over => collectStats({ since: SINCE, until: UNTIL, now: UNTIL, ...over });

describe('median', () => {
  it('takes the middle of an odd list and the mean of an even one', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('is null rather than zero when there is nothing to average', () => {
    // Zero would read as "decided instantly", which is a lie.
    expect(median([])).toBe(null);
  });
});

describe('cadence', () => {
  it('counts only contributions inside the window', () => {
    const r = stats({
      contributions: [
        contribution({ id: 'a', ts: '2026-08-10T00:00:00.000Z' }),
        contribution({ id: 'b', ts: '2026-07-01T00:00:00.000Z' }),   // before
        contribution({ id: 'c', ts: '2026-09-15T00:00:00.000Z' }),   // after
      ],
    });
    expect(r.cadence.total).toBe(1);
  });

  it('reports a per-week rate against the window length', () => {
    // 4 contributions over 28 days is 1/week — the number a manager actually
    // reads, rather than a raw total that means nothing without the window.
    const r = stats({
      contributions: ['05', '10', '15', '20'].map(d =>
        contribution({ id: d, ts: `2026-08-${d}T00:00:00.000Z` })),
    });
    expect(r.window.days).toBe(28);
    expect(r.cadence.perWeek).toBe(1);
  });

  it('counts one person once when their display name differs by surface', () => {
    // The whole reason authorKey exists: the same human contributing from the
    // CLI (git name) and the hosted server (GitHub name) is one contributor.
    const r = stats({
      contributions: [
        contribution({ id: 'a', author: 'Alice Example', authorKey: 'github:1001' }),
        contribution({ id: 'b', author: 'alice', authorKey: 'github:1001' }),
      ],
    });
    expect(r.cadence.byAuthor).toHaveLength(1);
    expect(r.cadence.byAuthor[0]).toMatchObject({ count: 2, key: 'github:1001' });
  });

  it('keeps authors apart when there is no key to join them on', () => {
    const r = stats({
      contributions: [contribution({ id: 'a', author: 'Alice' }), contribution({ id: 'b', author: 'Bob' })],
    });
    expect(r.cadence.byAuthor.map(a => a.author).sort()).toEqual(['Alice', 'Bob']);
  });

  it('ranks authors by volume', () => {
    const r = stats({
      contributions: [
        contribution({ id: 'a', author: 'Alice' }),
        contribution({ id: 'b', author: 'Bob' }),
        contribution({ id: 'c', author: 'Bob' }),
      ],
    });
    expect(r.cadence.byAuthor[0]).toMatchObject({ author: 'Bob', count: 2 });
  });

  it('counts decisions separately', () => {
    const r = stats({
      contributions: [contribution({ id: 'a', tagged: 'decision' }), contribution({ id: 'b' })],
    });
    expect(r.cadence).toMatchObject({ total: 2, decisions: 1 });
  });
});

describe('approvals', () => {
  const timeline = new Map([
    // queued on the 10th, decided on the 12th — 48 hours
    ['c-1', { id: 'c-1', queuedAt: '2026-08-10T00:00:00.000Z', decidedAt: '2026-08-12T00:00:00.000Z' }],
    // queued on the 10th, decided on the 11th — 24 hours
    ['c-2', { id: 'c-2', queuedAt: '2026-08-10T00:00:00.000Z', decidedAt: '2026-08-11T00:00:00.000Z' }],
    // still pending: no decision to measure
    ['c-3', { id: 'c-3', queuedAt: '2026-08-20T00:00:00.000Z', decidedAt: null }],
  ]);

  it('measures latency from the queue file being written to it being removed', () => {
    const r = stats({ timeline });
    expect(r.approvals.medianHours).toBe(36);        // (24 + 48) / 2
    expect(r.approvals.decided).toBe(2);
  });

  it('separates approvals from rejections using the rejected files', () => {
    // Approving records nothing, so an approval is only ever "a decision that
    // did not leave a rejection behind".
    const r = stats({
      timeline,
      rejected: [{ id: 'c-2', rejectedAt: '2026-08-11T00:00:00.000Z', workstream: 'main' }],
    });
    expect(r.approvals).toMatchObject({ decided: 2, approved: 1, rejected: 1, approvalRate: 50 });
  });

  it('reports nothing rather than guessing when git history is unavailable', () => {
    // Hosted mode has no git binary. A zero here would read as "nobody has
    // ever approved anything", which is the opposite of the truth.
    const r = stats({ timeline: new Map(), rejected: [{ id: 'x', rejectedAt: '2026-08-11T00:00:00.000Z' }] });
    expect(r.approvals.historyAvailable).toBe(false);
    expect(r.approvals.decided).toBe(null);
    expect(r.approvals.approved).toBe(null);
    expect(r.approvals.medianHours).toBe(null);
    expect(r.approvals.rejected, 'rejections are still knowable').toBe(1);
  });

  it('counts the queue as it stands, not only within the window', () => {
    // A contribution queued three months ago is still waiting today; a window
    // that hid it would flatter the numbers.
    const r = stats({ queue: [{ id: 'old', createdAt: '2026-01-01T00:00:00.000Z', workstream: 'main' }] });
    expect(r.approvals.pending).toBe(1);
  });

  it('ignores decisions made outside the window', () => {
    const r = stats({
      timeline: new Map([['c-9', { queuedAt: '2026-06-01T00:00:00.000Z', decidedAt: '2026-06-02T00:00:00.000Z' }]]),
    });
    expect(r.approvals.decided).toBe(0);
    expect(r.approvals.medianHours).toBe(null);
  });
});

describe('freshness', () => {
  it('reports days since the last contribution per workstream', () => {
    const r = stats({
      workstreams: ['main', 'billing'],
      contributions: [
        contribution({ id: 'a', workstream: 'main', ts: '2026-08-27T00:00:00.000Z' }),
        contribution({ id: 'b', workstream: 'billing', ts: '2026-08-01T00:00:00.000Z' }),
      ],
    });
    expect(r.freshness).toEqual([
      { workstream: 'billing', lastContributionAt: '2026-08-01T00:00:00.000Z', daysSince: 28, pending: 0 },
      { workstream: 'main', lastContributionAt: '2026-08-27T00:00:00.000Z', daysSince: 2, pending: 0 },
    ]);
  });

  it('looks past the window for the last contribution', () => {
    // "Nothing in 4 weeks" is the finding. Reporting null because the last one
    // predates the window would hide exactly the workstream worth noticing.
    const r = stats({
      workstreams: ['stale'],
      contributions: [contribution({ workstream: 'stale', ts: '2026-05-01T00:00:00.000Z' })],
    });
    expect(r.freshness[0].daysSince).toBe(120);
  });

  it('says nothing has ever landed rather than reporting zero days', () => {
    const r = stats({ workstreams: ['empty'] });
    expect(r.freshness[0]).toMatchObject({ lastContributionAt: null, daysSince: null });
  });

  it('counts pending items per workstream', () => {
    const r = stats({
      workstreams: ['main'],
      queue: [{ id: 'q1', workstream: 'main' }, { id: 'q2', workstream: 'main' }],
    });
    expect(r.freshness[0].pending).toBe(2);
  });
});

describe('tasks', () => {
  it('separates flow in the window from the standing totals', () => {
    const r = stats({
      tasks: [
        { id: 't1', status: 'done', createdAt: '2026-08-02', doneAt: '2026-08-05', compiledAt: '2026-08-03' },
        { id: 't2', status: 'open', createdAt: '2026-08-20', doneAt: null, compiledAt: null },
        { id: 't3', status: 'done', createdAt: '2026-05-01', doneAt: '2026-05-02', compiledAt: null },
      ],
    });
    expect(r.tasks).toEqual({ opened: 2, completed: 1, open: 1, done: 2, compiled: 1 });
  });
});

describe('queueTimeline — against a real repository', () => {
  let root;
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  const commit = msg => {
    git('add', '-A');
    git('-c', 'user.email=t@t.dev', '-c', 'user.name=Test', 'commit', '-m', msg, '--no-gpg-sign');
  };
  const queueFile = id => join(root, '.teamctx', 'queue', `${id}.json`);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'teamctx-metrics-'));
    git('init', '-q');
    mkdirSync(join(root, '.teamctx', 'queue'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads queued-at and decided-at from the add and delete of a queue file', async () => {
    // The commit that removes the queue item *is* the decision. Nothing else
    // records an approval, so this is the only honest source.
    writeFileSync(queueFile('c-1'), '{}');
    commit('queue: Alice submission pending approval (c-1)');
    unlinkSync(queueFile('c-1'));
    commit('context: Alice contribution (approved by Bob)');

    const timeline = await queueTimeline({ cwd: root });
    const entry = timeline.get('c-1');
    expect(entry.queuedAt).toBeTruthy();
    expect(entry.decidedAt).toBeTruthy();
    expect(new Date(entry.decidedAt).getTime()).toBeGreaterThanOrEqual(new Date(entry.queuedAt).getTime());
  });

  it('leaves a still-queued item without a decision time', async () => {
    writeFileSync(queueFile('c-2'), '{}');
    commit('queue: Alice submission pending approval (c-2)');

    const timeline = await queueTimeline({ cwd: root });
    expect(timeline.get('c-2')).toMatchObject({ decidedAt: null });
    expect(timeline.get('c-2').queuedAt).toBeTruthy();
  });

  it('handles several items decided in one commit', async () => {
    writeFileSync(queueFile('c-3'), '{}');
    writeFileSync(queueFile('c-4'), '{}');
    commit('queue: two submissions');
    unlinkSync(queueFile('c-3'));
    unlinkSync(queueFile('c-4'));
    commit('review: both decided');

    const timeline = await queueTimeline({ cwd: root });
    expect([...timeline.keys()].sort()).toEqual(['c-3', 'c-4']);
    expect([...timeline.values()].every(e => e.decidedAt)).toBe(true);
  });

  it('is empty rather than throwing outside a git repository', async () => {
    // stats must still print cadence from the audit log when git cannot help.
    const bare = mkdtempSync(join(tmpdir(), 'teamctx-nogit-'));
    try {
      expect((await queueTimeline({ cwd: bare })).size).toBe(0);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('is empty when nothing has ever been queued', async () => {
    // Git has no empty directories, so the queue dir alone is not committable.
    writeFileSync(join(root, '.teamctx', 'config.json'), '{}');
    commit('chore: initialize teamctx for "Test"');
    expect((await queueTimeline({ cwd: root })).size).toBe(0);
  });
});

describe('defaults', () => {
  it('windows on four weeks, which is what a pilot cadence reads as', () => {
    expect(DEFAULT_WINDOW_DAYS).toBe(28);
  });
});
