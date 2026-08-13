import { readDocuments } from '../import.js';

/**
 * The reference connector: a local directory of .md/.txt files.
 *
 * `teamctx import <paths…>` resolves to this one, so the contract is exercised
 * by every local import rather than only by code that does not exist yet. An
 * interface nothing runs is decoration — it drifts, because nothing breaks when
 * it is wrong.
 *
 * It is also the worked example. Connector authors copy a file; they do not
 * read an interface document. This is deliberately the smallest thing that
 * satisfies the contract.
 */

export const name = 'folder';
export const describe = 'A local directory or file (.md, .txt)';

/** Nothing to authenticate against — the filesystem is already there. */
export function auth() {
  return { ok: true };
}

/**
 * `selector` is one or more paths. Listing reads the files, because the
 * filesystem gives no cheaper way to know a file is empty or oversized — a
 * remote connector would answer this from metadata instead.
 */
export function list(_auth, selector, { cwd = process.cwd() } = {}) {
  const paths = Array.isArray(selector) ? selector : [selector];
  const { documents, skipped } = readDocuments(paths, { cwd });
  return {
    items: documents.map(d => ({ ref: d, id: d.id, title: d.title })),
    skipped,
  };
}

/** The document is already in hand from `list`; nothing more to fetch. */
export function fetch(_auth, ref) {
  return { id: ref.id, title: ref.title, text: ref.text };
}
