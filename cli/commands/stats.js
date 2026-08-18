import { computeStats, DEFAULT_WINDOW_DAYS } from '../../src/metrics.js';

/**
 * `teamctx stats` — honest team numbers, computed locally.
 *
 * Presentation only. Every judgement about what counts lives in src/metrics.js
 * so the same numbers can feed the MCP tool without going through a terminal.
 *
 * Deliberately neutral: no streaks, no nudges, no "you're falling behind". A
 * manager running a pilot needs numbers they can trust more than they need
 * encouragement, and a tool that editorialises gets read as marketing.
 */

const pad = (s, n) => String(s).padEnd(n);
const ago = days => (days === null ? 'never' : days === 0 ? 'today' : `${days}d ago`);

/**
 * Hours are the wrong unit at both ends: a review turned around in ten minutes
 * reads as "0h", and one that took a fortnight reads as "336h".
 */
function duration(hours) {
  if (hours === null) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${hours}h`;
  return `${Math.round((hours / 24) * 10) / 10}d`;
}

function renderCadence({ total, decisions, perWeek, byAuthor }) {
  console.log('  Cadence');
  if (total === 0) {
    console.log('    nothing in this window\n');
    return;
  }
  const decisionNote = decisions ? `, ${decisions} decision${decisions === 1 ? '' : 's'}` : '';
  console.log(`    ${pad(`${total} contribution${total === 1 ? '' : 's'}${decisionNote}`, 38)}${perWeek}/week`);
  for (const a of byAuthor) console.log(`      ${pad(a.author, 34)} ${a.count}`);
  console.log();
}

function renderApprovals({ decided, approved, rejected, pending, approvalRate, medianHours, historyAvailable }) {
  console.log('  Approval flow');
  if (!historyAvailable) {
    // Saying "0 approved" here would be a lie of omission — approving leaves
    // no record outside git, so without it we genuinely cannot see one.
    console.log(`    ${pad('Decided', 20)}— needs git history for .teamctx/queue`);
  } else {
    const split = decided ? ` (${approved} approved, ${rejected} rejected)` : '';
    const rate = approvalRate === null ? '' : `   ${approvalRate}% approved`;
    console.log(`    ${pad('Decided', 20)}${decided}${split}${rate}`);
    console.log(`    ${pad('Median wait', 20)}${duration(medianHours)}`);
  }
  console.log(`    ${pad('Pending now', 20)}${pending}`);
  console.log();
}

function renderFreshness(rows) {
  console.log('  Context freshness');
  for (const r of rows) {
    const waiting = r.pending ? `${r.pending} pending` : '';
    console.log(`    ${pad(r.workstream, 20)}${pad(ago(r.daysSince), 12)}${waiting}`);
  }
  console.log();
}

function renderTasks({ opened, completed, open, done, compiled }) {
  console.log('  Tasks');
  console.log(`    ${pad(`${opened} opened, ${completed} completed`, 38)}${open} open, ${done} done${compiled ? ` (${compiled} compiled)` : ''}`);
  console.log();
}

export async function statsCommand(opts = {}) {
  const stats = await computeStats({
    cwd: process.cwd(),
    since: opts.since,
    workstream: opts.workstream,
  });

  if (opts.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  const scope = stats.workstream ? ` · ${stats.workstream}` : '';
  const window = opts.since
    ? `since ${stats.window.since.slice(0, 10)}`
    : `last ${DEFAULT_WINDOW_DAYS} days`;
  console.log(`\n${stats.project || 'teamctx'} — stats (${window}${scope})\n`);

  renderCadence(stats.cadence);
  renderApprovals(stats.approvals);
  renderFreshness(stats.freshness);
  renderTasks(stats.tasks);
}
