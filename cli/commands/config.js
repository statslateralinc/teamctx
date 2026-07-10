import { readConfig, writeConfig } from '../../src/storage.js';
import { getModelsFor, getDefaultModelFor } from '../../src/ai.js';

const ALIASES = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
};

const PROVIDER_KEYS = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

export async function configProviderCommand(value) {
  const config = readConfig();
  const current = config.provider || 'anthropic';

  if (!value) {
    console.log(`\nCurrent provider: ${current}`);
    console.log('\nAvailable providers: anthropic, openai, gemini');
    console.log('\nUsage: teamctx config provider <anthropic|openai|gemini>');
    return;
  }

  const v = value.toLowerCase();
  if (!PROVIDER_KEYS[v]) {
    console.error(`Error: unknown provider "${value}". Valid: ${Object.keys(PROVIDER_KEYS).join(', ')}.`);
    process.exit(1);
  }

  const currentModel = config.model;
  const knownForNew = getModelsFor(v);
  const stillValid = knownForNew.some(m => m.id === currentModel);
  const nextModel = stillValid ? currentModel : getDefaultModelFor(v);

  writeConfig({ ...config, provider: v, model: nextModel });
  console.log(`✓ Provider set to ${v}`);
  if (!stillValid) {
    console.log(`  Model reset to ${nextModel} (was "${currentModel}", not valid for ${v}).`);
    console.log(`  Change with: teamctx config model <id>`);
  }
  if (!process.env[PROVIDER_KEYS[v]]) {
    console.log(`Note: ${PROVIDER_KEYS[v]} is not set. Add it to .env.local before running teamctx contribute, ask, or reflect.`);
  }
}

export async function configModelCommand(value) {
  const config = readConfig();
  const providerId = config.provider || 'anthropic';
  const models = getModelsFor(providerId);

  if (!value) {
    const current = models.find(m => m.id === config.model);
    console.log(`\nProvider: ${providerId}`);
    console.log(`Current model: ${config.model}${current ? ` (${current.label})` : ''}`);
    console.log(`\nAvailable models for ${providerId}:`);
    models.forEach(m => {
      const marker = m.id === config.model ? ' ←' : '';
      console.log(`  ${m.id.padEnd(24)} ${m.label}${marker}`);
    });
    console.log('\nUsage: teamctx config model <model-id>');
    return;
  }

  const resolved = ALIASES[value.toLowerCase()] || value;
  if (models.length && !models.find(m => m.id === resolved)) {
    console.warn(`Warning: "${resolved}" is not in the known model list for ${providerId}.`);
    console.warn(`Known: ${models.map(m => m.id).join(', ')}`);
    console.warn('Setting it anyway — remove or change with `teamctx config model` if it doesn\'t work.');
  }

  writeConfig({ ...config, model: resolved });
  const known = models.find(m => m.id === resolved);
  console.log(`✓ Model set to ${resolved}${known ? ` (${known.label})` : ''}`);
}

export async function configGithubRawBaseCommand(value) {
  const config = readConfig();
  if (!value) {
    console.log(`\nCurrent githubRawBase: ${config.githubRawBase || '(not set)'}`);
    console.log('\nUsage: teamctx config github-raw-base <url>');
    console.log('Example: teamctx config github-raw-base https://raw.githubusercontent.com/org/repo/main');
    return;
  }
  writeConfig({ ...config, githubRawBase: value });
  console.log(`✓ githubRawBase set to ${value}`);
}

export async function configManagerCommand(value) {
  const config = readConfig();
  if (!value) {
    console.log(`\nCurrent manager: ${config.manager || '(not set — solo mode: anyone can approve/reject)'}`);
    console.log(`Your identity (config.me): ${config.me}`);
    console.log('\nUsage: teamctx config manager <name>');
    console.log('Set to your `config.me` value to enable the approval gate.');
    console.log('Set to "" (empty) to disable the gate (solo mode).');
    return;
  }
  const next = value === '""' || value === "''" ? '' : value;
  writeConfig({ ...config, manager: next });
  if (!next) {
    console.log('✓ Manager gate cleared (solo mode: anyone can approve/reject).');
  } else {
    console.log(`✓ Manager set to ${next}. Only this identity may approve/reject pending contributions.`);
    if (config.me !== next) {
      console.log(`Note: your current identity (${config.me}) will no longer be able to approve/reject.`);
    }
  }
}

export async function configManagerEmailCommand(value) {
  const config = readConfig();
  if (!value) {
    console.log(`\nCurrent managerEmail: ${config.managerEmail || '(not set)'}`);
    console.log('\nUsage: teamctx config manager-email <email>');
    return;
  }
  writeConfig({ ...config, managerEmail: value });
  console.log(`✓ managerEmail set to ${value}`);
}

export async function configDeployUrlCommand(value) {
  const config = readConfig();
  if (!value) {
    console.log(`\nCurrent deployUrl: ${config.deployUrl || '(not set)'}`);
    console.log('\nUsage: teamctx config deploy-url <url>');
    console.log('Example: teamctx config deploy-url https://team-context-xyz.vercel.app');
    return;
  }
  writeConfig({ ...config, deployUrl: value });
  console.log(`✓ deployUrl set to ${value}`);
}
