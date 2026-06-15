#!/usr/bin/env node
import 'dotenv/config';
import { program } from 'commander';
import { initCommand } from './commands/init.js';
import { roleCommand } from './commands/role.js';
import { contributeCommand } from './commands/contribute.js';
import { pullCommand } from './commands/pull.js';
import { reflectCommand } from './commands/reflect.js';
import { contextCommand } from './commands/context.js';
import { statusCommand } from './commands/status.js';
import { configModelCommand, configGithubRawBaseCommand, configManagerEmailCommand } from './commands/config.js';

program.name('teamctx').description('AI-native version control for team context').version('0.1.0');

program.command('init').description('Set up teamctx in the current git repo').action(initCommand);

const role = program.command('role').description('Manage team roles');
role.command('add').description('Add a new role (AI-assisted)').option('--suggest', 'AI suggests roles from context').action(opts => roleCommand('add', opts));
role.command('list').description('List all roles').action(() => roleCommand('list', {}));

program.command('contribute <text>').description('Add context — AI updates all files')
  .option('--decision', 'Tag as a human decision (never pruned by reflect)')
  .option('--auto-approve', 'Skip diff review')
  .action(contributeCommand);

program.command('pull').description('Fetch and process pending web contributions').action(pullCommand);
program.command('reflect').description('AI rewrites shared context for clarity').action(reflectCommand);
program.command('context <role>').description('Print role context MD to stdout').action(contextCommand);
program.command('status').description('Show project summary').action(statusCommand);

const config = program.command('config').description('View or change project settings');
config.command('model [value]').description('Get or set the AI model').action(configModelCommand);
config.command('github-raw-base [value]').description('Get or set the GitHub raw base URL').action(configGithubRawBaseCommand);
config.command('manager-email [value]').description('Get or set the manager email for contribution notifications').action(configManagerEmailCommand);

program.parseAsync();
