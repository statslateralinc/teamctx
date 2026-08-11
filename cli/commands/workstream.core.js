import {
  readConfig, writeConfig, readWorkstream, writeWorkstream, writeWorkstreamMd,
  listWorkstreamIds, writeRoleFile, readContributions,
} from '../../src/storage.js';
import { proposeSubworkstreams, serializeToMd, generateRoleFile } from '../../src/context.js';
import { commitContext, pushContext } from '../../src/git.js';
import { slugify } from '../../src/roles.js';
import { UnknownWorkstreamError } from './role.core.js';
import { resolveActor } from '../../src/actor.js';
import { resolveActiveWorkstream, writePrefs } from '../../src/prefs.js';

/** The caller's active workstream — their own preference, then the project default. */
async function activeId(config, teamctxDir, projectDir) {
  const actor = await resolveActor({ config, cwd: projectDir });
  return resolveActiveWorkstream({ actor, config, teamctxDir });
}

export class WorkstreamSplitError extends Error {
  constructor(msg) { super(msg); this.code = 'WORKSTREAM_SPLIT'; }
}

function knownWorkstreams(config, teamctxDir) {
  return new Set([...(config.workstreams || []).map(w => w.id), ...listWorkstreamIds(teamctxDir)]);
}

async function commitAndOptionallyPush(config, msg, projectDir) {
  await commitContext(msg, projectDir ? { cwd: projectDir } : undefined);
  if (!config.autoPush) return { pushed: false, pushError: null };
  try { await pushContext(projectDir ? { cwd: projectDir } : undefined); return { pushed: true, pushError: null }; }
  catch (err) { return { pushed: false, pushError: err.message?.split('\n')[0] || err.stderr?.trim() || 'no remote?' }; }
}

export async function listAllWorkstreams({ teamctxDir, projectDir } = {}) {
  const config = readConfig(teamctxDir);
  const active = await activeId(config, teamctxDir, projectDir);
  const declared = config.workstreams || [];
  const onDisk = new Set(listWorkstreamIds(teamctxDir));
  const ids = Array.from(new Set([...declared.map(w => w.id), ...onDisk])).sort();
  return ids.map(id => {
    const meta = declared.find(w => w.id === id);
    const ws = readWorkstream(id, teamctxDir);
    const roles = (config.roles || []).filter(r => (r.workstream || 'main') === id).map(r => r.slug);
    return {
      id,
      name: meta?.name || ws.name || id,
      isActive: id === active,
      whyCount: ws.whys?.length || 0,
      roles,
    };
  });
}

export async function suggestWorkstreamSplits({ teamctxDir, projectDir } = {}) {
  const config = readConfig(teamctxDir);
  const active = await activeId(config, teamctxDir, projectDir);
  const workstream = readWorkstream(active, teamctxDir);
  const { splits, leftover } = await proposeSubworkstreams(workstream, config, config.roles || []);
  const enriched = splits.map(s => ({
    name: s.name,
    rationale: s.rationale || '',
    whyIds: s.whyIds,
    whys: s.whyIds.map(id => workstream.whys.find(w => w.id === id)).filter(Boolean),
  }));
  const leftoverWhys = leftover.map(id => workstream.whys.find(w => w.id === id)).filter(Boolean);
  return { activeId: active, workstream, splits: enriched, leftover: leftoverWhys };
}

