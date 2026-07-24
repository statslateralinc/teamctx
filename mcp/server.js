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
} from '../src/storage.js';
import { answerQuestion } from '../src/context.js';
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
import { reflectWorkstream } from '../cli/commands/reflect.core.js';
import { getConfig, setConfig } from '../cli/commands/config.core.js';

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
    description: 'Return the teamctx project status: project name, provider, model, manager identity, workstreams with why-counts, roles, contribution/decision totals.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_config',
    description: 'Return the public project config (provider, model, manager, deployUrl, autoPush, roles, workstreams). Never returns API keys.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ask',
    description: "Ask a question answered from the team's shared context; optionally include a role's perspective.",
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        role: { type: 'string', description: 'Optional role slug' },
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

  // Tier 1 — additive writes
  {
    name: 'contribute',
    description: 'Add a contribution to a workstream. Defaults to enqueueing for manager approval; set apply:true to write immediately (requires the caller to be the manager if a manager gate is set). Optional decision:true tags it as a first-class decision. Returns { id, mode: "queued"|"applied"|"no-op", summary, operations, reportBack }.',
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
    description: RISKY + 'changes the active workstream. All subsequent contribute/ask/reflect calls without an explicit workstream will target this one. Low-severity but user-visible; confirm before switching.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'review_approve',
    description: RISKY + 'applies a queued contribution to shared context, regenerates the bound role files, and commits. Irreversible without a git revert. Manager-gated: caller (via `author`) must match config.manager if set. Report the queue item author + summary to the user before calling; report the resulting operations after.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Queue item id (from list_pending_reviews)' },
        author: { type: 'string', description: 'Caller identity — must match config.manager if a manager gate is set' },
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
        author: { type: 'string' },
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
        author: { type: 'string' },
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
        id: { type: 'string' }, reason: { type: 'string' }, author: { type: 'string' },
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
    name: 'config_set',
    description: RISKY + 'writes a single config key. Allowed keys: provider, model, githubRawBase, manager, managerEmail, deployUrl, autoPush. Changing `manager` re-gates who can approve/reject; changing `provider` may reset `model`.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          enum: ['provider', 'model', 'githubRawBase', 'manager', 'managerEmail', 'deployUrl', 'autoPush'],
        },
        value: { description: 'String, boolean, or empty string to clear' },
      },
      required: ['key', 'value'], additionalProperties: false,
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
  const dir = () => getTeamctxDir(projectRoot);
  // Some tools (init) run before .teamctx/ exists, so they take projectRoot directly.

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
      return textResult({ workstreams: listAllWorkstreams({ teamctxDir: dir() }) });
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
      const workstreams = listAllWorkstreams({ teamctxDir });
      const { readContributions } = await import('../src/storage.js');
      const contributions = readContributions(teamctxDir);
      const decisions = contributions.filter(c => c.tagged === 'decision');
      return textResult({
        project: config.project,
        provider: config.provider || 'anthropic',
        model: config.model,
        manager: config.manager || null,
        me: config.me,
        activeWorkstream: config.activeWorkstream || 'main',
        totalWhys: workstreams.reduce((n, w) => n + w.whyCount, 0),
        workstreams,
        contributions: { total: contributions.length, decisions: decisions.length },
        roles: (config.roles || []).map(r => ({ slug: r.slug, name: r.name, workstream: r.workstream || 'main' })),
      });
    },

    async get_config() {
      return textResult(getConfig({ teamctxDir: dir() }));
    },

    async ask({ question, role }) {
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
      const answer = await answerQuestion({ sharedMd, roleMd, question, config });
      return textResult(answer);
    },

    async suggest_roles({ workstream } = {}) {
      const result = await coreSuggestRoles({ workstreamId: workstream, teamctxDir: dir() });
      return textResult(result);
    },

    async suggest_workstream_splits() {
      const result = await suggestWorkstreamSplits({ teamctxDir: dir() });
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
        projectDir: projectRoot,
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
        projectDir: projectRoot,
        project: args.project, me: args.me,
        provider: args.provider || 'anthropic',
        model: args.model,
        autoPush: args.autoPush !== false,
        deployUrl: args.deployUrl,
        githubRawBase: args.githubRawBase,
        managerEmail: args.managerEmail,
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
        projectDir: projectRoot,
      });
      const reportBack = `Tell the user: role "${r.slug}" created on workstream "${r.workstreamId}"${r.pushed ? ' (committed and pushed)' : ' (committed)'}.`;
      return textResult({ ...r, reportBack });
    },

    async role_assign(args) {
      const r = await assignRole({
        slug: args.slug, workstreamId: args.workstream,
        teamctxDir: dir(), projectDir: projectRoot,
      });
      const reportBack = r.changed
        ? `Tell the user: role "${r.slug}" moved to workstream "${r.workstreamId}"; role file regenerated.`
        : `Tell the user: role "${r.slug}" was already on workstream "${r.workstreamId}" — no change.`;
      return textResult({ ...r, reportBack });
    },

    async workstream_split(args) {
      const r = await splitWorkstreams({
        accepted: args.accepted,
        teamctxDir: dir(), projectDir: projectRoot,
      });
      const summary = r.results.map(x => `"${x.splitName}" (${x.newId}, ${x.movedWhyCount} Whys${x.movedRoles.length ? `, moved roles ${x.movedRoles.join(',')}` : ''})`).join('; ');
      const reportBack = `Tell the user: split "${r.sourceId}" into ${r.results.length} new workstream${r.results.length === 1 ? '' : 's'}: ${summary}.`;
      return textResult({ ...r, reportBack });
    },

    async workstream_use({ id }) {
      const r = useWorkstream({ id, teamctxDir: dir() });
      return textResult({ ...r, reportBack: `Tell the user: active workstream is now "${r.activeWorkstream}".` });
    },

    async review_approve({ id, author }) {
      const r = await approveReview({ id, teamctxDir: dir(), projectDir: projectRoot, actor: author });
      const reportBack = `Tell the user: approved contribution ${r.id} by ${r.author} on workstream "${r.workstream}" (${r.operations.length} op${r.operations.length === 1 ? '' : 's'}${r.rolesRegenerated.length ? `, regenerated roles: ${r.rolesRegenerated.join(', ')}` : ''}${r.pushed ? ', pushed' : ''}).`;
      return textResult({ ...r, reportBack });
    },

    async review_reject({ id, reason, author }) {
      const r = await rejectReview({ id, reason, teamctxDir: dir(), projectDir: projectRoot, actor: author });
      const reportBack = `Tell the user: rejected ${r.id}${r.reason ? ` (reason: ${r.reason})` : ''}${r.pushed ? ' — pushed' : ''}.`;
      return textResult({ ...r, reportBack });
    },

    async snapshot_create({ message } = {}) {
      const r = await createSnapshot({ message, teamctxDir: dir(), projectDir: projectRoot });
      const reportBack = `Tell the user: snapshot ${r.snapshot.id} created${r.snapshot.message ? ` (${r.snapshot.message})` : ''} — manager must approve via snapshot_approve for it to become current.`;
      return textResult({ ...r, reportBack });
    },

    async snapshot_approve({ id, author }) {
      const r = await approveSnapshot({ prefix: id, teamctxDir: dir(), projectDir: projectRoot, actor: author });
      const reportBack = `Tell the user: snapshot ${r.id} approved by ${r.approvedBy} — it is now the current-approved snapshot.`;
      return textResult({ ...r, reportBack });
    },

    async snapshot_reject({ id, reason, author }) {
      const r = await rejectSnapshot({ prefix: id, reason, teamctxDir: dir(), projectDir: projectRoot, actor: author });
      const reportBack = `Tell the user: snapshot ${r.id} rejected${r.reason ? ` (reason: ${r.reason})` : ''}.`;
      return textResult({ ...r, reportBack });
    },

    async reflect({ workstream } = {}) {
      const r = await reflectWorkstream({ workstreamId: workstream, teamctxDir: dir(), projectDir: projectRoot });
      const reportBack = `Tell the user: reflected workstream "${r.workstreamId}"${r.rolesRegenerated.length ? `; regenerated roles: ${r.rolesRegenerated.join(', ')}` : ''}${r.pushed ? '; pushed' : ''}.`;
      return textResult({ workstreamId: r.workstreamId, rolesRegenerated: r.rolesRegenerated, pushed: r.pushed, pushError: r.pushError, reportBack });
    },

    async config_set({ key, value }) {
      const r = setConfig({ key, value, teamctxDir: dir() });
      const notes = r.notes.length ? ` Notes: ${r.notes.join(' | ')}` : '';
      return textResult({ ...r, reportBack: `Tell the user: config.${r.key} set to ${JSON.stringify(r.value)}.${notes}` });
    },
  };
}

export function buildServer(projectRoot) {
  const handlers = makeHandlers(projectRoot);

  const server = new Server(
    { name: 'teamctx', version: '0.2.0' },
    { capabilities: { tools: {} } },
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
