#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import { program } from 'commander';
import { initCommand } from './commands/init.js';
import { roleCommand } from './commands/role.js';
import { contributeCommand } from './commands/contribute.js';
import { askCommand } from './commands/ask.js';
import { pullCommand } from './commands/pull.js';
import { reflectCommand } from './commands/reflect.js';
import { contextCommand } from './commands/context.js';
import { statusCommand } from './commands/status.js';
import { configModelCommand, configGithubRawBaseCommand, configManagerEmailCommand, configDeployUrlCommand } from './commands/config.js';
import { setupCommand } from './commands/setup.js';
import { mcpCommand } from './commands/mcp.js';

program.name('teamctx').description('AI-native version control for team context').version('0.1.0');

program.command('setup').description('Create a private GitHub repo and initialize teamctx').action(setupCommand);
program.command('init').description('Set up teamctx in an existing git repo').action(initCommand);

const role = program.command('role').description('Manage team roles');
role.command('add').description('Add a new role (AI-assisted)').option('--suggest', 'AI suggests roles from context').action(opts => roleCommand('add', opts));
role.command('list').description('List all roles').action(() => roleCommand('list', {}));

program.command('contribute <text>').description('Add context — AI updates all files')
  .option('--decision', 'Tag as a human decision (never pruned by reflect)')
  .option('--auto-approve', 'Skip diff review')
  .action(contributeCommand);

program.command('ask <question>').description("Ask a question, answered from your team's context")
  .option('--role <slug>', "Answer from a specific role's perspective")
  .action(askCommand);

program.command('pull').description('Fetch and process pending web contributions').action(pullCommand);
program.command('reflect').description('AI rewrites shared context for clarity').action(reflectCommand);
program.command('context <role>').description('Print role context MD to stdout').action(contextCommand);
program.command('status').description('Show project summary').action(statusCommand);
program.command('mcp').description('Start MCP server over stdio (for Claude Code, Claude Desktop, Cursor, etc.)')
  .option('-p, --project <path>', 'Absolute path to the teamctx project (defaults to $TEAMCTX_PROJECT_DIR or cwd)')
  .action(mcpCommand);

const config = program.command('config').description('View or change project settings');
config.command('model [value]').description('Get or set the AI model').action(configModelCommand);
config.command('github-raw-base [value]').description('Get or set the GitHub raw base URL').action(configGithubRawBaseCommand);
config.command('manager-email [value]').description('Get or set the manager email for contribution notifications').action(configManagerEmailCommand);
config.command('deploy-url [value]').description('Get or set the Vercel deploy URL').action(configDeployUrlCommand);

program.parseAsync();
