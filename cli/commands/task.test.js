import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/storage.js', () => ({
  readConfig: vi.fn(),
  listTasks: vi.fn(() => []),
  readTask: vi.fn(),
  writeTask: vi.fn(),
  deleteTask: vi.fn(() => ({ id: 't-x', workstream: 'main' })),
  listWorkstreamIds: vi.fn(() => ['main']),
  readWorkstream: vi.fn(() => ({ id: 'main', name: 'M', whys: [] })),
  readContributions: vi.fn(() => []),
  writeTaskFile: vi.fn(),
  taskFilePath: vi.fn(id => `/fake/tasks/${id}.md`),
  taskFileExists: vi.fn(() => false),
}));

vi.mock('../../src/context.js', () => ({
  compileTaskPrompt: vi.fn(() => Promise.resolve('# Task: fake\n')),
}));

vi.mock('../../src/git.js', () => ({
  commitContext: vi.fn(),
  pushContext: vi.fn(),
}));


// Identity resolution shells out to git and reads a local prefs file; stub both
// so these stay unit tests and do not pick up the developer's own git config.
vi.mock('../../src/actor.js', () => ({
  resolveActor: vi.fn(async () => ({ key: 'name:alice', name: 'alice', login: null, source: 'config' })),
}));

vi.mock('../../src/prefs.js', () => ({
  readPrefs: vi.fn(async () => ({})),
  writePrefs: vi.fn(),
  resolveActiveWorkstream: vi.fn(async ({ config }) => config?.activeWorkstream || 'main'),
  resolveDisplayName: vi.fn(async ({ actor, config }) => actor?.name || config?.me || 'unknown'),
}));

import {
  taskAddCommand, taskListCommand, taskShowCommand,
  taskDoneCommand, taskReopenCommand, taskAssignCommand, taskRmCommand,
  taskCompileCommand,
  slugify, uniqueTaskId,
} from './task.js';
import {
  readConfig, listTasks, readTask, writeTask, deleteTask,
  writeTaskFile, taskFileExists, readWorkstream,
} from '../../src/storage.js';
import { compileTaskPrompt } from '../../src/context.js';
import { commitContext } from '../../src/git.js';

beforeEach(() => {
  vi.clearAllMocks();
  readConfig.mockReturnValue({ project: 'p', me: 'alice', autoPush: false });
  listTasks.mockReturnValue([]);
});

