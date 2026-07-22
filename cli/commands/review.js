import { listPendingReviews, approveReview, rejectReview, ManagerGateError, QueueItemNotFoundError } from './review.core.js';

export async function reviewListCommand() {
  const queue = await listPendingReviews();
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

function handleCliError(err) {
  if (err instanceof ManagerGateError || err instanceof QueueItemNotFoundError) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

export async function reviewApproveCommand(id) {
  let result;
  try { result = await approveReview({ id }); }
  catch (err) { handleCliError(err); return; }

  if (result.rolesRegenerated.length > 0) {
    console.log(`→ Regenerating ${result.rolesRegenerated.length} role file${result.rolesRegenerated.length !== 1 ? 's' : ''}...`);
    result.rolesRegenerated.forEach(slug => process.stdout.write(`  ✓ ${slug}.md\n`));
  }

  if (result.pushed) {
    console.log('\n✓ Approved, committed, and pushed.');
  } else if (result.pushError) {
    console.log(`\n✓ Approved and committed. Push failed (${result.pushError}) — run \`git push\` manually.`);
  } else {
    console.log('\n✓ Approved and committed. Run `git push` to share with your team.');
  }
}

export async function reviewRejectCommand(id, opts) {
  let result;
  try { result = await rejectReview({ id, reason: opts?.reason }); }
  catch (err) { handleCliError(err); return; }

  const reasonNote = result.reason ? ` (reason: ${result.reason})` : '';
  if (result.pushed) {
    console.log(`\n✓ Rejected contribution ${result.id}${reasonNote}. Archived, committed, and pushed.\n`);
  } else if (result.pushError) {
    console.log(`\n✓ Rejected contribution ${result.id}${reasonNote}. Archived and committed. Push failed (${result.pushError}) — run \`git push\` manually.\n`);
  } else {
    console.log(`\n✓ Rejected contribution ${result.id}${reasonNote}. Archived to .teamctx/rejected/ and committed. Run \`git push\` to share with your team.\n`);
  }
}
