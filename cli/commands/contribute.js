import { ask } from '../prompt.js';
import { readConfig, readWorkstream, writeWorkstream, writeWorkstreamMd, appendContribution, writeRoleFile, writeQueueItem, readContributions } from '../../src/storage.js';
import { updateShared, generateRoleFile, serializeToMd } from '../../src/context.js';
import { commitContext, pushContext } from '../../src/git.js';

function newContribution(text, author, tagged, source) {
  return {
    id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ts: new Date().toISOString(),
    author,
    text,
    tagged: tagged || null,
    source: source || 'cli',
    status: 'logged',
  };
}

function workstreamDisplayName(id, workstream, config) {
  return config.workstreams?.find(w => w.id === id)?.name || workstream.name || config.project;
}

export async function contributeCommand(text, opts) {
  const config = readConfig();
  const targetId = opts.workstream || config.activeWorkstream || 'main';
  const known = new Set((config.workstreams || []).map(w => w.id));
  if (config.workstreams && !known.has(targetId)) {
    console.error(`Error: no workstream "${targetId}". Run \`teamctx workstream list\`.`);
    process.exit(1);
  }
  const workstream = readWorkstream(targetId);
  const tagged = opts.decision ? 'decision' : null;
  const contribution = newContribution(text, config.me, tagged, opts.source);

  appendContribution(contribution);
  const wsLabel = targetId === 'main' ? '' : ` [workstream: ${targetId}]`;
  console.log(`\n→ Processing contribution from ${config.me}${wsLabel}...`);

  const { workstream: updated, summary, operations } = await updateShared(workstream, contribution, config);

  if (operations.length === 0) {
    console.log('No changes to context tree (contribution logged).');
    return;
  }

  console.log(`\nProposed changes (${operations.length} op${operations.length !== 1 ? 's' : ''}):`);
  console.log(`  Summary: ${summary}`);
  operations.forEach(op => {
    const label = op.type === 'addWhy' ? `+ Why: ${op.text}`
      : op.type === 'addWhat' ? `+ What: ${op.text}`
      : op.type === 'addHow' ? `+ How: ${op.text}`
      : op.type === 'editStatement' ? `~ Edit: ${op.text}`
      : `- Delete: ${op.id}`;
    console.log(`  ${label}`);
  });

  if (!opts.autoApprove) {
    const prompt = opts.apply ? '\nApply these changes now? (y/n)' : '\nSubmit for manager approval? (y/n)';
    const answer = await ask(prompt, 'y');
    if (answer.toLowerCase() !== 'y') { console.log('Changes discarded. Contribution is logged.'); return; }
  }

  if (!opts.apply) {
    writeQueueItem({
      id: contribution.id,
      status: 'pending',
      createdAt: contribution.ts,
      author: contribution.author,
      source: 'cli',
      text: contribution.text,
      tagged: contribution.tagged,
      summary,
      operations,
    });

    await commitContext(`queue: ${config.me} submission pending approval (${contribution.id})`);

    if (config.autoPush) {
      try {
        await pushContext();
        console.log(`\n✓ Submitted for approval (id: ${contribution.id}) — committed and pushed.`);
      } catch (err) {
        console.log(`\n✓ Submitted for approval (id: ${contribution.id}) — committed. Push failed (${err.message?.split('\n')[0] || err.stderr?.trim() || 'no remote?'}) — run \`git push\` manually.`);
      }
    } else {
      console.log(`\n✓ Submitted for approval (id: ${contribution.id}) — committed. Run \`git push\` to send it to your manager.`);
    }
    console.log(`  Manager: after \`git pull\`, run \`teamctx review approve ${contribution.id}\` or \`teamctx review reject ${contribution.id}\`.`);
    return;
  }

  writeWorkstream(targetId, updated);
  const contributions = readContributions();
  writeWorkstreamMd(targetId, serializeToMd(updated, workstreamDisplayName(targetId, updated, config), config.me, contributions));

  const rolesOnTarget = (config.roles || []).filter(r => (r.workstream || 'main') === targetId);
  if (rolesOnTarget.length > 0) {
    console.log(`\n→ Regenerating ${rolesOnTarget.length} role file${rolesOnTarget.length !== 1 ? 's' : ''}...`);
    for (const role of rolesOnTarget) {
      const md = await generateRoleFile(updated, role, config.project, config, contributions);
      writeRoleFile(role.slug, md);
      process.stdout.write(`  ✓ ${role.slug}.md\n`);
    }
  }

  const note = tagged === 'decision' ? ' [decision]' : '';
  const wsNote = targetId === 'main' ? '' : ` (${targetId})`;
  await commitContext(`context: ${config.me} contribution${note}${wsNote}`);

  if (config.autoPush) {
    try { await pushContext(); console.log('\n✓ Committed and pushed.'); }
    catch (err) { console.log(`\n✓ Committed. Push failed (${err.message?.split('\n')[0] || err.stderr?.trim() || 'no remote?'}) — run \`git push\` manually.`); }
  } else {
    console.log('\n✓ Committed. Run `git push` to share with your team.');
  }
}
