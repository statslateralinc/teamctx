import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/storage.js', () => ({
  getTeamctxDir: vi.fn((root) => `${root}/.teamctx`),
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  readWorkstream: vi.fn(),
  writeWorkstream: vi.fn(),
  listWorkstreamIds: vi.fn(() => []),
  readSharedMd: vi.fn(),
  writeWorkstreamMd: vi.fn(),
  readRoleFile: vi.fn(),
  writeRoleFile: vi.fn(),
  appendContribution: vi.fn(),
  readContributions: vi.fn(() => []),
  listQueue: vi.fn(() => []),
  readQueueItem: vi.fn(),
  deleteQueueItem: vi.fn(),
  writeRejected: vi.fn(),
  writeQueueItem: vi.fn(),
  listSnapshots: vi.fn(() => []),
  readSnapshot: vi.fn(),
  writeSnapshot: vi.fn(),
  resolveSnapshotId: vi.fn((p) => p),
  readCurrentSnapshotPointer: vi.fn(() => null),
  writeCurrentSnapshotPointer: vi.fn(),
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
  readConfig, readWorkstream, writeWorkstream, listWorkstreamIds,
  readSharedMd, writeWorkstreamMd,
  readRoleFile, writeRoleFile,
  appendContribution,
} from '../src/storage.js';
import { updateShared, generateRoleFile, answerQuestion } from '../src/context.js';
import { commitContext, pushContext } from '../src/git.js';

const baseWs = { id: 'main', name: 'Demo', whys: [] };
const baseConfig = { project: 'Demo', me: 'alice', model: 'claude-sonnet-4-6', roles: [], autoPush: false, workstreams: [{ id: 'main', name: 'Demo' }] };
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
  it('exposes the read-only tools', () => {
    const names = TOOLS.map(t => t.name);
    for (const n of ['get_context', 'list_workstreams', 'get_workstream', 'get_role_context',
                     'list_roles', 'list_snapshots', 'get_snapshot', 'get_current_snapshot',
                     'list_pending_reviews', 'get_status', 'get_config', 'ask',
                     'suggest_roles', 'suggest_workstream_splits']) {
      expect(names).toContain(n);
    }
  });

  it('exposes the mutating tools including init, role/workstream/review/snapshot/config, contribute + submit_contribution alias', () => {
    const names = TOOLS.map(t => t.name);
    for (const n of ['contribute', 'submit_contribution', 'init',
                     'role_add', 'role_assign',
                     'workstream_split', 'workstream_use',
                     'review_approve', 'review_reject',
                     'snapshot_create', 'snapshot_approve', 'snapshot_reject',
                     'reflect', 'config_set']) {
      expect(names).toContain(n);
    }
  });

  it('every Tier 2 (risky) tool warns in its description', () => {
    const risky = ['init', 'role_add', 'role_assign', 'workstream_split', 'workstream_use',
                   'review_approve', 'review_reject', 'snapshot_create', 'snapshot_approve',
                   'snapshot_reject', 'reflect', 'config_set'];
    for (const name of risky) {
      const t = TOOLS.find(x => x.name === name);
      expect(t, `tool ${name} missing`).toBeTruthy();
      expect(t.description).toMatch(/RISKY/);
    }
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
    expect(getTeamctxDir).not.toHaveBeenCalled();
  });
});

