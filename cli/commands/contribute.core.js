import { readConfig, readWorkstream, writeWorkstream, writeWorkstreamMd, appendContribution, writeRoleFile, writeQueueItem, readContributions, listWorkstreamIds } from '../../src/storage.js';
import { updateShared, generateRoleFile, serializeToMd } from '../../src/context.js';
import { commitContext, pushContext } from '../../src/git.js';
import { UnknownWorkstreamError } from './role.core.js';

function newContribution({ text, author, tagged, source, workstream }) {
  const idPrefix = source === 'mcp' ? 'mcp' : 'c';
  return {
    id: `${idPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ts: new Date().toISOString(),
    author,
    text,
    tagged: tagged || null,
    source: source || 'cli',
    workstream: workstream || 'main',
    status: 'logged',
  };
}

function workstreamDisplayName(id, workstream, config) {
  return config.workstreams?.find(w => w.id === id)?.name || workstream.name || config.project;
}

async function commitAndOptionallyPush(config, msg, projectDir) {
  await commitContext(msg, projectDir ? { cwd: projectDir } : undefined);
  if (!config.autoPush) return { pushed: false, pushError: null };
  try { await pushContext(projectDir ? { cwd: projectDir } : undefined); return { pushed: true, pushError: null }; }
  catch (err) { return { pushed: false, pushError: err.message?.split('\n')[0] || err.stderr?.trim() || 'no remote?' }; }
}

export async function contributeCore({
  text, author, workstreamId, decision = false, apply = false,
  source = 'cli', teamctxDir, projectDir,
} = {}) {
  if (!text) throw new Error('contribution text is required');
  const config = readConfig(teamctxDir);
  const actor = author || config.me;
  const targetId = workstreamId || config.activeWorkstream || 'main';
  const known = new Set([
    ...(config.workstreams || []).map(w => w.id),
    ...listWorkstreamIds(teamctxDir),
  ]);
  if (known.size > 0 && !known.has(targetId)) throw new UnknownWorkstreamError(targetId);

  const workstream = readWorkstream(targetId, teamctxDir);
  const tagged = decision ? 'decision' : null;
  const contribution = newContribution({ text, author: actor, tagged, source, workstream: targetId });
  appendContribution(contribution, teamctxDir);

  const { workstream: updated, summary, operations } = await updateShared(workstream, contribution, config);

  if (!operations || operations.length === 0) {
    return {
      id: contribution.id, workstream: targetId, author: actor, source,
      mode: 'no-op', summary: 'No changes to context tree (contribution logged).',
      operations: [], pushed: false, pushError: null,
    };
  }

  if (!apply) {
    writeQueueItem({
      id: contribution.id, status: 'pending', createdAt: contribution.ts,
      author: contribution.author, source, workstream: targetId,
      text: contribution.text, tagged: contribution.tagged, summary, operations,
    }, teamctxDir);
    const { pushed, pushError } = await commitAndOptionallyPush(
      config, `queue: ${actor} submission pending approval (${contribution.id})`, projectDir,
    );
    return {
      id: contribution.id, workstream: targetId, author: actor, source,
      mode: 'queued', summary, operations, pushed, pushError,
    };
  }

  writeWorkstream(targetId, updated, teamctxDir);
  const contributions = readContributions(teamctxDir);
  writeWorkstreamMd(
    targetId,
    serializeToMd(updated, workstreamDisplayName(targetId, updated, config), actor, contributions),
    teamctxDir,
  );

  const rolesOnTarget = (config.roles || []).filter(r => (r.workstream || 'main') === targetId);
  const rolesRegenerated = [];
  for (const role of rolesOnTarget) {
    const md = await generateRoleFile(updated, role, config.project, config, contributions);
    writeRoleFile(role.slug, md, teamctxDir);
    rolesRegenerated.push(role.slug);
  }

  const note = tagged === 'decision' ? ' [decision]' : '';
  const wsNote = targetId === 'main' ? '' : ` (${targetId})`;
  const sourceNote = source === 'mcp' ? ' (via mcp)' : '';
  const { pushed, pushError } = await commitAndOptionallyPush(
    config, `context: ${actor} contribution${sourceNote}${note}${wsNote}`, projectDir,
  );

  return {
    id: contribution.id, workstream: targetId, author: actor, source,
    mode: 'applied', summary, operations, rolesRegenerated, pushed, pushError,
  };
}
