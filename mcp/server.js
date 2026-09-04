import { existsSync } from 'fs';
import { resolve as pathResolve, join } from 'path';
import dotenv from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  getTeamctxDir,
  readConfig, readWorkstream, listWorkstreamIds,
  readSharedMd,
  readRoleFile,
  readContributions,
} from '../src/storage.js';
import { answerQuestion } from '../src/context.js';
import { commitContext } from '../src/git.js';
import { connectorUrl, originRemote } from '../cli/commands/connect.core.js';
import { migrateIfNeeded } from '../src/migrate.js';
import { computeStats } from '../src/metrics.js';
import { initProject } from '../cli/commands/init.core.js';
import {
  listPendingReviews, approveReview, rejectReview,
} from '../cli/commands/review.core.js';
import {
  createSnapshot, approveSnapshot, rejectSnapshot,
  listAllSnapshots, getSnapshot, getCurrentSnapshot,
} from '../cli/commands/snapshot.core.js';
import {
  listRoles as coreListRoles, suggestRoles as coreSuggestRoles,
  addRoleFull, assignRole,
} from '../cli/commands/role.core.js';
import {
  listAllWorkstreams, suggestWorkstreamSplits, splitWorkstreams, useWorkstream,
} from '../cli/commands/workstream.core.js';
import { contributeCore } from '../cli/commands/contribute.core.js';
import {
  listTasksFiltered, getTask, addTask, setTaskStatus, assignTask, removeTask, compileTask,
} from '../cli/commands/task.core.js';
import { listMembers, addMember, removeMember } from '../cli/commands/member.core.js';
import { reflectWorkstream } from '../cli/commands/reflect.core.js';
import { getConfig, setConfig, repairManagerGate } from '../cli/commands/config.core.js';
import { resolveActor } from '../src/actor.js';
import { resolveActiveWorkstream, resolveIdentity, resolveDisplayName } from '../src/prefs.js';
import { managerKeys } from '../src/review.js';
import { INSTRUCTIONS } from './instructions.js';

export function resolveProjectDir(argv = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  const flagIdx = argv.findIndex(a => a === '--project' || a === '-p');
  if (flagIdx !== -1 && argv[flagIdx + 1]) return pathResolve(argv[flagIdx + 1]);
  const eqArg = argv.find(a => a.startsWith('--project='));
  if (eqArg) return pathResolve(eqArg.slice('--project='.length));
  if (env.TEAMCTX_PROJECT_DIR) return pathResolve(env.TEAMCTX_PROJECT_DIR);
  return cwd;
}

const RISKY = '⚠ RISKY: ';
const REPORT = ' The client should report the returned reportBack string to the user after calling.';