describe('get_context', () => {
  it('returns { workstreams: [...] } with a tree for each configured workstream', async () => {
    readConfig.mockReturnValue({ ...baseConfig, workstreams: [{ id: 'main' }, { id: 'tech' }] });
    listWorkstreamIds.mockReturnValue(['main', 'tech']);
    readWorkstream.mockImplementation((id) => ({ id, name: id, whys: [] }));

    const handlers = makeHandlers(ROOT);
    const result = await handlers.get_context({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.workstreams.map(w => w.id).sort()).toEqual(['main', 'tech']);
    expect(payload.workstreams[0].tree).toBeTruthy();
  });

  it('defaults to a single main workstream when config has none', async () => {
    readConfig.mockReturnValue({ ...baseConfig, workstreams: [] });
    listWorkstreamIds.mockReturnValue([]);
    readWorkstream.mockReturnValue(baseWs);

    const handlers = makeHandlers(ROOT);
    const result = await handlers.get_context({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.workstreams).toHaveLength(1);
    expect(payload.workstreams[0].id).toBe('main');
  });
});

describe('list_workstreams', () => {
  it('returns each workstream with id, name, isActive, whyCount, roles', async () => {
    readConfig.mockReturnValue({ ...baseConfig, workstreams: [{ id: 'main', name: 'Main' }, { id: 'tech', name: 'Tech' }], activeWorkstream: 'main', roles: [{ slug: 'eng', workstream: 'tech' }] });
    listWorkstreamIds.mockReturnValue(['main', 'tech']);
    readWorkstream.mockImplementation((id) => ({ id, name: id, whys: [] }));
    const handlers = makeHandlers(ROOT);
    const result = await handlers.list_workstreams({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.workstreams).toHaveLength(2);
    const tech = payload.workstreams.find(w => w.id === 'tech');
    expect(tech.roles).toEqual(['eng']);
    expect(payload.workstreams.find(w => w.id === 'main').isActive).toBe(true);
  });
});

describe('get_workstream', () => {
  it('returns the requested workstream tree', async () => {
    readWorkstream.mockReturnValue({ id: 'tech', name: 'Tech', whys: [] });
    const handlers = makeHandlers(ROOT);
    const result = await handlers.get_workstream({ id: 'tech' });
    expect(readWorkstream).toHaveBeenCalledWith('tech', TDIR);
    expect(JSON.parse(result.content[0].text).id).toBe('tech');
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
  const twoWsConfig = {
    ...baseConfig,
    workstreams: [{ id: 'main' }, { id: 'tech' }, { id: 'growth' }],
    activeWorkstream: 'main',
    roles: [
      { slug: 'engineer', workstream: 'tech' },
      { slug: 'marketer', workstream: 'growth' },
    ],
  };

  it('defaults to activeWorkstream when no workstream arg is given', async () => {
    readConfig.mockReturnValue({ ...twoWsConfig, activeWorkstream: 'main' });
    readWorkstream.mockReturnValue(baseWs);
    updateShared.mockResolvedValue({
      workstream: { ...baseWs, _applied: true }, summary: 's', operations: [{ type: 'addWhy' }],
    });

    const handlers = makeHandlers(ROOT);
    await handlers.submit_contribution({ text: 'note' });
    expect(readWorkstream).toHaveBeenCalledWith('main', TDIR);
    expect(writeWorkstream.mock.calls[0][0]).toBe('main');
    expect(writeWorkstreamMd.mock.calls[0][0]).toBe('main');
  });

  it('targets the workstream arg when provided', async () => {
    readConfig.mockReturnValue(twoWsConfig);
    readWorkstream.mockReturnValue({ id: 'tech', name: 'Tech', whys: [] });
    updateShared.mockResolvedValue({ workstream: baseWs, summary: 's', operations: [{ type: 'addWhy' }] });

    const handlers = makeHandlers(ROOT);
    const result = await handlers.submit_contribution({ text: 'note', workstream: 'tech' });
    expect(readWorkstream).toHaveBeenCalledWith('tech', TDIR);
    expect(writeWorkstream.mock.calls[0][0]).toBe('tech');
    expect(JSON.parse(result.content[0].text).workstream).toBe('tech');
  });

  it('throws a helpful error for an unknown workstream', async () => {
    readConfig.mockReturnValue(twoWsConfig);
    const handlers = makeHandlers(ROOT);
    await expect(handlers.submit_contribution({ text: 't', workstream: 'ghost' }))
      .rejects.toThrow(/no workstream "ghost"/);
    expect(writeWorkstream).not.toHaveBeenCalled();
  });

  it('regenerates only role files bound to the target workstream', async () => {
    readConfig.mockReturnValue(twoWsConfig);
    readWorkstream.mockReturnValue({ id: 'tech', name: 'Tech', whys: [] });
    updateShared.mockResolvedValue({ workstream: baseWs, summary: 's', operations: [{ type: 'addWhy' }] });
    generateRoleFile.mockResolvedValue('# role md');

    const handlers = makeHandlers(ROOT);
    await handlers.submit_contribution({ text: 't', workstream: 'tech' });
    const regeneratedSlugs = writeRoleFile.mock.calls.map(c => c[0]);
    expect(regeneratedSlugs).toEqual(['engineer']);
    expect(regeneratedSlugs).not.toContain('marketer');
  });

  it('defaults author to config.me but honors an override', async () => {
    readConfig.mockReturnValue({ ...twoWsConfig, activeWorkstream: 'main' });
    readWorkstream.mockReturnValue(baseWs);
    updateShared.mockResolvedValue({ workstream: baseWs, summary: 's', operations: [{ type: 'addWhy' }] });

    const handlers = makeHandlers(ROOT);
    await handlers.submit_contribution({ text: 't', author: 'bob' });
    const written = appendContribution.mock.calls[0][0];
    expect(written.author).toBe('bob');
    expect(commitContext).toHaveBeenCalledWith(expect.stringContaining('bob'), { cwd: ROOT });
  });

  it('short-circuits without writing when no operations are proposed', async () => {
    readConfig.mockReturnValue({ ...twoWsConfig, activeWorkstream: 'main' });
    readWorkstream.mockReturnValue(baseWs);
    updateShared.mockResolvedValue({ workstream: baseWs, summary: 's', operations: [] });

    const handlers = makeHandlers(ROOT);
    const result = await handlers.submit_contribution({ text: 't' });
    expect(writeWorkstream).not.toHaveBeenCalled();
    expect(writeWorkstreamMd).not.toHaveBeenCalled();
    expect(commitContext).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text).operations).toEqual([]);
  });

  it('records the workstream on the contribution audit-log entry', async () => {
    readConfig.mockReturnValue(twoWsConfig);
    readWorkstream.mockReturnValue({ id: 'growth', name: 'Growth', whys: [] });
    updateShared.mockResolvedValue({ workstream: baseWs, summary: 's', operations: [{ type: 'addWhy' }] });

    const handlers = makeHandlers(ROOT);
    await handlers.submit_contribution({ text: 't', workstream: 'growth' });
    const written = appendContribution.mock.calls[0][0];
    expect(written.workstream).toBe('growth');
    expect(written.source).toBe('mcp');
  });

  it('pushes when autoPush is true and swallows push errors', async () => {
    readConfig.mockReturnValue({ ...twoWsConfig, autoPush: true, activeWorkstream: 'main' });
    readWorkstream.mockReturnValue(baseWs);
    updateShared.mockResolvedValue({ workstream: baseWs, summary: 's', operations: [{ type: 'addWhy' }] });
    pushContext.mockRejectedValueOnce(new Error('no remote'));

    const handlers = makeHandlers(ROOT);
    const result = await handlers.submit_contribution({ text: 't' });
    expect(pushContext).toHaveBeenCalledWith({ cwd: ROOT });
    expect(result.content[0].text).toContain('summary');
  });
});

import {
  writeConfig, listQueue, readQueueItem, deleteQueueItem, writeRejected, writeQueueItem,
  listSnapshots, readSnapshot, writeSnapshot, resolveSnapshotId,
} from '../src/storage.js';

describe('contribute (new tool)', () => {
  const twoWs = { ...baseConfig, workstreams: [{ id: 'main' }, { id: 'tech' }], activeWorkstream: 'main', roles: [] };

  it('enqueues by default (apply omitted)', async () => {
    readConfig.mockReturnValue(twoWs);
    readWorkstream.mockReturnValue(baseWs);
    updateShared.mockResolvedValue({ workstream: baseWs, summary: 's', operations: [{ type: 'addWhy' }] });

    const handlers = makeHandlers(ROOT);
    const result = await handlers.contribute({ text: 'note' });
    expect(writeQueueItem).toHaveBeenCalledTimes(1);
    expect(writeWorkstream).not.toHaveBeenCalled();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.mode).toBe('queued');
    expect(payload.reportBack).toMatch(/queued for manager approval/);
  });

  it('applies immediately when apply:true', async () => {
    readConfig.mockReturnValue(twoWs);
    readWorkstream.mockReturnValue(baseWs);
    updateShared.mockResolvedValue({ workstream: baseWs, summary: 's', operations: [{ type: 'addWhy' }] });

    const handlers = makeHandlers(ROOT);
    const result = await handlers.contribute({ text: 'note', apply: true });
    expect(writeQueueItem).not.toHaveBeenCalled();
    expect(writeWorkstream).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0].text).mode).toBe('applied');
  });

  it('records decision tag on the audit log when decision:true', async () => {
    readConfig.mockReturnValue(twoWs);
    readWorkstream.mockReturnValue(baseWs);
    updateShared.mockResolvedValue({ workstream: baseWs, summary: 's', operations: [{ type: 'addWhy' }] });

    const handlers = makeHandlers(ROOT);
    await handlers.contribute({ text: 'we chose X', decision: true });
    expect(appendContribution.mock.calls[0][0].tagged).toBe('decision');
  });
});

