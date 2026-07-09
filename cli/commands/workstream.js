import { readConfig, writeConfig, readWorkstream, listWorkstreamIds } from '../../src/storage.js';
import { proposeSubworkstreams } from '../../src/context.js';

function workstreamMeta(config, id) {
  return (config.workstreams || []).find(w => w.id === id);
}

export async function workstreamSuggestCommand() {
  const config = readConfig();
  const activeId = config.activeWorkstream || 'main';
  const workstream = readWorkstream(activeId);

  console.log(`\n→ Analyzing workstream "${activeId}" (${workstream.whys.length} Why nodes) for candidate splits...\n`);

  const { splits, leftover } = await proposeSubworkstreams(workstream, config, config.roles || []);

  if (splits.length === 0) {
    console.log('No clean split proposed. The current workstream reads as one thread.\n');
    return;
  }

  console.log(`Proposed ${splits.length} sub-workstream${splits.length === 1 ? '' : 's'}:\n`);
  splits.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.name}`);
    if (s.rationale) console.log(`     ${s.rationale}`);
    s.whyIds.forEach(id => {
      const why = workstream.whys.find(w => w.id === id);
      console.log(`     - ${why ? why.text : `(missing: ${id})`}`);
    });
    console.log();
  });

  if (leftover.length > 0) {
    console.log(`Left in "${activeId}": ${leftover.length} Why node${leftover.length === 1 ? '' : 's'}`);
    leftover.forEach(id => {
      const why = workstream.whys.find(w => w.id === id);
      if (why) console.log(`  - ${why.text}`);
    });
    console.log();
  }

  console.log('This was a dry-run. Run `teamctx workstream split` to accept and apply.\n');
}

export async function workstreamListCommand() {
  const config = readConfig();
  const activeId = config.activeWorkstream || 'main';
  const declared = config.workstreams || [];
  const onDisk = new Set(listWorkstreamIds());

  const ids = Array.from(new Set([...declared.map(w => w.id), ...onDisk])).sort();
  if (ids.length === 0) {
    console.log('No workstreams yet. Run `teamctx init`.\n');
    return;
  }

  console.log(`\nWorkstreams for "${config.project}":\n`);
  ids.forEach(id => {
    const meta = workstreamMeta(config, id);
    const ws = readWorkstream(id);
    const roles = (config.roles || []).filter(r => (r.workstream || 'main') === id).map(r => r.slug);
    const marker = id === activeId ? '*' : ' ';
    const name = meta?.name || ws.name || '(unnamed)';
    console.log(`  ${marker} ${id.padEnd(16)} ${name}`);
    console.log(`      ${ws.whys.length} Why nodes · roles: ${roles.length ? roles.join(', ') : '(none)'}`);
  });
  console.log('\n  * = active workstream (target of `contribute` when --workstream is omitted)\n');
}

export async function workstreamUseCommand(id) {
  const config = readConfig();
  const known = new Set([...(config.workstreams || []).map(w => w.id), ...listWorkstreamIds()]);
  if (!known.has(id)) {
    console.error(`Error: no workstream "${id}". Run \`teamctx workstream list\` to see options.`);
    process.exit(1);
  }
  writeConfig({ ...config, activeWorkstream: id });
  console.log(`✓ Active workstream is now "${id}".`);
}
