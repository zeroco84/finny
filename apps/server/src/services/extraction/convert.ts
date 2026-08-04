import { isTabular, renderTabular, TABULAR_MIME_BY_EXT } from './tabular.js';
import { isWordDocument, renderWordDocument, WORD_MIME_BY_EXT } from './officeDocuments.js';

/**
 * Attachments the extraction model cannot read natively, converted to text
 * before it sees them: spreadsheets and delimited text (tabular.ts) and
 * word-processor documents (officeDocuments.ts). PDFs and images are passed
 * through untouched — the model reads those directly.
 *
 * One entry point so the extractors and the document-steering check all agree
 * on what is convertible; a format supported in one place and not another is
 * how an attachment silently goes missing.
 */

/** Extension → MIME for every convertible format, for the ingest MIME map. */
export const CONVERTIBLE_MIME_BY_EXT: Record<string, string> = {
  ...TABULAR_MIME_BY_EXT,
  ...WORD_MIME_BY_EXT,
};

export function isConvertibleToText(mime: string): boolean {
  return isTabular(mime) || isWordDocument(mime);
}

/** Throws UnreadableDocumentError when the attachment cannot be read. */
export function convertToText(buffer: Buffer, mime: string): string {
  return isTabular(mime) ? renderTabular(buffer, mime) : renderWordDocument(buffer, mime);
}

/** How the converted text is described to the model. */
export function convertedDocumentTitle(mime: string): string {
  return isTabular(mime)
    ? 'Supplier attachment (spreadsheet converted to CSV)'
    : 'Supplier attachment (document converted to text)';
}
