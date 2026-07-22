import {
  readConfig, readWorkstream, listWorkstreamIds,
  writeSnapshot, readSnapshot, listSnapshots, resolveSnapshotId,
  readCurrentSnapshotPointer, writeCurrentSnapshotPointer,
} from '../../src/storage.js';
import { buildSnapshot, buildApproved, buildRejected, buildPointer, snapshotWorkstreams } from '../../src/snapshots.js';
import { canApprove } from '../../src/review.js';
import { serializeToMd } from '../../src/context.js';
import { commitContext, pushContext } from '../../src/git.js';

function checkManagerGate(config) {
  if (!canApprove(config)) {
    console.error(`Error: only the configured manager (${config.manager}) may approve or reject snapshots. You are ${config.me}.`);
    process.exit(1);
  }
}

function resolveOrExit(prefix) {
  try {
    return resolveSnapshotId(prefix);
  } catch (err) {
    console.error(`Error: ${err.message}. Run \`teamctx snapshot list\` to see snapshots.`);
    process.exit(1);
  }
}

async function commitAndPush(config, msg, successLine) {
  await commitContext(msg);
  if (config.autoPush) {
    try { await pushContext(); console.log(`\n${successLine} — committed and pushed.\n`); }
    catch (err) { console.log(`\n${successLine} — committed. Push failed (${err.message?.split('\n')[0] || err.stderr?.trim() || 'no remote?'}) — run \`git push\` manually.\n`); }
  } else {
    console.log(`\n${successLine} — committed. Run \`git push\` to share with your team.\n`);
  }
}

function collectWorkstreams(config) {
  const idSet = new Set([
    ...(config.workstreams || []).map(w => w.id),
    ...listWorkstreamIds(),
  ]);
  if (idSet.size === 0) idSet.add('main');
  return [...idSet].sort().map(id => ({ id, tree: readWorkstream(id) }));
}

export async function snapshotCreateCommand(opts) {
  const config = readConfig();
  const workstreams = collectWorkstreams(config);
  const snapshot = buildSnapshot({ workstreams, author: config.me, message: opts?.message });
  writeSnapshot(snapshot);
  const label = snapshot.message ? ` (${snapshot.message})` : '';
  await commitAndPush(config, `snapshot: ${snapshot.id} created by ${config.me}${label}`,
    `✓ Snapshot ${snapshot.id} created${label}`);
  console.log(`  Manager: after \`git pull\`, run \`teamctx snapshot approve ${snapshot.id}\` or \`teamctx snapshot reject ${snapshot.id}\`.`);
}

export async function snapshotListCommand() {
  const snapshots = listSnapshots();
  if (snapshots.length === 0) {
    console.log('\nNo snapshots yet.\n');
    return;
  }
  const pointer = readCurrentSnapshotPointer();
  const currentId = pointer?.id;

  console.log(`\n${snapshots.length} snapshot${snapshots.length !== 1 ? 's' : ''}${currentId ? ` (current: ${currentId})` : ''}:\n`);
  const header = [' ', 'ID', 'Status', 'Author', 'Created', 'Message'];
  const rows = snapshots.map(s => [
    s.id === currentId ? '*' : ' ',
    s.id,
    s.status || '-',
    s.createdBy || '-',
    s.createdAt || '-',
    (s.message || '').slice(0, 60),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const fmt = cells => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(fmt(header));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  rows.forEach(r => console.log(fmt(r)));
  console.log('');
}

export async function snapshotShowCommand(prefix) {
  const id = resolveOrExit(prefix);
  const snapshot = readSnapshot(id);
  const config = readConfig();
  const workstreams = snapshotWorkstreams(snapshot);
  console.log(`\n# Snapshot ${snapshot.id}`);
  console.log(`# Status: ${snapshot.status} · Author: ${snapshot.createdBy} · Created: ${snapshot.createdAt}`);
  if (snapshot.message) console.log(`# Message: ${snapshot.message}`);
  console.log(`# Workstreams: ${workstreams.map(w => w.id).join(', ') || '(none)'}`);
  console.log('');
  for (const w of workstreams) {
    if (workstreams.length > 1) console.log(`\n## Workstream: ${w.id}\n`);
    console.log(serializeToMd(w.tree, config.project, snapshot.createdBy));
  }
}

export async function snapshotApproveCommand(prefix) {
  const config = readConfig();
  checkManagerGate(config);
  const id = resolveOrExit(prefix);
  const snapshot = readSnapshot(id);
  if (snapshot.status === 'approved') {
    console.error(`Error: snapshot ${id} is already approved.`);
    process.exit(1);
  }
  if (snapshot.status === 'rejected') {
    console.error(`Error: snapshot ${id} was rejected and cannot be approved. Create a new snapshot.`);
    process.exit(1);
  }
  const approved = buildApproved(snapshot, config.me);
  writeSnapshot(approved);
  writeCurrentSnapshotPointer(buildPointer(approved));
  await commitAndPush(config, `snapshot: ${id} approved by ${config.me}`,
    `✓ Snapshot ${id} approved and marked current`);
}

export async function snapshotRejectCommand(prefix, opts) {
  const config = readConfig();
  checkManagerGate(config);
  const id = resolveOrExit(prefix);
  const snapshot = readSnapshot(id);
  if (snapshot.status !== 'pending') {
    console.error(`Error: snapshot ${id} has status "${snapshot.status}" — only pending snapshots can be rejected.`);
    process.exit(1);
  }
  const rejected = buildRejected(snapshot, config.me, opts?.reason);
  writeSnapshot(rejected);
  const reasonNote = opts?.reason ? ` (reason: ${opts.reason})` : '';
  await commitAndPush(config, `snapshot: ${id} rejected by ${config.me}${opts?.reason ? ` (${opts.reason})` : ''}`,
    `✓ Snapshot ${id} rejected${reasonNote}`);
}

export async function snapshotCurrentCommand() {
  const pointer = readCurrentSnapshotPointer();
  if (!pointer) {
    console.log('\nNo approved snapshot yet. Run `teamctx snapshot create` then have the manager approve it.\n');
    return;
  }
  const label = pointer.message ? ` — ${pointer.message}` : '';
  console.log(`\n${pointer.id}${label}`);
  console.log(`  approved by ${pointer.approvedBy} on ${pointer.approvedAt}\n`);
}