async function applySplit({ source, sourceId, split, moveRoleSlugs, config, teamctxDir }) {
  const existingIds = knownWorkstreams(config, teamctxDir);
  const newId = slugify(split.name);
  if (!newId) throw new WorkstreamSplitError(`split name "${split.name}" produced an empty id.`);
  if (existingIds.has(newId)) throw new WorkstreamSplitError(`workstream id "${newId}" already exists.`);

  const movingWhys = source.whys.filter(w => split.whyIds.includes(w.id));
  if (movingWhys.length === 0) throw new WorkstreamSplitError(`no matching Why nodes for "${split.name}" (source may have changed).`);
  const remainingWhys = source.whys.filter(w => !split.whyIds.includes(w.id));
  const newWs = { id: newId, name: split.name, whys: movingWhys };
  const updatedSource = { ...source, whys: remainingWhys };

  writeWorkstream(newId, newWs, teamctxDir);
  writeWorkstreamMd(newId, serializeToMd(newWs, split.name), teamctxDir);
  writeWorkstream(sourceId, updatedSource, teamctxDir);
  const sourceName = config.workstreams?.find(w => w.id === sourceId)?.name || source.name || sourceId;
  writeWorkstreamMd(sourceId, serializeToMd(updatedSource, sourceName), teamctxDir);

  const rolesOnSource = (config.roles || []).filter(r => (r.workstream || 'main') === sourceId);
  const validMoveSlugs = (moveRoleSlugs || []).filter(s => rolesOnSource.some(r => r.slug === s));
  const unknownRequested = (moveRoleSlugs || []).filter(s => !rolesOnSource.some(r => r.slug === s));

  const updatedConfig = {
    ...config,
    workstreams: [...(config.workstreams || []), { id: newId, name: split.name, createdAt: new Date().toISOString() }],
    roles: (config.roles || []).map(r => validMoveSlugs.includes(r.slug) ? { ...r, workstream: newId } : r),
  };
  writeConfig(updatedConfig, teamctxDir);

  const contributions = readContributions(teamctxDir);
  for (const slug of validMoveSlugs) {
    const role = updatedConfig.roles.find(r => r.slug === slug);
    const md = await generateRoleFile(newWs, role, updatedConfig.project, updatedConfig, contributions);
    writeRoleFile(slug, md, teamctxDir);
  }
  const stillOnSource = (updatedConfig.roles || []).filter(r => (r.workstream || 'main') === sourceId);
  for (const role of stillOnSource) {
    const md = await generateRoleFile(updatedSource, role, updatedConfig.project, updatedConfig, contributions);
    writeRoleFile(role.slug, md, teamctxDir);
  }

  return { newId, movedWhyCount: movingWhys.length, movedRoles: validMoveSlugs, unknownRoles: unknownRequested };
}

export async function splitWorkstreams({ accepted, teamctxDir, projectDir } = {}) {
  if (!Array.isArray(accepted) || accepted.length === 0) {
    throw new WorkstreamSplitError('accepted must be a non-empty array of splits.');
  }
  const config = readConfig(teamctxDir);
  const active = await activeId(config, teamctxDir, projectDir);
  const source = readWorkstream(active, teamctxDir);
  if ((source.whys || []).length < 2) {
    throw new WorkstreamSplitError(`workstream "${active}" has fewer than 2 Why nodes — nothing to split.`);
  }

  const results = [];
  for (const split of accepted) {
    const fresh = readConfig(teamctxDir);
    const src = readWorkstream(active, teamctxDir);
    const r = await applySplit({
      source: src, sourceId: active, split,
      moveRoleSlugs: split.moveRoles || [],
      config: fresh, teamctxDir,
    });
    const finalConfig = readConfig(teamctxDir);
    const { pushed, pushError } = await commitAndOptionallyPush(
      finalConfig, `workstream: split "${split.name}" from ${active}`, projectDir,
    );
    results.push({ ...r, splitName: split.name, pushed, pushError });
  }
  return { sourceId: active, results };
}

/**
 * Switching workstream is a personal act, so it writes to the caller's
 * preferences rather than the shared config — no repo write, no commit, and no
 * effect on anyone else. `config.activeWorkstream` stays as the project default
 * for people who have never switched.
 */
export async function useWorkstream({ id, teamctxDir, projectDir } = {}) {
  const config = readConfig(teamctxDir);
  if (!knownWorkstreams(config, teamctxDir).has(id)) throw new UnknownWorkstreamError(id);
  const actor = await resolveActor({ config, cwd: projectDir });
  await writePrefs(actor, { activeWorkstream: id }, teamctxDir);
  return { activeWorkstream: id, actor: actor.name };
}
