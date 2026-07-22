import {
  readConfig, readWorkstream, listWorkstreamIds,
  writeSnapshot, readSnapshot, listSnapshots, resolveSnapshotId,
  readCurrentSnapshotPointer, writeCurrentSnapshotPointer,
} from '../../src/storage.js';
import { buildSnapshot, buildApproved, buildRejected, buildPointer, snapshotWorkstreams } from '../../src/snapshots.js';
import { canApprove } from '../../src/review.js';
import { commitContext, pushContext } from '../../src/git.js';
import { ManagerGateError } from './review.core.js';

export class SnapshotNotFoundError extends Error {
  constructor(prefix, cause) {
    super(`${cause?.message || `no snapshot matching "${prefix}"`}. Run \`teamctx snapshot list\` to see snapshots.`);
    this.code = 'SNAPSHOT_NOT_FOUND';
  }
}

export class SnapshotStateError extends Error {
  constructor(msg) { super(msg); this.code = 'SNAPSHOT_STATE'; }
}

function assertManager(config, actor) {
  const effective = actor ? { ...config, me: actor } : config;
  if (!canApprove(effective)) throw new ManagerGateError(effective);
}

function collectWorkstreams(teamctxDir) {
  const config = readConfig(teamctxDir);
  const idSet = new Set([
    ...(config.workstreams || []).map(w => w.id),
    ...listWorkstreamIds(teamctxDir),
  ]);
  if (idSet.size === 0) idSet.add('main');
  return [...idSet].sort().map(id => ({ id, tree: readWorkstream(id, teamctxDir) }));
}

async function commitAndPush(config, msg, { projectDir } = {}) {
  await commitContext(msg, projectDir ? { cwd: projectDir } : undefined);
  if (!config.autoPush) return { pushed: false, pushError: null };
  try { await pushContext(projectDir ? { cwd: projectDir } : undefined); return { pushed: true, pushError: null }; }
  catch (err) { return { pushed: false, pushError: err.message?.split('\n')[0] || err.stderr?.trim() || 'no remote?' }; }
}

export async function createSnapshot({ message, teamctxDir, projectDir, actor } = {}) {
  const config = readConfig(teamctxDir);
  const author = actor || config.me;
  const workstreams = collectWorkstreams(teamctxDir);
  const snapshot = buildSnapshot({ workstreams, author, message });
  writeSnapshot(snapshot, teamctxDir);
  const label = snapshot.message ? ` (${snapshot.message})` : '';
  const { pushed, pushError } = await commitAndPush(
    config, `snapshot: ${snapshot.id} created by ${author}${label}`, { projectDir },
  );
  return { snapshot, pushed, pushError };
}

export async function approveSnapshot({ prefix, teamctxDir, projectDir, actor } = {}) {
  const config = readConfig(teamctxDir);
  assertManager(config, actor);
  let id;
  try { id = resolveSnapshotId(prefix, teamctxDir); }
  catch (err) { throw new SnapshotNotFoundError(prefix, err); }
  const snapshot = readSnapshot(id, teamctxDir);
  if (snapshot.status === 'approved') throw new SnapshotStateError(`snapshot ${id} is already approved.`);
  if (snapshot.status === 'rejected') throw new SnapshotStateError(`snapshot ${id} was rejected and cannot be approved. Create a new snapshot.`);
  const approvedBy = actor || config.me;
  const approved = buildApproved(snapshot, approvedBy);
  writeSnapshot(approved, teamctxDir);
  writeCurrentSnapshotPointer(buildPointer(approved), teamctxDir);
  const { pushed, pushError } = await commitAndPush(
    config, `snapshot: ${id} approved by ${approvedBy}`, { projectDir },
  );
  return { id, approvedBy, pushed, pushError };
}

export async function rejectSnapshot({ prefix, reason, teamctxDir, projectDir, actor } = {}) {
  const config = readConfig(teamctxDir);
  assertManager(config, actor);
  let id;
  try { id = resolveSnapshotId(prefix, teamctxDir); }
  catch (err) { throw new SnapshotNotFoundError(prefix, err); }
  const snapshot = readSnapshot(id, teamctxDir);
  if (snapshot.status !== 'pending') throw new SnapshotStateError(`snapshot ${id} has status "${snapshot.status}" — only pending snapshots can be rejected.`);
  const rejectedBy = actor || config.me;
  const rejected = buildRejected(snapshot, rejectedBy, reason);
  writeSnapshot(rejected, teamctxDir);
  const { pushed, pushError } = await commitAndPush(
    config, `snapshot: ${id} rejected by ${rejectedBy}${reason ? ` (${reason})` : ''}`, { projectDir },
  );
  return { id, rejectedBy, reason: reason || null, pushed, pushError };
}

export function listAllSnapshots({ teamctxDir } = {}) {
  const snapshots = listSnapshots(teamctxDir);
  const pointer = readCurrentSnapshotPointer(teamctxDir);
  return { snapshots, currentId: pointer?.id || null };
}

export function getSnapshot({ prefix, teamctxDir }) {
  let id;
  try { id = resolveSnapshotId(prefix, teamctxDir); }
  catch (err) { throw new SnapshotNotFoundError(prefix, err); }
  const snapshot = readSnapshot(id, teamctxDir);
  return { snapshot, workstreams: snapshotWorkstreams(snapshot) };
}

export function getCurrentSnapshot({ teamctxDir } = {}) {
  return readCurrentSnapshotPointer(teamctxDir) || null;
}
