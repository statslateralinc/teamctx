import {
  readConfig, readWorkstream, writeWorkstream, writeWorkstreamMd, writeRoleFile,
  readQueueItem, deleteQueueItem, writeRejected, readContributions, listQueue,
} from '../../src/storage.js';
import { applyQueueItem, buildRejected, canApprove, isLegacyManagerRef } from '../../src/review.js';
import { isBrokenGate } from '../../src/manager-repair.js';
import { serializeToMd, generateRoleFile } from '../../src/context.js';
import { commitContext, pushContext } from '../../src/git.js';
import { resolveActor } from '../../src/actor.js';
import { resolveDisplayName } from '../../src/prefs.js';
import { sourceTrailer } from './contribute.core.js';

function workstreamDisplayName(id, workstream, config) {
  return config.workstreams?.find(w => w.id === id)?.name || workstream.name || config.project;
}

/**
 * Who is really calling, and what they are called.
 *
 * The gate uses `actor` — a stable identity that the caller cannot choose. The
 * display name is only for messages and for the deprecated name-matching path.
 */
async function currentIdentity(config, teamctxDir, projectDir) {
  const actor = await resolveActor({ config, cwd: projectDir });
  const displayName = await resolveDisplayName({ actor, config, teamctxDir });
  return { actor, displayName };
}

export class ManagerGateError extends Error {
  constructor(config, { actor, displayName } = {}) {
    const manager = config.managerKey || config.manager;
    const you = displayName || actor?.name || 'unidentified';
    const key = actor?.key ? ` (${actor.key})` : '';
    // A display-name gate names the caller and refuses them in the same
    // sentence, which reads as a contradiction rather than a problem. Projects
    // created on the web before #71 all carry one, and nobody can match it.
    super(isBrokenGate(config)
      ? `this project's manager gate is "${manager}", a display name rather than an identity — `
        + 'nobody can match one, including you. Projects created on the web before this was fixed '
        + 'all carry one. Run `teamctx config manager --repair` from a clone to re-pin it to your '
        + `own identity${actor?.key ? ` (${actor.key})` : ''}.`
      : `only the configured manager (${manager}) may approve or reject. You are ${you}${key}.`);
    this.code = 'MANAGER_GATE';
    this.manager = manager;
    this.actor = you;
    this.brokenGate = isBrokenGate(config);
  }
}

export class QueueItemNotFoundError extends Error {
  constructor(id) {
    super(`no pending contribution with id "${id}". Run \`teamctx review list\` to see the queue.`);
    this.code = 'QUEUE_ITEM_NOT_FOUND';
    this.id = id;
  }
}

export function assertManager(config, { actor, displayName } = {}) {
  if (!canApprove(config, { actor, displayName })) {
    throw new ManagerGateError(config, { actor, displayName });
  }
  if (isLegacyManagerRef(config)) {
    // Names are settable by their owner, so a name-based gate is advisory only.
    console.warn(`Warning: config.manager is a display name ("${config.manager}"), which anyone can set as their own. Run \`teamctx config manager --repair\` as the manager to pin it to an identity.`);
  }
}

export async function listPendingReviews({ teamctxDir } = {}) {
  return listQueue(teamctxDir);
}

export async function approveReview({ id, teamctxDir, projectDir, actor } = {}) {
  const config = readConfig(teamctxDir);
  // The gate reads the resolved identity, never the caller-supplied `actor`.
  // That argument is attribution only: it is a claim, not a credential.
  const { actor: caller, displayName } = await currentIdentity(config, teamctxDir, projectDir);
  assertManager(config, { actor: caller, displayName });
  const who = actor || displayName;

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
  const approvedBy = who;
  await commitContext(
    // This is the commit that actually changes shared context, so it is the one
    // someone reads when asking where a Why came from. The queue item carried
    // the source through review; without this it would be lost at the last step.
    `context: ${item.author} contribution (approved by ${approvedBy})${note}${wsNote}${sourceTrailer(item.source)}`,
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
  const { actor: caller, displayName } = await currentIdentity(config, teamctxDir, projectDir);
  assertManager(config, { actor: caller, displayName });
  const rejectedBy = actor || displayName;

  let item;
  try { item = readQueueItem(id, teamctxDir); }
  catch { throw new QueueItemNotFoundError(id); }

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
