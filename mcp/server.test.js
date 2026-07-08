import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/storage.js', () => ({
  getTeamctxDir: vi.fn((root) => `${root}/.teamctx`),
  readConfig: vi.fn(),
  readShared: vi.fn(),
  writeShared: vi.fn(),
  readSharedMd: vi.fn(),
  writeSharedMd: vi.fn(),
  readRoleFile: vi.fn(),
  writeRoleFile: vi.fn(),
  appendContribution: vi.fn(),
}));

vi.mock('../src/context.js', () => ({
  updateShared: vi.fn(),
  generateRoleFile: vi.fn(),
  serializeToMd: vi.fn(() => '# md'),
  answerQuestion: vi.fn(),
}));

vi.mock('../src/git.js', () => ({
  commitContext: vi.fn(),
  pushContext: vi.fn(),
}));

import { TOOLS, makeHandlers, buildServer, resolveProjectDir } from './server.js';
import {
  getTeamctxDir,
  readConfig, readShared, writeShared,
  readSharedMd, writeSharedMd,
  readRoleFile, writeRoleFile,
  appendContribution,
} from '../src/storage.js';
import { updateShared, generateRoleFile, answerQuestion } from '../src/context.js';
import { commitContext, pushContext } from '../src/git.js';

const baseWs = { id: 'main', name: 'Demo', whys: [] };
const baseConfig = { project: 'Demo', me: 'alice', model: 'claude-sonnet-4-6', roles: [], autoPush: false };
const ROOT = '/proj';
const TDIR = '/proj/.teamctx';

beforeEach(() => vi.clearAllMocks());

describe('resolveProjectDir', () => {
  it('prefers --project <path>', () => {
    const r = resolveProjectDir(['mcp', '--project', '/a/b'], {}, '/cwd');
    expect(r).toMatch(/[/\\]a[/\\]b$/);
  });

  it('prefers --project=<path>', () => {
    const r = resolveProjectDir(['mcp', '--project=/x/y'], {}, '/cwd');
    expect(r).toMatch(/[/\\]x[/\\]y$/);
  });

  it('prefers -p as short form', () => {
    const r = resolveProjectDir(['mcp', '-p', '/short/path'], {}, '/cwd');
    expect(r).toMatch(/[/\\]short[/\\]path$/);
  });

  it('falls back to TEAMCTX_PROJECT_DIR when no flag', () => {
    const r = resolveProjectDir(['mcp'], { TEAMCTX_PROJECT_DIR: '/from/env' }, '/cwd');
    expect(r).toMatch(/[/\\]from[/\\]env$/);
  });

  it('flag beats env var', () => {
    const r = resolveProjectDir(['mcp', '--project', '/from/flag'], { TEAMCTX_PROJECT_DIR: '/from/env' }, '/cwd');
    expect(r).toMatch(/[/\\]from[/\\]flag$/);
  });

  it('falls back to cwd when neither flag nor env is set', () => {
    const r = resolveProjectDir(['mcp'], {}, '/the/cwd');
    expect(r).toBe('/the/cwd');
  });
});

describe('TOOLS list', () => {
  it('exposes exactly the four expected tools', () => {
    const names = TOOLS.map(t => t.name).sort();
    expect(names).toEqual(['ask', 'get_context', 'get_role_context', 'submit_contribution']);
  });

  it('each tool has a name, description, and object inputSchema', () => {
    for (const t of TOOLS) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.inputSchema.type).toBe('object');
    }
  });
});

describe('buildServer', () => {
  it('returns a Server instance without eagerly resolving the teamctx dir', () => {
    const server = buildServer(ROOT);
    expect(server).toBeTruthy();
    expect(typeof server.connect).toBe('function');
    // dir resolution must be lazy so the server can start even if .teamctx is missing
    expect(getTeamctxDir).not.toHaveBeenCalled();
  });
});

describe('get_context', () => {
  it('returns the workstream JSON as text content and reads from the resolved teamctx dir', async () => {
    readShared.mockReturnValue(baseWs);
    const handlers = makeHandlers(ROOT);
    const result = await handlers.get_context({});
    expect(readShared).toHaveBeenCalledWith(TDIR);
    expect(JSON.parse(result.content[0].text)).toEqual(baseWs);
  });
});

describe('get_role_context', () => {
  it('reads the role markdown from the resolved teamctx dir', async () => {
    readRoleFile.mockReturnValue('# CPO Context\n\n...');
    const handlers = makeHandlers(ROOT);
    const result = await handlers.get_role_context({ role: 'cpo' });
    expect(readRoleFile).toHaveBeenCalledWith('cpo', TDIR);
    expect(result.content[0].text).toContain('# CPO Context');
  });
});

