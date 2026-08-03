import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { all, closeDb, getStatus, one, openDb } from '../src/db/db.js';
import { seedDefaults } from '../src/services/settings.js';
import { listAlerts } from '../src/services/alerts.js';
import { pollGraphMailbox } from '../src/services/ingestion/mailProviders.js';

const saved = {
  graph: { ...config.graph },
  attachmentsDir: config.attachmentsDir,
  webhook: config.alertWebhookUrl,
};

// Three messages, oldest first. The middle one is a poison pill: Graph keeps
// failing on its attachments, exactly like the stall that stopped ingestion.
const MESSAGES = [
  { id: 'msg-1', subject: 'Invoice 1001', receivedDateTime: '2026-07-10T09:00:00Z' },
  { id: 'msg-poison', subject: 'Invoice 1002', receivedDateTime: '2026-07-10T10:00:00Z' },
  { id: 'msg-3', subject: 'Invoice 1003', receivedDateTime: '2026-07-10T11:00:00Z' },
].map((m) => ({
  ...m,
  from: { emailAddress: { address: 'billing@supplier.example', name: 'Supplier' } },
  hasAttachments: true,
}));

const PDF = Buffer.from('%PDF-1.4 test invoice').toString('base64');

function attachmentsFor(id: string) {
  return {
    value: [
      {
        '@odata.type': '#microsoft.graph.fileAttachment',
        id: `att-${id}`,
        name: `${id}.pdf`,
        contentType: 'application/pdf',
        contentBytes: PDF,
        size: 21,
      },
    ],
  };
}

/** Graph stub: token + message list + per-message attachments (poison 500s). */
function stubGraph(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    if (u.includes('login.microsoftonline.com')) {
      return new Response(JSON.stringify({ access_token: 't0ken', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.includes('/mailFolders/inbox/messages')) {
      // The real poller filters on receivedDateTime gt watermark; the stall we
      // are testing is about the watermark never moving, so serve the full set
      // and let dedup/parking do the work.
      return new Response(JSON.stringify({ value: MESSAGES }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const attMatch = u.match(/\/messages\/([^/]+)\/attachments/);
    if (attMatch) {
      const id = attMatch[1];
      if (id === 'msg-poison') {
        return new Response('{"error":{"code":"InternalServerError"}}', { status: 500 });
      }
      return new Response(JSON.stringify(attachmentsFor(id)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (opts?.method === 'PATCH') return new Response('{}', { status: 200 });
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  closeDb();
  openDb(':memory:');
  seedDefaults();
  Object.assign(config.graph, {
    tenantId: 'tenant-1',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    mailbox: 'ap@example.com',
    markRead: false,
    backfillDays: 0,
  });
  config.attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finny-mailpoll-'));
  config.alertWebhookUrl = ''; // stored only, no outbound post
  stubGraph();
});

afterEach(() => {
  Object.assign(config.graph, saved.graph);
  config.attachmentsDir = saved.attachmentsDir;
  config.alertWebhookUrl = saved.webhook;
  vi.unstubAllGlobals();
});

const ingestedRefs = () =>
  all<{ email_message_id: string }>('SELECT email_message_id FROM invoices').map(
    (r) => r.email_message_id,
  );

describe('graph mailbox poll — one bad message never stops the mailbox', () => {
  it('ingests the messages behind a failing one on the very first poll', async () => {
    await pollGraphMailbox();

    // The old poller aborted the batch on the poison message, so msg-3 (which
    // arrived AFTER it) was never seen — that is how a July invoice stopped
    // every invoice behind it.
    expect(ingestedRefs()).toContain('msg-1');
    expect(ingestedRefs()).toContain('msg-3');
    expect(ingestedRefs()).not.toContain('msg-poison');
  });

  it('holds the watermark while the failing message still has retries left', async () => {
    await pollGraphMailbox();

    // Only msg-1 is a finished prefix; msg-poison is owed retries, so the
    // watermark must not skip past it and lose it.
    expect(getStatus('graph_mail_watermark')).toBe('2026-07-10T09:00:00Z');
    const failure = one<{ attempts: number; parked: number; last_error: string }>(
      'SELECT attempts, parked, last_error FROM mail_message_failures WHERE message_id = ?',
      'msg-poison',
    )!;
    expect(failure.attempts).toBe(1);
    expect(failure.parked).toBe(0);
    expect(failure.last_error).toContain('500');
  });

  it('parks the message after the retry budget, alerts, and releases the watermark', async () => {
    await pollGraphMailbox();
    await pollGraphMailbox();
    await pollGraphMailbox(); // third attempt spends the budget

    const failure = one<{ attempts: number; parked: number }>(
      'SELECT attempts, parked FROM mail_message_failures WHERE message_id = ?',
      'msg-poison',
    )!;
    expect(failure.attempts).toBe(3);
    expect(failure.parked).toBe(1);

    // Watermark is free to move past the parked message to the newest mail.
    expect(getStatus('graph_mail_watermark')).toBe('2026-07-10T11:00:00Z');
    expect(getStatus('mail_last_error')).toBeNull();

    const alert = listAlerts().find((a) => a.type === 'mail_message_failed');
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe('critical');
    expect(alert!.subject).toContain('Invoice 1002');
    expect(alert!.message).toContain('billing@supplier.example');
  });

  it('does not re-ingest or re-attempt a message once it is finished', async () => {
    await pollGraphMailbox();
    const afterFirst = ingestedRefs().length;
    await pollGraphMailbox();
    await pollGraphMailbox();
    await pollGraphMailbox(); // one poll past parking

    expect(ingestedRefs().length).toBe(afterFirst); // no duplicate invoices
    const failure = one<{ attempts: number }>(
      'SELECT attempts FROM mail_message_failures WHERE message_id = ?',
      'msg-poison',
    )!;
    expect(failure.attempts).toBe(3); // parked, so never retried again
  });
});

describe('graph mailbox poll — failures are never silent', () => {
  it('alerts on a non-auth poll failure, not just on auth errors', async () => {
    // Whole-mailbox failure: listing the inbox itself 500s.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('login.microsoftonline.com')) {
          return new Response(JSON.stringify({ access_token: 't0ken', expires_in: 3600 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('{"error":{"code":"ServiceUnavailable"}}', { status: 503 });
      }),
    );

    await pollGraphMailbox();

    expect(getStatus('mail_last_error')).toContain('503');
    const alert = listAlerts().find((a) => a.type === 'mailbox_auth_failure');
    expect(alert).toBeDefined();
    expect(alert!.subject).toContain('NOT being ingested');
  });
});
