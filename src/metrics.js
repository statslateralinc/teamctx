import { execFile } from 'child_process';
import { promisify } from 'util';
import { getCurrentSession } from './session-context.js';
import {
  readContributions, listQueue, listRejected, listTasks, listWorkstreamIds, readConfig,
} from './storage.js';

const execFileAsync = promisify(execFile);

/**
 * Team metrics, computed entirely from what the repo already holds.
 *
 * Hard requirement from the proposal: nothing phones home. Every number below
 * comes from `.teamctx/` and the repo's own git history, so a manager can run
 * this on a laptop with no network and no telemetry.
 *
 * The awkward part is approval latency, and it is worth explaining because it
 * shapes the whole module. Approving a contribution *deletes* its queue item
 * and records nothing — there is no `approvedAt` anywhere. Rejecting writes
 * `.teamctx/rejected/<id>.json` with `rejectedAt`, so rejections are easy and
 * approvals are invisible. `contributions.jsonl` never updates its `status`
 * either; every row stays `logged`.
 *
 * So the only honest source for "when was this decided" is the commit that
 * removed the queue file. One `git log --diff-filter=AD` over `.teamctx/queue`
 * gives the add and delete of every item, which is exactly queued-at and
 * decided-at, without parsing a single commit message.
 *
 * Where that history is unavailable — hosted mode has no git binary, and a
 * fresh clone may lack depth — the latency numbers come back null rather than
 * guessed. A made-up median is worse than a missing one.
 */

/** The proposal's default: a trailing four weeks reads as "current cadence". */
export const DEFAULT_WINDOW_DAYS = 28;

const DAY_MS = 86400000;
const iso = d => new Date(d).toISOString();
const time = v => (v ? new Date(v).getTime() : NaN);

export function median(numbers) {
  const sorted = [...numbers].filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Queued-at and decided-at for every contribution that ever entered the queue.
 *
 * `--diff-filter=AD` restricts the log to commits that added or deleted a queue
 * file; `--reverse` puts them oldest-first so the first add is the real queue
 * time. Returns an empty map rather than throwing when git cannot answer — a
 * missing latency column is a much better outcome than a failed command.
 */
export async function queueTimeline({ cwd } = {}) {
  const events = new Map();
  if (getCurrentSession()) return events;   // hosted: no working copy, no git binary

  let stdout;
  try {
    ({ stdout } = await execFileAsync('git', [
      'log', '--reverse', '--diff-filter=AD', '--name-status', '--format=\x01%aI',
      '--', '.teamctx/queue',
    ], { cwd, maxBuffer: 16 * 1024 * 1024 }));
  } catch {
    return events;                          // not a repo, shallow clone, no git
  }

  let at = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('\x01')) { at = line.slice(1).trim(); continue; }
    const match = /^([AD])\s+.*queue\/(.+)\.json$/.exec(line.trim());
    if (!match || !at) continue;
    const [, kind, id] = match;
    const entry = events.get(id) || { id, queuedAt: null, decidedAt: null };
    if (kind === 'A' && !entry.queuedAt) entry.queuedAt = at;
    else if (kind === 'D') entry.decidedAt = at;    // re-queued and re-decided: the last one stands
    events.set(id, entry);
  }
  return events;
}

/** One person, however their display name has drifted between surfaces. */
function authorKeyOf(contribution) {
  return contribution.authorKey || `name:${contribution.author || 'unknown'}`;
}

/**
 * Turn already-read data into numbers. Pure on purpose: every metric below is
 * a judgement call about what counts, and those are worth testing without a
 * repo, a clock, or a git binary in the way.
 */