describe('ask', () => {
  it('answers with shared context only when role is omitted', async () => {
    readConfig.mockReturnValue({ ...baseConfig, roles: [] });
    readSharedMd.mockReturnValue('# Shared');
    answerQuestion.mockResolvedValue('The answer.');

    const handlers = makeHandlers(ROOT);
    const result = await handlers.ask({ question: 'What?' });
    expect(readConfig).toHaveBeenCalledWith(TDIR);
    expect(readSharedMd).toHaveBeenCalledWith(TDIR);
    expect(answerQuestion).toHaveBeenCalledWith(expect.objectContaining({
      sharedMd: '# Shared', roleMd: '', question: 'What?',
    }));
    expect(result.content[0].text).toBe('The answer.');
  });

  it('includes role markdown when role is provided', async () => {
    readConfig.mockReturnValue({ ...baseConfig, roles: [{ slug: 'cpo' }] });
    readSharedMd.mockReturnValue('# Shared');
    readRoleFile.mockReturnValue('# CPO');
    answerQuestion.mockResolvedValue('answer');

    const handlers = makeHandlers(ROOT);
    await handlers.ask({ question: 'q?', role: 'cpo' });
    expect(readRoleFile).toHaveBeenCalledWith('cpo', TDIR);
    expect(answerQuestion).toHaveBeenCalledWith(expect.objectContaining({ roleMd: '# CPO' }));
  });

  it('throws a helpful error when the role does not exist', async () => {
    readConfig.mockReturnValue({ ...baseConfig, roles: [{ slug: 'cpo' }] });
    const handlers = makeHandlers(ROOT);
    await expect(handlers.ask({ question: 'q?', role: 'ghost' }))
      .rejects.toThrow(/No role "ghost"/);
  });
});

describe('submit_contribution', () => {
  it('appends, updates shared, writes files, commits with resolved cwd, and returns the summary', async () => {
    readConfig.mockReturnValue({ ...baseConfig, roles: [] });
    readShared.mockReturnValue(baseWs);
    updateShared.mockResolvedValue({
      workstream: { ...baseWs, _applied: true },
      summary: 'added a why',
      operations: [{ type: 'addWhy', text: 'x' }],
    });

    const handlers = makeHandlers(ROOT);
    const result = await handlers.submit_contribution({ text: 'new note' });

    expect(appendContribution).toHaveBeenCalledWith(expect.any(Object), TDIR);
    expect(writeShared).toHaveBeenCalledWith(expect.any(Object), TDIR);
    expect(writeSharedMd).toHaveBeenCalledWith(expect.any(String), TDIR);
    expect(commitContext).toHaveBeenCalledWith(expect.stringMatching(/via mcp/), { cwd: ROOT });
    expect(pushContext).not.toHaveBeenCalled();

    const payload = JSON.parse(result.content[0].text);
    expect(payload.summary).toBe('added a why');
    expect(payload.operations).toHaveLength(1);
    expect(payload.id).toMatch(/^mcp-/);
  });

  it('defaults author to config.me but honors an override', async () => {
    readConfig.mockReturnValue({ ...baseConfig, roles: [] });
    readShared.mockReturnValue(baseWs);
    updateShared.mockResolvedValue({ workstream: baseWs, summary: 's', operations: [{ type: 'addWhy' }] });

    const handlers = makeHandlers(ROOT);
    await handlers.submit_contribution({ text: 't', author: 'bob' });
    const written = appendContribution.mock.calls[0][0];
    expect(written.author).toBe('bob');
    expect(commitContext).toHaveBeenCalledWith(expect.stringContaining('bob'), { cwd: ROOT });
  });

  it('regenerates each role file when config has roles', async () => {
    readConfig.mockReturnValue({ ...baseConfig, roles: [{ slug: 'cpo' }, { slug: 'cto' }] });
    readShared.mockReturnValue(baseWs);
    updateShared.mockResolvedValue({ workstream: baseWs, summary: 's', operations: [{ type: 'addWhy' }] });
    generateRoleFile.mockResolvedValue('# role md');

    const handlers = makeHandlers(ROOT);
    await handlers.submit_contribution({ text: 't' });
    expect(generateRoleFile).toHaveBeenCalledTimes(2);
    expect(writeRoleFile).toHaveBeenCalledTimes(2);
    expect(writeRoleFile).toHaveBeenCalledWith('cpo', expect.any(String), TDIR);
  });

  it('short-circuits without writing when no operations are proposed', async () => {
    readConfig.mockReturnValue({ ...baseConfig, roles: [] });
    readShared.mockReturnValue(baseWs);
    updateShared.mockResolvedValue({ workstream: baseWs, summary: 's', operations: [] });

    const handlers = makeHandlers(ROOT);
    const result = await handlers.submit_contribution({ text: 't' });
    expect(writeShared).not.toHaveBeenCalled();
    expect(writeSharedMd).not.toHaveBeenCalled();
    expect(commitContext).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text).operations).toEqual([]);
  });

  it('pushes when autoPush is true and swallows push errors', async () => {
    readConfig.mockReturnValue({ ...baseConfig, roles: [], autoPush: true });
    readShared.mockReturnValue(baseWs);
    updateShared.mockResolvedValue({ workstream: baseWs, summary: 's', operations: [{ type: 'addWhy' }] });
    pushContext.mockRejectedValueOnce(new Error('no remote'));

    const handlers = makeHandlers(ROOT);
    const result = await handlers.submit_contribution({ text: 't' });
    expect(pushContext).toHaveBeenCalledWith({ cwd: ROOT });
    expect(result.content[0].text).toContain('summary');
  });
});
