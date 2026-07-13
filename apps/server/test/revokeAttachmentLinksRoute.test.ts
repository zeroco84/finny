import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { config } from '../src/config.js';
import { all, closeDb, openDb } from '../src/db/db.js';
import { createSessionCookie } from '../src/api/auth.js';
import { buildRouter } from '../src/api/routes.js';
import { buildAttachmentLink, redeemAttachmentToken } from '../src/services/attachmentLinks.js';

/**
 * Regression test for the revoke endpoint's position in the middleware chain.
 * It was once registered ABOVE `router.use(requireAuth)`, so req.user was never
 * populated and requireLead 403'd every caller — including a signed-in AP Lead.
 * These tests run the real router over HTTP, so a route registered outside the
 * auth gate fails them.
 */

const saved = { secret: config.sessionSecret, leads: config.leadEmails, appUrl: config.appUrl };
let server: Server;
let base: string;

const cookieFor = (user: { email: string; name: string; role: 'processor' | 'lead' }) =>
  createSessionCookie(user).split(';')[0];

const revoke = (invoiceId: string, cookie?: string) =>
  fetch(`${base}/api/invoices/${invoiceId}/revoke-attachment-links`, {
    method: 'POST',
    headers: cookie ? { cookie } : undefined,
  });

beforeEach(async () => {
  closeDb();
  openDb(':memory:');
  config.sessionSecret = 'test-secret';
  config.appUrl = 'https://finny.test';
  // readSession resolves the role live on every request; pin the lead in config
  // so the signed cookie's role survives the directory lookup.
  config.leadEmails = ['lead@example.com'];
  const app = express();
  app.use('/api', buildRouter());
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  config.sessionSecret = saved.secret;
  config.leadEmails = saved.leads;
  config.appUrl = saved.appUrl;
  await new Promise((resolve) => server.close(resolve));
  closeDb();
});

describe('POST /invoices/:id/revoke-attachment-links', () => {
  it('lets a signed-in AP Lead revoke links (route must sit behind requireAuth)', async () => {
    const link = buildAttachmentLink('inv-1', { scope: 'approver', approverId: 'app-1', createdBy: 'x' });
    const token = new URL(link).searchParams.get('t')!;

    const res = await revoke('inv-1', cookieFor({ email: 'lead@example.com', name: 'Lead', role: 'lead' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: 1 });

    // The link is dead and the revocation is on the audit trail.
    expect(redeemAttachmentToken(token)).toBeNull();
    const events = all<{ actor: string }>(
      `SELECT actor FROM audit_events WHERE type = 'attachment_links_revoked'`,
    );
    expect(events).toEqual([{ actor: 'lead@example.com' }]);
  });

  it('rejects anonymous callers with 401 and processors with 403, revoking nothing', async () => {
    buildAttachmentLink('inv-2', { scope: 'sage' });

    expect((await revoke('inv-2')).status).toBe(401);
    expect(
      (await revoke('inv-2', cookieFor({ email: 'proc@example.com', name: 'Proc', role: 'processor' }))).status,
    ).toBe(403);

    expect(all(`SELECT id FROM attachment_tokens WHERE revoked_at IS NULL`)).toHaveLength(1);
  });
});
