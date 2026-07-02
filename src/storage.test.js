import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readConfig, writeConfig,
  readShared, writeShared,
  appendContribution, readContributions,
  writeRoleFile, readRoleFile,
  writeSharedMd, readSharedMd,
} from './storage.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'teamctx-test-'));
  mkdirSync(join(dir, 'context', 'roles'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('config', () => {
  it('writes and reads config round-trip', () => {
    const cfg = { project: 'Demo', model: 'claude-sonnet-4-6', autoPush: false, me: 'alice', roles: [] };
    writeConfig(cfg, dir);
    expect(readConfig(dir)).toEqual(cfg);
  });
});

describe('workstream', () => {
  it('returns empty workstream when shared.json does not exist', () => {
    expect(readShared(dir)).toEqual({ id: 'main', name: '', whys: [] });
  });

  it('writes and reads workstream round-trip', () => {
    const ws = { id: 'main', name: 'Q3 Launch', whys: [] };
    writeShared(ws, dir);
    expect(readShared(dir)).toEqual(ws);
  });
});

describe('contributions', () => {
  it('returns empty array when contributions.jsonl does not exist', () => {
    expect(readContributions(dir)).toEqual([]);
  });

  it('appends and reads multiple contributions', () => {
    const c1 = { id: 'c1', ts: '2026-01-01', author: 'alice', text: 'first', status: 'merged' };
    const c2 = { id: 'c2', ts: '2026-01-02', author: 'bob', text: 'second', status: 'merged' };
    appendContribution(c1, dir);
    appendContribution(c2, dir);
    expect(readContributions(dir)).toEqual([c1, c2]);
  });
});

describe('role files', () => {
  it('writes and reads a role MD file', () => {
    writeRoleFile('cpo', '# CPO Context\n\nHello', dir);
    expect(readRoleFile('cpo', dir)).toBe('# CPO Context\n\nHello');
  });

  it('throws on invalid slug with path traversal characters', () => {
    expect(() => writeRoleFile('../../config', '# bad', dir)).toThrow(/invalid role slug/i);
    expect(() => readRoleFile('../../config', dir)).toThrow(/invalid role slug/i);
  });
});

describe('shared.md', () => {
  it('writes shared.md into context/', async () => {
    writeSharedMd('# Project\n\n*No context.*', dir);
    const { readFileSync } = await import('fs');
    const content = readFileSync(join(dir, 'context', 'shared.md'), 'utf-8');
    expect(content).toBe('# Project\n\n*No context.*');
  });

  it('reads shared.md written previously', () => {
    writeSharedMd('# Project\n\nHello', dir);
    expect(readSharedMd(dir)).toBe('# Project\n\nHello');
  });

  it('returns empty string when shared.md does not exist', () => {
    expect(readSharedMd(dir)).toBe('');
  });
});
