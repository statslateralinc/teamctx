import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { getCurrentSession } from './session-context.js';

/**
 * Storage layer.
 *
 * Local (CLI) mode: every function reads/writes the filesystem under
 * `dir` (usually `.teamctx/`).
 *
 * Hosted (MCP over HTTP) mode: the HTTP handler runs each tool call inside
 * a `runWithSession(session, ...)` context (see src/session-context.js).
 * The session has an in-memory buffer prefetched from a GitHub repo.
 * When `getCurrentSession()` returns non-null, every read/write here
 * targets that buffer instead of the filesystem — synchronous, no async
 * cascade. The session's `commit()` flushes buffered writes as one atomic
 * git commit later, at request end.
 *
 * The `dir` argument in hosted mode is a virtual root; the session's
 * paths are all absolute inside the repo. We ignore `dir` for github
 * dispatch because the session knows its own layout.
 */

const CTX_ROOT = '.teamctx';

function resolve(dir, ...parts) {
  return join(dir || getTeamctxDir(), ...parts);
}

function ctxPath(...parts) {
  return [CTX_ROOT, ...parts].join('/');
}

export function getTeamctxDir(startPath = process.cwd()) {
  let current = startPath;
  while (true) {
    const candidate = join(current, '.teamctx');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('Not in a teamctx project. Run `teamctx init` first.');
}

// ---- Session helpers (hosted mode only) ----

function sessionRead(path) {
  const s = getCurrentSession();
  if (!s) return undefined;
  const rec = s.read(path);
  return rec ? rec.content : null;
}

function sessionWrite(path, content) {
  const s = getCurrentSession();
  if (!s) return false;
  s.write(path, content);
  return true;
}

function sessionDelete(path) {
  const s = getCurrentSession();
  if (!s) return false;
  s.del(path);
  return true;
}

function sessionListDir(dirPath) {
  const s = getCurrentSession();
  if (!s) return null;
  return s.listDir(dirPath);
}

// ---- Config ----

export function readConfig(dir) {
  const s = sessionRead(ctxPath('config.json'));
  if (s !== undefined) {
    if (s === null) throw new Error('Not in a teamctx project. .teamctx/config.json not found.');
    return JSON.parse(s);
  }
  return JSON.parse(readFileSync(resolve(dir, 'config.json'), 'utf-8'));
}

export function writeConfig(config, dir) {
  if (sessionWrite(ctxPath('config.json'), JSON.stringify(config, null, 2))) return;
  writeFileSync(resolve(dir, 'config.json'), JSON.stringify(config, null, 2));
}

// ---- Shared / main workstream (legacy compat) ----

export function readShared(dir) {
  if (getCurrentSession()) return readWorkstream('main', dir);
  const mainWs = resolve(dir, 'workstreams', 'main.json');
  if (existsSync(mainWs)) return readWorkstream('main', dir);
  const p = resolve(dir, 'shared.json');
  if (!existsSync(p)) return { id: 'main', name: '', whys: [] };
  return JSON.parse(readFileSync(p, 'utf-8'));
}

export function writeShared(workstream, dir) {
  if (getCurrentSession()) return writeWorkstream('main', workstream, dir);
  const mainWs = resolve(dir, 'workstreams', 'main.json');
  if (existsSync(mainWs)) return writeWorkstream('main', workstream, dir);
  writeFileSync(resolve(dir, 'shared.json'), JSON.stringify(workstream, null, 2));
}

// ---- Contributions log ----

export function appendContribution(contribution, dir) {
  const s = getCurrentSession();
  if (s) {
    const path = ctxPath('contributions.jsonl');
    const existing = s.read(path);
    const next = (existing?.content || '') + JSON.stringify(contribution) + '\n';
    s.write(path, next);
    return;
  }
  appendFileSync(resolve(dir, 'contributions.jsonl'), JSON.stringify(contribution) + '\n');
}

export function readContributions(dir) {
  const s = sessionRead(ctxPath('contributions.jsonl'));
  if (s !== undefined) {
    if (s === null) return [];
    return s.split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  const p = resolve(dir, 'contributions.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

// ---- Role files ----

function sanitizeSlug(slug) {
  if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new Error(`Invalid role slug: "${slug}"`);
  }
}

export function writeRoleFile(slug, content, dir) {
  sanitizeSlug(slug);
  if (sessionWrite(ctxPath('context', 'roles', `${slug}.md`), content)) return;
  const rolesDir = resolve(dir, 'context', 'roles');
  mkdirSync(rolesDir, { recursive: true });
  writeFileSync(join(rolesDir, `${slug}.md`), content);
}

export function readRoleFile(slug, dir) {
  sanitizeSlug(slug);
  const s = sessionRead(ctxPath('context', 'roles', `${slug}.md`));
  if (s !== undefined) {
    if (s === null) throw new Error(`role file not found: ${slug}`);
    return s;
  }
  return readFileSync(resolve(dir, 'context', 'roles', `${slug}.md`), 'utf-8');
}

// ---- Shared md (legacy compat) ----

export function readSharedMd(dir) {
  if (getCurrentSession()) return readWorkstreamMd('main', dir);
  const mainMd = resolve(dir, 'context', 'workstreams', 'main.md');
  if (existsSync(mainMd)) return readWorkstreamMd('main', dir);
  const p = resolve(dir, 'context', 'shared.md');
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf-8');
}

export function writeSharedMd(content, dir) {
  if (getCurrentSession()) return writeWorkstreamMd('main', content, dir);
  const mainMd = resolve(dir, 'context', 'workstreams', 'main.md');
  if (existsSync(mainMd)) return writeWorkstreamMd('main', content, dir);
  const contextDir = resolve(dir, 'context');
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(join(contextDir, 'shared.md'), content);
}

// ---- Queue ----

function sanitizeQueueId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid queue id: "${id}"`);
  }
}

export function queueDir(dir) {
  return resolve(dir, 'queue');
}

export function writeQueueItem(item, dir) {
  sanitizeQueueId(item?.id);
  if (sessionWrite(ctxPath('queue', `${item.id}.json`), JSON.stringify(item, null, 2))) return;
  const d = queueDir(dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${item.id}.json`), JSON.stringify(item, null, 2));
}

