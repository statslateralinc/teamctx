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
import { reviewListCommand, reviewApproveCommand, reviewRejectCommand } from './commands/review.js';
import { setupCommand } from './commands/setup.js';

program.name('teamctx').description('AI-native version control for team context').version('0.1.0');

program.command('setup').description('Create a private GitHub repo and initialize teamctx').action(setupCommand);
program.command('init').description('Set up teamctx in an existing git repo').action(initCommand);

const role = program.command('role').description('Manage team roles');
role.command('add').description('Add a new role (AI-assisted)').option('--suggest', 'AI suggests roles from context').action(opts => roleCommand('add', opts));
role.command('list').description('List all roles').action(() => roleCommand('list', {}));

program.command('contribute <text>').description('Add context — AI proposes changes and enqueues for manager approval')
  .option('--decision', 'Tag as a human decision (never pruned by reflect)')
  .option('--auto-approve', 'Skip the y/n confirmation on the proposed diff')
  .option('--apply', 'Apply immediately instead of enqueueing for approval (solo mode)')
  .action(contributeCommand);

program.command('ask <question>').description("Ask a question, answered from your team's context")
  .option('--role <slug>', "Answer from a specific role's perspective")
  .action(askCommand);

program.command('pull').description('Fetch and process pending web contributions').action(pullCommand);
program.command('reflect').description('AI rewrites shared context for clarity').action(reflectCommand);
program.command('context <role>').description('Print role context MD to stdout').action(contextCommand);
program.command('status').description('Show project summary').action(statusCommand);

const review = program.command('review').description('Review pending contributions awaiting manager approval');
review.command('list').description('List all pending contributions').action(reviewListCommand);
review.command('approve <id>').description('Approve a pending contribution — applies it to shared context').action(reviewApproveCommand);
review.command('reject <id>').description('Reject a pending contribution — archives with optional reason')
  .option('--reason <text>', 'Reason for rejection (archived alongside the item)')
  .action(reviewRejectCommand);

const config = program.command('config').description('View or change project settings');
config.command('model [value]').description('Get or set the AI model').action(configModelCommand);
config.command('github-raw-base [value]').description('Get or set the GitHub raw base URL').action(configGithubRawBaseCommand);
config.command('manager-email [value]').description('Get or set the manager email for contribution notifications').action(configManagerEmailCommand);
config.command('deploy-url [value]').description('Get or set the Vercel deploy URL').action(configDeployUrlCommand);

program.parseAsync();
