import { readConfig, readWorkstream, writeWorkstream, writeWorkstreamMd, readContributions, writeRoleFile } from '../../src/storage.js';
import { generateReflection, serializeToMd, generateRoleFile } from '../../src/context.js';
import { extractJson } from '../../src/ai.js';
import { commitContext, pushContext } from '../../src/git.js';
import { UnknownWorkstreamError } from './role.core.js';

export async function reflectWorkstream({ workstreamId, teamctxDir, projectDir } = {}) {
  const config = readConfig(teamctxDir);
  const targetId = workstreamId || config.activeWorkstream || 'main';
  const workstream = readWorkstream(targetId, teamctxDir);
  if (!workstream) throw new UnknownWorkstreamError(targetId);
  const contributions = readContributions(teamctxDir);

  const raw = await generateReflection(workstream, contributions, config);
  let updated;
  try {
    const parsed = extractJson(raw);
    updated = { ...workstream, whys: Array.isArray(parsed.whys) ? parsed.whys : workstream.whys };
  } catch (err) {
    throw new Error(`AI returned invalid JSON. Reflection aborted. ${err.message}`);
  }

  const wsName = config.workstreams?.find(w => w.id === targetId)?.name || workstream.name || config.project;
  writeWorkstream(targetId, updated, teamctxDir);
  writeWorkstreamMd(targetId, serializeToMd(updated, wsName, 'reflect', contributions), teamctxDir);

  const rolesOnTarget = (config.roles || []).filter(r => (r.workstream || 'main') === targetId);
  const rolesRegenerated = [];
  for (const role of rolesOnTarget) {
    const md = await generateRoleFile(updated, role, config.project, config, contributions);
    writeRoleFile(role.slug, md, teamctxDir);
    rolesRegenerated.push(role.slug);
  }

  await commitContext(`context: reflect ${targetId} — AI rewrote shared context`, projectDir ? { cwd: projectDir } : undefined);
  let pushed = false, pushError = null;
  if (config.autoPush) {
    try { await pushContext(projectDir ? { cwd: projectDir } : undefined); pushed = true; }
    catch (err) { pushError = err.message?.split('\n')[0] || err.stderr?.trim() || 'no remote?'; }
  }

  return { workstreamId: targetId, updatedTree: updated, rolesRegenerated, pushed, pushError };
}
