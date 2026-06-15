import { readConfig, readShared, readContributions } from '../../src/storage.js';

export async function statusCommand() {
  const config = readConfig();
  const workstream = readShared();
  const contributions = readContributions();
  const decisions = contributions.filter(c => c.tagged === 'decision');

  console.log(`\n${config.project} — teamctx status\n`);
  console.log(`  Model:        ${config.model}`);
  console.log(`  Auto-push:    ${config.autoPush ? 'on' : 'off'}`);
  console.log(`  Why nodes:    ${workstream.whys.length}`);
  console.log(`  Contributions:${contributions.length} total, ${decisions.length} decisions`);
  console.log(`\nRoles (${config.roles.length}):`);

  if (config.roles.length === 0) {
    console.log('  None yet. Run `teamctx role add`.');
  } else {
    config.roles.forEach(r => {
      const url = config.deployUrl ? `${config.deployUrl}/context/${r.slug}` : `[deploy-url]/context/${r.slug}`;
      console.log(`  ${r.slug.padEnd(20)} ${r.name}`);
      console.log(`  ${''.padEnd(20)} ${url}`);
    });
  }
  console.log();
}
