import { inflateRawSync } from 'zlib';

/**
 * Read the text out of a .docx.
 *
 * Needed because Microsoft Graph cannot convert anything to text — its format
 * endpoint offers pdf, jpg and html, and html only for Loop and Whiteboard
 * files. A Word document is not a pointer to something a server can render, the
 * way a Google Doc is: the bytes *are* the document, and the bytes are a ZIP.
 *
 * It lives in src/formats rather than in a connector because three callers want
 * it. M365 is useless without it; Dropbox skips both `.docx` and the Google Docs
 * it reports as `export_as: docx`; and `folder` could read Word files off local
 * disk with the same function.
 *
 * No dependency: Node ships zlib, and a ZIP is a container format simple enough
 * to walk directly. What follows is the central directory, which is the only
 * reliable place to find an entry — local headers may carry zeroed sizes with
 * the real values in a trailing data descriptor.
 *
 * Deliberately *not* a general OOXML renderer. It recovers paragraph text and
 * nothing else: no styles, no numbering, no tables-as-tables. The distiller
 * reads prose, and every extra shape is another place to be wrong about what a
 * document actually said.
 */

const EOCD_SIG = 0x06054b50;          // end of central directory
const CEN_SIG = 0x02014b50;           // central directory file header
const ZIP64_LOCATOR_SIG = 0x07064b50;

const STORED = 0;
const DEFLATED = 8;

/** Word puts the body here. Every .docx has it; if it is missing, the file is
 *  not a Word document whatever its extension says. */
const DOCUMENT_PART = 'word/document.xml';

export class DocxError extends Error {
  constructor(message) {
    super(`docx: ${message}`);
    this.code = 'DOCX_PARSE';
  }
}

/**
 * Find the end-of-central-directory record.
 *
 * It sits at the very end unless the archive carries a comment, so this scans
 * backwards. The 64KB bound is the maximum a ZIP comment can be — beyond that
 * the record cannot be there and the file is not a ZIP.
 */
function findEndOfCentralDirectory(buf) {
  const earliest = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= earliest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new DocxError('not a ZIP archive (no end-of-central-directory record)');
}

/**
 * Walk the central directory and return the entry we want.
 *
 * Reading every header rather than stopping at the first match would be tidier
 * to write and slower on a document full of images, which is the common case —
 * a 40MB .docx is mostly media around a small body part.
 */
function findEntry(buf, wanted) {
  const eocd = findEndOfCentralDirectory(buf);

  // A ZIP64 archive stores the real offsets elsewhere. A Word document large
  // enough to need that is far past the size cap import would accept anyway,
  // so say so rather than read a 0xffffffff placeholder as an offset.
  if (buf.length > 22 + 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) {
    throw new DocxError('ZIP64 archives are not supported');
  }

  let count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);

  while (count-- > 0) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CEN_SIG) {
      throw new DocxError('the central directory is malformed');
    }
    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const localHeaderOffset = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);

    if (name === wanted) return { method, compressedSize, localHeaderOffset };
    at += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/**
 * The bytes of one entry.
 *
 * The local header repeats the name and extra fields, and its extra-field
 * length often differs from the central directory's — so the data offset has to
 * come from the local header, not be assumed.
 */
function readEntry(buf, entry) {
  const { localHeaderOffset: off, method, compressedSize } = entry;
  if (off + 30 > buf.length) throw new DocxError('the archive is truncated');

  const nameLength = buf.readUInt16LE(off + 26);
  const extraLength = buf.readUInt16LE(off + 28);
  const start = off + 30 + nameLength + extraLength;
  const end = start + compressedSize;
  if (end > buf.length) throw new DocxError('the archive is truncated');

  const raw = buf.subarray(start, end);
  if (method === STORED) return raw;
  if (method === DEFLATED) {
    try {
      return inflateRawSync(raw);
    } catch {
      throw new DocxError('the document part could not be decompressed');
    }
  }
  throw new DocxError(`unsupported compression method (${method})`);
}

const XML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
};

function decodeXml(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos);/g, m => XML_ENTITIES[m]);
}

/**
 * Everything Word can hold that must never reach the output.
 *
 * `w:del` is the important one and the reason this is a list rather than a
 * blanket tag strip. Text inside it has been *deleted* with track-changes on;
 * it is still in the file, and a naive strip would resurrect a sentence someone
 * removed on purpose. Putting that into shared context would be worse than
 * importing nothing at all.
 *
 * `w:instrText` is field code (`PAGE`, `HYPERLINK "…"`), not prose.
 * `w:proofErr` and the rest carry no text but nest around it.
 */
const DROPPED_ELEMENTS = ['w:del', 'w:instrText', 'w:delText', 'w:commentRangeStart'];

function stripDropped(xml) {
  let out = xml;
  for (const tag of DROPPED_ELEMENTS) {
    // Both the paired form and the self-closing one; non-greedy so two
    // deletions in a paragraph do not swallow the text between them.
    out = out
      .replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'g'), '')
      .replace(new RegExp(`<${tag}(?:\\s[^>]*)?/>`, 'g'), '');
  }
  return out;
}

/**
 * Paragraph text, in document order.
 *
 * Word splits a sentence across as many `w:t` runs as it likes — a spellcheck
 * mark or a change of font is enough — so runs are joined without a separator
 * and paragraphs are what become lines. `xml:space="preserve"` matters: a run
 * carrying a single space is how Word writes the gap between two words.
 */
export function textFromDocumentXml(xml) {
  const body = stripDropped(String(xml ?? ''));
  const lines = [];

  for (const [, paragraph] of body.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    let text = '';
    for (const [, run] of paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) {
      text += decodeXml(run);
    }
    // A tab is a column separator in Word's idea of a table row, and losing it
    // turns two cells into one word.
    if (/<w:tab\b/.test(paragraph)) text = text.replace(/\s*$/, '');
    // Explicit line breaks inside one paragraph are still line breaks.
    lines.push(...(/<w:br\b/.test(paragraph) ? text.split('\n') : [text]));
  }

  return lines
    .map(l => l.replace(/[ \t]+$/, ''))
    // Word emits a great many empty paragraphs for spacing; more than one blank
    // line in a row says nothing the distiller can use.
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract the text of a .docx supplied as a Buffer.
 *
 * Throws rather than returning empty on a file that is not a Word document: a
 * caller that queued an empty contribution because a download was truncated
 * would be a much worse outcome than a named failure.
 */
export function docxToText(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new DocxError('expected a Buffer');
  if (buffer.length < 22) throw new DocxError('the file is too small to be a .docx');

  const entry = findEntry(buffer, DOCUMENT_PART);
  if (!entry) throw new DocxError(`no ${DOCUMENT_PART} — this is a ZIP, but not a Word document`);

  return textFromDocumentXml(readEntry(buffer, entry).toString('utf8'));
}
