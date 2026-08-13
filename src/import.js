import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative, resolve, extname, basename, sep } from 'path';

/**
 * Turn local files into normalized documents for import.
 *
 * A document is the unit the rest of the import pipeline works on, and it is
 * deliberately not file-shaped: connectors (Slack, Drive, …) will produce the
 * same structure from remote sources, where there is no path and no extension.
 * Hence `id` rather than `path`, and an explicit `source`.
 *
 *   { id, title, text, bytes, source }
 *
 *   id      stable, human-meaningful reference — a relative path here, but
 *           `slack:C0421/p1699…` for a connector. Used for attribution and to
 *           deduplicate within a run.
 *   title   first markdown H1, else the filename without its extension.
 *   text    the file's contents, BOM stripped.
 *   source  where it came from: 'file' here, 'slack'/'drive' for connectors.
 *
 * Nothing here calls an AI or writes anything — reading is kept separate from
 * distilling so connectors can reuse it and so it stays cheap to test.
 */

/** Formats we can read as plain text today. PDF/docx extraction is a follow-up. */
export const DEFAULT_EXTENSIONS = ['.md', '.txt'];

/**
 * Skipped wholesale when walking a directory. `.teamctx` matters most: importing
 * a project's own compiled context back into itself would loop its own output
 * through the distiller.
 */
export const DEFAULT_IGNORED_DIRS = ['.git', '.teamctx', 'node_modules', 'dist', 'build', 'vendor'];

/**
 * Files above this are skipped rather than truncated. A single oversized
 * document would dominate an import run's cost and distill badly; better to
 * say so and let the user split it.
 */
export const DEFAULT_MAX_BYTES = 256 * 1024;

export class ImportPathError extends Error {
  constructor(path) {
    super(`no such file or directory: ${path}`);
    this.code = 'IMPORT_PATH_NOT_FOUND';
    this.path = path;
  }
}

/** Ids always use forward slashes, so they read the same on every platform. */
function toId(cwd, abs) {
  return relative(cwd, abs).split(sep).join('/') || basename(abs);
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** First markdown H1, else the filename without its extension. */
export function titleFor(text, filePath) {
  for (const line of text.split('\n', 50)) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading) return heading[1].trim();
    if (line.trim()) break;      // real content before any heading — don't hunt
  }
  return basename(filePath, extname(filePath));
}

function isIgnoredDir(name, ignoredDirs) {
  return name.startsWith('.') || ignoredDirs.includes(name);
}

/** Depth-first walk yielding absolute file paths, sorted for determinism. */
function walk(dir, { extensions, ignoredDirs }, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;                  // unreadable directory — treated as empty
  }
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    // Symlinks are skipped rather than resolved: a link back up the tree turns
    // the walk into an infinite loop, and following one silently pulls in files
    // from outside the paths the user named.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (isIgnoredDir(entry.name, ignoredDirs)) continue;
      walk(join(dir, entry.name), { extensions, ignoredDirs }, out);
    } else if (entry.isFile()) {
      if (entry.name.startsWith('.')) continue;
      if (extensions.includes(extname(entry.name).toLowerCase())) out.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Apply the rules every document has to satisfy, wherever it came from.
 *
 * Returns either `{ document }` or `{ skipped }` — never throws, because one
 * unusable item should not abandon the other twenty-nine.
 *
 * Connectors call this on whatever they fetch, so a Slack thread that is
 * whitespace or half a megabyte is rejected for exactly the reason a local file
 * would be. Without a shared rule each connector invents its own, and the
 * skipped-file report stops meaning one thing.
 */
export function normalizeDocument({ id, title, text, source = 'file', titleHint }, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!id) return { skipped: { id: '(unknown)', reason: 'no id' } };

  const clean = typeof text === 'string' ? stripBom(text) : '';
  if (!clean.trim()) return { skipped: { id, reason: 'empty' } };

  const bytes = Buffer.byteLength(clean, 'utf8');
  if (bytes > maxBytes) {
    return {
      skipped: {
        id,
        reason: `too large (${Math.round(bytes / 1024)}KB, limit ${Math.round(maxBytes / 1024)}KB)`,
      },
    };
  }

  return {
    document: {
      id,
      // A connector that knows its own title wins; otherwise fall back to the
      // markdown heading, then to whatever name the source suggests.
      title: (title && String(title).trim()) || titleFor(clean, titleHint || id),
      text: clean,
      bytes,
      source,
    },
  };
}

/**
 * Read the given files and directories into normalized documents.
 *
 * A path that does not exist throws. Silently importing nothing because of a
 * typo is the failure mode most likely to waste someone's afternoon.
 *
 * Everything else that cannot be used — too large, empty, wrong extension —
 * comes back in `skipped` with a reason, so the caller can report it rather
 * than leave the user wondering why 3 of their 12 files are missing.
 */
export function readDocuments(paths, {
  cwd = process.cwd(),
  extensions = DEFAULT_EXTENSIONS,
  ignoredDirs = DEFAULT_IGNORED_DIRS,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (!paths || paths.length === 0) throw new Error('at least one path is required');

  const exts = extensions.map(e => e.toLowerCase());
  const files = [];
  const skipped = [];

  for (const input of paths) {
    const abs = resolve(cwd, input);
    if (!existsSync(abs)) throw new ImportPathError(input);

    if (statSync(abs).isDirectory()) {
      files.push(...walk(abs, { extensions: exts, ignoredDirs }));
    } else if (!exts.includes(extname(abs).toLowerCase())) {
      // Named explicitly, so say why it was ignored rather than dropping it.
      skipped.push({ id: toId(cwd, abs), reason: `unsupported type (${exts.join(', ')} only)` });
    } else {
      files.push(abs);
    }
  }

  const documents = [];
  const seen = new Set();

  for (const abs of [...new Set(files)].sort()) {
    const id = toId(cwd, abs);
    if (seen.has(id)) continue;          // same file named twice, or via a parent dir
    seen.add(id);

    let raw;
    try {
      // Checked against the file size before reading, so an oversized file is
      // rejected without being pulled into memory first. normalizeDocument
      // re-checks the decoded text; a connector has no stat() to lean on.
      const { size } = statSync(abs);
      if (size > maxBytes) {
        skipped.push({ id, reason: `too large (${Math.round(size / 1024)}KB, limit ${Math.round(maxBytes / 1024)}KB)` });
        continue;
      }
      raw = readFileSync(abs, 'utf-8');
    } catch (err) {
      skipped.push({ id, reason: `unreadable (${err.code || err.message})` });
      continue;
    }

    const result = normalizeDocument({ id, text: raw, source: 'file', titleHint: abs }, { maxBytes });
    if (result.skipped) skipped.push(result.skipped);
    else documents.push(result.document);
  }

  return { documents, skipped };
}