export const TOOLS = [
  // Tier 0 — read-only
  {
    name: 'get_context',
    description: 'Fetch all workstreams (Why/What/How trees) for the current teamctx project. Returns { workstreams: [{id, tree}, ...] }.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_workstreams',
    description: 'List the workstreams configured for the current project (id + name for each).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_workstream',
    description: 'Fetch a single workstream tree by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'get_role_context',
    description: "Fetch a role's compiled context markdown by role slug.",
    inputSchema: {
      type: 'object',
      properties: { role: { type: 'string' } },
      required: ['role'], additionalProperties: false,
    },
  },
  {
    name: 'list_roles',
    description: 'List all defined roles (slug, name, workstream).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_snapshots',
    description: 'List all snapshots with their status; also returns the current-approved id.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_snapshot',
    description: 'Fetch a snapshot by id or unique prefix.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'snapshot id or unique prefix' } },
      required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'get_current_snapshot',
    description: 'Fetch the current-approved snapshot pointer (id, message, approvedBy, approvedAt).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_pending_reviews',
    description: 'List all queued contributions awaiting manager review (id, author, workstream, summary, operations).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_status',
    description: "**Call this first when you do not know where you are.** Answers who is calling, which project, whether it is set up at all, and whether the caller is the manager — all in one read. Returns project name, provider, model, manager identity, workstreams with why-counts, roles, contribution/decision totals. `me` and `activeWorkstream` are the calling user's, not the project defaults. Read-only.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_connect_url',
    description: "**Reach for this after adding someone to the project** — it is what you send them. The URL a team member pastes into their AI client; they add it as a custom connector and sign in. Read-only. Fails with what to run when the project has no deploy URL recorded, which is the usual reason it is missing.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_config',
    description: "Return the public project config (provider, model, manager, deployUrl, autoPush, roles, workstreams), plus `me` and `activeWorkstream` resolved for the calling user. `projectDefaults` holds what the repo's config.json says. Never returns API keys.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ask',
    description: "Ask a question answered from the team's shared context; optionally include a role's perspective. Pass audit=true to append a per-contribution source list to the answer.",
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        role: { type: 'string', description: 'Optional role slug to add role-specific context' },
        audit: { type: 'boolean', description: 'When true, append a detailed source list; when false (default), append a one-line contributor summary' },
      },
      required: ['question'], additionalProperties: false,
    },
  },
  {
    name: 'suggest_roles',
    description: 'AI-suggest 3-5 roles for a workstream (dry-run; does not create them). Use role_add to create the chosen ones.',
    inputSchema: {
      type: 'object',
      properties: { workstream: { type: 'string', description: 'Workstream id (defaults to active or main)' } },
      additionalProperties: false,
    },
  },
  {
    name: 'suggest_workstream_splits',
    description: 'AI-propose sub-workstream splits for the active workstream (dry-run). Returns { splits: [{name, rationale, whyIds, whys}], leftover }. Use workstream_split to accept.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_stats',
    description: "Team metrics computed from the project's own history — contribution cadence by author, approval flow and median review wait, context freshness per workstream, task flow. Read-only, no AI call, nothing leaves the machine. Numbers are grounded: report them as returned rather than estimating. `approvals.historyAvailable` is false when git history is unreachable (hosted mode), in which case `decided`/`approved`/`medianHours` are null and must not be reported as zero. `approvals.waits` lists each decided item slowest first with its wait in hours and whether it was rejected — use it to name what actually stalled rather than summarising the median, which hides an outlier by design.",
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Start of the window as a date (default: last 28 days)' },
        workstream: { type: 'string', description: 'Narrow every metric to one workstream' },
      },
      additionalProperties: false,
    },
  },

  {
    name: 'list_tasks',
    description: "**Reach for this when somebody asks what they should be working on.** Pass mine:true for their own — never ask them what they are called, the server already knows who is calling. Defaults to open tasks in the caller's active workstream; pass all:true for every status across every workstream, which is what \"did we finish X\" means. Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'open | done' },
        mine: { type: 'boolean', description: "Only tasks belonging to the caller — this is what \"my tasks\" means. Cannot be combined with owner." },
        owner: { type: 'string', description: 'Someone else, by the display name shown in the task list' },
        workstream: { type: 'string' },
        all: { type: 'boolean', description: 'Every status, every workstream' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_members',
    description: 'List the people on this project: name, GitHub login, email, who added them and when. Read-only. A member is a person the manager has put on the roster; it is not the same as having access to the repository.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_task',
    description: 'Return one task by id or unique id prefix: title, owner, status, workstream, created/done/compiled timestamps, and the prompt file path if one has been compiled. Read-only. Use task_compile to get the prompt text itself.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task id, or a unique prefix of one' } },
      required: ['id'],
      additionalProperties: false,
    },
  },

  // Tier 1 — additive writes
  {
    name: 'contribute',
    description: "**This is how anything gets into the shared context — there is no separate import step.** Reach for it both when a manager tells you what the project is about and when somebody sends finished work back. Defaults to enqueueing for the manager's review, so tell the user it was sent for review, not that it was added. **The exception is a project's first contribution**: when get_status shows totalWhys:0, pass apply:true so it lands rather than waiting on the manager to approve their own opening message. apply:true writes immediately and requires the caller to be the manager. Optional decision:true tags it as a first-class decision. Returns { id, mode: \"queued\"|\"applied\"|\"no-op\", summary, operations, reportBack }.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        workstream: { type: 'string' },
        author: { type: 'string' },
        decision: { type: 'boolean' },
        apply: { type: 'boolean', description: 'Write immediately; skips the review queue' },
      },
      required: ['text'], additionalProperties: false,
    },
  },
  {
    name: 'submit_contribution',
    description: 'Deprecated alias for `contribute` — kept for one release. Prefer `contribute`.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' }, workstream: { type: 'string' }, author: { type: 'string' },
      },
      required: ['text'], additionalProperties: false,
    },
  },

  {
    name: 'task_add',
    description: '**Reach for this to turn what a manager wants into work somebody can pick up.** Creates a task and commits it; defaults to the caller as owner and their active workstream. Set compile:true to compile its prompt in the same call — the compiled prompt is the thing a person actually acts on, so this is usually what you want. It spends an AI call, so confirm the title with the user first; the result then carries the compiled markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        owner: { type: 'string', description: 'Defaults to the calling user' },
        workstream: { type: 'string', description: 'Defaults to the active workstream' },
        compile: { type: 'boolean', description: 'Also compile the prompt (AI call)' },
        role: { type: 'string', description: 'With compile:true, frame the prompt for this role slug' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_done',
    description: 'Mark a task done and commit. Returns unchanged:true without committing if it was already done.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_reopen',
    description: 'Reopen a done task and commit. Returns unchanged:true without committing if it was already open.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_assign',
    description: 'Reassign a task to a different owner and commit.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, owner: { type: 'string' } },
      required: ['id', 'owner'],
      additionalProperties: false,
    },
  },

  // Tier 2 — structural / gated
  {
    name: 'init',
    description: RISKY + 'creates a new teamctx project (.teamctx/ config, initial workstream, initial commit) in the resolved project directory. Refuses if already initialized. Requires the project dir to be a git repository. The caller becomes the initial author (config.me); no manager gate is set by default. Confirm all params with the user before calling.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Human project name' },
        me: { type: 'string', description: 'Your name/handle on contributions' },
        provider: { type: 'string', enum: ['anthropic', 'openai', 'gemini'] },
        model: { type: 'string', description: 'Optional; falls back to provider default' },
        autoPush: { type: 'boolean' },
        deployUrl: { type: 'string' },
        githubRawBase: { type: 'string' },
        managerEmail: { type: 'string' },
      },
      required: ['project', 'me'], additionalProperties: false,
    },
  },
  {
    name: 'role_add',
    description: RISKY + 'creates a new role, generates its role-context file, and commits. Not gated, but role structure changes the shape of every downstream regeneration. Confirm name + responsibilities with the user first.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        responsibilities: { type: 'string' },
        excludes: { type: 'string' },
        email: { type: 'string' },
        workstream: { type: 'string' },
      },
      required: ['name', 'responsibilities'], additionalProperties: false,
    },
  },
  {
    name: 'role_assign',
    description: RISKY + 'moves a role to a different workstream and regenerates its context file. Confirm the target workstream with the user.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' }, workstream: { type: 'string' } },
      required: ['slug', 'workstream'], additionalProperties: false,
    },
  },
  {
    name: 'workstream_split',
    description: RISKY + 'creates new sub-workstreams by moving Why nodes out of the active one. Structural change — reshapes how the project is organized. Callers should pass the accepted array returned (or filtered) from suggest_workstream_splits. Confirm the split names + role moves with the user before calling.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        accepted: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              whyIds: { type: 'array', items: { type: 'string' } },
              moveRoles: { type: 'array', items: { type: 'string' } },
            },
            required: ['name', 'whyIds'],
          },
        },
      },
      required: ['accepted'], additionalProperties: false,
    },
  },
  {
    name: 'workstream_use',
    description: 'Changes the calling user\'s active workstream. All their subsequent contribute/ask/reflect calls without an explicit workstream target this one. Personal setting — it is not written to the repo and does not affect other users.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'review_approve',
    description: RISKY + 'applies a queued contribution to shared context, regenerates the bound role files, and commits. Irreversible without a git revert. Manager-gated against the authenticated caller; there is no way to assert a different identity. Report the queue item author + summary to the user before calling; report the resulting operations after.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Queue item id (from list_pending_reviews)' },
      },
      required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'review_reject',
    description: RISKY + 'archives a queued contribution to rejected/ with an optional reason and commits. Manager-gated. Confirm intent with the user before calling.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'snapshot_create',
    description: RISKY + 'freezes every workstream as a versioned pending snapshot and commits. Not gated (creation is safe), but the manager needs to approve it via snapshot_approve for it to become current. Confirm the message with the user.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'snapshot_approve',
    description: RISKY + 'approves a pending snapshot and updates the current-approved pointer. Manager-gated. Report the snapshot summary to the user before calling.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Snapshot id or unique prefix' },
      },
      required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'snapshot_reject',
    description: RISKY + 'rejects a pending snapshot with an optional reason. Manager-gated. Confirm with the user.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, reason: { type: 'string' },
      },
      required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'reflect',
    description: RISKY + 'runs an AI rewrite of the workstream tree — condenses, deduplicates, and reorganizes Why nodes. Can meaningfully change how context reads. Not gated; confirm scope with the user first.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: { workstream: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'repair_manager_gate',
    description: RISKY + "re-pins a manager gate that is a display name rather than an identity — projects created on the web before this was fixed carry one, and nobody can match it, so every approval fails. Refuses unless the gate is broken **and** the caller created the project, read from the commit that added .teamctx/config.json. Not a way to take over a project: against a working gate, or from anybody but the creator, it refuses." + REPORT,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'config_set',
    description: RISKY + "writes a single config key. Project-wide keys: provider, model, githubRawBase, managerEmail, deployUrl, autoPush — these change the project for everyone. Personal key: name — the display name used on the caller's own contributions, stored against them and never written to the repo. Who may approve is fixed at init and cannot be changed here. Changing `provider` may reset `model`." + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          enum: ['provider', 'model', 'githubRawBase', 'manager', 'managerKey', 'managerEmail', 'deployUrl', 'autoPush', 'name'],
        },
        value: { description: 'String, boolean, or empty string to clear' },
      },
      required: ['key', 'value'], additionalProperties: false,
    },
  },
  {
    name: 'member_add',
    description: RISKY + "adds a person to the project roster and commits. Manager-gated against the authenticated caller. Takes a GitHub username or an email address — only a username can be invited to the repository, since GitHub's collaborator endpoint takes no email. Set invite:true to also send a repository invitation, which they must accept before they can clone. Without it they are on the roster but have no access, which looks the same to a manager and is not. Confirm the person and whether to invite before calling." + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'GitHub username, or an email address' },
        name: { type: 'string', description: 'Display name, if different from the handle' },
        invite: { type: 'boolean', description: 'Also invite them to the GitHub repository' },
        permission: { type: 'string', description: 'pull | triage | push | maintain | admin (default push)' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'member_rm',
    description: RISKY + 'removes a person from the project roster and commits. Manager-gated. Does **not** revoke their GitHub access — that has to be done on GitHub, and saying otherwise would leave a manager believing access was withdrawn when it was not.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'Username, email, name or actor key' } },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_rm',
    description: RISKY + 'permanently deletes a task and its compiled prompt file, then commits. There is no undo short of a git revert. Report the task title to the user and confirm before calling.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_compile',
    description: RISKY + "**Reach for this when somebody is ready to start a task** — it is the brief they work from. Spends an AI call to build a prompt from the workstream's shared context, the role's responsibilities and recent decisions, then overwrites any existing prompt and commits. Returns the markdown itself, not just a path: hand it to them, the caller usually cannot read the file. Skips the AI call and returns the cached prompt with alreadyCompiled:true when nothing has changed; pass force:true to regenerate anyway. Do not call in a loop." + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        role: { type: 'string', description: 'Role slug to frame the prompt for' },
        force: { type: 'boolean', description: 'Regenerate even if the Whys are unchanged' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

function textResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

function reportBackContribute(r) {
  if (r.mode === 'no-op') return `Tell the user: contribution logged for workstream "${r.workstream}" but the AI proposed no changes to the tree.`;
  if (r.mode === 'queued') return `Tell the user: contribution ${r.id} queued for manager approval on workstream "${r.workstream}" (${r.operations.length} op${r.operations.length === 1 ? '' : 's'}). Manager must run \`teamctx review approve ${r.id}\` or call the review_approve tool.`;
  return `Tell the user: contribution ${r.id} applied to workstream "${r.workstream}" (${r.operations.length} op${r.operations.length === 1 ? '' : 's'})${r.rolesRegenerated?.length ? `, regenerated roles: ${r.rolesRegenerated.join(', ')}` : ''}${r.pushed ? ', committed and pushed' : ', committed'}.`;
}

export function makeHandlers(projectRoot) {
  // `projectRoot` is either a filesystem path (local/stdio mode) or a hosted
  // context object `{__backend:'github', ...}`. In hosted mode, storage
  // dispatch ignores the `dir` arg and pulls from the ambient GithubSession
  // (see src/session-context.js), so any truthy placeholder here is fine.
  const isHosted = typeof projectRoot === 'object' && projectRoot?.__backend === 'github';
  // Some tools (init) run before .teamctx/ exists, so they take projectRoot directly.
  // migrateIfNeeded touches the filesystem directly, so it only runs locally.
  let migrated = false;
  const dir = () => {
    if (isHosted) return projectRoot;
    const teamctxDir = getTeamctxDir(projectRoot);
    if (!migrated) {
      try { migrateIfNeeded(teamctxDir); } catch { /* best-effort */ }
      migrated = true;
    }
    return teamctxDir;
  };

  // Local (stdio) mode has no ambient actor, so this falls through to the git
  // identity in the project directory. Hosted mode gets one seeded per request
  // from the OAuth session — see api/mcp/[owner]/[repo].js.
  // In hosted mode `projectRoot` is a context object, not a path — never hand it
  // to anything that shells out to git.
  const gitCwd = isHosted ? undefined : projectRoot;

  const who = async (teamctxDir, config) => {
    const actor = await resolveActor({ config, cwd: gitCwd });
    const identity = await resolveIdentity({ actor, config, teamctxDir });
    return {
      actor,
      name: identity.name,
      // Where the *name* came from. 'override' when the user set their own,
      // which is not the same as where the actor was authenticated.
      nameSource: identity.source,
      workstream: await resolveActiveWorkstream({ actor, config, teamctxDir }),
    };
  };

  return {
    async get_context() {
      const teamctxDir = dir();
      const config = readConfig(teamctxDir);
      const ids = new Set([
        ...(config.workstreams || []).map(w => w.id),
        ...listWorkstreamIds(teamctxDir),
      ]);
      if (ids.size === 0) ids.add('main');
      const workstreams = [...ids].sort().map(id => ({ id, tree: readWorkstream(id, teamctxDir) }));
      return textResult({ workstreams });
    },

    async list_workstreams() {
      return textResult({
        workstreams: await listAllWorkstreams({ teamctxDir: dir(), projectDir: gitCwd }),
      });
    },

    async get_workstream({ id }) {
      return textResult(readWorkstream(id, dir()));
    },

    async get_role_context({ role }) {
      return textResult(readRoleFile(role, dir()));
    },

    async list_roles() {
      return textResult({ roles: coreListRoles({ teamctxDir: dir() }) });
    },

    async list_snapshots() {
      return textResult(listAllSnapshots({ teamctxDir: dir() }));
    },

    async get_snapshot({ id }) {
      return textResult(getSnapshot({ prefix: id, teamctxDir: dir() }));
    },

    async get_current_snapshot() {
      return textResult({ current: getCurrentSnapshot({ teamctxDir: dir() }) });
    },

    async list_pending_reviews() {
      return textResult({ pending: await listPendingReviews({ teamctxDir: dir() }) });
    },

    async get_status() {
      const teamctxDir = dir();
      const config = readConfig(teamctxDir);
      const workstreams = await listAllWorkstreams({ teamctxDir, projectDir: gitCwd });
      const contributions = readContributions(teamctxDir);
      const decisions = contributions.filter(c => c.tagged === 'decision');
      const me = await who(teamctxDir, config);
      return textResult({
        project: config.project,
        provider: config.provider || 'anthropic',
        model: config.model,
        // The gate, not `config.manager`. That field is the legacy display-name
        // one and is empty on every project created since; reading it reported
        // "no manager" for projects that had one, which is the question this
        // field exists to answer.
        manager: managerKeys(config)[0] || config.manager || null,
        managerDisplayName: config.manager || null,
        // Who *this caller* is and where *they* are working — not the shared
        // config.me / config.activeWorkstream, which are only the defaults.
        me: me.name,
        meSource: me.nameSource,
        actorSource: me.actor.source,
        activeWorkstream: me.workstream,
        projectDefaults: { me: config.me, activeWorkstream: config.activeWorkstream || 'main' },
        totalWhys: workstreams.reduce((n, w) => n + w.whyCount, 0),
        workstreams,
        contributions: { total: contributions.length, decisions: decisions.length },
        roles: (config.roles || []).map(r => ({ slug: r.slug, name: r.name, workstream: r.workstream || 'main' })),
      });
    },

    async list_members() {
      return textResult({ members: listMembers({ teamctxDir: dir() }) });
    },

    async member_add(args = {}) {
      const r = await addMember({
        ref: args.ref,
        name: args.name,
        invite: !!args.invite,
        permission: args.permission || 'push',
        // Hosted requests carry the repo they are scoped to, and the caller's
        // own token already holds the `repo` scope the invite needs.
        owner: projectRoot?.owner,
        repo: projectRoot?.repo,
        ghToken: projectRoot?.ghToken,
        teamctxDir: dir(),
        projectDir: gitCwd,
      });

      const access = r.invite?.invited ? ' and invited to the repository'
        : r.invite?.alreadyCollaborator ? ' (already had repository access)'
        : r.invite?.error ? ` — the repository invite failed: ${r.invite.error}`
        : r.member.login ? ' — not invited to the repository, so they cannot clone it yet'
        : '';
      return textResult({ ...r, reportBack: `${r.member.name} added to the project${access}.` });
    },

    async member_rm(args = {}) {
      const r = await removeMember({ ref: args.ref, teamctxDir: dir(), projectDir: gitCwd });
      return textResult({
        ...r,
        reportBack: `${r.member.name} removed from the roster.`
          + (r.stillHasRepoAccess ? ' Their GitHub access is unchanged.' : ''),
      });
    },

    async list_tasks(args = {}) {
      const teamctxDir = dir();
      const config = readConfig(teamctxDir);
      const actor = await resolveActor({ config, cwd: gitCwd });
      const activeWorkstream = await resolveActiveWorkstream({ actor, config, teamctxDir });
      // The server already knows who is calling, so "what are my tasks?" does
      // not need the caller to know what this project calls them.
      const me = await resolveDisplayName({ actor, config, teamctxDir });
      return textResult(listTasksFiltered({
        ...args, activeWorkstream, teamctxDir, me, myKey: actor.key,
      }));
    },

    async get_task(args = {}) {
      return textResult(getTask({ id: args.id, teamctxDir: dir() }));
    },

    async task_add(args = {}) {
      const teamctxDir = dir();
      const added = await addTask({
        title: args.title,
        owner: args.owner,
        workstream: args.workstream,
        teamctxDir,
        projectDir: gitCwd,
      });

      // Raising a task and immediately compiling it is the common case, and two
      // round trips for one intention is friction an assistant feels more than
      // a person does. Kept opt-in because the second half spends an AI call.
      if (!args.compile) {
        return textResult({
          ...added,
          reportBack: `Task ${added.task.id} added, owned by ${added.task.owner}.`,
        });
      }

      const compiled = await compileTask({
        id: added.task.id,
        role: args.role,
        teamctxDir,
        projectDir: gitCwd,
      });
      return textResult({
        ...compiled,
        reportBack: `Task ${added.task.id} added and its prompt compiled`
          + `${compiled.role ? ` for role ${compiled.role}` : ''}.`,
      });
    },

    async task_done(args = {}) {
      const r = await setTaskStatus({
        id: args.id, status: 'done', teamctxDir: dir(), projectDir: gitCwd,
      });
      return textResult({
        ...r,
        reportBack: r.unchanged
          ? `Task ${r.task.id} was already done.`
          : `Task ${r.task.id} marked done.`,
      });
    },

    async task_reopen(args = {}) {
      const r = await setTaskStatus({
        id: args.id, status: 'open', teamctxDir: dir(), projectDir: gitCwd,
      });
      return textResult({
        ...r,
        reportBack: r.unchanged
          ? `Task ${r.task.id} was already open.`
          : `Task ${r.task.id} reopened.`,
      });
    },

    async task_assign(args = {}) {
      const r = await assignTask({
        id: args.id, owner: args.owner, teamctxDir: dir(), projectDir: gitCwd,
      });
      return textResult({ ...r, reportBack: `Task ${r.task.id} assigned to ${r.task.owner}.` });
    },

    async task_rm(args = {}) {
      const r = await removeTask({ id: args.id, teamctxDir: dir(), projectDir: gitCwd });
      return textResult({
        ...r,
        reportBack: `Task ${r.id} ("${r.title}") permanently removed from workstream ${r.workstream}.`,
      });
    },

    async task_compile(args = {}) {
      const r = await compileTask({
        id: args.id, role: args.role, force: !!args.force,
        teamctxDir: dir(), projectDir: gitCwd,
      });
      return textResult({
        ...r,
        reportBack: r.alreadyCompiled
          ? `Task ${r.task.id} was already compiled and its workstream has not changed — returned the existing prompt, no AI call spent.`
          : `Compiled a prompt for task ${r.task.id}${r.role ? ` framed for role ${r.role}` : ''}.`,
      });
    },

    async get_stats(args = {}) {
      // Hosted mode reaches the repo over the Git Data API, not a working copy,
      // so `queueTimeline` finds no git binary and the approval numbers come
      // back null. The tool description tells the client to say so rather than
      // report a zero.
      return textResult(await computeStats({
        cwd: gitCwd,
        teamctxDir: dir(),
        since: args.since,
        workstream: args.workstream,
      }));
    },

    async get_connect_url() {
      const config = readConfig(dir());
      // Hosted already knows the repository from the request URL; a clone has to
      // read its remote, which stays right through a rename.
      const where = isHosted
        ? { owner: projectRoot.owner, repo: projectRoot.repo }
        : { remote: await originRemote(gitCwd) };
      try {
        const r = connectorUrl({ deployUrl: config.deployUrl, ...where });
        return textResult({
          ...r,
          reportBack: `Connector URL for ${config.project || r.repo}: ${r.url} — send it to anyone on the project; they add it as a custom connector and sign in.`,
        });
      } catch (err) {
        return textResult({
          error: err.message,
          reportBack: err.code === 'NO_DEPLOY_URL'
            ? 'Tell the user: this project has no deploy URL recorded, so there is no connector to hand out. Set it with config_set key "deployUrl" if the project is deployed.'
            : `Tell the user: ${err.message}.`,
        });
      }
    },

    async get_config() {
      // `me` and `activeWorkstream` come back resolved for *this* caller;
      // `projectDefaults` carries what config.json says, which is only the
      // fallback for someone who has set no preference of their own.
      return textResult(await getConfig({ teamctxDir: dir(), projectDir: gitCwd }));
    },

    async ask({ question, role, audit }) {
      const teamctxDir = dir();
      const config = readConfig(teamctxDir);
      let roleMd = '';
      if (role) {
        const found = (config.roles || []).find(r => r.slug === role);
        if (!found) {
          const available = (config.roles || []).map(r => r.slug).join(', ') || '(none)';
          throw new Error(`No role "${role}". Available: ${available}`);
        }
        roleMd = readRoleFile(role, teamctxDir);
      }
      const sharedMd = readSharedMd(teamctxDir);
      const { workstream: activeWorkstreamId } = await who(teamctxDir, config);
      const workstream = readWorkstream(activeWorkstreamId, teamctxDir);
      const contributions = readContributions(teamctxDir);
      const answer = await answerQuestion({
        sharedMd, roleMd, question, config,
        workstream, contributions, audit: !!audit,
      });
      return textResult(answer);
    },

    async suggest_roles({ workstream } = {}) {
      const result = await coreSuggestRoles({ workstreamId: workstream, teamctxDir: dir(), projectDir: gitCwd });
      return textResult(result);
    },

    async suggest_workstream_splits() {
      const result = await suggestWorkstreamSplits({ teamctxDir: dir(), projectDir: gitCwd });
      return textResult({
        activeId: result.activeId,
        splits: result.splits,
        leftover: result.leftover,
      });
    },

    async contribute(args) {
      const r = await contributeCore({
        text: args.text,
        author: args.author,
        workstreamId: args.workstream,
        decision: !!args.decision,
        apply: !!args.apply,
        source: 'mcp',
        teamctxDir: dir(),
        projectDir: gitCwd,
      });
      return textResult({ ...r, reportBack: reportBackContribute(r) });
    },

    async submit_contribution(args) {
      // Deprecated alias for backward compat. The old submit_contribution wrote
      // immediately (no approval queue), so preserve that by defaulting apply:true.
      return this.contribute({ ...args, apply: true });
    },

    async init(args) {
      const r = await initProject({
        projectDir: gitCwd,
        project: args.project, me: args.me,
        provider: args.provider || 'anthropic',
        model: args.model,
        autoPush: args.autoPush !== false,
        deployUrl: args.deployUrl,
        githubRawBase: args.githubRawBase,
        managerEmail: args.managerEmail,
        source: 'mcp',
      });
      const reportBack = `Tell the user: teamctx initialized at ${r.projectDir} for project "${r.config.project}"` +
        (r.envVarPresent ? '' : ` — WARNING: ${r.envVarNeeded} is not set in the environment; ask/contribute/reflect will fail until it is.`) +
        (r.pushed ? '. Committed and pushed.' : '. Committed (no remote configured yet).');
      return textResult({
        projectDir: r.projectDir,
        config: r.config,
        gitignoreChanged: r.gitignoreChanged,
        envVarNeeded: r.envVarNeeded,
        envVarPresent: r.envVarPresent,
        pushed: r.pushed,
        reportBack,
      });
    },

    async role_add(args) {
      const r = await addRoleFull({
        name: args.name,
        responsibilities: args.responsibilities,
        excludes: args.excludes,
        email: args.email,
        workstreamId: args.workstream,
        teamctxDir: dir(),
        projectDir: gitCwd,
      });
      const reportBack = `Tell the user: role "${r.slug}" created on workstream "${r.workstreamId}"${r.pushed ? ' (committed and pushed)' : ' (committed)'}.`;
      return textResult({ ...r, reportBack });
    },

    async role_assign(args) {
      const r = await assignRole({
        slug: args.slug, workstreamId: args.workstream,
        teamctxDir: dir(), projectDir: gitCwd,
      });
      const reportBack = r.changed
        ? `Tell the user: role "${r.slug}" moved to workstream "${r.workstreamId}"; role file regenerated.`
        : `Tell the user: role "${r.slug}" was already on workstream "${r.workstreamId}" — no change.`;
      return textResult({ ...r, reportBack });
    },

    async workstream_split(args) {
      const r = await splitWorkstreams({
        accepted: args.accepted,
        teamctxDir: dir(), projectDir: gitCwd,
      });
      const summary = r.results.map(x => `"${x.splitName}" (${x.newId}, ${x.movedWhyCount} Whys${x.movedRoles.length ? `, moved roles ${x.movedRoles.join(',')}` : ''})`).join('; ');
      const reportBack = `Tell the user: split "${r.sourceId}" into ${r.results.length} new workstream${r.results.length === 1 ? '' : 's'}: ${summary}.`;
      return textResult({ ...r, reportBack });
    },

    async workstream_use({ id }) {
      const r = await useWorkstream({ id, teamctxDir: dir(), projectDir: gitCwd });
      return textResult({
        ...r,
        reportBack: `Tell the user: their active workstream is now "${r.activeWorkstream}". This is a personal setting — it does not change anyone else's.`,
      });
    },

    async review_approve({ id }) {
      // No caller-supplied identity: the gate reads the authenticated actor.
      const r = await approveReview({ id, teamctxDir: dir(), projectDir: gitCwd });
      const reportBack = `Tell the user: approved contribution ${r.id} by ${r.author} on workstream "${r.workstream}" (${r.operations.length} op${r.operations.length === 1 ? '' : 's'}${r.rolesRegenerated.length ? `, regenerated roles: ${r.rolesRegenerated.join(', ')}` : ''}${r.pushed ? ', pushed' : ''}).`;
      return textResult({ ...r, reportBack });
    },

    async review_reject({ id, reason }) {
      const r = await rejectReview({ id, reason, teamctxDir: dir(), projectDir: gitCwd });
      const reportBack = `Tell the user: rejected ${r.id}${r.reason ? ` (reason: ${r.reason})` : ''}${r.pushed ? ' — pushed' : ''}.`;
      return textResult({ ...r, reportBack });
    },

    async snapshot_create({ message } = {}) {
      const r = await createSnapshot({ message, teamctxDir: dir(), projectDir: gitCwd });
      const reportBack = `Tell the user: snapshot ${r.snapshot.id} created${r.snapshot.message ? ` (${r.snapshot.message})` : ''} — manager must approve via snapshot_approve for it to become current.`;
      return textResult({ ...r, reportBack });
    },

    async snapshot_approve({ id }) {
      const r = await approveSnapshot({ prefix: id, teamctxDir: dir(), projectDir: gitCwd });
      const reportBack = `Tell the user: snapshot ${r.id} approved by ${r.approvedBy} — it is now the current-approved snapshot.`;
      return textResult({ ...r, reportBack });
    },

    async snapshot_reject({ id, reason }) {
      const r = await rejectSnapshot({ prefix: id, reason, teamctxDir: dir(), projectDir: gitCwd });
      const reportBack = `Tell the user: snapshot ${r.id} rejected${r.reason ? ` (reason: ${r.reason})` : ''}.`;
      return textResult({ ...r, reportBack });
    },

    async reflect({ workstream } = {}) {
      const r = await reflectWorkstream({ workstreamId: workstream, teamctxDir: dir(), projectDir: gitCwd });
      const reportBack = `Tell the user: reflected workstream "${r.workstreamId}"${r.rolesRegenerated.length ? `; regenerated roles: ${r.rolesRegenerated.join(', ')}` : ''}${r.pushed ? '; pushed' : ''}.`;
      return textResult({ workstreamId: r.workstreamId, rolesRegenerated: r.rolesRegenerated, pushed: r.pushed, pushError: r.pushError, reportBack });
    },

    async repair_manager_gate() {
      const r = await repairManagerGate({ teamctxDir: dir(), projectDir: gitCwd });
      const c = await commitContext(`config: repair manager gate (via mcp)`,
        gitCwd ? { cwd: gitCwd } : undefined);
      return textResult({
        ...r, committed: c?.committed === true,
        reportBack: `Tell the user: the manager gate was ${r.from}, which nobody could match. `
          + `It is now ${r.to}, so they can approve again.`
          + (r.warning ? ` Also tell them: ${r.warning}` : ''),
      });
    },

    async config_set({ key, value }) {
      const r = await setConfig({ key, value, teamctxDir: dir(), projectDir: gitCwd });
      // Every other mutating tool commits; this one did not. A hosted write
      // lands in the session's in-memory copy of the repo, so without a commit
      // the request ended and the change was gone — while the tool still
      // reported success, which is the worst way for a write to fail.
      let committed = false;
      if (r.wroteRepo) {
        // Reported rather than assumed: writing the value already stored leaves
        // nothing to commit, and a caller told otherwise has a success it can
        // only disprove by reading back.
        const c = await commitContext(`config: ${r.key} by ${await who(dir(), readConfig(dir()))} (via mcp)`,
          gitCwd ? { cwd: gitCwd } : undefined);
        committed = c?.committed === true;
      }
      const notes = r.notes.length ? ` Notes: ${r.notes.join(' | ')}` : '';
      // Clearing is not setting. A client that surfaces only reportBack would
      // otherwise tell the user their name was set to the very value they just
      // removed the override for.
      const what = r.cleared
        ? `config.${r.key} override cleared — it is derived again, currently ${JSON.stringify(r.value)}.`
        : `config.${r.key} set to ${JSON.stringify(r.value)}.`;
      // Whether it persisted belongs in the sentence a client reads out. The
      // tool description tells callers to report this verbatim, so a success
      // string that does not depend on the write is a false success said aloud.
      const landed = r.wroteRepo
        ? (committed ? ' Committed to the repo.' : ' Nothing was committed — the value was already stored.')
        : '';
      return textResult({ ...r, committed, reportBack: `Tell the user: ${what}${landed}${notes}` });
    },
  };
}

export function buildServer(projectRoot) {
  const handlers = makeHandlers(projectRoot);

  const server = new Server(
    { name: 'teamctx', version: '0.2.0' },
    // `instructions` reaches the model once, before any tool call. Without it a
    // host has the whole surface and no idea when to reach for any of it — see
    // mcp/instructions.js.
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const handler = handlers[req.params.name];
    if (!handler) throw new Error(`Unknown tool: ${req.params.name}`);
    try {
      return await handler.call(handlers, req.params.arguments || {});
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });

  return server;
}

export async function startMcpServer({ projectDir } = {}) {
  const projectRoot = projectDir ? pathResolve(projectDir) : resolveProjectDir();
  const envLocalPath = join(projectRoot, '.env.local');
  if (existsSync(envLocalPath)) dotenv.config({ path: envLocalPath });

  const server = buildServer(projectRoot);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
