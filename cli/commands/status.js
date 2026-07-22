import { readConfig, readWorkstream, listWorkstreamIds, readContributions } from '../../src/storage.js';

export async function statusCommand() {
  const config = readConfig();
  const contributions = readContributions();
  const decisions = contributions.filter(c => c.tagged === 'decision');

  const wsIds = [...new Set([
    ...(config.workstreams || []).map(w => w.id),
    ...listWorkstreamIds(),
  ])].sort();
  const workstreams = (wsIds.length ? wsIds : ['main']).map(id => ({ id, tree: readWorkstream(id) }));
  const totalWhys = workstreams.reduce((n, w) => n + (w.tree.whys?.length || 0), 0);

  console.log(`\n${config.project} — teamctx status\n`);
  console.log(`  Model:        ${config.model}`);
  console.log(`  Provider:     ${config.provider || 'anthropic'}`);
  console.log(`  Auto-push:    ${config.autoPush ? 'on' : 'off'}`);
  console.log(`  Why nodes:    ${totalWhys} across ${workstreams.length} workstream${workstreams.length !== 1 ? 's' : ''}`);
  if (workstreams.length > 1) {
    workstreams.forEach(w => {
      const active = w.id === config.activeWorkstream ? ' (active)' : '';
      console.log(`    - ${w.id.padEnd(20)} ${w.tree.whys?.length || 0} Why nodes${active}`);
    });
  }
  console.log(`  Contributions: ${contributions.length} total, ${decisions.length} decisions`);
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
