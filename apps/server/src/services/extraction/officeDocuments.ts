import { unzipSync } from 'fflate';
import { UnreadableDocumentError } from './extractor.js';

/**
 * Word-processor attachments: OpenDocument Text (.odt) and Office Open XML
 * (.docx). Suppliers send invoices as documents as well as PDFs and
 * spreadsheets — two real .odt invoices sat in the failed queue as
 * "unsupported type" before this existed.
 *
 * Both formats are a ZIP holding one XML file of content, so they share an
 * implementation. The extraction model reads neither natively, so the text is
 * pulled out here and passed as a text document, exactly as spreadsheets are.
 */

export const WORD_MIME_BY_EXT: Record<string, string> = {
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const WORD_MIMES = new Set(Object.values(WORD_MIME_BY_EXT));

/** The single entry worth reading in each format. */
const CONTENT_ENTRY: Record<string, string> = {
  'application/vnd.oasis.opendocument.text': 'content.xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word/document.xml',
};

// Untrusted ZIPs from a mailbox: the decompressed size is attacker-controlled,
// so the entry is rejected on its declared uncompressed size before any
// inflation happens, and only the one entry we need is decompressed at all.
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_CHARS = 80_000;

export function isWordDocument(mime: string): boolean {
  return WORD_MIMES.has(mime.toLowerCase());
}

function looksLikeZip(buffer: Buffer): boolean {
  if (buffer.byteLength < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false;
  const marker = (buffer[2] << 8) | buffer[3];
  return marker === 0x0304 || marker === 0x0506 || marker === 0x0708;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Ampersand last, so a literal "&amp;lt;" doesn't become "<".
    .replace(/&amp;/g, '&');
}

/**
 * XML to plain text, preserving the structure extraction actually depends on:
 * a newline per paragraph and per table row, a tab between table cells. Invoice
 * line items live in tables, so flattening cells together would run the
 * description, quantity and amount into one unreadable string.
 */
function xmlToText(xml: string): string {
  const text = xml
    // Drop anything that never carries visible content.
    .replace(/<office:(automatic-styles|font-face-decls|scripts)[\s\S]*?<\/office:\1>/g, '')
    .replace(/<w:(?:instrText|proofErr|bookmark[^>]*)\b[^>]*\/?>/g, '')
    // A cell's text is wrapped in its own paragraph. That paragraph-end must
    // not become a newline, or every cell lands on its own line and the row
    // structure — which is what makes line items readable — is destroyed.
    .replace(/<\/(?:text:p|text:h|w:p)>\s*(?=<\/(?:table:table-cell|w:tc)>)/g, '')
    // Cell boundaries next — they sit inside rows.
    .replace(/<\/(?:table:table-cell|w:tc)>/g, '\t')
    .replace(/<\/(?:table:table-row|w:tr)>/g, '\n')
    .replace(/<\/(?:text:p|text:h|w:p)>/g, '\n')
    .replace(/<(?:text:line-break|w:br)\s*\/?>/g, '\n')
    .replace(/<(?:text:tab|w:tab)\s*\/?>/g, '\t')
    .replace(/<text:s\s+text:c="(\d+)"\s*\/>/g, (_, n: string) => ' '.repeat(Math.min(Number(n), 40)))
    .replace(/<text:s\s*\/>/g, ' ')
    .replace(/<[^>]+>/g, '');

  return decodeEntities(text)
    .split('\n')
    // Trim each line but keep the tabs that carry the table columns.
    .map((line) => line.replace(/[  ]+/g, ' ').replace(/ *\t */g, '\t').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Render a .odt or .docx attachment as plain text. Throws
 * UnreadableDocumentError (→ failed queue with an actionable message) rather
 * than returning something empty.
 */
export function renderWordDocument(buffer: Buffer, mime: string): string {
  const normalized = mime.toLowerCase();
  const entryName = CONTENT_ENTRY[normalized];
  if (!entryName) throw new UnreadableDocumentError(`"${mime}" is not a word-processor document`);

  // Both formats are ZIP containers. Bytes that aren't a ZIP mean a corrupt or
  // truncated file — say so, rather than failing obscurely inside the unzip.
  if (!looksLikeZip(buffer)) {
    throw new UnreadableDocumentError(
      'The document is corrupt or was truncated in transit — ask the supplier to resend it.',
    );
  }

  let entry: Uint8Array | undefined;
  try {
    const files = unzipSync(buffer, {
      // Decompress only the content entry, and only if its declared
      // uncompressed size is sane — a zip bomb is refused before inflation.
      filter: (file) => file.name === entryName && file.originalSize <= MAX_ENTRY_BYTES,
    });
    entry = files[entryName];
  } catch (err) {
    throw new UnreadableDocumentError(
      `Document could not be read (${err instanceof Error ? err.message : 'corrupt file'})`,
    );
  }

  if (!entry) {
    throw new UnreadableDocumentError(
      `The document is missing its content (${entryName}), or that content is too large to read.`,
    );
  }

  const text = xmlToText(Buffer.from(entry).toString('utf8'));
  if (text.trim().length === 0) {
    throw new UnreadableDocumentError('The document has no readable text');
  }
  return text.length <= MAX_CHARS
    ? text
    : `${text.slice(0, MAX_CHARS)}\n\n[truncated — document exceeds the ${MAX_CHARS / 1000}k character extraction limit]`;
}
