import { ask } from '../prompt.js';
import { readConfig, readWorkstream } from '../../src/storage.js';
import { UnknownWorkstreamError } from './role.core.js';
import {
  listAllWorkstreams, suggestWorkstreamSplits, splitWorkstreams, useWorkstream,
  WorkstreamSplitError,
} from './workstream.core.js';

function cliError(err) {
  if (err instanceof UnknownWorkstreamError || err instanceof WorkstreamSplitError) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

export async function workstreamSuggestCommand() {
  const config = readConfig();
  const activeId = config.activeWorkstream || 'main';
  const workstream = readWorkstream(activeId);

  console.log(`\n→ Analyzing workstream "${activeId}" (${workstream.whys.length} Why nodes) for candidate splits...\n`);

  const { splits, leftover } = await suggestWorkstreamSplits();
  if (splits.length === 0) {
    console.log('No clean split proposed. The current workstream reads as one thread.\n');
    return;
  }

  console.log(`Proposed ${splits.length} sub-workstream${splits.length === 1 ? '' : 's'}:\n`);
  splits.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.name}`);
    if (s.rationale) console.log(`     ${s.rationale}`);
    s.whys.forEach(why => console.log(`     - ${why.text}`));
    console.log();
  });

  if (leftover.length > 0) {
    console.log(`Left in "${activeId}": ${leftover.length} Why node${leftover.length === 1 ? '' : 's'}`);
    leftover.forEach(why => console.log(`  - ${why.text}`));
    console.log();
  }

  console.log('This was a dry-run. Run `teamctx workstream split` to accept and apply.\n');
}

export async function workstreamListCommand() {
  const config = readConfig();
  const workstreams = listAllWorkstreams();
  if (workstreams.length === 0) {
    console.log('No workstreams yet. Run `teamctx init`.\n');
    return;
  }
  console.log(`\nWorkstreams for "${config.project}":\n`);
  workstreams.forEach(w => {
    const marker = w.isActive ? '*' : ' ';
    console.log(`  ${marker} ${w.id.padEnd(16)} ${w.name}`);
    console.log(`      ${w.whyCount} Why nodes · roles: ${w.roles.length ? w.roles.join(', ') : '(none)'}`);
  });
  console.log('\n  * = active workstream (target of `contribute` when --workstream is omitted)\n');
}

export async function workstreamSplitCommand(opts = {}) {
  const { activeId, workstream, splits } = await suggestWorkstreamSplits();
  console.log(`\n→ Analyzing workstream "${activeId}" for candidate splits...`);
  if ((workstream.whys || []).length < 2) {
    console.log(`\nWorkstream "${activeId}" has fewer than 2 Why nodes — nothing to split.\n`);
    return;
  }
  if (splits.length === 0) {
    console.log('No clean split proposed. The current workstream reads as one thread.\n');
    return;
  }

  const accepted = [];
  const config = readConfig();
  for (const proposal of splits) {
    console.log(`\n  Proposed: ${proposal.name}`);
    if (proposal.rationale) console.log(`    ${proposal.rationale}`);
    proposal.whys.forEach(why => console.log(`    - ${why.text}`));

    let entry = { name: proposal.name, whyIds: proposal.whyIds };
    if (opts.acceptAll) {
      // no rename; no per-split role prompt in accept-all
    } else {
      const answer = (await ask(`  Accept? (y/n/rename)`, 'y')).toLowerCase();
      if (answer === 'n' || answer === 'no') { console.log('  Skipped.'); continue; }
      if (answer === 'rename' || answer === 'r') {
        const newName = await ask('  New name');
        if (!newName) { console.log('  Skipped.'); continue; }
        entry.name = newName;
      }
      const rolesOnSource = (config.roles || []).filter(r => (r.workstream || 'main') === activeId);
      if (rolesOnSource.length > 0) {
        console.log(`\n  Roles currently on "${activeId}": ${rolesOnSource.map(r => r.slug).join(', ')}`);
        const roleAnswer = await ask(`  Move any to "${entry.name}"? Comma-separated slugs, or blank`, '');
        if (roleAnswer) {
          entry.moveRoles = roleAnswer.split(',').map(s => s.trim()).filter(Boolean);
        }
      }
    }
    accepted.push(entry);
  }

  if (accepted.length === 0) {
    console.log('\nNo splits accepted.\n');
    return;
  }

  let result;
  try { result = await splitWorkstreams({ accepted }); }
  catch (err) { cliError(err); return; }

  result.results.forEach(r => {
    if (r.movedRoles.length > 0) {
      r.movedRoles.forEach(slug => console.log(`  ✓ Moved role "${slug}" to "${r.splitName}" and regenerated its context.`));
    }
    if (r.unknownRoles.length > 0) {
      console.log(`  Note: unknown or non-source slugs ignored: ${r.unknownRoles.join(', ')}`);
    }
    console.log(`  ✓ Created workstream "${r.splitName}" (${r.newId}) with ${r.movedWhyCount} Why node${r.movedWhyCount === 1 ? '' : 's'}.`);
  });
  console.log('\n✓ Split complete.\n');
}

export async function workstreamUseCommand(id) {
  try { useWorkstream({ id }); }
  catch (err) { cliError(err); return; }
  console.log(`✓ Active workstream is now "${id}".`);
}
