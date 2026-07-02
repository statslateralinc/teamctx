import { readConfig, readSharedMd, readRoleFile } from '../../src/storage.js';
import { answerQuestion } from '../../src/context.js';

export async function askCommand(question, opts) {
  const config = readConfig();

  let roleMd = '';
  if (opts.role) {
    const role = config.roles.find(r => r.slug === opts.role);
    if (!role) {
      console.error(`Error: no role "${opts.role}". Run \`teamctx role list\` to see available roles.`);
      process.exit(1);
    }
    roleMd = readRoleFile(opts.role);
  }

  const sharedMd = readSharedMd();
  const answer = await answerQuestion({ sharedMd, roleMd, question, config });
  console.log(`\n${answer}\n`);
}
