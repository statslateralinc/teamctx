import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';

function resolve(dir, ...parts) {
  return join(dir || getTeamctxDir(), ...parts);
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

export function readConfig(dir) {
  return JSON.parse(readFileSync(resolve(dir, 'config.json'), 'utf-8'));
}

export function writeConfig(config, dir) {
  writeFileSync(resolve(dir, 'config.json'), JSON.stringify(config, null, 2));
}

export function readShared(dir) {
  const mainWs = resolve(dir, 'workstreams', 'main.json');
  if (existsSync(mainWs)) return readWorkstream('main', dir);
  const p = resolve(dir, 'shared.json');
  if (!existsSync(p)) return { id: 'main', name: '', whys: [] };
  return JSON.parse(readFileSync(p, 'utf-8'));
}

export function writeShared(workstream, dir) {
  const mainWs = resolve(dir, 'workstreams', 'main.json');
  if (existsSync(mainWs)) return writeWorkstream('main', workstream, dir);
  writeFileSync(resolve(dir, 'shared.json'), JSON.stringify(workstream, null, 2));
}

export function appendContribution(contribution, dir) {
  appendFileSync(resolve(dir, 'contributions.jsonl'), JSON.stringify(contribution) + '\n');
}

export function readContributions(dir) {
  const p = resolve(dir, 'contributions.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function sanitizeSlug(slug) {
  if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new Error(`Invalid role slug: "${slug}"`);
  }
}

function sanitizeQueueId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid queue id: "${id}"`);
  }
}

export function writeRoleFile(slug, content, dir) {
  sanitizeSlug(slug);
  const rolesDir = resolve(dir, 'context', 'roles');
  mkdirSync(rolesDir, { recursive: true });
  writeFileSync(join(rolesDir, `${slug}.md`), content);
}

export function readRoleFile(slug, dir) {
  sanitizeSlug(slug);
  return readFileSync(resolve(dir, 'context', 'roles', `${slug}.md`), 'utf-8');
}

export function readSharedMd(dir) {
  const mainMd = resolve(dir, 'context', 'workstreams', 'main.md');
  if (existsSync(mainMd)) return readWorkstreamMd('main', dir);
  const p = resolve(dir, 'context', 'shared.md');
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf-8');
}

export function writeSharedMd(content, dir) {
  const mainMd = resolve(dir, 'context', 'workstreams', 'main.md');
  if (existsSync(mainMd)) return writeWorkstreamMd('main', content, dir);
  const contextDir = resolve(dir, 'context');
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(join(contextDir, 'shared.md'), content);
}

export function queueDir(dir) {
  return resolve(dir, 'queue');
}

export function writeQueueItem(item, dir) {
  sanitizeQueueId(item?.id);
  const d = queueDir(dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${item.id}.json`), JSON.stringify(item, null, 2));
}

export function readQueueItem(id, dir) {
  sanitizeQueueId(id);
  return JSON.parse(readFileSync(join(queueDir(dir), `${id}.json`), 'utf-8'));
}

export function listQueue(dir) {
  const d = queueDir(dir);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(d, name), 'utf-8')))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

export function deleteQueueItem(id, dir) {
  sanitizeQueueId(id);
  unlinkSync(join(queueDir(dir), `${id}.json`));
}

export function writeRejected(item, dir) {
  const d = resolve(dir, 'rejected');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${item.id}.json`), JSON.stringify(item, null, 2));
}

export function snapshotsDir(dir) {
  return resolve(dir, 'snapshots');
}

export function writeSnapshot(snapshot, dir) {
  const d = snapshotsDir(dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${snapshot.id}.json`), JSON.stringify(snapshot, null, 2));
}

export function readSnapshot(id, dir) {
  return JSON.parse(readFileSync(join(snapshotsDir(dir), `${id}.json`), 'utf-8'));
}

export function listSnapshots(dir) {
  const d = snapshotsDir(dir);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter(name => name.endsWith('.json') && name !== 'current.json')
    .map(name => JSON.parse(readFileSync(join(d, name), 'utf-8')))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

export function resolveSnapshotId(prefix, dir) {
  const d = snapshotsDir(dir);
  if (!existsSync(d)) throw new Error(`no snapshot matches "${prefix}"`);
  const ids = readdirSync(d)
    .filter(name => name.endsWith('.json') && name !== 'current.json')
    .map(name => name.slice(0, -5));
  const matches = ids.filter(id => id === prefix || id.startsWith(prefix));
  if (matches.length === 0) throw new Error(`no snapshot matches "${prefix}"`);
  const exact = matches.find(id => id === prefix);
  if (exact) return exact;
  if (matches.length > 1) throw new Error(`prefix "${prefix}" is ambiguous: ${matches.join(', ')}`);
  return matches[0];
}

export function readCurrentSnapshotPointer(dir) {
  const p = join(snapshotsDir(dir), 'current.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

export function writeCurrentSnapshotPointer(pointer, dir) {
  const d = snapshotsDir(dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'current.json'), JSON.stringify(pointer, null, 2));
}

function sanitizeWorkstreamId(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid workstream id: "${id}"`);
  }
}

export function readWorkstream(id, dir) {
  sanitizeWorkstreamId(id);
  const p = resolve(dir, 'workstreams', `${id}.json`);
  if (!existsSync(p)) return { id, name: '', whys: [] };
  return JSON.parse(readFileSync(p, 'utf-8'));
}

export function writeWorkstream(id, workstream, dir) {
  sanitizeWorkstreamId(id);
  const wsDir = resolve(dir, 'workstreams');
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, `${id}.json`), JSON.stringify(workstream, null, 2));
}

export function listWorkstreamIds(dir) {
  const wsDir = resolve(dir, 'workstreams');
  if (!existsSync(wsDir)) return [];
  return readdirSync(wsDir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -'.json'.length))
    .sort();
}

export function readWorkstreamMd(id, dir) {
  sanitizeWorkstreamId(id);
  const p = resolve(dir, 'context', 'workstreams', `${id}.md`);
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf-8');
}

export function writeWorkstreamMd(id, content, dir) {
  sanitizeWorkstreamId(id);
  const mdDir = resolve(dir, 'context', 'workstreams');
  mkdirSync(mdDir, { recursive: true });
  writeFileSync(join(mdDir, `${id}.md`), content);
}
