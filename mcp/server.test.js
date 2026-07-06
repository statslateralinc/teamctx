import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/storage.js', () => ({
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

import { TOOLS, HANDLERS, buildServer } from './server.js';
import {
  readConfig, readShared, writeShared,
  readSharedMd, writeSharedMd,
  readRoleFile, writeRoleFile,
  appendContribution,
} from '../src/storage.js';
import { updateShared, generateRoleFile, answerQuestion } from '../src/context.js';
import { commitContext, pushContext } from '../src/git.js';

const baseWs = { id: 'main', name: 'Demo', whys: [] };
const baseConfig = { project: 'Demo', me: 'alice', model: 'claude-sonnet-4-6', roles: [], autoPush: false };

beforeEach(() => vi.clearAllMocks());

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
  it('returns a Server instance with request handlers registered', () => {
    const server = buildServer();
    expect(server).toBeTruthy();
    expect(typeof server.connect).toBe('function');
  });
});

describe('get_context', () => {
  it('returns the workstream JSON as text content', async () => {
    readShared.mockReturnValue(baseWs);
    const result = await HANDLERS.get_context({});
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(baseWs);
  });
});

describe('get_role_context', () => {
  it('returns the role markdown for a valid slug', async () => {
    readRoleFile.mockReturnValue('# CPO Context\n\n...');
    const result = await HANDLERS.get_role_context({ role: 'cpo' });
    expect(readRoleFile).toHaveBeenCalledWith('cpo');
    expect(result.content[0].text).toContain('# CPO Context');
  });
});

describe('ask', () => {
  it('answers with shared context only when role is omitted', async () => {
    readConfig.mockReturnValue({ ...baseConfig, roles: [] });
    readSharedMd.mockReturnValue('# Shared');
    answerQuestion.mockResolvedValue('The answer.');

    const result = await HANDLERS.ask({ question: 'What?' });
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

    await HANDLERS.ask({ question: 'q?', role: 'cpo' });
    expect(answerQuestion).toHaveBeenCalledWith(expect.objectContaining({ roleMd: '# CPO' }));
  });

  it('throws a helpful error when the role does not exist', async () => {
    readConfig.mockReturnValue({ ...baseConfig, roles: [{ slug: 'cpo' }] });
    await expect(HANDLERS.ask({ question: 'q?', role: 'ghost' }))
      .rejects.toThrow(/No role "ghost"/);
  });
});

describe('submit_contribution', () => {
  it('appends, updates shared, writes files, commits, and returns the summary', async () => {
    readConfig.mockReturnValue({ ...baseConfig, roles: [] });
    readShared.mockReturnValue(baseWs);
    updateShared.mockResolvedValue({
      workstream: { ...baseWs, _applied: true },
      summary: 'added a why',
      operations: [{ type: 'addWhy', text: 'x' }],
    });

    const result = await HANDLERS.submit_contribution({ text: 'new note' });

    expect(appendContribution).toHaveBeenCalledOnce();
    expect(updateShared).toHaveBeenCalledOnce();
    expect(writeShared).toHaveBeenCalledOnce();
    expect(writeSharedMd).toHaveBeenCalledOnce();
    expect(commitContext).toHaveBeenCalledWith(expect.stringMatching(/via mcp/));
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

    await HANDLERS.submit_contribution({ text: 't', author: 'bob' });
    const written = appendContribution.mock.calls[0][0];
    expect(written.author).toBe('bob');
    expect(commitContext).toHaveBeenCalledWith(expect.stringContaining('bob'));
  });

  it('regenerates each role file when config has roles', async () => {
    readConfig.mockReturnValue({ ...baseConfig, roles: [{ slug: 'cpo' }, { slug: 'cto' }] });
    readShared.mockReturnValue(baseWs);
    updateShared.mockResolvedValue({ workstream: baseWs, summary: 's', operations: [{ type: 'addWhy' }] });
    generateRoleFile.mockResolvedValue('# role md');

    await HANDLERS.submit_contribution({ text: 't' });
    expect(generateRoleFile).toHaveBeenCalledTimes(2);
    expect(writeRoleFile).toHaveBeenCalledTimes(2);
  });

  it('short-circuits without writing when no operations are proposed', async () => {
    readConfig.mockReturnValue({ ...baseConfig, roles: [] });
    readShared.mockReturnValue(baseWs);
    updateShared.mockResolvedValue({ workstream: baseWs, summary: 's', operations: [] });

    const result = await HANDLERS.submit_contribution({ text: 't' });
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

    const result = await HANDLERS.submit_contribution({ text: 't' });
    expect(pushContext).toHaveBeenCalledOnce();
    expect(result.content[0].text).toContain('summary');
  });
});
