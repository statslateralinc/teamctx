import { ask } from '../prompt.js';
import { readConfig, readWorkstream, writeWorkstream, writeWorkstreamMd, readContributions, writeRoleFile } from '../../src/storage.js';
import { generateReflection, serializeToMd, generateRoleFile } from '../../src/context.js';
import { extractJson } from '../../src/ai.js';
import { commitContext, pushContext } from '../../src/git.js';

export async function reflectCommand(opts = {}) {
  const config = readConfig();
  const targetId = opts.workstream || config.activeWorkstream || 'main';
  const workstream = readWorkstream(targetId);
  const contributions = readContributions();

  const wsName = config.workstreams?.find(w => w.id === targetId)?.name || workstream.name || config.project;
  console.log(`\n→ Reviewing workstream "${targetId}" (${wsName})...`);
  console.log(`  ${workstream.whys.length} Why nodes, ${contributions.length} contributions.\n`);

  const raw = await generateReflection(workstream, contributions, config);

  let updated;
  try {
    const parsed = extractJson(raw);
    updated = { ...workstream, whys: Array.isArray(parsed.whys) ? parsed.whys : workstream.whys };
  } catch (err) {
    console.error('Error: AI returned invalid JSON. Reflection aborted.');
    console.error(err.message);
    return;
  }

  console.log('Proposed reflected context:\n');
  console.log(serializeToMd(updated, wsName, '', contributions));

  const answer = await ask('Apply this reflection? (y/n)', 'y');
  if (answer.toLowerCase() !== 'y') { console.log('Reflection discarded.'); return; }

  writeWorkstream(targetId, updated);
  writeWorkstreamMd(targetId, serializeToMd(updated, wsName, 'reflect', contributions));

  const rolesOnTarget = (config.roles || []).filter(r => (r.workstream || 'main') === targetId);
  if (rolesOnTarget.length > 0) {
    console.log(`\n→ Regenerating ${rolesOnTarget.length} role file${rolesOnTarget.length !== 1 ? 's' : ''}...`);
    for (const role of rolesOnTarget) {
      const md = await generateRoleFile(updated, role, config.project, config, contributions);
      writeRoleFile(role.slug, md);
      process.stdout.write(`  ✓ ${role.slug}.md\n`);
    }
  }

  await commitContext(`context: reflect ${targetId} — AI rewrote shared context`);
  if (config.autoPush) {
    try { await pushContext(); } catch (err) { console.log(`Push failed (${err.message?.split('\n')[0] || err.stderr?.trim() || 'no remote?'}) — run \`git push\` manually.`); }
  }
  console.log('\n✓ Context reflected and committed.');
}
