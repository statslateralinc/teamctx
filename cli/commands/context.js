import { readRoleFile, readConfig } from '../../src/storage.js';

export async function contextCommand(role) {
  const config = readConfig();
  if (!config.roles.find(r => r.slug === role)) {
    console.error(`Error: role "${role}" not found. Run \`teamctx role list\` to see available roles.`);
    process.exit(1);
  }
  try {
    process.stdout.write(readRoleFile(role));
  } catch {
    console.error(`Error: context file for "${role}" not found. It may not have been generated yet.`);
    process.exit(1);
  }
}
