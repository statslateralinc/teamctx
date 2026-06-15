import { readConfig, writeConfig } from '../../src/storage.js';
import { MODELS } from '../../src/ai.js';

const ALIASES = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
};

export async function configModelCommand(value) {
  const config = readConfig();

  if (!value) {
    const current = MODELS.find(m => m.id === config.model);
    console.log(`\nCurrent model: ${config.model}${current ? ` (${current.label})` : ''}`);
    console.log('\nAvailable models:');
    MODELS.forEach(m => {
      const marker = m.id === config.model ? ' ←' : '';
      console.log(`  ${m.id.padEnd(24)} ${m.label}${marker}`);
    });
    console.log('\nUsage: teamctx config model <opus|sonnet|haiku|full-model-id>');
    return;
  }

  const resolved = ALIASES[value.toLowerCase()] || value;
  if (!MODELS.find(m => m.id === resolved)) {
    console.error(`Error: unknown model "${value}".`);
    console.error(`Valid options: ${MODELS.map(m => m.id).join(', ')}`);
    console.error(`Or use short names: opus, sonnet, haiku`);
    process.exit(1);
  }

  writeConfig({ ...config, model: resolved });
  const label = MODELS.find(m => m.id === resolved).label;
  console.log(`✓ Model set to ${resolved} (${label})`);
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
