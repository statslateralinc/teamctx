import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { checkGitRepo, commitContext, pushContext } from '../../src/git.js';
import { getModelsFor, getDefaultModelFor } from '../../src/ai.js';
import { readConfig, writeConfig, writeWorkstream, writeWorkstreamMd } from '../../src/storage.js';
import { getCurrentSession } from '../../src/session-context.js';
import { serializeToMd } from '../../src/context.js';
import { resolveActor } from '../../src/actor.js';
import { writePrefs } from '../../src/prefs.js';

const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic (Claude)', envVar: 'ANTHROPIC_API_KEY' },
  { id: 'openai',    label: 'OpenAI (GPT)',       envVar: 'OPENAI_API_KEY' },
  { id: 'gemini',    label: 'Google Gemini',      envVar: 'GEMINI_API_KEY' },
];

export function getProviders() { return PROVIDERS.map(p => ({ ...p })); }

/**
 * Hosted mode cannot stat a directory, so it asks the storage layer whether a
 * config is already readable — which is the thing "already initialized" really
 * means.
 */
function alreadyInitialized(hosted, teamctxDir) {
  if (!hosted) return existsSync(teamctxDir);
  try {
    readConfig();
    return true;
  } catch {
    return false;
  }
}

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
  source = 'cli',
}) {
  // Hosted mode has no checkout: `projectDir` is the GitHub context object, and
  // every write goes through the session-aware storage layer instead. Every
  // other write path in the codebase already branches on this — initProject was
  // the one that did not, so bootstrapping a project through the hosted MCP
  // server crashed on the first `join()`.
  const hosted = !!getCurrentSession();
  const gitCwd = hosted ? undefined : projectDir;

  if (!hosted && !projectDir) throw new Error('projectDir is required');
  if (!project) throw new Error('project name is required');
  if (!me) throw new Error('author name (me) is required');

  const providerMeta = PROVIDERS.find(p => p.id === provider);
  if (!providerMeta) {
    throw new Error(`unknown provider "${provider}". Valid: ${PROVIDERS.map(p => p.id).join(', ')}`);
  }

  await checkGitRepo({ cwd: gitCwd });

  // Nominal in hosted mode: the storage layer ignores `dir` when a session is
  // ambient and addresses everything from the repo root, so this is only ever
  // a real path locally.
  const teamctxDir = hosted ? '.teamctx' : join(projectDir, '.teamctx');
  if (alreadyInitialized(hosted, teamctxDir)) {
    throw new Error('.teamctx/ already exists. This project is already initialized.');
  }

  const models = getModelsFor(provider);
  const resolvedModel = model || getDefaultModelFor(provider);
  if (!models.some(m => m.id === resolvedModel)) {
    // lax registry: warn via return, don't hard-fail
  }

  // Both are filesystem-only. Git has no empty directories, so the tree is
  // implied by the files below; and the hosted session prefetches `.teamctx/**`
  // only, so there is no .gitignore in its buffer to rewrite.
  const gitignoreChanged = hosted ? false : unignoreTeamctx(projectDir);
  if (!hosted) mkdirSync(join(teamctxDir, 'context', 'roles'), { recursive: true });

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
  // Locally this reserves the file so the layout is complete on disk. Hosted,
  // appendContribution creates it on first write and readContributions already
  // treats absence as empty — committing an empty blob would be noise.
  if (!hosted) writeFileSync(join(teamctxDir, 'contributions.jsonl'), '');

  // Record the name they just chose as *their* preference, not only as the
  // project default. Without this, the next time they contribute their git
  // identity would silently override the handle they typed here.
  try {
    const actor = await resolveActor({ config, cwd: gitCwd });
    await writePrefs(actor, { name: me }, teamctxDir);
  } catch { /* preferences are best-effort; never block init */ }

  // Same note `contributeCore` puts on its commits: reading the history of a
  // repo initialized from a chat client, there is otherwise nothing to say where
  // the commit came from — no local checkout, no shell, just an author.
  const sourceNote = source === 'mcp' ? ' (via mcp)' : '';
  await commitContext(`chore: initialize teamctx for "${project}"${sourceNote}`, gitCwd ? { cwd: gitCwd } : undefined);

  let pushed = false;
  if (autoPush) {
    try { await pushContext(gitCwd ? { cwd: gitCwd } : undefined); pushed = true; } catch { /* no remote yet */ }
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
