import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as folder from './folder.js';
import { ImportPathError } from '../import.js';

let root;
const write = (rel, text) => {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'teamctx-folder-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('folder connector', () => {
  it('needs no credentials', () => {
    expect(folder.auth({})).toEqual({ ok: true });
  });

  it('lists the documents under a directory', () => {
    write('docs/a.md', '# A\n\nalpha');
    write('docs/b.txt', 'bravo');
    const { items } = folder.list(null, ['docs'], { cwd: root });
    expect(items.map(i => i.id)).toEqual(['docs/a.md', 'docs/b.txt']);
    expect(items[0].title).toBe('A');
  });

  it('accepts a bare selector as well as an array', () => {
    write('docs/a.md', 'alpha');
    expect(folder.list(null, 'docs', { cwd: root }).items).toHaveLength(1);
  });

  it('reports what it skipped, so the caller can explain the gap', () => {
    write('docs/a.md', 'alpha');
    write('docs/empty.md', '');
    const { skipped } = folder.list(null, ['docs'], { cwd: root });
    expect(skipped).toEqual([{ id: 'docs/empty.md', reason: 'empty' }]);
  });

  it('fetches the document a ref points at', () => {
    write('docs/a.md', '# A\n\nalpha');
    const { items } = folder.list(null, ['docs'], { cwd: root });
    expect(folder.fetch(null, items[0].ref)).toMatchObject({ id: 'docs/a.md', title: 'A' });
    expect(folder.fetch(null, items[0].ref).text).toContain('alpha');
  });

  it('propagates a missing path rather than listing nothing', () => {
    // Same contract as the native path: a typo is loud.
    expect(() => folder.list(null, ['nope'], { cwd: root })).toThrow(ImportPathError);
  });
});
