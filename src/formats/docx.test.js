import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'zlib';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { docxToText, textFromDocumentXml, DocxError } from './docx.js';
import { buildZip, buildDocx, wordDocument, para, run } from './zip-fixture.js';

const doc = inner => docxToText(buildDocx(wordDocument(inner)));

describe('reading the container', () => {
  it('finds the body part when it is not the first entry', () => {
    // It never is in a real .docx — [Content_Types].xml comes first — so a
    // reader that assumes entry zero passes its own fixture and nothing else.
    expect(doc(para(run('Hello')))).toBe('Hello');
  });

  it('reads a stored entry as well as a deflated one', () => {
    const xml = wordDocument(para(run('Uncompressed')));
    expect(docxToText(buildDocx(xml, { store: true }))).toBe('Uncompressed');
  });

  it('takes the data offset from the local header, not the central one', () => {
    // The two extra-field lengths are allowed to differ, and Word makes them
    // differ. Reading the central directory's length here lands mid-file.
    const xml = wordDocument(para(run('Offset survived')));
    expect(docxToText(buildDocx(xml, { localExtra: 17 }))).toBe('Offset survived');
  });

  it('finds the directory when a comment follows it', () => {
    const xml = wordDocument(para(run('After a comment')));
    expect(docxToText(buildDocx(xml, { comment: 'x'.repeat(300) }))).toBe('After a comment');
  });

  it('refuses a file that is not a ZIP', () => {
    expect(() => docxToText(Buffer.from('this is a plain text file, at length')))
      .toThrow(/not a ZIP archive/);
  });

  it('refuses a ZIP that is not a Word document', () => {
    // A .zip renamed to .docx, or a .pptx — both are valid archives.
    const zip = buildZip([{ name: 'ppt/presentation.xml', data: '<p/>' }]);
    expect(() => docxToText(zip)).toThrow(/not a Word document/);
  });

  it('refuses a truncated archive rather than returning half a document', () => {
    const full = buildDocx(wordDocument(para(run('Body'))));
    expect(() => docxToText(full.subarray(0, full.length - 40))).toThrow(DocxError);
  });

  it('refuses anything that is not a Buffer', () => {
    expect(() => docxToText('a string')).toThrow(/expected a Buffer/);
    expect(() => docxToText(null)).toThrow(/expected a Buffer/);
  });

  it('names an unsupported compression method instead of returning noise', () => {
    const zip = buildZip([{ name: 'word/document.xml', data: 'x' }]);
    zip.writeUInt16LE(99, 8);                          // local header method
    const cen = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt16LE(99, cen + 10);                   // central header method
    expect(() => docxToText(zip)).toThrow(/unsupported compression method \(99\)/);
  });

  it('reports a body part that will not decompress', () => {
    const zip = buildZip([{ name: 'word/document.xml', data: 'x' }]);
    // Corrupt the deflate stream in place, keeping every offset intact.
    const at = zip.indexOf(deflateRawSync(Buffer.from('x')));
    zip[at] = zip[at] ^ 0xff;
    expect(() => docxToText(zip)).toThrow(/could not be decompressed/);
  });
});

describe('extracting text', () => {
  it('joins the runs Word splits a sentence into', () => {
    // A spellcheck mark or a font change is enough to split a run, so runs are
    // joined with nothing between them and paragraphs are what become lines.
    expect(doc(para(run('The quick '), run('brown'), run(' fox')))).toBe('The quick brown fox');
  });

  it('keeps a run that is only a space', () => {
    // xml:space="preserve" on a lone space is how Word writes the gap between
    // two words that ended up in different runs.
    expect(doc(para(run('two'), run(' ', { preserve: true }), run('words')))).toBe('two words');
  });

  it('makes each paragraph a line', () => {
    expect(doc(para(run('First')) + para(run('Second')))).toBe('First\nSecond');
  });

  it('collapses the empty paragraphs Word uses for spacing', () => {
    const xml = para(run('Before')) + para() + para() + para() + para(run('After'));
    expect(doc(xml)).toBe('Before\n\nAfter');
  });

  it('decodes entities, including numeric ones', () => {
    expect(doc(para(run('a &amp; b &lt; c &#8212; d &#x2019;e'))))
      .toBe('a & b < c — d ’e');
  });

  it('splits on an explicit line break inside a paragraph', () => {
    expect(doc(para('<w:r><w:t>one</w:t></w:r><w:br/><w:r><w:t>\ntwo</w:t></w:r>')))
      .toBe('one\ntwo');
  });

  it('returns nothing for a document with no text', () => {
    expect(doc(para() + para())).toBe('');
  });
});

