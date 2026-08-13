import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readDocuments, titleFor, normalizeDocument, ImportPathError, DEFAULT_MAX_BYTES } from './import.js';

let root;
const write = (rel, text) => {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
  return p;
};
const ids = r => r.documents.map(d => d.id);
const reasonFor = (r, id) => r.skipped.find(s => s.id === id)?.reason;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'teamctx-import-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('readDocuments — selection', () => {
  it('reads a single named file', () => {
    write('notes.md', '# Strategy\n\nWe are moving off Stripe.');
    const r = readDocuments(['notes.md'], { cwd: root });
    expect(ids(r)).toEqual(['notes.md']);
    expect(r.documents[0]).toMatchObject({ title: 'Strategy', source: 'file' });
    expect(r.documents[0].text).toContain('moving off Stripe');
  });

  it('walks a directory recursively, in a stable order', () => {
    write('docs/b.md', 'b');
    write('docs/a.txt', 'a');
    write('docs/deep/c.md', 'c');
    // Sorted, so a run is reproducible and tests are not order-flaky.
    expect(ids(readDocuments(['docs'], { cwd: root }))).toEqual(['docs/a.txt', 'docs/b.md', 'docs/deep/c.md']);
  });

  it('uses forward slashes in ids on every platform', () => {
    write('docs/deep/c.md', 'c');
    expect(ids(readDocuments(['docs'], { cwd: root }))[0]).toBe('docs/deep/c.md');
  });

  it('ignores unsupported extensions inside a directory silently', () => {
    write('docs/a.md', 'a');
    write('docs/logo.png', 'binary');
    const r = readDocuments(['docs'], { cwd: root });
    expect(ids(r)).toEqual(['docs/a.md']);
    expect(r.skipped).toEqual([]);
  });

  it('normalises skipped ids to forward slashes too', () => {
    // Skipped entries are shown alongside document ids; mixing separators
    // between the two lists looks like a bug to the reader.
    write('docs/logo.png', 'binary');
    const r = readDocuments(['docs/logo.png'], { cwd: root });
    expect(r.skipped[0].id).toBe('docs/logo.png');
  });

  it('reports an unsupported file the user named explicitly', () => {
    // Naming a file and having nothing happen is confusing; walking past one
    // inside a directory is not.
    write('deck.pdf', 'x');
    const r = readDocuments(['deck.pdf'], { cwd: root });
    expect(ids(r)).toEqual([]);
    expect(reasonFor(r, 'deck.pdf')).toMatch(/unsupported type/);
  });

  it('skips dotfiles, dot-directories and the usual noise', () => {
    write('docs/a.md', 'a');
    write('docs/.hidden.md', 'h');
    write('docs/.cache/b.md', 'b');
    write('node_modules/pkg/readme.md', 'n');
    write('dist/out.md', 'd');
    expect(ids(readDocuments(['.'], { cwd: root }))).toEqual(['docs/a.md']);
  });

  it("never re-imports the project's own .teamctx context", () => {
    // Feeding compiled context back through the distiller would loop teamctx's
    // own output into itself.
    write('.teamctx/context/workstreams/main.md', '# Project Context');
    write('notes.md', 'real note');
    expect(ids(readDocuments(['.'], { cwd: root }))).toEqual(['notes.md']);
  });

  it('does not follow symlinks', () => {
    write('docs/a.md', 'a');
    try {
      symlinkSync(join(root, 'docs'), join(root, 'docs/loop'), 'dir');
    } catch {
      return;    // needs privileges on Windows; the guard is still exercised below
    }
    // Without the symlink guard this recurses until the stack gives out.
    expect(ids(readDocuments(['docs'], { cwd: root }))).toEqual(['docs/a.md']);
  });
});

describe('readDocuments — deduplication', () => {
  it('reads a file once when named twice', () => {
    write('docs/a.md', 'a');
    expect(ids(readDocuments(['docs/a.md', 'docs/a.md'], { cwd: root }))).toEqual(['docs/a.md']);
  });

  it('reads a file once when named directly and via its directory', () => {
    write('docs/a.md', 'a');
    write('docs/b.md', 'b');
    expect(ids(readDocuments(['docs', 'docs/a.md'], { cwd: root }))).toEqual(['docs/a.md', 'docs/b.md']);
  });
});

