import { ask, askChoice } from '../prompt.js';
import { readConfig, writeConfig, readShared, writeRoleFile } from '../../src/storage.js';
import { addRole, suggestRoles, slugify } from '../../src/roles.js';
import { generateRoleFile } from '../../src/context.js';
import { commitContext, pushContext } from '../../src/git.js';
import { callClaude, extractJson } from '../../src/ai.js';

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
  const raw = await callClaude({ prompt, model: 'claude-haiku-4-5' });
  const parsed = extractJson(raw);
  return { responsibilities: parsed.responsibilities || '', excludes: parsed.excludes || '' };
}

export async function roleCommand(subcommand, opts) {
  if (subcommand === 'list') return listRoles();
  if (subcommand === 'add' && opts.suggest) return suggestAndAdd();
  return addRoleInteractive();
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

async function addRoleInteractive(prefill = {}) {
  const config = readConfig();
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
    const result = addRole({ name, responsibilities, excludes, email: email || undefined }, config);
    slug = result.slug;
    updatedConfig = result.config;
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  writeConfig(updatedConfig);

  console.log(`\n→ Generating context file for ${name}...`);
  const workstream = readShared();
  const roleData = updatedConfig.roles.find(r => r.slug === slug);
  const md = await generateRoleFile(workstream, roleData, config.project, config);
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

async function suggestAndAdd() {
  const config = readConfig();
  const workstream = readShared();

  console.log('\n→ Analyzing project context to suggest roles...\n');
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
  await addRoleInteractive(suggestions[idx - 1]);
}