describe('review_approve (manager-gated)', () => {
  const configWithManager = { ...baseConfig, manager: 'boss', me: 'alice', activeWorkstream: 'main', workstreams: [{ id: 'main' }], roles: [] };

  it('refuses when caller is not the manager', async () => {
    readConfig.mockReturnValue(configWithManager);
    const handlers = makeHandlers(ROOT);
    await expect(handlers.review_approve({ id: 'q-1', author: 'alice' }))
      .rejects.toThrow(/only the configured manager/);
    expect(readQueueItem).not.toHaveBeenCalled();
  });

  it('proceeds when caller matches the manager', async () => {
    readConfig.mockReturnValue(configWithManager);
    readQueueItem.mockReturnValue({ id: 'q-1', workstream: 'main', author: 'alice', operations: [{ type: 'addWhy', text: 't', summary: 's' }] });
    readWorkstream.mockReturnValue(baseWs);
    const handlers = makeHandlers(ROOT);
    const result = await handlers.review_approve({ id: 'q-1', author: 'boss' });
    expect(writeWorkstream).toHaveBeenCalled();
    expect(deleteQueueItem).toHaveBeenCalled();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.approvedBy).toBe('boss');
    expect(payload.reportBack).toMatch(/approved contribution q-1/);
  });

  it('is un-gated when config.manager is unset (solo mode)', async () => {
    readConfig.mockReturnValue({ ...baseConfig, workstreams: [{ id: 'main' }], roles: [] });
    readQueueItem.mockReturnValue({ id: 'q-2', workstream: 'main', author: 'alice', operations: [{ type: 'addWhy', text: 't', summary: 's' }] });
    readWorkstream.mockReturnValue(baseWs);
    const handlers = makeHandlers(ROOT);
    await handlers.review_approve({ id: 'q-2' });
    expect(writeWorkstream).toHaveBeenCalled();
  });
});

