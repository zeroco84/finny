import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { closeDb, one, openDb } from '../src/db/db.js';
import { seedDefaults } from '../src/services/settings.js';
import { ingestAttachment } from '../src/services/ingestion/ingest.js';

const saved = { max: config.attachmentMaxBytes, dir: config.attachmentsDir, webhook: config.alertWebhookUrl };
let tmpDir: string;

beforeEach(() => {
  closeDb();
  openDb(':memory:');
  seedDefaults();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finny-ingest-'));
  config.attachmentsDir = tmpDir;
  config.attachmentMaxBytes = 1024; // 1 KB cap for the test
  config.alertWebhookUrl = ''; // no outbound webhook
});
afterEach(() => {
  Object.assign(config, { attachmentMaxBytes: saved.max, attachmentsDir: saved.dir, alertWebhookUrl: saved.webhook });
});

describe('attachment size cap at ingest', () => {
  it('parks an oversized attachment as failed and never writes it to disk', async () => {
    const id = await ingestAttachment(Buffer.alloc(4096), 'huge.pdf', { source: 'test' });
    const row = one<{ status: string; extraction_error: string; attachment_path: string }>(
      `SELECT status, extraction_error, attachment_path FROM invoices WHERE id = ?`,
      id,
    )!;
    expect(row.status).toBe('extraction_failed');
    expect(row.extraction_error).toContain('too large');
    expect(fs.existsSync(row.attachment_path)).toBe(false); // never stored
  });

  it('ingests a normal-sized supported attachment into the queue', async () => {
    const id = await ingestAttachment(Buffer.from('%PDF-1.4 small'), 'ok.pdf', { source: 'test' });
    const row = one<{ status: string }>(`SELECT status FROM invoices WHERE id = ?`, id)!;
    expect(row.status).not.toBe('extraction_failed');
  });
});
