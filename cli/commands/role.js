import { ask, askChoice } from '../prompt.js';
import { readConfig, readWorkstream, listWorkstreamIds } from '../../src/storage.js';
import {
  listRoles as coreListRoles, suggestRoles as coreSuggestRoles,
  suggestRoleDetails, addRoleFull, assignRole,
  slugify, UnknownRoleError, UnknownWorkstreamError,
} from './role.core.js';

function cliError(err) {
  if (err instanceof UnknownRoleError || err instanceof UnknownWorkstreamError) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

export async function roleCommand(subcommand, opts) {
  if (subcommand === 'list') return listRolesCli();
  if (subcommand === 'add' && opts.suggest) return suggestAndAdd(opts);
  if (subcommand === 'add') return addRoleInteractive({}, opts);
  return addRoleInteractive({}, opts);
}

export async function roleAssignCommand(slug, opts) {
  const targetId = opts.workstream;
  if (!targetId) {
    console.error('Error: --workstream <id> is required.');
    process.exit(1);
  }
  let result;
  try { result = await assignRole({ slug, workstreamId: targetId }); }
  catch (err) { cliError(err); return; }
  if (!result.changed) {
    console.log(`Role "${slug}" is already on workstream "${targetId}".`);
    return;
  }
  console.log(`✓ Role "${slug}" is now on workstream "${targetId}".`);
}

async function listRolesCli() {
  const config = readConfig();
  const roles = coreListRoles();
  if (roles.length === 0) {
    console.log('No roles defined yet. Run `teamctx role add` to add one.');
    return;
  }
  console.log(`\nRoles for "${config.project}":\n`);
  roles.forEach(r => {
    const url = config.deployUrl ? `${config.deployUrl}/context/${r.slug}` : `[deploy-url]/context/${r.slug}`;
    console.log(`  ${r.slug.padEnd(20)} ${r.name}`);
    console.log(`  ${''.padEnd(20)} ${url}\n`);
  });
}

async function addRoleInteractive(prefill = {}, opts = {}) {
  const config = readConfig();
  const workstreamId = opts.workstream || config.activeWorkstream || 'main';
  const known = new Set([...(config.workstreams || []).map(w => w.id), ...listWorkstreamIds()]);
  if (config.workstreams && !known.has(workstreamId)) {
    console.error(`Error: no workstream "${workstreamId}". Run \`teamctx workstream list\`.`);
    process.exit(1);
  }
  console.log('\nDefining a new role. Press Enter to skip optional fields.\n');

  const name = prefill.name || await ask('Role title (e.g. "Chief Product Officer")');
  if (!name) { console.error('Role title is required.'); process.exit(1); }

  let defaultResponsibilities = prefill.responsibilities || '';
  let defaultExcludes = prefill.excludes || '';

  if (!prefill.responsibilities) {
    process.stdout.write('  → Asking Haiku to suggest...');
    try {
      const workstream = readWorkstream(workstreamId);
      const suggestion = await suggestRoleDetails({ name, workstream, config });
      defaultResponsibilities = suggestion.responsibilities;
      defaultExcludes = suggestion.excludes;
      process.stdout.write(' done.\n\n');
    } catch {
      process.stdout.write(' skipped.\n\n');
    }
  }

  const responsibilities = await ask('What do they own?', defaultResponsibilities);
  if (!responsibilities) { console.error('Responsibilities are required.'); process.exit(1); }

  const excludes = await ask('What should they NOT worry about? (optional)', defaultExcludes);
  const email = await ask('Team member email (optional — for contribution notifications)', '');

  console.log('\n→ Role profile:');
  console.log(`  Name:     ${name} (${slugify(name)})`);
  console.log(`  Owns:     ${responsibilities}`);
  if (excludes) console.log(`  Excludes: ${excludes}`);
  if (email) console.log(`  Email:    ${email}`);

  const confirm = await ask('\nSave this role? (y/n)', 'y');
  if (confirm.toLowerCase() !== 'y') { console.log('Cancelled.'); return; }

  let result;
  try {
    result = await addRoleFull({ name, responsibilities, excludes, email, workstreamId });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  if (result.pushError) {
    console.log(`Note: push failed (${result.pushError}) — check your git remote.`);
  }

  const url = config.deployUrl ? `${config.deployUrl}/context/${result.slug}` : `[your-vercel-url]/context/${result.slug}`;
  console.log(`\n✓ Role created: ${name} (${result.slug})`);
  console.log(`  Context URL: ${url}`);
  console.log(`  Share this — team member opens URL, copies MD, pastes into ChatGPT / Claude.\n`);
}

async function suggestAndAdd(opts = {}) {
  const { workstreamId, suggestions } = await coreSuggestRoles({ workstreamId: opts.workstream });

  console.log(`\n→ Analyzing workstream "${workstreamId}" to suggest roles...\n`);
  if (!suggestions.length) {
    console.log('No suggestions returned. Run `teamctx role add` to define one manually.');
    return;
  }

  suggestions.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.name}`);
    console.log(`     Owns: ${r.responsibilities}`);
    if (r.excludes) console.log(`     Excludes: ${r.excludes}`);
    console.log();
  });

  const idx = await askChoice('Add which role? (0 to cancel)', ['Cancel', ...suggestions.map(r => r.name)], 0);
  if (idx === 0) { console.log('Cancelled.'); return; }
  await addRoleInteractive(suggestions[idx - 1], opts);
}