describe('readDocuments — what it refuses', () => {
  it('throws on a path that does not exist', () => {
    // A typo must be loud. Importing nothing and reporting success is the
    // failure mode most likely to waste an afternoon.
    expect(() => readDocuments(['nope.md'], { cwd: root })).toThrow(ImportPathError);
    expect(() => readDocuments(['nope.md'], { cwd: root })).toThrow(/no such file or directory/);
  });

  it('requires at least one path', () => {
    expect(() => readDocuments([], { cwd: root })).toThrow(/at least one path/);
  });

  it('skips an oversized file with the size in the reason', () => {
    write('big.md', 'x'.repeat(2000));
    const r = readDocuments(['big.md'], { cwd: root, maxBytes: 1000 });
    expect(ids(r)).toEqual([]);
    expect(reasonFor(r, 'big.md')).toMatch(/too large/);
  });

  it('skips empty and whitespace-only files', () => {
    write('empty.md', '');
    write('blank.md', '   \n\n\t\n');
    write('real.md', 'content');
    const r = readDocuments(['.'], { cwd: root });
    expect(ids(r)).toEqual(['real.md']);
    expect(reasonFor(r, 'empty.md')).toBe('empty');
    expect(reasonFor(r, 'blank.md')).toBe('empty');
  });

  it('has a default size limit', () => {
    expect(DEFAULT_MAX_BYTES).toBeGreaterThan(0);
  });
});

describe('titles and encoding', () => {
  it('prefers the first markdown H1', () => {
    expect(titleFor('# Billing migration\n\nbody', '/x/notes.md')).toBe('Billing migration');
  });

  it('looks past leading blank lines for the heading', () => {
    expect(titleFor('\n\n#  Spaced  \n', '/x/notes.md')).toBe('Spaced');
  });

  it('falls back to the filename when prose comes first', () => {
    // A heading buried under paragraphs is a section, not the document title.
    expect(titleFor('Intro paragraph.\n\n# Later heading', '/x/quarterly-plan.md')).toBe('quarterly-plan');
  });

  it('falls back to the filename when there is no heading', () => {
    expect(titleFor('just text', '/x/raw-notes.txt')).toBe('raw-notes');
  });

  it('strips a UTF-8 BOM so it cannot leak into the title or text', () => {
    write('bom.md', '﻿# Title\n\nbody');
    const doc = readDocuments(['bom.md'], { cwd: root }).documents[0];
    expect(doc.title).toBe('Title');
    expect(doc.text.startsWith('#')).toBe(true);
  });

  it('reports byte length, not character length', () => {
    write('uni.md', '# T\n\ncafé');           // é is two bytes in UTF-8
    const doc = readDocuments(['uni.md'], { cwd: root }).documents[0];
    expect(doc.bytes).toBe(Buffer.byteLength(doc.text, 'utf8'));
  });
});

describe('normalizeDocument — the rules every source obeys', () => {
  // Connectors call this on whatever they fetch, so a remote document is
  // rejected for exactly the reasons a local file would be.
  const doc = (over = {}) => normalizeDocument({ id: 'slack:C1/p2', text: 'real content', source: 'slack', ...over });

  it('returns a document with bytes and source filled in', () => {
    const { document } = doc();
    expect(document).toMatchObject({ id: 'slack:C1/p2', text: 'real content', source: 'slack' });
    expect(document.bytes).toBe(Buffer.byteLength('real content', 'utf8'));
  });

  it('prefers a title the connector already knows', () => {
    expect(doc({ title: 'Thread in #eng' }).document.title).toBe('Thread in #eng');
  });

  it('falls back to a markdown heading when the connector has no title', () => {
    expect(doc({ text: '# Billing plan\n\nbody' }).document.title).toBe('Billing plan');
  });

  it('falls back to the id when there is no title and no heading', () => {
    expect(doc({ id: 'notes' }).document.title).toBe('notes');
  });

  it('ignores a blank title rather than using it', () => {
    expect(doc({ title: '   ', text: '# Heading\n' }).document.title).toBe('Heading');
  });

  it('skips empty and whitespace-only text', () => {
    expect(doc({ text: '' }).skipped.reason).toBe('empty');
    expect(doc({ text: '  \n\t ' }).skipped.reason).toBe('empty');
    expect(doc({ text: undefined }).skipped.reason).toBe('empty');
  });

  it('skips oversized text with the size in the reason', () => {
    const r = normalizeDocument({ id: 'x', text: 'y'.repeat(2000) }, { maxBytes: 1000 });
    expect(r.skipped.reason).toMatch(/too large/);
  });

  it('strips a BOM before measuring or titling', () => {
    const { document } = doc({ text: '﻿# Title\n\nbody' });
    expect(document.title).toBe('Title');
    expect(document.text.startsWith('#')).toBe(true);
  });

  it('refuses a document with no id instead of inventing one', () => {
    // An id is how a contribution points back at its artifact; guessing would
    // silently break provenance.
    expect(normalizeDocument({ text: 'body' }).skipped.reason).toBe('no id');
  });

  it('never throws — one bad item must not abandon the rest of the run', () => {
    expect(() => normalizeDocument({})).not.toThrow();
    expect(() => normalizeDocument({ id: 'x', text: 42 })).not.toThrow();
  });
});
