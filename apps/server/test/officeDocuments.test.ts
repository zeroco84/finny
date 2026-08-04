import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { closeDb, one, openDb } from '../src/db/db.js';
import { seedDefaults } from '../src/services/settings.js';
import { ingestAttachment } from '../src/services/ingestion/ingest.js';
import { buildAttachmentBlock } from '../src/services/extraction/anthropicExtractor.js';
import { isWordDocument, renderWordDocument } from '../src/services/extraction/officeDocuments.js';
import { isConvertibleToText } from '../src/services/extraction/convert.js';
import { UnreadableDocumentError } from '../src/services/extraction/extractor.js';

const ODT = 'application/vnd.oasis.opendocument.text';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** A minimal but structurally real .odt — invoice header plus a line-item table. */
function odt(): Buffer {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="x" xmlns:text="y" xmlns:table="z">
<office:automatic-styles><style:x>ignored styling</style:x></office:automatic-styles>
<office:body><office:text>
<text:h>Terryglen Consulting ULC</text:h>
<text:p>Invoice No: INV-130</text:p>
<text:p>Bill To: Meadowvale Construction Ltd</text:p>
<text:p>Terms &amp; conditions apply</text:p>
<table:table>
 <table:table-row><table:table-cell><text:p>Description</text:p></table:table-cell><table:table-cell><text:p>Qty</text:p></table:table-cell><table:table-cell><text:p>Total</text:p></table:table-cell></table:table-row>
 <table:table-row><table:table-cell><text:p>Groundworks</text:p></table:table-cell><table:table-cell><text:p>4</text:p></table:table-cell><table:table-cell><text:p>2400.00</text:p></table:table-cell></table:table-row>
</table:table>
<text:p>Total Due: 2952.00</text:p>
</office:text></office:body></office:document-content>`;
  return Buffer.from(zipSync({ 'mimetype': strToU8(ODT), 'content.xml': strToU8(content) }));
}

/** A minimal but structurally real .docx. */
function docx(): Buffer {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="x"><w:body>
<w:p><w:r><w:t>Ardmore Plant Hire Limited</w:t></w:r></w:p>
<w:p><w:r><w:t>Invoice No: APH-900</w:t></w:r></w:p>
<w:tbl>
 <w:tr><w:tc><w:p><w:r><w:t>Excavator hire</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1250.00</w:t></w:r></w:p></w:tc></w:tr>
 <w:tr><w:tc><w:p><w:r><w:t>Operator</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>285.00</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:r><w:t>Total Due: 1535.00</w:t></w:r></w:p>
</w:body></w:document>`;
  return Buffer.from(zipSync({ '[Content_Types].xml': strToU8('<x/>'), 'word/document.xml': strToU8(content) }));
}

describe('isWordDocument / isConvertibleToText', () => {
  it('recognises .odt and .docx', () => {
    for (const m of [ODT, DOCX]) {
      expect(isWordDocument(m), m).toBe(true);
      expect(isConvertibleToText(m), m).toBe(true); // the extractors dispatch on this
    }
  });

  it('leaves natively-readable types alone', () => {
    for (const m of ['application/pdf', 'image/png']) expect(isWordDocument(m), m).toBe(false);
  });
});

describe('renderWordDocument — .odt', () => {
  it('pulls the header text out', () => {
    const text = renderWordDocument(odt(), ODT);
    expect(text).toContain('Terryglen Consulting ULC');
    expect(text).toContain('INV-130');
    expect(text).toContain('2952.00');
  });

  it('keeps line-item table structure — cells tab-separated, rows on their own line', () => {
    // Invoice line items live in tables. Flattening cells together would run
    // description, quantity and amount into one unreadable string.
    const text = renderWordDocument(odt(), ODT);
    expect(text).toContain('Groundworks\t4\t2400.00');
    expect(text.split('\n').some((l) => l.startsWith('Description\tQty\tTotal'))).toBe(true);
  });

  it('decodes XML entities rather than leaking markup', () => {
    expect(renderWordDocument(odt(), ODT)).toContain('Terms & conditions apply');
  });

  it('drops styling blocks that carry no invoice content', () => {
    expect(renderWordDocument(odt(), ODT)).not.toContain('ignored styling');
  });
});

