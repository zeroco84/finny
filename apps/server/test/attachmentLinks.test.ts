import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { all, closeDb, openDb, run } from '../src/db/db.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAttachmentLink,
  hashAttachmentToken,
  redeemAttachmentToken,
  revokeAttachmentLinks,
} from '../src/services/attachmentLinks.js';

const tokenOf = (link: string) => new URL(link).searchParams.get('t')!;

beforeEach(() => {
  closeDb();
  openDb(':memory:');
  config.appUrl = 'https://finny.test';
  config.attachmentLinkMaxTtlDays = 365;
});
afterEach(() => closeDb());

describe('revocable attachment links', () => {
  it('mints an opaque token bound to the invoice, redeems it, and logs the access', () => {
    const link = buildAttachmentLink('inv-123', { scope: 'approver', approverId: 'app-1', createdBy: 'lead@x' });
    expect(link).toContain('/api/public/invoices/inv-123/attachment?t=');
    const t = tokenOf(link);
    expect(t.length).toBeGreaterThan(20);
    // The invoice id is not derivable from the token — no enumeration/forgery.
    expect(t).not.toContain('inv-123');

    expect(redeemAttachmentToken(t, { ip: '1.2.3.4', ua: 'Chrome' })).toEqual({ invoiceId: 'inv-123' });

    const log = all<{ detail: string }>(`SELECT detail FROM audit_events WHERE type = 'attachment_link_viewed'`);
    expect(log.length).toBe(1);
    expect(JSON.parse(log[0].detail).ip).toBe('1.2.3.4');
  });

  it('rejects unknown, expired and revoked tokens', () => {
    expect(redeemAttachmentToken('nope')).toBeNull();
    expect(redeemAttachmentToken(undefined)).toBeNull();

    const expired = tokenOf(buildAttachmentLink('inv-1', { scope: 'approver', ttlMs: -1000 }));
    expect(redeemAttachmentToken(expired)).toBeNull();

    const t = tokenOf(buildAttachmentLink('inv-2', { scope: 'approver' }));
    expect(redeemAttachmentToken(t)).toEqual({ invoiceId: 'inv-2' });
    expect(revokeAttachmentLinks('inv-2', 'lead@x')).toBe(1);
    expect(redeemAttachmentToken(t)).toBeNull(); // revoked links stop working immediately
  });

  it('stores only a digest of the token, so a copy of the database is not a copy of every link', () => {
    const t = tokenOf(buildAttachmentLink('inv-5', { scope: 'approver' }));
    const ids = all<{ id: string }>('SELECT id FROM attachment_tokens').map((r) => r.id);
    expect(ids).toEqual([hashAttachmentToken(t)]);
    expect(ids[0]).not.toBe(t);
    expect(ids[0]).toMatch(/^[0-9a-f]{64}$/);
    // Presenting the stored digest as if it were the token gets nothing.
    expect(redeemAttachmentToken(ids[0])).toBeNull();
    expect(redeemAttachmentToken(t)).toEqual({ invoiceId: 'inv-5' });
  });

  it('hashes plaintext tokens from older deployments in place, so links already handed out keep working', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finny-tokens-'));
    const file = path.join(dir, 'finny.db');
    closeDb();
    openDb(file);
    const legacy = 'legacy-plaintext-token-from-a-teams-card';
    run(
      `INSERT INTO attachment_tokens (id, invoice_id, scope, created_at, expires_at) VALUES (?, 'inv-old', 'approver', ?, ?)`,
      legacy, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString(),
    );
    closeDb();
    openDb(file); // migration runs on open
    expect(all<{ id: string }>('SELECT id FROM attachment_tokens').map((r) => r.id)).toEqual([hashAttachmentToken(legacy)]);
    expect(redeemAttachmentToken(legacy)).toEqual({ invoiceId: 'inv-old' });
    closeDb();
    openDb(file); // idempotent: a digest is not re-hashed
    expect(redeemAttachmentToken(legacy)).toEqual({ invoiceId: 'inv-old' });
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('caps the TTL so a Sage link is no longer a decade-long capability', () => {
    config.attachmentLinkMaxTtlDays = 365;
    const t = tokenOf(buildAttachmentLink('inv-9', { scope: 'sage', ttlMs: 10 * 365 * 24 * 60 * 60 * 1000 }));
    const row = all<{ expires_at: string }>(`SELECT expires_at FROM attachment_tokens WHERE id = ?`, hashAttachmentToken(t))[0];
    const days = (new Date(row.expires_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThanOrEqual(365.001);
  });
});