describe('slugify', () => {
  it('lowercases, replaces non-alnum with dashes, strips edges, prefixes with t-', () => {
    expect(slugify('Plan the Q3 pivot!')).toBe('t-plan-the-q3-pivot');
    expect(slugify('  Migrate --> auth ')).toBe('t-migrate-auth');
  });

  it('throws when title has no alphanumerics', () => {
    expect(() => slugify('!!!')).toThrow(/at least one alphanumeric/);
    expect(() => slugify('')).toThrow(/at least one alphanumeric/);
  });

  it('caps length at 60', () => {
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe('uniqueTaskId', () => {
  it('returns base when free', () => {
    listTasks.mockReturnValue([]);
    expect(uniqueTaskId('t-plan')).toBe('t-plan');
  });

  it('appends -2, -3 on collision', () => {
    listTasks.mockReturnValue([{ id: 't-plan' }]);
    expect(uniqueTaskId('t-plan')).toBe('t-plan-2');
    listTasks.mockReturnValue([{ id: 't-plan' }, { id: 't-plan-2' }]);
    expect(uniqueTaskId('t-plan')).toBe('t-plan-3');
  });
});

describe('taskAddCommand', () => {
  it('writes a well-formed task with default owner=me and workstream=main', async () => {
    await taskAddCommand('Plan Q3 pivot', {});
    const [task] = writeTask.mock.calls[0];
    expect(task.id).toBe('t-plan-q3-pivot');
    expect(task.title).toBe('Plan Q3 pivot');
    expect(task.owner).toBe('alice');
    expect(task.status).toBe('open');
    expect(task.workstream).toBe('main');
    expect(task.doneAt).toBeNull();
    expect(task.compiledAt).toBeNull();
    expect(task.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('honors --owner and --workstream', async () => {
    readConfig.mockReturnValue({
      project: 'p', me: 'alice', autoPush: false,
      workstreams: [{ id: 'main', name: 'M' }, { id: 'growth', name: 'G' }],
    });
    await taskAddCommand('Ship the pivot', { owner: 'priya', workstream: 'growth' });
    const [task] = writeTask.mock.calls[0];
    expect(task.owner).toBe('priya');
    expect(task.workstream).toBe('growth');
  });

  it('exits when --workstream is not a known workstream', async () => {
    readConfig.mockReturnValue({
      project: 'p', me: 'alice', autoPush: false,
      workstreams: [{ id: 'main', name: 'M' }],
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(taskAddCommand('X', { workstream: 'ghost' })).rejects.toThrow('exit');
    expect(errSpy).toHaveBeenCalled();
    expect(writeTask).not.toHaveBeenCalled();
    exit.mockRestore();
    errSpy.mockRestore();
  });

  it('picks a unique id when the slug already exists', async () => {
    listTasks.mockReturnValue([{ id: 't-plan-q3-pivot' }]);
    await taskAddCommand('Plan Q3 pivot', {});
    expect(writeTask.mock.calls[0][0].id).toBe('t-plan-q3-pivot-2');
  });

  it('commits with a workstream tag when not main', async () => {
    readConfig.mockReturnValue({
      project: 'p', me: 'alice', autoPush: false,
      workstreams: [{ id: 'main', name: 'M' }, { id: 'growth', name: 'G' }],
    });
    await taskAddCommand('X', { workstream: 'growth' });
    expect(commitContext.mock.calls[0][0]).toMatch(/\[workstream: growth\]/);
  });
});

describe('taskDoneCommand', () => {
  it('marks a task done and sets doneAt', async () => {
    readTask.mockReturnValue({
      task: { id: 't-plan', title: 'x', status: 'open', workstream: 'main', createdAt: '2026-07-24', doneAt: null, compiledAt: null },
      workstream: 'main',
    });
    await taskDoneCommand('t-plan');
    const [updated] = writeTask.mock.calls[0];
    expect(updated.status).toBe('done');
    expect(updated.doneAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('is a no-op if already done', async () => {
    readTask.mockReturnValue({
      task: { id: 't-plan', title: 'x', status: 'done', workstream: 'main', createdAt: '2026-07-24', doneAt: '2026-07-25', compiledAt: null },
      workstream: 'main',
    });
    await taskDoneCommand('t-plan');
    expect(writeTask).not.toHaveBeenCalled();
    expect(commitContext).not.toHaveBeenCalled();
  });
});

describe('taskReopenCommand', () => {
  it('reopens a done task and clears doneAt', async () => {
    readTask.mockReturnValue({
      task: { id: 't-plan', title: 'x', status: 'done', workstream: 'main', createdAt: '2026-07-24', doneAt: '2026-07-25', compiledAt: null },
      workstream: 'main',
    });
    await taskReopenCommand('t-plan');
    const [updated] = writeTask.mock.calls[0];
    expect(updated.status).toBe('open');
    expect(updated.doneAt).toBeNull();
  });

  it('is a no-op if already open', async () => {
    readTask.mockReturnValue({
      task: { id: 't-plan', title: 'x', status: 'open', workstream: 'main', createdAt: '2026-07-24', doneAt: null, compiledAt: null },
      workstream: 'main',
    });
    await taskReopenCommand('t-plan');
    expect(writeTask).not.toHaveBeenCalled();
  });
});

describe('taskAssignCommand', () => {
  it('reassigns to a new owner', async () => {
    readTask.mockReturnValue({
      task: { id: 't-plan', title: 'x', status: 'open', owner: 'alice', workstream: 'main', createdAt: '2026-07-24', doneAt: null, compiledAt: null },
      workstream: 'main',
    });
    await taskAssignCommand('t-plan', { owner: 'priya' });
    expect(writeTask.mock.calls[0][0].owner).toBe('priya');
  });

  it('exits when --owner is missing', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(taskAssignCommand('t-plan', {})).rejects.toThrow('exit');
    exit.mockRestore();
    errSpy.mockRestore();
  });
});

describe('taskRmCommand', () => {
  it('deletes the task and commits', async () => {
    deleteTask.mockReturnValue({ id: 't-plan', workstream: 'growth' });
    await taskRmCommand('t-plan');
    expect(deleteTask).toHaveBeenCalledWith('t-plan');
    expect(commitContext.mock.calls[0][0]).toMatch(/task: rm t-plan by alice/);
  });
});

describe('taskListCommand', () => {
  it('defaults to open tasks in active workstream and prints nothing on empty', async () => {
    readConfig.mockReturnValue({ project: 'p', me: 'alice', autoPush: false, activeWorkstream: 'growth' });
    listTasks.mockReturnValue([]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await taskListCommand({});
    expect(listTasks).toHaveBeenCalledWith({ workstream: 'growth' });
    expect(log.mock.calls.some(c => c[0]?.includes?.('No tasks match'))).toBe(true);
    log.mockRestore();
  });

  it('with --all uses no scope and includes every status', async () => {
    listTasks.mockReturnValue([
      { id: 't-a', title: 'a', status: 'open',  owner: 'alice', workstream: 'main', createdAt: '2026-07-24' },
      { id: 't-b', title: 'b', status: 'done',  owner: 'alice', workstream: 'main', createdAt: '2026-07-24' },
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await taskListCommand({ all: true });
    expect(listTasks).toHaveBeenCalledWith({});
    const printed = log.mock.calls.map(c => c[0]).join('\n');
    expect(printed).toContain('t-a');
    expect(printed).toContain('t-b');
    log.mockRestore();
  });

  it('applies --status filter', async () => {
    listTasks.mockReturnValue([
      { id: 't-a', title: 'a', status: 'open',  owner: 'alice', workstream: 'main', createdAt: '2026-07-24' },
      { id: 't-b', title: 'b', status: 'done',  owner: 'alice', workstream: 'main', createdAt: '2026-07-24' },
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await taskListCommand({ all: true, status: 'done' });
    const printed = log.mock.calls.map(c => c[0]).join('\n');
    expect(printed).toContain('t-b');
    expect(printed).not.toContain('t-a');
    log.mockRestore();
  });
});

describe('taskCompileCommand', () => {
  const openTask = {
    id: 't-plan', title: 'Plan Q3', owner: 'priya', status: 'open',
    workstream: 'main', createdAt: '2026-07-24', doneAt: null, compiledAt: null,
  };
  const wsA = { id: 'main', name: 'M', whys: [{ id: 'w1', text: 'a', whats: [] }] };
  const wsB = { id: 'main', name: 'M', whys: [{ id: 'w1', text: 'b', whats: [] }] };

  it('calls compileTaskPrompt, writes the file, records compiledAt + compiledFromHash, and commits', async () => {
    readTask.mockReturnValue({ task: openTask, workstream: 'main' });
    readWorkstream.mockReturnValue(wsA);
    await taskCompileCommand('t-plan', {});
    expect(compileTaskPrompt).toHaveBeenCalled();
    const [id, content] = writeTaskFile.mock.calls[0];
    expect(id).toBe('t-plan');
    expect(content).toBe('# Task: fake\n');
    const [updated] = writeTask.mock.calls[0];
    expect(updated.compiledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(updated.compiledFromHash).toMatch(/^[a-f0-9]{16}$/);
    expect(commitContext.mock.calls[0][0]).toMatch(/task: compile t-plan/);
  });

  it('skips the AI call when the Whys hash on the task matches the current workstream (no --force)', async () => {
    readWorkstream.mockReturnValue(wsA);
    // First compile to capture the hash the code would store.
    readTask.mockReturnValue({ task: openTask, workstream: 'main' });
    taskFileExists.mockReturnValue(false);
    await taskCompileCommand('t-plan', {});
    const savedHash = writeTask.mock.calls[0][0].compiledFromHash;

    // Second compile: same workstream, task now has matching hash, cached file exists.
    vi.clearAllMocks();
    readConfig.mockReturnValue({ project: 'p', me: 'alice', autoPush: false });
    readTask.mockReturnValue({
      task: { ...openTask, compiledAt: '2026-07-24T00:00:00Z', compiledFromHash: savedHash },
      workstream: 'main',
    });
    readWorkstream.mockReturnValue(wsA);
    taskFileExists.mockReturnValue(true);
    await taskCompileCommand('t-plan', {});
    expect(compileTaskPrompt).not.toHaveBeenCalled();
    expect(writeTaskFile).not.toHaveBeenCalled();
  });

  it('with --force always regenerates even when the hash matches', async () => {
    readWorkstream.mockReturnValue(wsA);
    readTask.mockReturnValue({ task: openTask, workstream: 'main' });
    await taskCompileCommand('t-plan', {});
    const savedHash = writeTask.mock.calls[0][0].compiledFromHash;

    vi.clearAllMocks();
    readConfig.mockReturnValue({ project: 'p', me: 'alice', autoPush: false });
    readTask.mockReturnValue({
      task: { ...openTask, compiledAt: '2026-07-24T00:00:00Z', compiledFromHash: savedHash },
      workstream: 'main',
    });
    readWorkstream.mockReturnValue(wsA);
    taskFileExists.mockReturnValue(true);
    await taskCompileCommand('t-plan', { force: true });
    expect(compileTaskPrompt).toHaveBeenCalled();
    expect(writeTaskFile).toHaveBeenCalled();
  });

  it('regenerates when the workstream Whys have actually changed', async () => {
    // Task was compiled against wsA, but workstream now reads as wsB.
    readWorkstream.mockReturnValue(wsA);
    readTask.mockReturnValue({ task: openTask, workstream: 'main' });
    await taskCompileCommand('t-plan', {});
    const oldHash = writeTask.mock.calls[0][0].compiledFromHash;

    vi.clearAllMocks();
    readConfig.mockReturnValue({ project: 'p', me: 'alice', autoPush: false });
    readTask.mockReturnValue({
      task: { ...openTask, compiledAt: '2026-07-24T00:00:00Z', compiledFromHash: oldHash },
      workstream: 'main',
    });
    readWorkstream.mockReturnValue(wsB);
    taskFileExists.mockReturnValue(true);
    await taskCompileCommand('t-plan', {});
    expect(compileTaskPrompt).toHaveBeenCalled();
  });

  it('regenerates when the task has never been compiled (no cached file)', async () => {
    readTask.mockReturnValue({ task: openTask, workstream: 'main' });
    readWorkstream.mockReturnValue(wsA);
    taskFileExists.mockReturnValue(false);
    await taskCompileCommand('t-plan', {});
    expect(compileTaskPrompt).toHaveBeenCalled();
  });

  it('with --role passes the matching role to compileTaskPrompt', async () => {
    readConfig.mockReturnValue({
      project: 'p', me: 'alice', autoPush: false,
      roles: [{ slug: 'growth', name: 'Growth', responsibilities: 'r' }],
    });
    readTask.mockReturnValue({ task: openTask, workstream: 'main' });
    readWorkstream.mockReturnValue(wsA);
    await taskCompileCommand('t-plan', { role: 'growth' });
    const arg = compileTaskPrompt.mock.calls[0][0];
    expect(arg.role).toMatchObject({ slug: 'growth', name: 'Growth' });
  });

  it('exits when --role names a slug that does not exist', async () => {
    readConfig.mockReturnValue({ project: 'p', me: 'alice', autoPush: false, roles: [] });
    readTask.mockReturnValue({ task: openTask, workstream: 'main' });
    readWorkstream.mockReturnValue(wsA);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(taskCompileCommand('t-plan', { role: 'ghost' })).rejects.toThrow('exit');
    expect(compileTaskPrompt).not.toHaveBeenCalled();
    exit.mockRestore();
    errSpy.mockRestore();
  });
});

describe('taskShowCommand', () => {
  it('prints metadata including compile hint when not yet compiled', async () => {
    readTask.mockReturnValue({
      task: { id: 't-plan', title: 'Plan Q3', owner: 'priya', status: 'open', workstream: 'growth', createdAt: '2026-07-24', doneAt: null, compiledAt: null },
      workstream: 'growth',
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await taskShowCommand('t-plan');
    const out = log.mock.calls.map(c => c[0]).join('\n');
    expect(out).toContain('# Task t-plan');
    expect(out).toContain('Plan Q3');
    expect(out).toContain('teamctx task compile t-plan');
    log.mockRestore();
  });
});
