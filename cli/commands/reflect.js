import { ask } from '../prompt.js';
import { readConfig, readShared, writeShared, writeSharedMd, readContributions, writeRoleFile } from '../../src/storage.js';
import { generateReflection, serializeToMd, generateRoleFile } from '../../src/context.js';
import { extractJson } from '../../src/ai.js';
import { commitContext, pushContext } from '../../src/git.js';

export async function reflectCommand() {
  const config = readConfig();
  const workstream = readShared();
  const contributions = readContributions();

  console.log(`\n→ Reviewing context for "${config.project}"...`);
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
  console.log(serializeToMd(updated, config.project, '', contributions));

  const answer = await ask('Apply this reflection? (y/n)', 'y');
  if (answer.toLowerCase() !== 'y') { console.log('Reflection discarded.'); return; }

  writeShared(updated);
  writeSharedMd(serializeToMd(updated, config.project, 'reflect', contributions));

  if (config.roles.length > 0) {
    console.log(`\n→ Regenerating ${config.roles.length} role files...`);
    for (const role of config.roles) {
      const md = await generateRoleFile(updated, role, config.project, config, contributions);
      writeRoleFile(role.slug, md);
      process.stdout.write(`  ✓ ${role.slug}.md\n`);
    }
  }

  await commitContext('context: reflect — AI rewrote shared context');
  if (config.autoPush) {
    try { await pushContext(); } catch (err) { console.log(`Push failed (${err.message?.split('\n')[0] || err.stderr?.trim() || 'no remote?'}) — run \`git push\` manually.`); }
  }
  console.log('\n✓ Context reflected and committed.');
}
