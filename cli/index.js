#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import { program } from 'commander';
import { initCommand } from './commands/init.js';
import { roleCommand, roleAssignCommand } from './commands/role.js';
import { contributeCommand } from './commands/contribute.js';
import { askCommand } from './commands/ask.js';
import { pullCommand } from './commands/pull.js';
import { reflectCommand } from './commands/reflect.js';
import { contextCommand } from './commands/context.js';
import { statusCommand } from './commands/status.js';
import { configModelCommand, configGithubRawBaseCommand, configManagerCommand, configManagerEmailCommand, configDeployUrlCommand, configProviderCommand } from './commands/config.js';
import { reviewListCommand, reviewApproveCommand, reviewRejectCommand } from './commands/review.js';
import {
  snapshotCreateCommand, snapshotListCommand, snapshotShowCommand,
  snapshotApproveCommand, snapshotRejectCommand, snapshotCurrentCommand,
} from './commands/snapshot.js';
import { setupCommand } from './commands/setup.js';
import { mcpCommand } from './commands/mcp.js';
import { workstreamSuggestCommand, workstreamListCommand, workstreamUseCommand, workstreamSplitCommand } from './commands/workstream.js';
import { getTeamctxDir } from '../src/storage.js';
import { migrateIfNeeded } from '../src/migrate.js';

program.name('teamctx').description('AI-native version control for team context').version('0.1.0');

program.hook('preAction', (thisCommand, actionCommand) => {
  const name = actionCommand.name();
  if (name === 'init' || name === 'setup') return;
  try {
    migrateIfNeeded(getTeamctxDir());
  } catch { /* not in a teamctx project — command will surface the error */ }
});

program.command('setup').description('Create a private GitHub repo and initialize teamctx').action(setupCommand);
program.command('init').description('Set up teamctx in an existing git repo').action(initCommand);

const role = program.command('role').description('Manage team roles');
role.command('add').description('Add a new role (AI-assisted)')
  .option('--suggest', 'AI suggests roles from context')
  .option('--workstream <id>', 'Bind this role to a workstream (default: active)')
  .action(opts => roleCommand('add', opts));
role.command('list').description('List all roles').action(() => roleCommand('list', {}));
role.command('assign <slug>').description("Move a role to a workstream and regenerate its context")
  .requiredOption('--workstream <id>', 'Target workstream id')
  .action(roleAssignCommand);

program.command('contribute <text>').description('Add context — AI proposes changes and enqueues for manager approval')
  .option('--decision', 'Tag as a human decision (never pruned by reflect)')
  .option('--auto-approve', 'Skip the y/n confirmation on the proposed diff')
  .option('--apply', 'Apply immediately instead of enqueueing for approval (solo mode)')
  .option('--workstream <id>', 'Target workstream (default: active)')
  .action(contributeCommand);

program.command('ask <question>').description("Ask a question, answered from your team's context")
  .option('--role <slug>', "Answer from a specific role's perspective")
  .option('--workstream <id>', 'Answer from a specific workstream (default: role\'s workstream, else active)')
  .action(askCommand);

program.command('pull').description('Fetch and process pending web contributions').action(pullCommand);
program.command('reflect').description('AI rewrites shared context for clarity')
  .option('--workstream <id>', 'Target workstream (default: active)')
  .action(reflectCommand);
program.command('context <role>').description('Print role context MD to stdout').action(contextCommand);
program.command('status').description('Show project summary').action(statusCommand);
program.command('mcp').description('Start MCP server over stdio (for Claude Code, Claude Desktop, Cursor, etc.)')
  .option('-p, --project <path>', 'Absolute path to the teamctx project (defaults to $TEAMCTX_PROJECT_DIR or cwd)')
  .action(mcpCommand);

const review = program.command('review').description('Review pending contributions awaiting manager approval');
review.command('list').description('List all pending contributions').action(reviewListCommand);
review.command('approve <id>').description('Approve a pending contribution — applies it to shared context').action(reviewApproveCommand);
review.command('reject <id>').description('Reject a pending contribution — archives with optional reason')
  .option('--reason <text>', 'Reason for rejection (archived alongside the item)')
  .action(reviewRejectCommand);

const snapshot = program.command('snapshot').description('Version and approve the whole shared context as a known-good state');
snapshot.command('create').description('Freeze the current shared context as a pending snapshot')
  .option('-m, --message <text>', 'Label for the snapshot (e.g. "pre-launch freeze")')
  .action(snapshotCreateCommand);
snapshot.command('list').description('List all snapshots (marks the current-approved with *)').action(snapshotListCommand);
snapshot.command('show <id>').description('Print the snapshotted shared context to stdout (id or unique prefix)').action(snapshotShowCommand);
snapshot.command('approve <id>').description('Approve a pending snapshot — updates the current-approved pointer').action(snapshotApproveCommand);
snapshot.command('reject <id>').description('Reject a pending snapshot')
  .option('--reason <text>', 'Reason for rejection (recorded in the snapshot)')
  .action(snapshotRejectCommand);
snapshot.command('current').description('Show the current-approved snapshot').action(snapshotCurrentCommand);

const workstream = program.command('workstream').description('Manage workstreams (Why/What/How trees)');
workstream.command('suggest').description('AI proposes how to split the active workstream').action(workstreamSuggestCommand);
workstream.command('split').description('Interactively accept AI-proposed splits — creates new workstreams')
  .option('--accept-all', 'Accept every proposed split with AI-suggested names (non-interactive)')
  .action(workstreamSplitCommand);
workstream.command('list').description('List all workstreams and their assigned roles').action(workstreamListCommand);
workstream.command('use <id>').description('Set the active workstream for contribute/ask/reflect').action(workstreamUseCommand);

const config = program.command('config').description('View or change project settings');
config.command('provider [value]').description('Get or set the AI provider (anthropic|openai|gemini)').action(configProviderCommand);
config.command('model [value]').description('Get or set the AI model').action(configModelCommand);
config.command('github-raw-base [value]').description('Get or set the GitHub raw base URL').action(configGithubRawBaseCommand);
config.command('manager [value]').description('Get or set the manager identity (name); only that identity may approve/reject').action(configManagerCommand);
config.command('manager-email [value]').description('Get or set the manager email for contribution notifications').action(configManagerEmailCommand);
config.command('deploy-url [value]').description('Get or set the Vercel deploy URL').action(configDeployUrlCommand);

function formatError(err) {
  const raw = err?.message || String(err);
  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart));
      const msg = parsed?.error?.message || parsed?.message;
      if (msg) return msg;
    } catch { /* fall through */ }
  }
  return raw.split('\n')[0];
}

program.parseAsync().catch(err => {
  console.error(`\nError: ${formatError(err)}\n`);
  process.exit(1);
});
