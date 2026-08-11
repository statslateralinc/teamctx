import { readConfig, readWorkstream, listWorkstreamIds, readContributions, listTasks } from '../../src/storage.js';
import { resolveActor } from '../../src/actor.js';
import { resolveActiveWorkstream, resolveIdentity } from '../../src/prefs.js';

export async function statusCommand() {
  const config = readConfig();
  const actor = await resolveActor({ config });
  const identity = await resolveIdentity({ actor, config });
  const activeWorkstream = await resolveActiveWorkstream({ actor, config });
  const contributions = readContributions();
  const decisions = contributions.filter(c => c.tagged === 'decision');

  const wsIds = [...new Set([
    ...(config.workstreams || []).map(w => w.id),
    ...listWorkstreamIds(),
  ])].sort();
  const workstreams = (wsIds.length ? wsIds : ['main']).map(id => ({ id, tree: readWorkstream(id) }));
  const totalWhys = workstreams.reduce((n, w) => n + (w.tree.whys?.length || 0), 0);
  const allTasks = listTasks({});
  const openTasks = allTasks.filter(t => t.status === 'open').length;
  const doneTasks = allTasks.filter(t => t.status === 'done').length;
  const compiledTasks = allTasks.filter(t => t.compiledAt).length;

  console.log(`\n${config.project} — teamctx status\n`);
  console.log(`  You:          ${identity.name} (${identity.source})`);
  console.log(`  Model:        ${config.model}`);
  console.log(`  Provider:     ${config.provider || 'anthropic'}`);
  console.log(`  Auto-push:    ${config.autoPush ? 'on' : 'off'}`);
  console.log(`  Why nodes:    ${totalWhys} across ${workstreams.length} workstream${workstreams.length !== 1 ? 's' : ''}`);
  if (workstreams.length > 1) {
    workstreams.forEach(w => {
      const active = w.id === activeWorkstream ? ' (active)' : '';
      console.log(`    - ${w.id.padEnd(20)} ${w.tree.whys?.length || 0} Why nodes${active}`);
    });
  }
  console.log(`  Contributions: ${contributions.length} total, ${decisions.length} decisions`);
  console.log(`  Tasks:        ${openTasks} open, ${doneTasks} done${compiledTasks ? ` (${compiledTasks} compiled)` : ''}`);
  console.log(`\nRoles (${config.roles.length}):`);

  if (config.roles.length === 0) {
    console.log('  None yet. Run `teamctx role add`.');
  } else {
    config.roles.forEach(r => {
      const url = config.deployUrl ? `${config.deployUrl}/context/${r.slug}` : `[deploy-url]/context/${r.slug}`;
      const wsLabel = r.workstream && r.workstream !== 'main' ? ` [${r.workstream}]` : '';
      console.log(`  ${r.slug.padEnd(20)} ${r.name}${wsLabel}`);
      console.log(`  ${''.padEnd(20)} ${url}`);
    });
  }
  console.log();
}