export function readQueueItem(id, dir) {
  sanitizeQueueId(id);
  const s = sessionRead(ctxPath('queue', `${id}.json`));
  if (s !== undefined) {
    if (s === null) throw new Error(`queue item not found: ${id}`);
    return JSON.parse(s);
  }
  return JSON.parse(readFileSync(join(queueDir(dir), `${id}.json`), 'utf-8'));
}

export function listQueue(dir) {
  const s = sessionListDir(ctxPath('queue'));
  if (s !== null) {
    return s.filter(name => name.endsWith('.json'))
      .map(name => {
        const content = getCurrentSession().read(ctxPath('queue', name));
        return content ? JSON.parse(content.content) : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  }
  const d = queueDir(dir);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(d, name), 'utf-8')))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

export function deleteQueueItem(id, dir) {
  sanitizeQueueId(id);
  if (sessionDelete(ctxPath('queue', `${id}.json`))) return;
  unlinkSync(join(queueDir(dir), `${id}.json`));
}

export function writeRejected(item, dir) {
  if (sessionWrite(ctxPath('rejected', `${item.id}.json`), JSON.stringify(item, null, 2))) return;
  const d = resolve(dir, 'rejected');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${item.id}.json`), JSON.stringify(item, null, 2));
}

/**
 * Rejections are the only decision that leaves a file behind — approving
 * deletes the queue item and records nothing — so this is the only way to tell
 * an approval from a rejection without reading git history.
 */
export function listRejected(dir) {
  const s = sessionListDir(ctxPath('rejected'));
  if (s !== null) {
    return s.filter(name => name.endsWith('.json'))
      .map(name => {
        const content = getCurrentSession().read(ctxPath('rejected', name));
        return content ? JSON.parse(content.content) : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a.rejectedAt || '').localeCompare(b.rejectedAt || ''));
  }
  const d = resolve(dir, 'rejected');
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(d, name), 'utf-8')))
    .sort((a, b) => (a.rejectedAt || '').localeCompare(b.rejectedAt || ''));
}

// ---- Snapshots ----

export function snapshotsDir(dir) {
  return resolve(dir, 'snapshots');
}

export function writeSnapshot(snapshot, dir) {
  if (sessionWrite(ctxPath('snapshots', `${snapshot.id}.json`), JSON.stringify(snapshot, null, 2))) return;
  const d = snapshotsDir(dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${snapshot.id}.json`), JSON.stringify(snapshot, null, 2));
}

