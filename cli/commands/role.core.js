import { readConfig, writeConfig, readWorkstream, listWorkstreamIds, writeRoleFile, readContributions } from '../../src/storage.js';
import { addRole as addRoleData, suggestRoles as aiSuggestRoles, slugify } from '../../src/roles.js';
import { generateRoleFile } from '../../src/context.js';
import { commitContext, pushContext } from '../../src/git.js';
import { callClaude, extractJson, getFastModelFor } from '../../src/ai.js';

export class UnknownRoleError extends Error {
  constructor(slug) { super(`no role "${slug}". Run \`teamctx role list\` to see options.`); this.code = 'UNKNOWN_ROLE'; }
}
export class UnknownWorkstreamError extends Error {
  constructor(id) { super(`no workstream "${id}". Run \`teamctx workstream list\`.`); this.code = 'UNKNOWN_WORKSTREAM'; }
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

export function listRoles({ teamctxDir } = {}) {
  const config = readConfig(teamctxDir);
  return config.roles || [];
}

export async function suggestRoleDetails({ name, workstream, config }) {
  const tree = workstream.whys.map(w => `- ${w.text}`).join('\n') || '(no context yet)';
  const prompt = [
    `Given the role "${name}" at a company with this context:`,
    tree,
    ``,
    `Suggest brief, specific responsibilities and exclusions for this role.`,
    `Return JSON: {"responsibilities": "...", "excludes": "..."}`,
    `Keep each under 15 words. JSON only.`,
  ].join('\n');
  const raw = await callClaude({ prompt, model: getFastModelFor(config.provider), config });
  const parsed = extractJson(raw);
  return { responsibilities: parsed.responsibilities || '', excludes: parsed.excludes || '' };
}

export async function suggestRoles({ workstreamId, teamctxDir } = {}) {
  const config = readConfig(teamctxDir);
  const wsId = workstreamId || config.activeWorkstream || 'main';
  const workstream = readWorkstream(wsId, teamctxDir);
  const suggestions = await aiSuggestRoles(workstream, config);
  return { workstreamId: wsId, suggestions };
}

export async function addRoleFull({
  name, responsibilities, excludes, email,
  workstreamId, teamctxDir, projectDir,
} = {}) {
  if (!name) throw new Error('role name is required');
  if (!responsibilities) throw new Error('responsibilities are required');
  const config = readConfig(teamctxDir);
  const wsId = workstreamId || config.activeWorkstream || 'main';
  if (!knownWorkstreams(config, teamctxDir).has(wsId)) throw new UnknownWorkstreamError(wsId);

  const { slug, config: updatedConfig } = addRoleData({
    name, responsibilities, excludes: excludes || '', email: email || undefined, workstream: wsId,
  }, config);
  writeConfig(updatedConfig, teamctxDir);

  const workstream = readWorkstream(wsId, teamctxDir);
  const contributions = readContributions(teamctxDir);
  const roleData = updatedConfig.roles.find(r => r.slug === slug);
  const md = await generateRoleFile(workstream, roleData, updatedConfig.project, updatedConfig, contributions);
  writeRoleFile(slug, md, teamctxDir);

  const { pushed, pushError } = await commitAndOptionallyPush(
    updatedConfig, `feat: add role "${slug}" to teamctx`, projectDir,
  );

  return { slug, role: roleData, workstreamId: wsId, pushed, pushError };
}

export async function assignRole({ slug, workstreamId, teamctxDir, projectDir } = {}) {
  const config = readConfig(teamctxDir);
  const role = (config.roles || []).find(r => r.slug === slug);
  if (!role) throw new UnknownRoleError(slug);
  if (!workstreamId) throw new Error('workstreamId is required');
  if (!knownWorkstreams(config, teamctxDir).has(workstreamId)) throw new UnknownWorkstreamError(workstreamId);
  if ((role.workstream || 'main') === workstreamId) {
    return { slug, workstreamId, changed: false, pushed: false, pushError: null };
  }

  const updatedConfig = {
    ...config,
    roles: config.roles.map(r => r.slug === slug ? { ...r, workstream: workstreamId } : r),
  };
  writeConfig(updatedConfig, teamctxDir);

  const workstream = readWorkstream(workstreamId, teamctxDir);
  const contributions = readContributions(teamctxDir);
  const md = await generateRoleFile(
    workstream, updatedConfig.roles.find(r => r.slug === slug),
    updatedConfig.project, updatedConfig, contributions,
  );
  writeRoleFile(slug, md, teamctxDir);

  const { pushed, pushError } = await commitAndOptionallyPush(
    updatedConfig, `role: assign "${slug}" to workstream ${workstreamId}`, projectDir,
  );

  return { slug, workstreamId, changed: true, pushed, pushError };
}

export { slugify };