describe('what must never come out', () => {
  it('drops text deleted with track changes on', () => {
    // The single most important rule here. Deleted text is still in the file;
    // a blanket tag-strip would resurrect a sentence someone removed on
    // purpose, and putting that into shared context is worse than importing
    // nothing at all.
    const xml = para(
      run('We chose Postgres'),
      '<w:del w:author="Sam"><w:r><w:delText> and then reversed it</w:delText></w:r></w:del>',
      run('.'),
    );
    const out = doc(xml);
    expect(out).toBe('We chose Postgres.');
    expect(out).not.toContain('reversed');
  });

  it('keeps the text between two separate deletions', () => {
    // A greedy match here would swallow everything from the first deletion to
    // the last, silently losing the surviving sentence in the middle.
    const xml = para(
      '<w:del w:author="A"><w:r><w:delText>gone</w:delText></w:r></w:del>',
      run('kept'),
      '<w:del w:author="B"><w:r><w:delText>also gone</w:delText></w:r></w:del>',
    );
    expect(doc(xml)).toBe('kept');
  });

  it('keeps text that was inserted with track changes on', () => {
    // w:ins is the opposite case: it is real content the author added, and
    // dropping it would lose the newest thinking in the document.
    const xml = para(
      run('We chose '),
      '<w:ins w:author="Sam"><w:r><w:t>Postgres</w:t></w:r></w:ins>',
    );
    expect(doc(xml)).toBe('We chose Postgres');
  });

  it('drops field codes, which are instructions rather than prose', () => {
    const xml = para(
      run('See page '),
      '<w:r><w:instrText> PAGEREF _Ref123 \\h </w:instrText></w:r>',
      run('4'),
    );
    expect(doc(xml)).toBe('See page 4');
  });

  it('ignores markup that carries no text', () => {
    const xml = para('<w:proofErr w:type="spellStart"/>', run('teamctx'), '<w:proofErr w:type="spellEnd"/>');
    expect(doc(xml)).toBe('teamctx');
  });
});

describe('textFromDocumentXml', () => {
  it('is usable on its own, without a container', () => {
    expect(textFromDocumentXml(wordDocument(para(run('Direct'))))).toBe('Direct');
  });

  it('is empty rather than throwing on nothing at all', () => {
    expect(textFromDocumentXml('')).toBe('');
    expect(textFromDocumentXml(undefined)).toBe('');
  });
});

describe('against markup a real Word document produced', () => {
  // fixtures/real-word-document.xml is the body part lifted out of a genuine
  // .docx — not written by zip-fixture.js, and not written by anyone here. The
  // synthetic tests above prove the reader does what it intends; this one
  // proves Word does not do something it never anticipated.
  const xml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures/real-word-document.xml'),
    'utf-8',
  );
  const text = textFromDocumentXml(xml);

  it('recovers the prose', () => {
    expect(text.split('\n')[0]).toBe('Demonstration of DOCX support in calibre');
    expect(text.length).toBeGreaterThan(5000);
  });

  it('leaks no markup', () => {
    expect(text, 'an unclosed or unexpected element left a tag behind').not.toMatch(/<\/?w:/);
    expect(text, 'an entity was not decoded').not.toMatch(/&(amp|lt|gt|quot|apos);/);
  });

  it('leaks no field codes', () => {
    // This document really does contain instrText, so the rule is exercised by
    // Word's own output rather than only by a fixture written to suit it.
    expect(xml).toMatch(/instrText/);
    expect(text).not.toMatch(/PAGEREF|HYPERLINK|TOC \o/);
  });

  it('does not run paragraphs together or leave gaps', () => {
    expect(text).not.toMatch(/\n{3,}/);
    expect(text.split('\n').length).toBeGreaterThan(100);
  });
});