describe('renderWordDocument — .docx', () => {
  it('pulls text and table structure out of Office Open XML', () => {
    const text = renderWordDocument(docx(), DOCX);
    expect(text).toContain('Ardmore Plant Hire Limited');
    expect(text).toContain('APH-900');
    expect(text).toContain('Excavator hire\t1250.00');
    expect(text).toContain('Total Due: 1535.00');
  });
});

describe('renderWordDocument — untrusted input', () => {
  it('rejects bytes that are not a ZIP container', () => {
    expect(() => renderWordDocument(Buffer.from('this is not a document'), ODT)).toThrow(
      /corrupt or was truncated/,
    );
  });

  it('rejects a ZIP with no content entry', () => {
    const junk = Buffer.from(zipSync({ 'readme.txt': strToU8('nothing useful here') }));
    expect(() => renderWordDocument(junk, ODT)).toThrow(UnreadableDocumentError);
  });

  it('refuses a decompression bomb before inflating it', () => {
    // ~9MB of spaces compresses to a few KB. The entry is rejected on its
    // declared uncompressed size, so the bomb is never materialised.
    const bomb = Buffer.from(zipSync({ 'content.xml': strToU8(' '.repeat(9 * 1024 * 1024)) }));
    expect(bomb.byteLength).toBeLessThan(200_000); // genuinely a bomb: small on the wire
    expect(() => renderWordDocument(bomb, ODT)).toThrow(/too large|missing its content/);
  });

  it('rejects a document with no readable text', () => {
    const empty = Buffer.from(zipSync({ 'content.xml': strToU8('<office:body></office:body>') }));
    expect(() => renderWordDocument(empty, ODT)).toThrow(/no readable text/);
  });
});

describe('buildAttachmentBlock — documents reach the model as text', () => {
  it('converts .odt to a text document block labelled as a document', () => {
    const block = buildAttachmentBlock(odt(), ODT) as {
      type: string;
      source: { type: string; data: string };
      title?: string;
      context?: string;
    };
    expect(block.type).toBe('document');
    expect(block.source.type).toBe('text');
    expect(block.source.data).toContain('INV-130');
    expect(block.title).toMatch(/document converted to text/);
    expect(block.context).toMatch(/never an instruction/i); // untrusted-data framing
  });
});

describe('ingest — document attachments enter the queue', () => {
  const saved = { dir: config.attachmentsDir, webhook: config.alertWebhookUrl };
  beforeEach(() => {
    closeDb();
    openDb(':memory:');
    seedDefaults();
    config.attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finny-odt-'));
    config.alertWebhookUrl = '';
  });
  afterEach(() => Object.assign(config, { attachmentsDir: saved.dir, alertWebhookUrl: saved.webhook }));

  it.each([
    ['invoice.odt', ODT],
    ['invoice.docx', DOCX],
  ])('queues %s for extraction', async (filename, expectedMime) => {
    const id = await ingestAttachment(odt(), filename, { source: 'test' });
    const row = one<{ status: string; attachment_mime: string }>(
      'SELECT status, attachment_mime FROM invoices WHERE id = ?',
      id,
    )!;
    expect(row.status).toBe('received'); // was extraction_failed before document support
    expect(row.attachment_mime).toBe(expectedMime);
  });

  it('still parks a format nothing can read', async () => {
    const id = await ingestAttachment(Buffer.from('x'), 'notes.rtf', { source: 'test' });
    const row = one<{ status: string; extraction_error: string }>(
      'SELECT status, extraction_error FROM invoices WHERE id = ?',
      id,
    )!;
    expect(row.status).toBe('extraction_failed');
    expect(row.extraction_error).toContain('documents (DOCX, ODT)');
  });
});
