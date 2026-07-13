import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { all, closeDb, openDb } from '../src/db/db.js';
import {
  buildAttachmentLink,
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

  it('caps the TTL so a Sage link is no longer a decade-long capability', () => {
    config.attachmentLinkMaxTtlDays = 365;
    const t = tokenOf(buildAttachmentLink('inv-9', { scope: 'sage', ttlMs: 10 * 365 * 24 * 60 * 60 * 1000 }));
    const row = all<{ expires_at: string }>(`SELECT expires_at FROM attachment_tokens WHERE id = ?`, t)[0];
    const days = (new Date(row.expires_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThanOrEqual(365.001);
  });
});
