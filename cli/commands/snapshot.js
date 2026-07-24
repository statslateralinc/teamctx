import { readConfig } from '../../src/storage.js';
import { serializeToMd } from '../../src/context.js';
import { ManagerGateError } from './review.core.js';
import {
  createSnapshot, approveSnapshot, rejectSnapshot,
  listAllSnapshots, getSnapshot, getCurrentSnapshot,
  SnapshotNotFoundError, SnapshotStateError,
} from './snapshot.core.js';

function reportCommit(config, successLine, pushed, pushError) {
  if (pushed) return console.log(`\n${successLine} — committed and pushed.\n`);
  if (pushError) return console.log(`\n${successLine} — committed. Push failed (${pushError}) — run \`git push\` manually.\n`);
  return console.log(`\n${successLine} — committed. Run \`git push\` to share with your team.\n`);
}

function handleCliError(err) {
  if (err instanceof ManagerGateError || err instanceof SnapshotNotFoundError || err instanceof SnapshotStateError) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

export async function snapshotCreateCommand(opts) {
  let result;
  try { result = await createSnapshot({ message: opts?.message }); }
  catch (err) { handleCliError(err); return; }
  const config = readConfig();
  const label = result.snapshot.message ? ` (${result.snapshot.message})` : '';
  reportCommit(config, `✓ Snapshot ${result.snapshot.id} created${label}`, result.pushed, result.pushError);
  console.log(`  Manager: after \`git pull\`, run \`teamctx snapshot approve ${result.snapshot.id}\` or \`teamctx snapshot reject ${result.snapshot.id}\`.`);
}

export async function snapshotListCommand() {
  const { snapshots, currentId } = listAllSnapshots();
  if (snapshots.length === 0) {
    console.log('\nNo snapshots yet.\n');
    return;
  }
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
  let result;
  try { result = getSnapshot({ prefix }); }
  catch (err) { handleCliError(err); return; }
  const { snapshot, workstreams } = result;
  const config = readConfig();
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
  let result;
  try { result = await approveSnapshot({ prefix }); }
  catch (err) { handleCliError(err); return; }
  const config = readConfig();
  reportCommit(config, `✓ Snapshot ${result.id} approved and marked current`, result.pushed, result.pushError);
}

export async function snapshotRejectCommand(prefix, opts) {
  let result;
  try { result = await rejectSnapshot({ prefix, reason: opts?.reason }); }
  catch (err) { handleCliError(err); return; }
  const config = readConfig();
  const reasonNote = result.reason ? ` (reason: ${result.reason})` : '';
  reportCommit(config, `✓ Snapshot ${result.id} rejected${reasonNote}`, result.pushed, result.pushError);
}

export async function snapshotCurrentCommand() {
  const pointer = getCurrentSnapshot();
  if (!pointer) {
    console.log('\nNo approved snapshot yet. Run `teamctx snapshot create` then have the manager approve it.\n');
    return;
  }
  const label = pointer.message ? ` — ${pointer.message}` : '';
  console.log(`\n${pointer.id}${label}`);
  console.log(`  approved by ${pointer.approvedBy} on ${pointer.approvedAt}\n`);
}
