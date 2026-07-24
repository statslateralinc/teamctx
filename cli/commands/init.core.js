import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { checkGitRepo, commitContext, pushContext } from '../../src/git.js';
import { getModelsFor, getDefaultModelFor } from '../../src/ai.js';
import { writeConfig, writeWorkstream, writeWorkstreamMd } from '../../src/storage.js';
import { serializeToMd } from '../../src/context.js';

const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic (Claude)', envVar: 'ANTHROPIC_API_KEY' },
  { id: 'openai',    label: 'OpenAI (GPT)',       envVar: 'OPENAI_API_KEY' },
  { id: 'gemini',    label: 'Google Gemini',      envVar: 'GEMINI_API_KEY' },
];

export function getProviders() { return PROVIDERS.map(p => ({ ...p })); }

export function unignoreTeamctx(projectDir) {
  const gitignorePath = join(projectDir, '.gitignore');
  if (!existsSync(gitignorePath)) return false;
  const lines = readFileSync(gitignorePath, 'utf-8').split('\n');
  const filtered = lines.filter(l => l.trim() !== '.teamctx/' && l.trim() !== '.teamctx');
  if (filtered.length === lines.length) return false;
  writeFileSync(gitignorePath, filtered.join('\n'));
  return true;
}

export async function initProject({
  projectDir,
  project,
  me,
  provider = 'anthropic',
  model,
  autoPush = true,
  deployUrl = '',
  githubRawBase = '',
  managerEmail = '',
}) {
  if (!projectDir) throw new Error('projectDir is required');
  if (!project) throw new Error('project name is required');
  if (!me) throw new Error('author name (me) is required');

  const providerMeta = PROVIDERS.find(p => p.id === provider);
  if (!providerMeta) {
    throw new Error(`unknown provider "${provider}". Valid: ${PROVIDERS.map(p => p.id).join(', ')}`);
  }

  await checkGitRepo({ cwd: projectDir });

  const teamctxDir = join(projectDir, '.teamctx');
  if (existsSync(teamctxDir)) {
    throw new Error('.teamctx/ already exists. This project is already initialized.');
  }

  const models = getModelsFor(provider);
  const resolvedModel = model || getDefaultModelFor(provider);
  if (!models.some(m => m.id === resolvedModel)) {
    // lax registry: warn via return, don't hard-fail
  }

  const gitignoreChanged = unignoreTeamctx(projectDir);

  mkdirSync(join(teamctxDir, 'context', 'roles'), { recursive: true });

  const createdAt = new Date().toISOString();
  const config = {
    project, me, provider, model: resolvedModel, autoPush,
    deployUrl: deployUrl || '', githubRawBase: githubRawBase || '', managerEmail: managerEmail || '',
    roles: [],
    workstreams: [{ id: 'main', name: project, createdAt }],
    activeWorkstream: 'main',
    workstreamsMigrated: true,
  };
  writeConfig(config, teamctxDir);

  const workstream = { id: 'main', name: project, whys: [] };
  writeWorkstream('main', workstream, teamctxDir);
  writeWorkstreamMd('main', serializeToMd(workstream, project), teamctxDir);
  writeFileSync(join(teamctxDir, 'contributions.jsonl'), '');

  await commitContext(`chore: initialize teamctx for "${project}"`, { cwd: projectDir });

  let pushed = false;
  if (autoPush) {
    try { await pushContext({ cwd: projectDir }); pushed = true; } catch { /* no remote yet */ }
  }

  return {
    projectDir,
    teamctxDir,
    config,
    gitignoreChanged,
    envVarNeeded: providerMeta.envVar,
    envVarPresent: !!process.env[providerMeta.envVar],
    pushed,
  };
}
