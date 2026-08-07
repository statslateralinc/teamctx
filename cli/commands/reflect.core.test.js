import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../../src/context.js', () => ({
  generateReflection: vi.fn(),
  serializeToMd: vi.fn(),
  generateRoleFile: vi.fn(),
}));

import { writeConfig } from '../../src/storage.js';
import { reflectWorkstream } from './reflect.core.js';
import { UnknownWorkstreamError } from './role.core.js';

let dir;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('reflectWorkstream', () => {
  it('rejects an unknown workstream id', async () => {
    dir = mkdtempSync(join(tmpdir(), 'teamctx-reflect-'));
    writeConfig({ activeWorkstream: 'main', workstreams: [{ id: 'main' }] }, dir);

    await expect(reflectWorkstream({ workstreamId: 'typo', teamctxDir: dir }))
      .rejects.toBeInstanceOf(UnknownWorkstreamError);
  });
});
