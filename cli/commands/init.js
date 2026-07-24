import { ask, askChoice } from '../prompt.js';
import { getModelsFor, getDefaultModelFor } from '../../src/ai.js';
import { getProviders, initProject } from './init.core.js';

export async function initCommand() {
  console.log('\nWelcome to teamctx. Setting up your project context.\n');

  const project = await ask('Project name');
  if (!project) { console.error('Project name is required.'); process.exit(1); }

  const me = await ask('Your name or handle (used on contributions)');
  if (!me) { console.error('Name is required.'); process.exit(1); }

  const providers = getProviders();
  const providerIdx = await askChoice('AI provider', providers.map(p => p.label), 0);
  const provider = providers[providerIdx].id;

  const models = getModelsFor(provider);
  const defaultModel = getDefaultModelFor(provider);
  const modelIdx = await askChoice('AI model', models.map(m => m.label), models.findIndex(m => m.id === defaultModel));
  const model = models[modelIdx].id;

  const autoPushAnswer = await ask('Auto-push to git after each update? (y/n)', 'y');
  const autoPush = autoPushAnswer.toLowerCase() === 'y';

  const deployUrl = await ask('Vercel deploy URL (optional, for team context links)', '');
  const githubRawBase = await ask('GitHub raw base URL (optional, e.g. https://raw.githubusercontent.com/org/repo/main)', '');
  const managerEmail = await ask('Your email (optional, for team contribution notifications)', '');

  const result = await initProject({
    projectDir: process.cwd(),
    project, me, provider, model, autoPush,
    deployUrl, githubRawBase, managerEmail,
  });

  if (result.gitignoreChanged) {
    console.log('→ Removed .teamctx/ from .gitignore (it must be tracked in your private repo).\n');
  }
  if (!result.envVarPresent) {
    console.log(`\nNote: ${result.envVarNeeded} is not set. Add it to .env.local before running teamctx contribute, ask, or reflect.`);
  }
  if (result.config.autoPush && !result.pushed) {
    console.log('Note: push skipped (no remote yet).');
  }

  console.log(`\n✓ teamctx initialized for "${result.config.project}"`);
  console.log('\nNext steps:');
  console.log('  teamctx contribute "<your first project update>"');
  console.log('  teamctx role add');
}
