import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import {
  APPROVAL_LINK_TTL_MS,
  buildAttachmentLink,
  verifyAttachmentToken,
} from '../src/services/attachmentLinks.js';

function parts(link: string): { id: string; exp: string; sig: string } {
  const url = new URL(link);
  const id = url.pathname.match(/invoices\/([^/]+)\/attachment/)![1];
  return { id, exp: url.searchParams.get('exp')!, sig: url.searchParams.get('sig')! };
}

describe('tokenized attachment links', () => {
  beforeAll(() => {
    config.sessionSecret = 'test-secret';
    config.appUrl = 'https://finny.test';
  });

  it('round-trips a valid link with a ~14 day expiry', () => {
    const link = buildAttachmentLink('inv-123');
    const { id, exp, sig } = parts(link);
    expect(id).toBe('inv-123');
    expect(Number(exp)).toBeGreaterThan(Date.now() + APPROVAL_LINK_TTL_MS - 60_000);
    expect(Number(exp)).toBeLessThanOrEqual(Date.now() + APPROVAL_LINK_TTL_MS);
    expect(verifyAttachmentToken(id, exp, sig)).toBe(true);
  });

  it('rejects expired links', () => {
    const link = buildAttachmentLink('inv-123', -1000);
    const { id, exp, sig } = parts(link);
    expect(verifyAttachmentToken(id, exp, sig)).toBe(false);
  });

  it('rejects tampered signatures, swapped invoices and shifted expiries', () => {
    const link = buildAttachmentLink('inv-123');
    const { exp, sig } = parts(link);
    expect(verifyAttachmentToken('inv-123', exp, sig.slice(0, -2) + 'xx')).toBe(false);
    expect(verifyAttachmentToken('inv-999', exp, sig)).toBe(false); // token bound to invoice
    expect(verifyAttachmentToken('inv-123', String(Number(exp) + 86_400_000), sig)).toBe(false);
  });

  it('rejects missing or junk parameters', () => {
    expect(verifyAttachmentToken('inv-123', undefined, undefined)).toBe(false);
    expect(verifyAttachmentToken('inv-123', 'soon', 'sig')).toBe(false);
    expect(verifyAttachmentToken('inv-123', String(Date.now() + 1000), '')).toBe(false);
  });
});
