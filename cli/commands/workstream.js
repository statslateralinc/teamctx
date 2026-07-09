import { ask } from '../prompt.js';
import { readConfig, writeConfig, readWorkstream, writeWorkstream, writeWorkstreamMd, listWorkstreamIds, writeRoleFile } from '../../src/storage.js';
import { proposeSubworkstreams, serializeToMd, generateRoleFile } from '../../src/context.js';
import { commitContext, pushContext } from '../../src/git.js';
import { slugify } from '../../src/roles.js';

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

export async function workstreamSplitCommand(opts = {}) {
  const config = readConfig();
  const activeId = config.activeWorkstream || 'main';
  const source = readWorkstream(activeId);

  if ((source.whys || []).length < 2) {
    console.log(`\nWorkstream "${activeId}" has fewer than 2 Why nodes — nothing to split.\n`);
    return;
  }

  console.log(`\n→ Analyzing workstream "${activeId}" for candidate splits...`);
  const { splits: proposals } = await proposeSubworkstreams(source, config, config.roles || []);

  if (proposals.length === 0) {
    console.log('No clean split proposed. The current workstream reads as one thread.\n');
    return;
  }

  const accepted = [];
  for (const proposal of proposals) {
    console.log(`\n  Proposed: ${proposal.name}`);
    if (proposal.rationale) console.log(`    ${proposal.rationale}`);
    proposal.whyIds.forEach(id => {
      const why = source.whys.find(w => w.id === id);
      if (why) console.log(`    - ${why.text}`);
    });

    if (opts.acceptAll) {
      accepted.push(proposal);
      continue;
    }
    const answer = (await ask(`  Accept? (y/n/rename)`, 'y')).toLowerCase();
    if (answer === 'rename' || answer === 'r') {
      const newName = await ask('  New name');
      if (!newName) { console.log('  Skipped.'); continue; }
      accepted.push({ ...proposal, name: newName });
    } else if (answer === 'y' || answer === 'yes' || answer === '') {
      accepted.push(proposal);
    } else {
      console.log('  Skipped.');
    }
  }

  if (accepted.length === 0) {
    console.log('\nNo splits accepted.\n');
    return;
  }

  for (const split of accepted) {
    const fresh = { source: readWorkstream(activeId), config: readConfig() };
    await applySplit({
      source: fresh.source,
      sourceId: activeId,
      split,
      config: fresh.config,
      acceptAll: !!opts.acceptAll,
    });
  }

  console.log('\n✓ Split complete.\n');
}

async function applySplit({ source, sourceId, split, config, acceptAll }) {
  const existingIds = new Set([...(config.workstreams || []).map(w => w.id), ...listWorkstreamIds()]);
  let newId = slugify(split.name);
  if (!newId) {
    console.error(`  Error: split name "${split.name}" produced an empty id. Skipping.`);
    return;
  }
  if (existingIds.has(newId)) {
    console.error(`  Error: workstream id "${newId}" already exists. Skipping "${split.name}".`);
    return;
  }

  const movingWhys = source.whys.filter(w => split.whyIds.includes(w.id));
  if (movingWhys.length === 0) {
    console.error(`  Error: no matching Why nodes for "${split.name}" (source may have changed). Skipping.`);
    return;
  }
  const remainingWhys = source.whys.filter(w => !split.whyIds.includes(w.id));
  const newWs = { id: newId, name: split.name, whys: movingWhys };
  const updatedSource = { ...source, whys: remainingWhys };

  writeWorkstream(newId, newWs);
  writeWorkstreamMd(newId, serializeToMd(newWs, split.name));
  writeWorkstream(sourceId, updatedSource);
  const sourceName = config.workstreams?.find(w => w.id === sourceId)?.name || source.name || sourceId;
  writeWorkstreamMd(sourceId, serializeToMd(updatedSource, sourceName));

  let moveSlugs = [];
  const rolesOnSource = (config.roles || []).filter(r => (r.workstream || 'main') === sourceId);
  if (!acceptAll && rolesOnSource.length > 0) {
    console.log(`\n  Roles currently on "${sourceId}": ${rolesOnSource.map(r => r.slug).join(', ')}`);
    const answer = await ask(`  Move any to "${split.name}"? Comma-separated slugs, or blank`, '');
    if (answer) {
      const requested = answer.split(',').map(s => s.trim()).filter(Boolean);
      moveSlugs = requested.filter(s => rolesOnSource.some(r => r.slug === s));
      const unknown = requested.filter(s => !rolesOnSource.some(r => r.slug === s));
      if (unknown.length > 0) console.log(`  Note: unknown or non-source slugs ignored: ${unknown.join(', ')}`);
    }
  }

  const updatedConfig = {
    ...config,
    workstreams: [...(config.workstreams || []), { id: newId, name: split.name, createdAt: new Date().toISOString() }],
    roles: (config.roles || []).map(r => moveSlugs.includes(r.slug) ? { ...r, workstream: newId } : r),
  };
  writeConfig(updatedConfig);

  for (const slug of moveSlugs) {
    const role = updatedConfig.roles.find(r => r.slug === slug);
    const md = await generateRoleFile(newWs, role, updatedConfig.project, updatedConfig);
    writeRoleFile(slug, md);
    console.log(`  ✓ Moved role "${slug}" to "${split.name}" and regenerated its context.`);
  }

  const stillOnSource = (updatedConfig.roles || []).filter(r => (r.workstream || 'main') === sourceId);
  for (const role of stillOnSource) {
    const md = await generateRoleFile(updatedSource, role, updatedConfig.project, updatedConfig);
    writeRoleFile(role.slug, md);
  }

  await commitContext(`workstream: split "${split.name}" from ${sourceId}`);
  if (updatedConfig.autoPush) {
    try { await pushContext(); } catch { /* non-fatal */ }
  }
  console.log(`  ✓ Created workstream "${split.name}" (${newId}) with ${movingWhys.length} Why node${movingWhys.length === 1 ? '' : 's'}.`);
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
