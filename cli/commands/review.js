import {
  readConfig, readWorkstream, writeWorkstream, writeWorkstreamMd, writeRoleFile,
  listQueue, readQueueItem, deleteQueueItem, writeRejected, readContributions,
} from '../../src/storage.js';
import { applyQueueItem, buildRejected, canApprove } from '../../src/review.js';
import { serializeToMd, generateRoleFile } from '../../src/context.js';
import { commitContext, pushContext } from '../../src/git.js';

function workstreamDisplayName(id, workstream, config) {
  return config.workstreams?.find(w => w.id === id)?.name || workstream.name || config.project;
}

function checkManagerGate(config) {
  if (!canApprove(config)) {
    console.error(`Error: only the configured manager (${config.manager}) may approve or reject. You are ${config.me}.`);
    process.exit(1);
  }
}

export async function reviewListCommand() {
  const queue = listQueue();
  if (queue.length === 0) {
    console.log('\nNo pending contributions.\n');
    return;
  }

  console.log(`\n${queue.length} pending contribution${queue.length !== 1 ? 's' : ''}:\n`);
  const header = ['ID', 'Author', 'Created', 'Ops', 'Summary'];
  const rows = queue.map(p => [
    p.id,
    p.author || '-',
    p.createdAt || '-',
    String((p.operations || []).length),
    (p.summary || '').slice(0, 60),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const fmt = cells => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(fmt(header));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  rows.forEach(r => console.log(fmt(r)));
  console.log('');
}

export async function reviewApproveCommand(id) {
  const config = readConfig();
  checkManagerGate(config);

  let item;
  try {
    item = readQueueItem(id);
  } catch {
    console.error(`Error: no pending contribution with id "${id}". Run \`teamctx review list\` to see the queue.`);
    process.exit(1);
  }

  const targetId = item.workstream || 'main';
  const workstream = readWorkstream(targetId);
  const updated = applyQueueItem(workstream, item);
  const contributions = readContributions();

  writeWorkstream(targetId, updated);
  writeWorkstreamMd(targetId, serializeToMd(updated, workstreamDisplayName(targetId, updated, config), item.author, contributions));

  const rolesOnTarget = (config.roles || []).filter(r => (r.workstream || 'main') === targetId);
  if (rolesOnTarget.length > 0) {
    console.log(`→ Regenerating ${rolesOnTarget.length} role file${rolesOnTarget.length !== 1 ? 's' : ''}...`);
    for (const role of rolesOnTarget) {
      const md = await generateRoleFile(updated, role, config.project, config, contributions);
      writeRoleFile(role.slug, md);
      process.stdout.write(`  ✓ ${role.slug}.md\n`);
    }
  }

  deleteQueueItem(item.id);

  const note = item.tagged === 'decision' ? ' [decision]' : '';
  const wsNote = targetId === 'main' ? '' : ` (${targetId})`;
  await commitContext(`context: ${item.author} contribution (approved by ${config.me})${note}${wsNote}`);

  if (config.autoPush) {
    try { await pushContext(); console.log('\n✓ Approved, committed, and pushed.'); }
    catch (err) { console.log(`\n✓ Approved and committed. Push failed (${err.message?.split('\n')[0] || 'no remote?'}) — run \`git push\` manually.`); }
  } else {
    console.log('\n✓ Approved and committed. Run `git push` to share with your team.');
  }
}

export async function reviewRejectCommand(id, opts) {
  const config = readConfig();
  checkManagerGate(config);

  let item;
  try {
    item = readQueueItem(id);
  } catch {
    console.error(`Error: no pending contribution with id "${id}". Run \`teamctx review list\` to see the queue.`);
    process.exit(1);
  }

  writeRejected(buildRejected(item, config.me, opts?.reason));
  deleteQueueItem(item.id);

  const reasonNote = opts?.reason ? ` (reason: ${opts.reason})` : '';
  await commitContext(`review: rejected ${item.id} by ${config.me}${opts?.reason ? ` (${opts.reason})` : ''}`);

  if (config.autoPush) {
    try { await pushContext(); console.log(`\n✓ Rejected contribution ${item.id}${reasonNote}. Archived, committed, and pushed.\n`); }
    catch (err) { console.log(`\n✓ Rejected contribution ${item.id}${reasonNote}. Archived and committed. Push failed (${err.message?.split('\n')[0] || 'no remote?'}) — run \`git push\` manually.\n`); }
  } else {
    console.log(`\n✓ Rejected contribution ${item.id}${reasonNote}. Archived to .teamctx/rejected/ and committed. Run \`git push\` to share with your team.\n`);
  }
}
