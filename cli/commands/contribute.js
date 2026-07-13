import { ask } from '../prompt.js';
import { readConfig, readShared, writeShared, writeSharedMd, appendContribution, writeRoleFile, writeQueueItem } from '../../src/storage.js';
import { updateShared, generateRoleFile, serializeToMd } from '../../src/context.js';
import { commitContext, pushContext } from '../../src/git.js';

function newContribution(text, author, tagged) {
  return {
    id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ts: new Date().toISOString(),
    author,
    text,
    tagged: tagged || null,
    status: 'logged',
  };
}

export async function contributeCommand(text, opts) {
  const config = readConfig();
  const workstream = readShared();
  const tagged = opts.decision ? 'decision' : null;
  const contribution = newContribution(text, config.me, tagged);

  appendContribution(contribution);
  console.log(`\n→ Processing contribution from ${config.me}...`);

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

  writeShared(updated);
  writeSharedMd(serializeToMd(updated, config.project, config.me));

  if (config.roles.length > 0) {
    console.log(`\n→ Regenerating ${config.roles.length} role file${config.roles.length !== 1 ? 's' : ''}...`);
    for (const role of config.roles) {
      const md = await generateRoleFile(updated, role, config.project, config);
      writeRoleFile(role.slug, md);
      process.stdout.write(`  ✓ ${role.slug}.md\n`);
    }
  }

  const note = tagged === 'decision' ? ' [decision]' : '';
  await commitContext(`context: ${config.me} contribution${note}`);

  if (config.autoPush) {
    try { await pushContext(); console.log('\n✓ Committed and pushed.'); }
    catch (err) { console.log(`\n✓ Committed. Push failed (${err.message?.split('\n')[0] || err.stderr?.trim() || 'no remote?'}) — run \`git push\` manually.`); }
  } else {
    console.log('\n✓ Committed. Run `git push` to share with your team.');
  }
}
