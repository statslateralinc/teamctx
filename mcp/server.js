import { existsSync } from 'fs';
import { resolve as pathResolve, join } from 'path';
import dotenv from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  getTeamctxDir,
  readConfig, readWorkstream, writeWorkstream, listWorkstreamIds,
  readSharedMd, writeWorkstreamMd,
  readRoleFile, writeRoleFile,
  appendContribution, readContributions,
} from '../src/storage.js';
import { updateShared, generateRoleFile, serializeToMd, answerQuestion } from '../src/context.js';
import { commitContext, pushContext } from '../src/git.js';

export function resolveProjectDir(argv = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  const flagIdx = argv.findIndex(a => a === '--project' || a === '-p');
  if (flagIdx !== -1 && argv[flagIdx + 1]) return pathResolve(argv[flagIdx + 1]);
  const eqArg = argv.find(a => a.startsWith('--project='));
  if (eqArg) return pathResolve(eqArg.slice('--project='.length));
  if (env.TEAMCTX_PROJECT_DIR) return pathResolve(env.TEAMCTX_PROJECT_DIR);
  return cwd;
}

export const TOOLS = [
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
      properties: { id: { type: 'string', description: 'Workstream id (e.g. "main", "tech")' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_role_context',
    description: "Fetch a role's compiled context markdown by role slug (e.g. 'cpo').",
    inputSchema: {
      type: 'object',
      properties: { role: { type: 'string', description: 'Role slug' } },
      required: ['role'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask',
    description: "Ask a question answered from the team's shared context; optionally include a role's perspective.",
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        role: { type: 'string', description: 'Optional role slug to add role-specific context' },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_contribution',
    description: 'Add a new contribution to a workstream. AI updates the tree, regenerates role files for that workstream, and commits.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        author: { type: 'string', description: 'Override author; defaults to config.me' },
        workstream: { type: 'string', description: 'Target workstream id; defaults to active or "main"' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

function textResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

export function makeHandlers(projectRoot) {
  const dir = () => getTeamctxDir(projectRoot);

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
      const config = readConfig(dir());
      return textResult({ workstreams: config.workstreams || [{ id: 'main', name: config.project }] });
    },

    async get_workstream({ id }) {
      return textResult(readWorkstream(id, dir()));
    },

    async get_role_context({ role }) {
      return textResult(readRoleFile(role, dir()));
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

    async submit_contribution({ text, author, workstream: wsArg }) {
      const teamctxDir = dir();
      const config = readConfig(teamctxDir);
      const targetId = wsArg || config.activeWorkstream || 'main';
      const known = new Set([
        ...(config.workstreams || []).map(w => w.id),
        ...listWorkstreamIds(teamctxDir),
      ]);
      if (known.size > 0 && !known.has(targetId)) {
        throw new Error(`no workstream "${targetId}". Call list_workstreams to see available ids.`);
      }
      const workstream = readWorkstream(targetId, teamctxDir);
      const contribution = {
        id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        ts: new Date().toISOString(),
        author: author || config.me,
        text,
        tagged: null,
        source: 'mcp',
        workstream: targetId,
        status: 'logged',
      };
      appendContribution(contribution, teamctxDir);

      const { workstream: updated, summary, operations } = await updateShared(workstream, contribution, config);

      if (!operations || operations.length === 0) {
        return textResult({ id: contribution.id, workstream: targetId, summary: 'No changes to context tree (contribution logged).', operations: [] });
      }

      writeWorkstream(targetId, updated, teamctxDir);
      const contributions = readContributions(teamctxDir);
      writeWorkstreamMd(targetId, serializeToMd(updated, config.project, contribution.author, contributions), teamctxDir);

      const rolesOnTarget = (config.roles || []).filter(r => (r.workstream || 'main') === targetId);
      for (const role of rolesOnTarget) {
        const md = await generateRoleFile(updated, role, config.project, config, contributions);
        writeRoleFile(role.slug, md, teamctxDir);
      }

      const wsNote = targetId === 'main' ? '' : ` (${targetId})`;
      await commitContext(`context: ${contribution.author} contribution (via mcp)${wsNote}`, { cwd: projectRoot });
      if (config.autoPush) {
        try { await pushContext({ cwd: projectRoot }); } catch { /* non-fatal */ }
      }

      return textResult({ id: contribution.id, workstream: targetId, summary, operations });
    },
  };
}

export function buildServer(projectRoot) {
  const handlers = makeHandlers(projectRoot);

  const server = new Server(
    { name: 'teamctx', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const handler = handlers[req.params.name];
    if (!handler) throw new Error(`Unknown tool: ${req.params.name}`);
    try {
      return await handler(req.params.arguments || {});
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
