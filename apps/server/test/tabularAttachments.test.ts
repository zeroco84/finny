import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { closeDb, one, openDb } from '../src/db/db.js';
import { seedDefaults } from '../src/services/settings.js';
import { ingestAttachment } from '../src/services/ingestion/ingest.js';
import { buildAttachmentBlock } from '../src/services/extraction/anthropicExtractor.js';
import { isTabular, renderTabular } from '../src/services/extraction/tabular.js';
import { UnreadableDocumentError } from '../src/services/extraction/extractor.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet';

const INVOICE_ROWS = [
  ['Meadowvale Plant Hire Ltd'],
  ['Invoice No:', 'INV-4471'],
  ['Date:', '2026-07-28'],
  ['Description', 'Qty', 'Unit', 'Total'],
  ['Excavator hire (week)', 2, '450.00', '900.00'],
  ['Net', '', '', '900.00'],
  ['VAT @ 23%', '', '', '207.00'],
  ['Total', '', '', '1107.00'],
];

function workbook(rows: unknown[][], bookType: 'xlsx' | 'ods'): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Invoice');
  return XLSX.write(wb, { type: 'buffer', bookType }) as Buffer;
}

describe('isTabular', () => {
  it('recognises the spreadsheet and text types suppliers actually send', () => {
    for (const m of [XLSX_MIME, ODS_MIME, 'application/vnd.ms-excel', 'text/csv', 'text/plain']) {
      expect(isTabular(m), m).toBe(true);
    }
  });

  it('leaves the natively-readable types alone', () => {
    for (const m of ['application/pdf', 'image/png', 'image/jpeg']) {
      expect(isTabular(m), m).toBe(false);
    }
  });
});

describe('renderTabular', () => {
  it('renders an .xlsx invoice to text carrying the values that matter', () => {
    const text = renderTabular(workbook(INVOICE_ROWS, 'xlsx'), XLSX_MIME);
    expect(text).toContain('Meadowvale Plant Hire Ltd');
    expect(text).toContain('INV-4471');
    expect(text).toContain('1107.00');
  });

  it('renders an .ods invoice the same way', () => {
    const text = renderTabular(workbook(INVOICE_ROWS, 'ods'), ODS_MIME);
    expect(text).toContain('Meadowvale Plant Hire Ltd');
    expect(text).toContain('INV-4471');
  });

  it('reads CSV directly and strips the BOM Excel writes', () => {
    const csv = Buffer.from('﻿Vendor,Ref,Total\nMeadowvale,INV-9,120.00\n', 'utf8');
    const text = renderTabular(csv, 'text/csv');
    expect(text.startsWith('Vendor')).toBe(true); // BOM would corrupt the first header cell
    expect(text).toContain('INV-9');
  });

  it('labels each sheet in a multi-sheet workbook', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(INVOICE_ROWS), 'Invoice');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Note', 'internal']]), 'Notes');
    const text = renderTabular(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer, XLSX_MIME);
    expect(text).toContain('--- Sheet: Invoice ---');
    expect(text).toContain('--- Sheet: Notes ---');
  });

  it('bounds a workbook that declares far more rows than it should', () => {
    // .xlsx and .ods are ZIP archives from an untrusted mailbox: a few KB can
    // declare millions of rows. The row cap must apply during the parse.
    const rows = Array.from({ length: 20_000 }, (_, i) => [`row-${i}`, i]);
    const text = renderTabular(workbook(rows, 'xlsx'), XLSX_MIME);
    expect(text).toContain('row-0');
    expect(text).not.toContain('row-19999');
    expect(text.length).toBeLessThanOrEqual(81_000); // char cap + truncation marker
  });

  it('truncates oversized text with a visible marker rather than silently', () => {
    const big = Buffer.from('x'.repeat(200_000), 'utf8');
    const text = renderTabular(big, 'text/plain');
    expect(text).toContain('[truncated');
  });

  it('rejects an empty attachment with an actionable error', () => {
    expect(() => renderTabular(Buffer.from('   ', 'utf8'), 'text/csv')).toThrow(UnreadableDocumentError);
  });

  it('rejects a corrupt .xlsx instead of parsing it as one garbage cell', () => {
    // The parser falls back to reading unrecognised bytes as plain text, which
    // would send a truncated workbook to the model as plausible-looking data.
    expect(() => renderTabular(Buffer.from('not a workbook at all'), XLSX_MIME)).toThrow(
      /corrupt or was truncated/,
    );
  });

  it('rejects a truncated ZIP whose header survived', () => {
    expect(() => renderTabular(Buffer.from('PK\x03\x04 then nothing useful'), XLSX_MIME)).toThrow(
      UnreadableDocumentError,
    );
  });

  it('still accepts a .xls that is really delimited text, as Excel does', () => {
    // Suppliers rename CSV exports to .xls constantly; Excel opens them, so
    // the leniency is kept for the non-ZIP formats.
    const text = renderTabular(
      Buffer.from('Vendor\tRef\tTotal\nMeadowvale\tINV-3\t99.00\n'),
      'application/vnd.ms-excel',
    );
    expect(text).toContain('Meadowvale');
  });
});

describe('buildAttachmentBlock — spreadsheets reach the model as a document', () => {
  it('converts a workbook to a text document block, framed as untrusted data', () => {
    const block = buildAttachmentBlock(workbook(INVOICE_ROWS, 'xlsx'), XLSX_MIME) as {
      type: string;
      source: { type: string; media_type: string; data: string };
      context?: string;
    };
    expect(block.type).toBe('document');
    expect(block.source.type).toBe('text');
    expect(block.source.media_type).toBe('text/plain');
    expect(block.source.data).toContain('INV-4471');
    // The cells are supplier-controlled; the block must not read as instructions.
    expect(block.context).toMatch(/never an instruction/i);
  });

  it('still rejects a type nothing can read', () => {
    expect(() => buildAttachmentBlock(Buffer.from('x'), 'application/zip')).toThrow(
      UnreadableDocumentError,
    );
  });
});

describe('ingest — spreadsheet attachments enter the queue instead of the failed pile', () => {
  const saved = { dir: config.attachmentsDir, webhook: config.alertWebhookUrl };
  beforeEach(() => {
    closeDb();
    openDb(':memory:');
    seedDefaults();
    config.attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finny-tab-'));
    config.alertWebhookUrl = '';
  });
  afterEach(() => Object.assign(config, { attachmentsDir: saved.dir, alertWebhookUrl: saved.webhook }));

  it.each([
    ['invoice.xlsx', XLSX_MIME],
    ['invoice.ods', ODS_MIME],
    ['export.csv', 'text/csv'],
    ['ledger.xls', 'application/vnd.ms-excel'],
  ])('queues %s for extraction', async (filename, expectedMime) => {
    const id = await ingestAttachment(Buffer.from('Vendor,Total\nMeadowvale,10.00\n'), filename, {
      source: 'test',
    });
    const row = one<{ status: string; attachment_mime: string }>(
      'SELECT status, attachment_mime FROM invoices WHERE id = ?',
      id,
    )!;
    expect(row.status).toBe('received'); // was extraction_failed before spreadsheet support
    expect(row.attachment_mime).toBe(expectedMime);
  });

  it('still parks a genuinely unreadable type with an actionable message', async () => {
    const id = await ingestAttachment(Buffer.from('PK'), 'invoices.zip', { source: 'test' });
    const row = one<{ status: string; extraction_error: string }>(
      'SELECT status, extraction_error FROM invoices WHERE id = ?',
      id,
    )!;
    expect(row.status).toBe('extraction_failed');
    expect(row.extraction_error).toContain('spreadsheets');
  });
});
