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
  const p = resolve(dir, 'shared.json');
  if (!existsSync(p)) return { id: 'main', name: '', whys: [] };
  return JSON.parse(readFileSync(p, 'utf-8'));
}

export function writeShared(workstream, dir) {
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
  const p = resolve(dir, 'context', 'shared.md');
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf-8');
}

export function writeSharedMd(content, dir) {
  const contextDir = resolve(dir, 'context');
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(join(contextDir, 'shared.md'), content);
}

export function queueDir(dir) {
  return resolve(dir, 'queue');
}

export function writeQueueItem(item, dir) {
  const d = queueDir(dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${item.id}.json`), JSON.stringify(item, null, 2));
}

export function readQueueItem(id, dir) {
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
  unlinkSync(join(queueDir(dir), `${id}.json`));
}

export function writeRejected(item, dir) {
  const d = resolve(dir, 'rejected');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${item.id}.json`), JSON.stringify(item, null, 2));
}