export function readSnapshot(id, dir) {
  const s = sessionRead(ctxPath('snapshots', `${id}.json`));
  if (s !== undefined) {
    if (s === null) throw new Error(`snapshot not found: ${id}`);
    return JSON.parse(s);
  }
  return JSON.parse(readFileSync(join(snapshotsDir(dir), `${id}.json`), 'utf-8'));
}

export function listSnapshots(dir) {
  const s = sessionListDir(ctxPath('snapshots'));
  if (s !== null) {
    return s
      .filter(name => name.endsWith('.json') && name !== 'current.json')
      .map(name => {
        const content = getCurrentSession().read(ctxPath('snapshots', name));
        return content ? JSON.parse(content.content) : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  }
  const d = snapshotsDir(dir);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter(name => name.endsWith('.json') && name !== 'current.json')
    .map(name => JSON.parse(readFileSync(join(d, name), 'utf-8')))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

export function resolveSnapshotId(prefix, dir) {
  const s = sessionListDir(ctxPath('snapshots'));
  let ids;
  if (s !== null) {
    ids = s
      .filter(name => name.endsWith('.json') && name !== 'current.json')
      .map(name => name.slice(0, -5));
  } else {
    const d = snapshotsDir(dir);
    if (!existsSync(d)) throw new Error(`no snapshot matches "${prefix}"`);
    ids = readdirSync(d)
      .filter(name => name.endsWith('.json') && name !== 'current.json')
      .map(name => name.slice(0, -5));
  }
  const matches = ids.filter(id => id === prefix || id.startsWith(prefix));
  if (matches.length === 0) throw new Error(`no snapshot matches "${prefix}"`);
  const exact = matches.find(id => id === prefix);
  if (exact) return exact;
  if (matches.length > 1) throw new Error(`prefix "${prefix}" is ambiguous: ${matches.join(', ')}`);
  return matches[0];
}

export function readCurrentSnapshotPointer(dir) {
  const s = sessionRead(ctxPath('snapshots', 'current.json'));
  if (s !== undefined) return s === null ? null : JSON.parse(s);
  const p = join(snapshotsDir(dir), 'current.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

export function writeCurrentSnapshotPointer(pointer, dir) {
  if (sessionWrite(ctxPath('snapshots', 'current.json'), JSON.stringify(pointer, null, 2))) return;
  const d = snapshotsDir(dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'current.json'), JSON.stringify(pointer, null, 2));
}

// ---- Workstreams ----

function sanitizeWorkstreamId(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid workstream id: "${id}"`);
  }
}

export function readWorkstream(id, dir) {
  sanitizeWorkstreamId(id);
  const s = sessionRead(ctxPath('workstreams', `${id}.json`));
  if (s !== undefined) {
    if (s === null) return { id, name: '', whys: [] };
    return JSON.parse(s);
  }
  const p = resolve(dir, 'workstreams', `${id}.json`);
  if (!existsSync(p)) return { id, name: '', whys: [] };
  return JSON.parse(readFileSync(p, 'utf-8'));
}

export function writeWorkstream(id, workstream, dir) {
  sanitizeWorkstreamId(id);
  if (sessionWrite(ctxPath('workstreams', `${id}.json`), JSON.stringify(workstream, null, 2))) return;
  const wsDir = resolve(dir, 'workstreams');
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, `${id}.json`), JSON.stringify(workstream, null, 2));
}

export function listWorkstreamIds(dir) {
  const s = sessionListDir(ctxPath('workstreams'));
  if (s !== null) return s.filter(f => f.endsWith('.json')).map(f => f.slice(0, -'.json'.length)).sort();
  const wsDir = resolve(dir, 'workstreams');
  if (!existsSync(wsDir)) return [];
  return readdirSync(wsDir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -'.json'.length))
    .sort();
}

export function readWorkstreamMd(id, dir) {
  sanitizeWorkstreamId(id);
  const s = sessionRead(ctxPath('context', 'workstreams', `${id}.md`));
  if (s !== undefined) return s === null ? '' : s;
  const p = resolve(dir, 'context', 'workstreams', `${id}.md`);
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf-8');
}

export function writeWorkstreamMd(id, content, dir) {
  sanitizeWorkstreamId(id);
  if (sessionWrite(ctxPath('context', 'workstreams', `${id}.md`), content)) return;
  const mdDir = resolve(dir, 'context', 'workstreams');
  mkdirSync(mdDir, { recursive: true });
  writeFileSync(join(mdDir, `${id}.md`), content);
}

function sanitizeTaskId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid task id: "${id}"`);
  }
}

export function tasksDir(dir) {
  return resolve(dir, 'context', 'tasks');
}

export function taskFilePath(id, dir) {
  sanitizeTaskId(id);
  return join(tasksDir(dir), `${id}.md`);
}

export function taskFileExists(id, dir) {
  return existsSync(taskFilePath(id, dir));
}

export function writeTaskFile(id, content, dir) {
  sanitizeTaskId(id);
  const d = tasksDir(dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${id}.md`), content);
}

export function readTaskFile(id, dir) {
  return readFileSync(taskFilePath(id, dir), 'utf-8');
}

export function deleteTaskFile(id, dir) {
  const p = taskFilePath(id, dir);
  if (existsSync(p)) unlinkSync(p);
}

export function listTasks({ workstream } = {}, dir) {
  const ids = workstream ? [workstream] : listWorkstreamIds(dir);
  const out = [];
  for (const wsId of ids) {
    const ws = readWorkstream(wsId, dir);
    const tasks = Array.isArray(ws.tasks) ? ws.tasks : [];
    for (const task of tasks) {
      out.push({ ...task, workstream: task.workstream || wsId });
    }
  }
  return out;
}

export function resolveTaskId(prefix, dir) {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new Error(`no task matches "${prefix}"`);
  }
  const all = listTasks({}, dir);
  const matches = all.filter(t => t.id === prefix || t.id.startsWith(prefix));
  if (matches.length === 0) throw new Error(`no task matches "${prefix}"`);
  const exact = matches.find(t => t.id === prefix);
  if (exact) return exact.id;
  if (matches.length > 1) throw new Error(`prefix "${prefix}" is ambiguous: ${matches.map(t => t.id).join(', ')}`);
  return matches[0].id;
}

export function readTask(idOrPrefix, dir) {
  const id = resolveTaskId(idOrPrefix, dir);
  const all = listTasks({}, dir);
  const task = all.find(t => t.id === id);
  return { task, workstream: task.workstream };
}

export function writeTask(task, dir) {
  sanitizeTaskId(task?.id);
  const wsId = task.workstream || 'main';
  sanitizeWorkstreamId(wsId);
  const ws = readWorkstream(wsId, dir);
  const tasks = Array.isArray(ws.tasks) ? ws.tasks : [];
  const idx = tasks.findIndex(t => t.id === task.id);
  if (idx >= 0) tasks[idx] = task;
  else tasks.push(task);
  ws.tasks = tasks;
  writeWorkstream(wsId, ws, dir);
}

export function deleteTask(idOrPrefix, dir) {
  const id = resolveTaskId(idOrPrefix, dir);
  const { workstream: wsId } = readTask(id, dir);
  const ws = readWorkstream(wsId, dir);
  ws.tasks = (ws.tasks || []).filter(t => t.id !== id);
  writeWorkstream(wsId, ws, dir);
  deleteTaskFile(id, dir);
  return { id, workstream: wsId };
}

