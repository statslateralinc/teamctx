import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  readConfig, readShared, writeShared,
  readSharedMd, writeSharedMd,
  readRoleFile, writeRoleFile,
  appendContribution,
} from '../src/storage.js';
import { updateShared, generateRoleFile, serializeToMd, answerQuestion } from '../src/context.js';
import { commitContext, pushContext } from '../src/git.js';

const TOOLS = [
  {
    name: 'get_context',
    description: 'Fetch the full Why/What/How tree for the current teamctx project as JSON.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
    description: 'Add a new contribution. AI updates the shared Why/What/How tree, regenerates role files, and commits.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        author: { type: 'string', description: 'Override author; defaults to config.me' },
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

async function handleGetContext() {
  return textResult(readShared());
}

async function handleGetRoleContext({ role }) {
  return textResult(readRoleFile(role));
}

async function handleAsk({ question, role }) {
  const config = readConfig();
  let roleMd = '';
  if (role) {
    const found = (config.roles || []).find(r => r.slug === role);
    if (!found) {
      const available = (config.roles || []).map(r => r.slug).join(', ') || '(none)';
      throw new Error(`No role "${role}". Available: ${available}`);
    }
    roleMd = readRoleFile(role);
  }
  const sharedMd = readSharedMd();
  const answer = await answerQuestion({ sharedMd, roleMd, question, config });
  return textResult(answer);
}

async function handleSubmitContribution({ text, author }) {
  const config = readConfig();
  const workstream = readShared();
  const contribution = {
    id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ts: new Date().toISOString(),
    author: author || config.me,
    text,
    tagged: null,
    status: 'logged',
  };
  appendContribution(contribution);

  const { workstream: updated, summary, operations } = await updateShared(workstream, contribution, config);

  if (!operations || operations.length === 0) {
    return textResult({ id: contribution.id, summary: 'No changes to context tree (contribution logged).', operations: [] });
  }

  writeShared(updated);
  writeSharedMd(serializeToMd(updated, config.project, contribution.author));

  for (const role of config.roles || []) {
    const md = await generateRoleFile(updated, role, config.project, config);
    writeRoleFile(role.slug, md);
  }

  await commitContext(`context: ${contribution.author} contribution (via mcp)`);
  if (config.autoPush) {
    try { await pushContext(); } catch { /* client already has the summary; push failure is non-fatal here */ }
  }

  return textResult({ id: contribution.id, summary, operations });
}

const HANDLERS = {
  get_context: handleGetContext,
  get_role_context: handleGetRoleContext,
  ask: handleAsk,
  submit_contribution: handleSubmitContribution,
};

export function buildServer() {
  const server = new Server(
    { name: 'teamctx', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const handler = HANDLERS[req.params.name];
    if (!handler) throw new Error(`Unknown tool: ${req.params.name}`);
    try {
      return await handler(req.params.arguments || {});
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });

  return server;
}

export async function startMcpServer() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
