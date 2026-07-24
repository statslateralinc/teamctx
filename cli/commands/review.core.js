import {
  readConfig, readWorkstream, writeWorkstream, writeWorkstreamMd, writeRoleFile,
  readQueueItem, deleteQueueItem, writeRejected, readContributions, listQueue,
} from '../../src/storage.js';
import { applyQueueItem, buildRejected, canApprove } from '../../src/review.js';
import { serializeToMd, generateRoleFile } from '../../src/context.js';
import { commitContext, pushContext } from '../../src/git.js';

function workstreamDisplayName(id, workstream, config) {
  return config.workstreams?.find(w => w.id === id)?.name || workstream.name || config.project;
}

export class ManagerGateError extends Error {
  constructor(config) {
    super(`only the configured manager (${config.manager}) may approve or reject. You are ${config.me}.`);
    this.code = 'MANAGER_GATE';
    this.manager = config.manager;
    this.actor = config.me;
  }
}

export class QueueItemNotFoundError extends Error {
  constructor(id) {
    super(`no pending contribution with id "${id}". Run \`teamctx review list\` to see the queue.`);
    this.code = 'QUEUE_ITEM_NOT_FOUND';
    this.id = id;
  }
}

export function assertManager(config, { actor } = {}) {
  const effective = actor ? { ...config, me: actor } : config;
  if (!canApprove(effective)) throw new ManagerGateError(effective);
}

export async function listPendingReviews({ teamctxDir } = {}) {
  return listQueue(teamctxDir);
}

export async function approveReview({ id, teamctxDir, projectDir, actor } = {}) {
  const config = readConfig(teamctxDir);
  assertManager(config, { actor });

  let item;
  try { item = readQueueItem(id, teamctxDir); }
  catch { throw new QueueItemNotFoundError(id); }

  const targetId = item.workstream || 'main';
  const workstream = readWorkstream(targetId, teamctxDir);
  const updated = applyQueueItem(workstream, item);
  const contributions = readContributions(teamctxDir);

  writeWorkstream(targetId, updated, teamctxDir);
  writeWorkstreamMd(
    targetId,
    serializeToMd(updated, workstreamDisplayName(targetId, updated, config), item.author, contributions),
    teamctxDir,
  );

  const rolesOnTarget = (config.roles || []).filter(r => (r.workstream || 'main') === targetId);
  const rolesRegenerated = [];
  for (const role of rolesOnTarget) {
    const md = await generateRoleFile(updated, role, config.project, config, contributions);
    writeRoleFile(role.slug, md, teamctxDir);
    rolesRegenerated.push(role.slug);
  }

  deleteQueueItem(item.id, teamctxDir);

  const note = item.tagged === 'decision' ? ' [decision]' : '';
  const wsNote = targetId === 'main' ? '' : ` (${targetId})`;
  const approvedBy = actor || config.me;
  await commitContext(
    `context: ${item.author} contribution (approved by ${approvedBy})${note}${wsNote}`,
    projectDir ? { cwd: projectDir } : undefined,
  );

  let pushed = false, pushError = null;
  if (config.autoPush) {
    try { await pushContext(projectDir ? { cwd: projectDir } : undefined); pushed = true; }
    catch (err) { pushError = err.message?.split('\n')[0] || 'no remote?'; }
  }

  return {
    id: item.id,
    workstream: targetId,
    author: item.author,
    approvedBy,
    operations: item.operations || [],
    rolesRegenerated,
    pushed,
    pushError,
  };
}

export async function rejectReview({ id, reason, teamctxDir, projectDir, actor } = {}) {
  const config = readConfig(teamctxDir);
  assertManager(config, { actor });

  let item;
  try { item = readQueueItem(id, teamctxDir); }
  catch { throw new QueueItemNotFoundError(id); }

  const rejectedBy = actor || config.me;
  writeRejected(buildRejected(item, rejectedBy, reason), teamctxDir);
  deleteQueueItem(item.id, teamctxDir);

  await commitContext(
    `review: rejected ${item.id} by ${rejectedBy}${reason ? ` (${reason})` : ''}`,
    projectDir ? { cwd: projectDir } : undefined,
  );

  let pushed = false, pushError = null;
  if (config.autoPush) {
    try { await pushContext(projectDir ? { cwd: projectDir } : undefined); pushed = true; }
    catch (err) { pushError = err.message?.split('\n')[0] || 'no remote?'; }
  }

  return { id: item.id, rejectedBy, reason: reason || null, pushed, pushError };
}
