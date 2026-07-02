import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Tokenized, expiring links to an invoice attachment — so approving managers
 * (who are not Finny users) can view the invoice straight from the Teams
 * approval card. Stateless: the URL carries an expiry and an HMAC over
 * (invoice id + expiry) keyed by the session secret, so there is nothing to
 * store or clean up. Rotating SESSION_SECRET invalidates outstanding links.
 */

export const APPROVAL_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function sign(invoiceId: string, exp: number): string {
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`attachment:${invoiceId}:${exp}`)
    .digest('base64url');
}

export function buildAttachmentLink(invoiceId: string, ttlMs = APPROVAL_LINK_TTL_MS): string {
  const exp = Date.now() + ttlMs;
  return `${config.appUrl}/api/public/invoices/${invoiceId}/attachment?exp=${exp}&sig=${sign(invoiceId, exp)}`;
}

export function verifyAttachmentToken(
  invoiceId: string,
  exp: string | undefined,
  sig: string | undefined,
): boolean {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now()) return false;
  if (typeof sig !== 'string' || sig.length === 0) return false;
  const provided = Buffer.from(sig);
  const expected = Buffer.from(sign(invoiceId, expNum));
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}