describe('snapshot_create + snapshot_approve', () => {
  it('creates and approves through manager gate', async () => {
    readConfig.mockReturnValue({ ...baseConfig, manager: 'boss', workstreams: [{ id: 'main' }], roles: [] });
    readWorkstream.mockReturnValue(baseWs);
    listWorkstreamIds.mockReturnValue([]);

    const handlers = makeHandlers(ROOT);
    const create = await handlers.snapshot_create({ message: 'pre-launch' });
    expect(writeSnapshot).toHaveBeenCalledTimes(1);
    const createdPayload = JSON.parse(create.content[0].text);
    expect(createdPayload.snapshot.workstreams).toHaveLength(1);
    expect(createdPayload.reportBack).toMatch(/manager must approve/);

    readSnapshot.mockReturnValue({ id: 'snap-1', status: 'pending', workstreams: [{ id: 'main', tree: baseWs }] });
    await expect(handlers.snapshot_approve({ id: 'snap-1', author: 'alice' }))
      .rejects.toThrow(/only the configured manager/);
    await handlers.snapshot_approve({ id: 'snap-1', author: 'boss' });
    expect(writeSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe('workstream_use', () => {
  it('writes the activeWorkstream and returns a reportBack', async () => {
    readConfig.mockReturnValue({ ...baseConfig, workstreams: [{ id: 'main' }, { id: 'tech' }], roles: [] });
    const handlers = makeHandlers(ROOT);
    const result = await handlers.workstream_use({ id: 'tech' });
    expect(writeConfig).toHaveBeenCalledWith(expect.objectContaining({ activeWorkstream: 'tech' }), TDIR);
    expect(JSON.parse(result.content[0].text).reportBack).toMatch(/active workstream is now "tech"/);
  });

  it('rejects unknown workstream ids', async () => {
    readConfig.mockReturnValue({ ...baseConfig, workstreams: [{ id: 'main' }], roles: [] });
    const handlers = makeHandlers(ROOT);
    await expect(handlers.workstream_use({ id: 'ghost' })).rejects.toThrow(/no workstream "ghost"/);
  });
});

describe('config_set', () => {
  it('rejects unknown keys', async () => {
    readConfig.mockReturnValue(baseConfig);
    const handlers = makeHandlers(ROOT);
    await expect(handlers.config_set({ key: 'evil', value: 'x' })).rejects.toThrow(/unknown config key/);
  });

  it('accepts a whitelisted key and reports back', async () => {
    readConfig.mockReturnValue({ ...baseConfig });
    const handlers = makeHandlers(ROOT);
    const result = await handlers.config_set({ key: 'manager', value: 'alice' });
    expect(writeConfig).toHaveBeenCalledWith(expect.objectContaining({ manager: 'alice' }), TDIR);
    expect(JSON.parse(result.content[0].text).reportBack).toMatch(/config.manager set to/);
  });
});

describe('get_config redaction', () => {
  it('never returns API keys — only the public config surface', async () => {
    readConfig.mockReturnValue({
      ...baseConfig, ANTHROPIC_API_KEY: 'sk-should-not-appear',
      apiKey: 'sk-neither', roles: [], workstreams: [{ id: 'main' }],
    });
    const handlers = makeHandlers(ROOT);
    const result = await handlers.get_config({});
    expect(result.content[0].text).not.toMatch(/sk-/);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.project).toBe('Demo');
    expect(payload.apiKey).toBeUndefined();
  });
});
