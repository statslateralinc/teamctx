import { deflateRawSync } from 'zlib';

/**
 * Build a real ZIP archive, for tests.
 *
 * Test-only, and deliberately written against the PKZIP layout rather than
 * against `docx.js` — the reader discovers offsets from the central directory,
 * this computes them forward, so an off-by-one in either shows up as a failure
 * instead of cancelling out.
 *
 * The options exist to reproduce the shapes real archives have and lazy parsers
 * get wrong: an entry that is not first, a stored entry beside a deflated one,
 * a local extra field of a different length from the central one (Word does
 * this), and a trailing comment that pushes the end-of-central-directory record
 * away from the end of the file.
 */
export function buildZip(entries, { comment = '' } = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data, store = false, localExtra = 0 } of entries) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const body = store ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);                       // version needed
    local.writeUInt16LE(0, 6);                        // flags
    local.writeUInt16LE(store ? 0 : 8, 8);            // method
    local.writeUInt32LE(0, 14);                       // crc — unchecked by the reader
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(localExtra, 28);

    const extra = Buffer.alloc(localExtra);
    chunks.push(local, nameBuf, extra, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(store ? 0 : 8, 10);
    cen.writeUInt32LE(0, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    // Deliberately not localExtra: the central and local extra fields are
    // allowed to differ, and assuming they match is the classic reader bug.
    cen.writeUInt16LE(0, 30);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + extra.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const commentBuf = Buffer.from(comment, 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(commentBuf.length, 20);

  return Buffer.concat([...chunks, centralBuf, eocd, commentBuf]);
}

/** A .docx-shaped archive: the body part is never the first entry in a real one. */
export function buildDocx(documentXml, opts = {}) {
  return buildZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '_rels/.rels', data: '<Relationships/>' },
    { name: 'word/document.xml', data: documentXml, ...opts },
    { name: 'word/styles.xml', data: '<w:styles/>' },
  ], opts);
}

/** Wrap paragraphs in the envelope Word actually emits. */
export function wordDocument(inner) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${inner}</w:body></w:document>`;
}

/** One paragraph made of one or more runs, as Word splits them. */
export const para = (...runs) =>
  `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${runs.join('')}</w:p>`;

export const run = (text, { preserve = false } = {}) =>
  `<w:r><w:t${preserve ? ' xml:space="preserve"' : ''}>${text}</w:t></w:r>`;
