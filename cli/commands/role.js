import { ask, askChoice } from '../prompt.js';
import { readConfig, writeConfig, readShared, readWorkstream, listWorkstreamIds, writeRoleFile, readContributions } from '../../src/storage.js';
import { addRole, suggestRoles, slugify } from '../../src/roles.js';
import { generateRoleFile } from '../../src/context.js';
import { commitContext, pushContext } from '../../src/git.js';
import { callClaude, extractJson, getFastModelFor } from '../../src/ai.js';

async function suggestRoleDetails(name, workstream, config) {
  const tree = workstream.whys.map(w => `- ${w.text}`).join('\n') || '(no context yet)';
  const prompt = [
    `Given the role "${name}" at a company with this context:`,
    tree,
    ``,
    `Suggest brief, specific responsibilities and exclusions for this role.`,
    `Return JSON: {"responsibilities": "...", "excludes": "..."}`,
    `Keep each under 15 words. JSON only.`,
  ].join('\n');
  const raw = await callClaude({ prompt, model: getFastModelFor(config.provider), config });
  const parsed = extractJson(raw);
  return { responsibilities: parsed.responsibilities || '', excludes: parsed.excludes || '' };
}

export async function roleCommand(subcommand, opts) {
  if (subcommand === 'list') return listRoles();
  if (subcommand === 'add' && opts.suggest) return suggestAndAdd(opts);
  if (subcommand === 'add') return addRoleInteractive({}, opts);
  return addRoleInteractive({}, opts);
}

export async function roleAssignCommand(slug, opts) {
  const config = readConfig();
  const role = (config.roles || []).find(r => r.slug === slug);
  if (!role) {
    console.error(`Error: no role "${slug}". Run \`teamctx role list\` to see options.`);
    process.exit(1);
  }
  const targetId = opts.workstream;
  if (!targetId) {
    console.error('Error: --workstream <id> is required.');
    process.exit(1);
  }
  const known = new Set([...(config.workstreams || []).map(w => w.id), ...listWorkstreamIds()]);
  if (!known.has(targetId)) {
    console.error(`Error: no workstream "${targetId}". Run \`teamctx workstream list\`.`);
    process.exit(1);
  }
  if ((role.workstream || 'main') === targetId) {
    console.log(`Role "${slug}" is already on workstream "${targetId}".`);
    return;
  }

  const updatedConfig = {
    ...config,
    roles: config.roles.map(r => r.slug === slug ? { ...r, workstream: targetId } : r),
  };
  writeConfig(updatedConfig);

  const workstream = readWorkstream(targetId);
  const contributions = readContributions();
  const md = await generateRoleFile(workstream, updatedConfig.roles.find(r => r.slug === slug), updatedConfig.project, updatedConfig, contributions);
  writeRoleFile(slug, md);

  await commitContext(`role: assign "${slug}" to workstream ${targetId}`);
  if (updatedConfig.autoPush) {
    try { await pushContext(); } catch { /* non-fatal */ }
  }
  console.log(`✓ Role "${slug}" is now on workstream "${targetId}".`);
}

async function listRoles() {
  const config = readConfig();
  if (config.roles.length === 0) {
    console.log('No roles defined yet. Run `teamctx role add` to add one.');
    return;
  }
  console.log(`\nRoles for "${config.project}":\n`);
  config.roles.forEach(r => {
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
      const workstream = readShared();
      const suggestion = await suggestRoleDetails(name, workstream, config);
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

  let slug, updatedConfig;
  try {
    const result = addRole({ name, responsibilities, excludes, email: email || undefined, workstream: workstreamId }, config);
    slug = result.slug;
    updatedConfig = result.config;
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  writeConfig(updatedConfig);

  console.log(`\n→ Generating context file for ${name} from workstream "${workstreamId}"...`);
  const workstream = readWorkstream(workstreamId);
  const contributions = readContributions();
  const roleData = updatedConfig.roles.find(r => r.slug === slug);
  const md = await generateRoleFile(workstream, roleData, config.project, config, contributions);
  writeRoleFile(slug, md);

  await commitContext(`feat: add role "${slug}" to teamctx`);
  if (config.autoPush) {
    try { await pushContext(); } catch (err) { console.log(`Note: push failed (${err.message?.split('\n')[0] || err.stderr?.trim() || 'no remote?'}) — check your git remote.`); }
  }

  const url = config.deployUrl ? `${config.deployUrl}/context/${slug}` : `[your-vercel-url]/context/${slug}`;
  console.log(`\n✓ Role created: ${name} (${slug})`);
  console.log(`  Context URL: ${url}`);
  console.log(`  Share this — team member opens URL, copies MD, pastes into ChatGPT / Claude.\n`);
}

async function suggestAndAdd(opts = {}) {
  const config = readConfig();
  const workstreamId = opts.workstream || config.activeWorkstream || 'main';
  const workstream = readWorkstream(workstreamId);

  console.log(`\n→ Analyzing workstream "${workstreamId}" to suggest roles...\n`);
  const suggestions = await suggestRoles(workstream, config);

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
