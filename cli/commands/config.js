import { readConfig, writeConfig } from '../../src/storage.js';
import { getModelsFor, getDefaultModelFor } from '../../src/ai.js';
import { resolveActor } from '../../src/actor.js';
import { setConfig } from './config.core.js';
import { writePrefs, resolveDisplayName, resolveIdentity } from '../../src/prefs.js';

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

/**
 * Who may approve or reject.
 *
 * Pinned to a stable identity, not a display name: display names are settable
 * by their owner (`teamctx config name`), so gating on one lets anyone claim
 * the manager's name and pass.
 */
export async function configManagerCommand(value, opts = {}) {
  const config = readConfig();
  const actor = await resolveActor({ config });

  if (value === undefined && !opts.me && !opts.clear) {
    const gate = config.managerKey
      ? `${config.managerKey} (identity — secure)`
      : (config.manager ? `${config.manager} (display name — advisory only)` : '(not set — anyone can approve/reject)');
    console.log(`\nCurrent manager gate: ${gate}`);
    console.log(`Your identity: ${actor.key}`);
    console.log('\nUsage: teamctx config manager --me        # pin the gate to you');
    console.log('       teamctx config manager @githublogin');
    console.log('       teamctx config manager --clear');
    if (config.manager && !config.managerKey) {
      console.log('\nWarning: a display name is not a secure gate — anyone can set that');
      console.log('name as their own with `teamctx config name`. Re-pin it with --me.');
    }
    return;
  }

  const requested = opts.clear ? '' : (opts.me ? '--me' : value);
  const r = await setConfig({ key: 'manager', value: requested });
  console.log(`✓ ${r.notes.join(' ')}`);
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


/**
 * Your display name on contributions. Personal, not project-wide: it is stored
 * against you under .teamctx/.local/ and never committed, so setting it does
 * not rename anyone else.
 */
export async function configNameCommand(value, opts = {}) {
  const config = readConfig();
  const actor = await resolveActor({ config });

  // `--clear` rather than an empty string: PowerShell drops `""` before the
  // process ever sees it, so an empty argument is indistinguishable from no
  // argument at all and there was no way to clear the override on Windows.
  const clearing = opts.clear === true
    || value === '""' || value === "''"
    || (value !== undefined && String(value).trim() === '');

  if (value === undefined && !clearing) {
    const current = await resolveIdentity({ actor, config });
    console.log(`\nYour name on contributions: ${current.name} (from: ${current.source})`);
    console.log('\nUsage: teamctx config name <your name>');
    console.log('       teamctx config name --clear   — drop the override and derive it again');
    return;
  }

  // Clearing removes the preference rather than storing a blank, so the name
  // is derived again — and keeps following the identity if it changes.
  const next = clearing ? '' : String(value).trim();
  if (!next) {
    await writePrefs(actor, { name: null }, undefined);
    const restored = await resolveIdentity({ actor, config });
    console.log(`✓ Override cleared — your name is derived again: ${restored.name} (from: ${restored.source})`);
    return;
  }
  await writePrefs(actor, { name: next }, undefined);
  console.log(`✓ Your name is now "${next}". (Personal setting — not committed.)`);
}
