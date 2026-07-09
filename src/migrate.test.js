import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeConfig, readConfig } from './storage.js';
import { migrateIfNeeded } from './migrate.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'teamctx-migrate-'));
  mkdirSync(join(dir, 'context', 'roles'), { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seedPreMigrationProject({ roles = [] } = {}) {
  writeConfig({ project: 'Demo', me: 'alice', model: 'claude-sonnet-4-6', autoPush: false, roles }, dir);
  writeFileSync(join(dir, 'shared.json'), JSON.stringify({ id: 'main', name: 'Demo', whys: [{ id: 'w1', text: 'launch' }] }, null, 2));
  writeFileSync(join(dir, 'context', 'shared.md'), '# Demo\n\nHello.\n');
}

describe('migrateIfNeeded', () => {
  it('returns false when no config.json exists', () => {
    expect(migrateIfNeeded(dir)).toBe(false);
  });

  it('returns false when config is already migrated', () => {
    writeConfig({ project: 'X', workstreamsMigrated: true, roles: [] }, dir);
    expect(migrateIfNeeded(dir)).toBe(false);
  });

  it('moves shared.json → workstreams/main.json', () => {
    seedPreMigrationProject();
    expect(migrateIfNeeded(dir)).toBe(true);

    expect(existsSync(join(dir, 'shared.json'))).toBe(false);
    const moved = JSON.parse(readFileSync(join(dir, 'workstreams', 'main.json'), 'utf-8'));
    expect(moved.id).toBe('main');
    expect(moved.whys[0].text).toBe('launch');
  });

  it('moves context/shared.md → context/workstreams/main.md', () => {
    seedPreMigrationProject();
    migrateIfNeeded(dir);

    expect(existsSync(join(dir, 'context', 'shared.md'))).toBe(false);
    expect(readFileSync(join(dir, 'context', 'workstreams', 'main.md'), 'utf-8')).toBe('# Demo\n\nHello.\n');
  });

  it('adds workstreams, activeWorkstream, and the migrated flag to config', () => {
    seedPreMigrationProject();
    migrateIfNeeded(dir);

    const cfg = readConfig(dir);
    expect(cfg.workstreams).toHaveLength(1);
    expect(cfg.workstreams[0]).toMatchObject({ id: 'main', name: 'Demo' });
    expect(cfg.workstreams[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(cfg.activeWorkstream).toBe('main');
    expect(cfg.workstreamsMigrated).toBe(true);
  });

  it('defaults every existing role to workstream "main"', () => {
    seedPreMigrationProject({ roles: [
      { slug: 'cpo', name: 'CPO' },
      { slug: 'cto', name: 'CTO', workstream: 'tech' },
    ]});
    migrateIfNeeded(dir);

    const cfg = readConfig(dir);
    expect(cfg.roles.find(r => r.slug === 'cpo').workstream).toBe('main');
    // pre-existing workstream assignment must be preserved
    expect(cfg.roles.find(r => r.slug === 'cto').workstream).toBe('tech');
  });

  it('is idempotent: second run is a no-op', () => {
    seedPreMigrationProject();
    expect(migrateIfNeeded(dir)).toBe(true);
    expect(migrateIfNeeded(dir)).toBe(false);
  });

  it('handles a project without shared.json (fresh config) by synthesizing an empty main workstream', () => {
    writeConfig({ project: 'Empty', me: 'a', model: 'x', autoPush: false, roles: [] }, dir);
    expect(migrateIfNeeded(dir)).toBe(true);

    const ws = JSON.parse(readFileSync(join(dir, 'workstreams', 'main.json'), 'utf-8'));
    expect(ws).toEqual({ id: 'main', name: 'Empty', whys: [] });
  });
});
