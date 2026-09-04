import { readConfig, writeConfig } from '../../src/storage.js';
import { getModelsFor, getDefaultModelFor } from '../../src/ai.js';
import { resolveActor } from '../../src/actor.js';
import { managerKeys } from '../../src/review.js';
import { isBrokenGate } from '../../src/manager-repair.js';
import { setConfig, repairManagerGate } from './config.core.js';
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
 * Read-only. The gate is pinned at `init` to whoever set the project up and is
 * not settable afterwards: a caller able to write it can grant themselves
 * approval and sign off their own submissions. Showing it stays useful — it is
 * how anyone finds out who to ask.
 */
export async function configManagerCommand(opts = {}) {
  if (opts.repair) {
    try {
      const r = await repairManagerGate();
      console.log('\n✓ Manager gate repaired.');
      console.log(`  was: ${r.from}`);
      console.log(`  now: ${r.to} (${r.name})`);
      if (r.warning) console.log(`\n  Note: ${r.warning}`);
      console.log('\nCommit and push .teamctx/config.json — the hosted server reads it from GitHub.\n');
    } catch (err) {
      console.error(`\nError: ${err.message}\n`);
      process.exit(1);
    }
    return;
  }

  const config = readConfig();
  const actor = await resolveActor({ config });
  const keys = managerKeys(config);

  const gate = keys.length
    ? keys.join(', ')
    : (config.manager ? `${config.manager} (display name — advisory only)` : '(not set — anyone can approve/reject)');
  console.log(`\nManager: ${gate}`);
  console.log(`You:     ${actor.key}`);

  if (isBrokenGate(config)) {
    // Worth saying without being asked: nobody can pass this gate, so every
    // approval on this project is already failing.
    console.log('\nThis gate is a display name, not an identity — nobody can match it,');
    console.log('including you. Re-pin it to yourself: teamctx config manager --repair');
  } else if (keys.length && !keys.includes(actor.key) && !keys.some(k => k === `git:${actor.email || ''}`)) {
    // The same person is a different key on a clone and in a chat client, so
    // this is worth saying plainly rather than leaving to be discovered at the
    // moment an approval is refused.
    console.log('\nThis identity is not the manager, so you cannot approve or reject here.');
  }
  if (!keys.length) {
    console.log('\nThis project predates the pinned gate. The next `teamctx init` would set it;');
    console.log('until something does, anyone reaching this project can approve.');
  }
  console.log('');
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
