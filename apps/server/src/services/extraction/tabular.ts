import * as XLSX from 'xlsx';
import { UnreadableDocumentError } from './extractor.js';

/**
 * Spreadsheet and delimited-text attachments. Suppliers send invoices as
 * workbooks and CSV exports as readily as PDFs, and Finny used to park every
 * one of them in the failed queue as an unsupported type.
 *
 * The extraction model reads PDFs and images natively but not workbooks, so
 * these are converted to CSV text here and passed as a text document. The
 * conversion is deliberately lossy — formatting, formulas and styling are
 * dropped; only cell values matter for extraction.
 */

/** Extensions handled here, mapped to the MIME recorded at ingest. */
export const TABULAR_MIME_BY_EXT: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroenabled.12',
  '.xls': 'application/vnd.ms-excel',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
};

const TABULAR_MIMES = new Set(Object.values(TABULAR_MIME_BY_EXT));

/** Text formats we decode directly — no parser, so no parser attack surface. */
const PLAIN_TEXT_MIMES = new Set(['text/csv', 'text/tab-separated-values', 'text/plain']);

// Bounds. .xlsx and .ods are ZIP archives from an untrusted mailbox, so the
// decompressed size is attacker-controlled: a few KB of file can declare
// millions of rows. sheetRows caps the parse itself rather than trimming
// afterwards, so a decompression bomb is bounded before it is materialised.
const MAX_SHEETS = 12;
const MAX_ROWS_PER_SHEET = 1000;
const MAX_CHARS = 80_000;

/** Types whose bytes must actually be a ZIP archive. */
const ZIP_CONTAINER_MIMES = new Set([
  TABULAR_MIME_BY_EXT['.xlsx'],
  TABULAR_MIME_BY_EXT['.xlsm'],
  TABULAR_MIME_BY_EXT['.ods'],
]);

/** ZIP local-file (PK\x03\x04), empty-archive and spanned-archive signatures. */
function looksLikeZip(buffer: Buffer): boolean {
  if (buffer.byteLength < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false;
  const marker = (buffer[2] << 8) | buffer[3];
  return marker === 0x0304 || marker === 0x0506 || marker === 0x0708;
}

export function isTabular(mime: string): boolean {
  return TABULAR_MIMES.has(mime.toLowerCase());
}

function decodeText(buffer: Buffer): string {
  // Excel writes UTF-8 CSVs with a BOM; left in place it becomes part of the
  // first header cell and the model reads a corrupted column name.
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  return text.replace(/\r\n/g, '\n');
}

function truncate(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(0, MAX_CHARS)}\n\n[truncated — attachment exceeds the ${MAX_CHARS / 1000}k character extraction limit]`;
}

/**
 * Render a spreadsheet or delimited-text attachment as plain text for the
 * extractor. Throws UnreadableDocumentError (→ failed queue + alert, with a
 * message a human can act on) rather than returning something empty.
 */
export function renderTabular(buffer: Buffer, mime: string): string {
  const normalized = mime.toLowerCase();
  if (!isTabular(normalized)) {
    throw new UnreadableDocumentError(`"${mime}" is not a spreadsheet or text attachment`);
  }

  if (PLAIN_TEXT_MIMES.has(normalized)) {
    const text = decodeText(buffer);
    if (text.trim().length === 0) throw new UnreadableDocumentError('The attachment is empty');
    return truncate(text);
  }

  // .xlsx/.xlsm/.ods are ZIP containers. The parser is deliberately lenient —
  // handed bytes it doesn't recognise it falls back to reading them as plain
  // text and returns a one-cell sheet, so a truncated or corrupt workbook would
  // reach the model as plausible-looking garbage instead of being flagged. If
  // the extension promises a ZIP, require a ZIP.
  if (ZIP_CONTAINER_MIMES.has(normalized) && !looksLikeZip(buffer)) {
    throw new UnreadableDocumentError(
      'The spreadsheet is corrupt or was truncated in transit — ask the supplier to resend it.',
    );
  }

  let book: XLSX.WorkBook;
  try {
    book = XLSX.read(buffer, {
      type: 'buffer',
      sheetRows: MAX_ROWS_PER_SHEET,
      // Values only. Formulas are not evaluated (and would be a text-injection
      // vector), styling is irrelevant to extraction, and HTML generation is a
      // parser surface we have no use for.
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      cellDates: true,
    });
  } catch (err) {
    throw new UnreadableDocumentError(
      `Spreadsheet could not be read (${err instanceof Error ? err.message : 'corrupt file'})`,
    );
  }

  const names = (book.SheetNames ?? []).slice(0, MAX_SHEETS);
  const parts: string[] = [];
  for (const name of names) {
    const sheet = book.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim();
    if (!csv) continue;
    // A workbook often carries the invoice on one tab and notes or lookups on
    // others; label them so the model can tell which is which.
    parts.push(names.length > 1 ? `--- Sheet: ${name} ---\n${csv}` : csv);
  }

  if (parts.length === 0) {
    throw new UnreadableDocumentError('The spreadsheet has no readable cells');
  }
  const dropped = (book.SheetNames?.length ?? 0) - names.length;
  if (dropped > 0) parts.push(`[${dropped} further sheet(s) not read — over the ${MAX_SHEETS}-sheet limit]`);
  return truncate(parts.join('\n\n'));
}