export function collectStats({
  contributions = [], queue = [], rejected = [], tasks = [], workstreams = [],
  timeline = new Map(), since, until = new Date(), now = until,
} = {}) {
  const from = time(since);
  const to = time(until);
  const within = v => { const t = time(v); return Number.isFinite(t) && t >= from && t <= to; };
  const days = Math.max(1, Math.round((to - from) / DAY_MS));

  // ---- cadence
  const inWindow = contributions.filter(c => within(c.ts));
  const byKey = new Map();
  for (const c of inWindow) {
    const key = authorKeyOf(c);
    const entry = byKey.get(key) || { key, author: c.author || 'unknown', count: 0 };
    entry.count += 1;
    entry.author = c.author || entry.author;      // latest name wins for display
    byKey.set(key, entry);
  }
  const byAuthor = [...byKey.values()].sort((a, b) => b.count - a.count || a.author.localeCompare(b.author));

  // ---- approvals
  const rejectedInWindow = rejected.filter(r => within(r.rejectedAt));
  const decisions = [...timeline.values()].filter(e => within(e.decidedAt));
  const latencies = decisions
    .filter(e => e.queuedAt)
    .map(e => (time(e.decidedAt) - time(e.queuedAt)) / 3600000);
  // Without git history there is no way to see an approval at all, so the
  // counts stay null instead of quietly reporting rejections as the whole
  // picture.
  const haveHistory = timeline.size > 0;
  const decided = haveHistory ? decisions.length : null;
  const approved = haveHistory ? Math.max(0, decisions.length - rejectedInWindow.length) : null;

  // ---- freshness, per workstream
  const ids = [...new Set([...workstreams, ...contributions.map(c => c.workstream || 'main')])].sort();
  const freshness = ids.map(id => {
    // `time(null)` is NaN and every comparison against NaN is false, so the
    // seed has to be handled explicitly or the reduce never leaves it.
    const last = contributions.filter(c => (c.workstream || 'main') === id)
      .reduce((acc, c) => (!acc || time(c.ts) > time(acc) ? c.ts : acc), null);
    return {
      workstream: id,
      lastContributionAt: last,
      daysSince: last ? Math.floor((time(now) - time(last)) / DAY_MS) : null,
      pending: queue.filter(q => (q.workstream || 'main') === id).length,
    };
  });

  return {
    window: { since: iso(since), until: iso(until), days },
    cadence: {
      total: inWindow.length,
      decisions: inWindow.filter(c => c.tagged === 'decision').length,
      perWeek: Math.round((inWindow.length / days) * 7 * 10) / 10,
      byAuthor,
    },
    approvals: {
      decided,
      approved,
      rejected: rejectedInWindow.length,
      pending: queue.length,
      approvalRate: decided ? Math.round((approved / decided) * 100) : null,
      // Two decimals, not one: a review turned around in ten minutes rounds to
      // 0.0 at one, and a consumer told to report the number verbatim would
      // say it was decided instantly.
      medianHours: latencies.length ? Math.round(median(latencies) * 100) / 100 : null,
      // Lets the presenter say "needs git history" rather than print a zero
      // that looks like "nothing was ever approved".
      historyAvailable: haveHistory,
    },
    freshness,
    tasks: {
      opened: tasks.filter(t => within(t.createdAt)).length,
      completed: tasks.filter(t => within(t.doneAt)).length,
      open: tasks.filter(t => t.status === 'open').length,
      done: tasks.filter(t => t.status === 'done').length,
      compiled: tasks.filter(t => t.compiledAt).length,
    },
  };
}

/**
 * Read everything the repo holds and compute the stats for a window.
 *
 * `workstream` narrows every metric, not only the freshness rows, so
 * `--workstream billing` answers "how is billing going" rather than showing
 * project-wide cadence next to one workstream's queue.
 */
export async function computeStats({
  cwd, teamctxDir, since, until = new Date(), workstream = null, now = new Date(),
} = {}) {
  const from = since ? new Date(since) : new Date(time(until) - DEFAULT_WINDOW_DAYS * DAY_MS);
  if (!Number.isFinite(from.getTime())) throw new Error(`not a date: "${since}"`);

  const onWorkstream = row => !workstream || (row.workstream || 'main') === workstream;
  const workstreams = listWorkstreamIds(teamctxDir);
  if (workstream && workstreams.length > 0 && !workstreams.includes(workstream)) {
    throw new Error(`unknown workstream "${workstream}". Known: ${workstreams.join(', ')}.`);
  }

  const stats = collectStats({
    contributions: readContributions(teamctxDir).filter(onWorkstream),
    queue: listQueue(teamctxDir).filter(onWorkstream),
    rejected: listRejected(teamctxDir).filter(onWorkstream),
    tasks: listTasks(workstream ? { workstream } : {}, teamctxDir),
    workstreams: workstream ? [workstream] : workstreams,
    timeline: await queueTimeline({ cwd }),
    since: from, until, now,
  });

  let project = null;
  try { project = readConfig(teamctxDir).project; } catch { /* stats should not need a config */ }
  return { project, workstream, ...stats };
}
