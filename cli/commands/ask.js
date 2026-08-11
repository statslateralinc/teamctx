import { readConfig, readWorkstreamMd, readRoleFile, readWorkstream, readContributions, listTasks } from '../../src/storage.js';
import { answerQuestion } from '../../src/context.js';
import { currentIdentity } from '../identity.js';

export async function askCommand(question, opts) {
  const config = readConfig();

  let roleMd = '';
  let targetWorkstreamId;
  if (opts.role) {
    const role = config.roles.find(r => r.slug === opts.role);
    if (!role) {
      console.error(`Error: no role "${opts.role}". Run \`teamctx role list\` to see available roles.`);
      process.exit(1);
    }
    roleMd = readRoleFile(opts.role);
    targetWorkstreamId = role.workstream || 'main';
  }

  const resolvedId = opts.workstream || targetWorkstreamId || (await currentIdentity(config)).activeWorkstream;
  const sharedMd = readWorkstreamMd(resolvedId);
  const workstream = readWorkstream(resolvedId);
  const contributions = readContributions();
  const openTasks = listTasks({ workstream: resolvedId }).filter(t => t.status === 'open');

  const answer = await answerQuestion({
    sharedMd, roleMd, question, config, openTasks,
    workstream, contributions, audit: !!opts.audit,
  });
  console.log(`\n${answer}\n`);
}
