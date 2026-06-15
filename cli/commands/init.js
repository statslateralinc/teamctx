import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ask, askChoice } from '../prompt.js';
import { checkGitRepo, commitContext, pushContext } from '../../src/git.js';
import { MODELS, DEFAULT_MODEL } from '../../src/ai.js';
import { writeConfig, writeShared, writeSharedMd } from '../../src/storage.js';
import { serializeToMd } from '../../src/context.js';

export async function initCommand() {
  await checkGitRepo();

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

  const modelIdx = await askChoice('AI model', MODELS.map(m => m.label), MODELS.findIndex(m => m.id === DEFAULT_MODEL));
  const model = MODELS[modelIdx].id;

  const autoPushAnswer = await ask('Auto-push to git after each update? (y/n)', 'y');
  const autoPush = autoPushAnswer.toLowerCase() === 'y';

  const deployUrl = await ask('Vercel deploy URL (optional, for team context links)', '');
  const githubRawBase = await ask('GitHub raw base URL (optional, e.g. https://raw.githubusercontent.com/org/repo/main)', '');
  const managerEmail = await ask('Your email (optional, for team contribution notifications)', '');

  mkdirSync(join(teamctxDir, 'context', 'roles'), { recursive: true });

  const config = { project, me, model, autoPush, deployUrl: deployUrl || '', githubRawBase: githubRawBase || '', managerEmail: managerEmail || '', roles: [] };
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
