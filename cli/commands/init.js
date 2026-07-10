import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { ask, askChoice } from '../prompt.js';
import { checkGitRepo, commitContext, pushContext } from '../../src/git.js';
import { getModelsFor, getDefaultModelFor } from '../../src/ai.js';
import { writeConfig, writeShared, writeSharedMd } from '../../src/storage.js';
import { serializeToMd } from '../../src/context.js';

function unignoreTeamctx() {
  const gitignorePath = join(process.cwd(), '.gitignore');
  if (!existsSync(gitignorePath)) return;
  const lines = readFileSync(gitignorePath, 'utf-8').split('\n');
  const filtered = lines.filter(l => l.trim() !== '.teamctx/' && l.trim() !== '.teamctx');
  if (filtered.length !== lines.length) {
    writeFileSync(gitignorePath, filtered.join('\n'));
    console.log('→ Removed .teamctx/ from .gitignore (it must be tracked in your private repo).\n');
  }
}

export async function initCommand() {
  await checkGitRepo();
  unignoreTeamctx();

  const teamctxDir = join(process.cwd(), '.teamctx');
  if (existsSync(teamctxDir)) {
    console.error('Error: .teamctx/ already exists. This project is already initialized.');
    process.exit(1);
  }

  console.log('\nWelcome to teamctx. Setting up your project context.\n');

  const project = await ask('Project name');
  if (!project) { console.error('Project name is required.'); process.exit(1); }

  const me = await ask('Your name or handle (used on contributions)');
  if (!me) { console.error('Name is required.'); process.exit(1); }

  const PROVIDERS = [
    { id: 'anthropic', label: 'Anthropic (Claude)',    envVar: 'ANTHROPIC_API_KEY' },
    { id: 'openai',    label: 'OpenAI (GPT)',          envVar: 'OPENAI_API_KEY' },
    { id: 'gemini',    label: 'Google Gemini',         envVar: 'GEMINI_API_KEY' },
  ];
  const providerIdx = await askChoice('AI provider', PROVIDERS.map(p => p.label), 0);
  const providerId = PROVIDERS[providerIdx].id;
  const providerEnvVar = PROVIDERS[providerIdx].envVar;

  const models = getModelsFor(providerId);
  const defaultModel = getDefaultModelFor(providerId);
  const modelIdx = await askChoice('AI model', models.map(m => m.label), models.findIndex(m => m.id === defaultModel));
  const model = models[modelIdx].id;

  if (!process.env[providerEnvVar]) {
    console.log(`\nNote: ${providerEnvVar} is not set. Add it to .env.local before running teamctx contribute, ask, or reflect.`);
  }

  const autoPushAnswer = await ask('Auto-push to git after each update? (y/n)', 'y');
  const autoPush = autoPushAnswer.toLowerCase() === 'y';

  const deployUrl = await ask('Vercel deploy URL (optional, for team context links)', '');
  const githubRawBase = await ask('GitHub raw base URL (optional, e.g. https://raw.githubusercontent.com/org/repo/main)', '');
  const managerEmail = await ask('Your email (optional, for team contribution notifications)', '');

  mkdirSync(join(teamctxDir, 'context', 'roles'), { recursive: true });

  const config = { project, me, provider: providerId, model, autoPush, deployUrl: deployUrl || '', githubRawBase: githubRawBase || '', managerEmail: managerEmail || '', roles: [] };
  writeConfig(config, teamctxDir);

  const workstream = { id: 'main', name: project, whys: [] };
  writeShared(workstream, teamctxDir);
  writeSharedMd(serializeToMd(workstream, project), teamctxDir);
  writeFileSync(join(teamctxDir, 'contributions.jsonl'), '');

  await commitContext(`chore: initialize teamctx for "${project}"`);

  if (autoPush) {
    try { await pushContext(); } catch { console.log('Note: push skipped (no remote yet).'); }
  }

  console.log(`\n✓ teamctx initialized for "${project}"`);
  console.log('\nNext steps:');
  console.log('  teamctx contribute "<your first project update>"');
  console.log('  teamctx role add');
}
