import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { newId } from '../../domain/util.js';
import { createInvoice } from '../invoices.js';
import { audit } from '../audit.js';
import { raiseAlert } from '../alerts.js';
import { run } from '../../db/db.js';
import { nowIso } from '../../domain/util.js';

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export interface IngestMeta {
  source: string;
  emailFrom?: string | null;
  emailSubject?: string | null;
  emailMessageId?: string | null;
  receivedAt?: string;
}

/**
 * Store an attachment and create the invoice record. Supported types enter
 * the extraction queue; anything else is parked as failed with an immediate
 * unreadable-attachment alert (spec: no invoice silently fails).
 */
export async function ingestAttachment(
  buffer: Buffer,
  filename: string,
  meta: IngestMeta,
): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  const safeName = path.basename(filename).replace(/[^\w.\- ]/g, '_');
  const storedPath = path.join(config.attachmentsDir, `${newId()}-${safeName}`);
  fs.writeFileSync(storedPath, buffer);

  const invoiceId = createInvoice({
    source: meta.source,
    email_from: meta.emailFrom ?? null,
    email_subject: meta.emailSubject ?? null,
    email_message_id: meta.emailMessageId ?? null,
    attachment_name: safeName,
    attachment_mime: mime,
    attachment_path: storedPath,
    attachment_size: buffer.byteLength,
    received_at: meta.receivedAt,
  });
  audit(invoiceId, 'received', 'system', {
    source: meta.source,
    from: meta.emailFrom ?? null,
    subject: meta.emailSubject ?? null,
    attachment: safeName,
  });

  if (!MIME_BY_EXT[ext]) {
    run(
      `UPDATE invoices SET status = 'extraction_failed', extraction_error = ?, updated_at = ? WHERE id = ?`,
      `Unsupported attachment type "${ext || 'no extension'}" — Finny accepts PDF, PNG and JPG`,
      nowIso(),
      invoiceId,
    );
    audit(invoiceId, 'extraction_failed', 'system', { error: `unsupported attachment type ${ext}` });
    await raiseAlert('unreadable_attachment', {
      invoiceId,
      attachmentName: safeName,
      error: `unsupported attachment type "${ext || 'none'}"`,
    });
  }
  return invoiceId;
}
