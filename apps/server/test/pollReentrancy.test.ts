import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { all, closeDb, getStatus, one, openDb, run } from '../src/db/db.js';
import { seedDefaults } from '../src/services/settings.js';
import { nowIso } from '../src/domain/util.js';
import { pollMail } from '../src/services/ingestion/mailProviders.js';
import { pollGraphApprovals } from '../src/services/approvals/approvals.js';

/**
 * setInterval fires on its own schedule, so a poll that runs longer than the
 * interval used to have the next tick start on top of it: duplicate Graph
 * traffic and two writers racing the same watermark / status keys. Both pollers
 * now skip a tick that lands on a still-running poll.
 *
 * Each test drives that overlap deterministically — a gate holds the first poll
 * inside a Graph call while the later ticks are fired — instead of leaning on
 * timing.
 */

const saved = {
  graph: { ...config.graph },
  mailProvider: config.mailProvider,
  approvalsProvider: config.approvalsProvider,
  attachmentsDir: config.attachmentsDir,
  inboxDir: config.inboxDir,
  webhook: config.alertWebhookUrl,
};

/** A latch a stubbed fetch can block on, and the test can watch and release. */
function gate() {
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => (markEntered = r));
  const released = new Promise<void>((r) => (release = r));
  return {
    /** Resolves once a caller is blocked inside the gate. */
    entered,
    /** Lets every blocked caller through. */
    open: () => release(),
    /** Called from the stub: park here until the test opens the gate. */
    wait: async () => {
      markEntered();
      await released;
    },
  };
}

const MESSAGE = {
  id: 'msg-1',
  subject: 'Invoice 1001',
  receivedDateTime: '2026-07-10T09:00:00Z',
  from: { emailAddress: { address: 'billing@supplier.example', name: 'Supplier' } },
  hasAttachments: true,
};

const ATTACHMENTS = {
  value: [
    {
      '@odata.type': '#microsoft.graph.fileAttachment',
      id: 'att-1',
      name: 'msg-1.pdf',
      contentType: 'application/pdf',
      contentBytes: Buffer.from('%PDF-1.4 test invoice').toString('base64'),
      size: 21,
    },
  ],
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const TOKEN_OK = () => json({ access_token: 't0ken', expires_in: 3600 });

/**
 * Graph mail stub. `hold`, if given, blocks the attachment read — the slow part
 * of a real poll — so the poll can be caught mid-flight.
 */
function stubGraphMail(hold?: ReturnType<typeof gate>) {
  const counts = { list: 0, attachments: 0 };
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('login.microsoftonline.com')) return TOKEN_OK();
    if (u.includes('/mailFolders/inbox/messages')) {
      counts.list += 1;
      return json({ value: [MESSAGE] });
    }
    if (/\/messages\/[^/]+\/attachments/.test(u)) {
      counts.attachments += 1;
      if (hold) await hold.wait();
      return json(ATTACHMENTS);
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return counts;
}

const invoiceCount = () => all('SELECT id FROM invoices').length;

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
  config.mailProvider = 'graph';
  config.attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finny-reentrancy-'));
  config.inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finny-reentrancy-inbox-'));
  config.alertWebhookUrl = ''; // stored only, no outbound post
});

afterEach(() => {
  Object.assign(config, {
    mailProvider: saved.mailProvider,
    approvalsProvider: saved.approvalsProvider,
    attachmentsDir: saved.attachmentsDir,
    inboxDir: saved.inboxDir,
    alertWebhookUrl: saved.webhook,
  });
  Object.assign(config.graph, saved.graph);
  vi.unstubAllGlobals();
});

describe('pollMail — overlapping ticks are skipped, not stacked', () => {
  it('does not start a second poll while one is in flight', async () => {
    const hold = gate();
    const counts = stubGraphMail(hold);

    const inFlight = pollMail();
    await hold.entered; // the first poll is parked inside a Graph call

    await pollMail(); // tick 2
    await pollMail(); // tick 3

    // Both later ticks returned without touching Graph — unguarded, each would
    // have listed the mailbox again off the same stale watermark.
    expect(counts.list).toBe(1);
    expect(counts.attachments).toBe(1);

    hold.open();
    await inFlight;

    expect(counts.list).toBe(1);
    expect(invoiceCount()).toBe(1); // and no duplicate invoice from the pile-up
    expect(getStatus('graph_mail_watermark')).toBe('2026-07-10T09:00:00Z');
  });

  it('polls again on the next tick once the previous poll has finished', async () => {
    const counts = stubGraphMail();

    await pollMail();
    await pollMail();

    // The guard is a skip, not a latch: it must clear when the poll returns.
    expect(counts.list).toBe(2);
    expect(invoiceCount()).toBe(1); // second poll dedupes the same message
  });

  it('clears the guard when a poll throws, so one bad poll cannot wedge the poller', async () => {
    config.mailProvider = 'mock';
    closeDb(); // any unexpected failure inside the poll — here, no database

    await expect(pollMail()).rejects.toThrow(/Database not opened/);

    openDb(':memory:');
    seedDefaults();
    await pollMail();

    expect(getStatus('mail_last_poll')).not.toBeNull();
  });
});

describe('pollGraphApprovals — overlapping ticks are skipped, not stacked', () => {
  beforeEach(() => {
    config.approvalsProvider = 'graph';
    run(
      `INSERT INTO approval_requests (id, invoice_id, approver_id, provider, external_id, status, created_at)
       VALUES (?, ?, ?, 'graph', ?, 'pending', ?)`,
      'req-1',
      'inv-1',
      'approver-1',
      'approval-item-1',
      nowIso(),
    );
  });

  it('does not start a second poll while one is in flight', async () => {
    const hold = gate();
    let itemCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('login.microsoftonline.com')) return TOKEN_OK();
        itemCalls += 1;
        await hold.wait();
        return json({ id: 'approval-item-1', state: 'completed', result: 'Approved' });
      }),
    );

    const inFlight = pollGraphApprovals();
    await hold.entered;

    await pollGraphApprovals(); // tick 2
    await pollGraphApprovals(); // tick 3

    expect(itemCalls).toBe(1);

    hold.open();
    await inFlight;

    expect(itemCalls).toBe(1);
    expect(one<{ status: string }>('SELECT status FROM approval_requests WHERE id = ?', 'req-1')!.status).toBe(
      'approved',
    );
  });

  it('polls again on the next tick once the previous poll has finished', async () => {
    let itemCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('login.microsoftonline.com')) return TOKEN_OK();
        itemCalls += 1;
        return json({ id: 'approval-item-1', state: 'pending' });
      }),
    );

    await pollGraphApprovals();
    await pollGraphApprovals();

    expect(itemCalls).toBe(2);
    expect(getStatus('approvals_last_poll')).not.toBeNull();
  });
});
