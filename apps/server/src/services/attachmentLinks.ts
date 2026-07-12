import crypto from 'node:crypto';
import { config } from '../config.js';
import { one, run } from '../db/db.js';
import { nowIso } from '../domain/util.js';
import { audit } from './audit.js';

/**
 * Attachment links let an approving manager (not a Finny user) view an invoice
 * from the Teams approval card, and let Sage store a link to the source
 * document. Each link is a random, single-purpose bearer token recorded in the
 * attachment_tokens table — so a link can be revoked individually (without
 * rotating the session secret), every open is logged with the caller's IP, its
 * lifetime is capped, and it is bound to one invoice (and, for approval links,
 * one approver). This replaces the previous stateless HMAC links, whose only
 * kill switch was rotating the global secret and whose Sage variant lived for
 * ten years.
 */

export const APPROVAL_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000; // approver review window

function maxTtlMs(): number {
  return config.attachmentLinkMaxTtlDays * 24 * 60 * 60 * 1000;
}

export interface AttachmentLinkOptions {
  scope: 'approver' | 'sage';
  /** For scope 'approver', the routed approver the link is issued to. */
  approverId?: string | null;
  createdBy?: string | null;
  ttlMs?: number;
}

/** Mint a link (and persist its token). Approver links default to 14 days;
 * Sage links default to — and every link is capped at — the configured max. */
export function buildAttachmentLink(invoiceId: string, opts: AttachmentLinkOptions): string {
  const requested = opts.ttlMs ?? (opts.scope === 'sage' ? maxTtlMs() : APPROVAL_LINK_TTL_MS);
  const ttl = Math.min(requested, maxTtlMs());
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttl).toISOString();
  run(
    `INSERT INTO attachment_tokens (id, invoice_id, scope, approver_id, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    token,
    invoiceId,
    opts.scope,
    opts.approverId ?? null,
    opts.createdBy ?? null,
    nowIso(),
    expiresAt,
  );
  return `${config.appUrl}/api/public/invoices/${invoiceId}/attachment?t=${token}`;
}

/**
 * Validate a presented token and, if good, log the access and return its
 * invoice id. Returns null for unknown / revoked / expired tokens — the token
 * is the sole source of truth, so the invoice id in the URL path is not trusted.
 */
export function redeemAttachmentToken(
  token: string | undefined,
  access: { ip?: string | null; ua?: string | null } = {},
): { invoiceId: string } | null {
  if (!token) return null;
  const row = one<Record<string, unknown>>('SELECT * FROM attachment_tokens WHERE id = ?', token);
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(String(row.expires_at)).getTime() < Date.now()) return null;
  const invoiceId = String(row.invoice_id);
  audit(invoiceId, 'attachment_link_viewed', 'public-link', {
    scope: row.scope,
    approver_id: row.approver_id ?? null,
    ip: access.ip ?? null,
    user_agent: (access.ua ?? '').slice(0, 200) || null,
  });
  return { invoiceId };
}

/** Revoke every outstanding link for an invoice (e.g. a leaked or superseded one). */
export function revokeAttachmentLinks(invoiceId: string, who: string): number {
  const res = run(
    `UPDATE attachment_tokens SET revoked_at = ? WHERE invoice_id = ? AND revoked_at IS NULL`,
    nowIso(),
    invoiceId,
  );
  const count = Number(res.changes);
  if (count) audit(invoiceId, 'attachment_links_revoked', who, { count });
  return count;
}
