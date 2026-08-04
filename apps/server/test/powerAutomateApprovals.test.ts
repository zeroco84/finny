import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { all, closeDb, one, openDb, run } from '../src/db/db.js';
import { seedDefaults } from '../src/services/settings.js';
import { createApprovalRequest } from '../src/services/approvals/approvals.js';
import { approvalCallbackUrl, approvalsFlowInfo, sendApprovalToFlow } from '../src/services/approvals/powerAutomate.js';
import { buildRouter } from '../src/api/routes.js';

const FLOW_URL = 'https://prod-12.westeurope.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=SECRET';
const saved = {
  provider: config.approvalsProvider,
  flow: config.approvalsFlowUrl,
  token: config.approvalsCallbackToken,
  callbackBase: config.approvalsCallbackBaseUrl,
  appUrl: config.appUrl,
};

function seedInvoiceAndApprover(): { invoiceId: string; approverId: string } {
  const now = new Date('2026-08-04T09:00:00Z').toISOString();
  run(
    `INSERT INTO invoices (id, source, attachment_name, attachment_mime, attachment_path, attachment_size,
       status, vendor_name, invoice_ref, gross_cents, category, po_number, received_at, created_at, updated_at)
     VALUES ('inv-1','test','a.pdf','application/pdf','/tmp/a.pdf',10,'confirmed','Meadowvale Ltd','INV-77',
       110700,'Materials','PO-9',?,?,?)`,
    now, now, now,
  );
  run(
    `INSERT INTO approvers (id, name, email, teams_user_id, active) VALUES ('app-1','Dana Reid','dana@example.test','aad-1',1)`,
  );
  return { invoiceId: 'inv-1', approverId: 'app-1' };
}

beforeEach(() => {
  closeDb();
  openDb(':memory:');
  seedDefaults();
  config.approvalsProvider = 'power_automate';
  config.approvalsFlowUrl = FLOW_URL;
  config.approvalsCallbackToken = 'callback-secret-token';
  config.appUrl = 'https://finny.example.com';
  config.approvalsCallbackBaseUrl = '';
});

afterEach(() => {
  Object.assign(config, {
    approvalsProvider: saved.provider,
    approvalsFlowUrl: saved.flow,
    approvalsCallbackToken: saved.token,
    approvalsCallbackBaseUrl: saved.callbackBase,
    appUrl: saved.appUrl,
  });
  vi.unstubAllGlobals();
});

describe('sendApprovalToFlow', () => {
  const request = {
    requestId: 'req-1', invoiceId: 'inv-1', title: 'Invoice', description: 'd',
    approverName: 'Dana Reid', approverEmail: 'dana@example.test',
    documentUrl: 'https://finny.example.com/a/tok', callbackUrl: 'https://finny.example.com/api/integrations/approvals/callback',
    vendor: 'Meadowvale Ltd', invoiceRef: 'INV-77', amount: '1107.00', category: 'Materials', poNumber: 'PO-9',
  };

  it('accepts a 202 with no body — the default HTTP-trigger response', async () => {
    // Assuming a JSON body is exactly what broke the Graph path: that endpoint
    // answers 202 while the code expected 200-with-body.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 202 })));
    await expect(sendApprovalToFlow(request)).resolves.toBeUndefined();
  });

  it('posts the correlation id and callback url the flow needs', async () => {
    const fetchMock = vi.fn(async (_url: string, _opts: RequestInit) => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    await sendApprovalToFlow(request);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(FLOW_URL);
    const body = JSON.parse(String(opts.body));
    expect(body.requestId).toBe('req-1');
    expect(body.callbackUrl).toBe('https://finny.example.com/api/integrations/approvals/callback');
    expect(body.approverEmail).toBe('dana@example.test');
    expect(opts.redirect).toBe('manual'); // never follow a redirect off the validated host
  });

  it('refuses a flow url outside the allowlisted Microsoft hosts', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    config.approvalsFlowUrl = 'https://evil.example.com/hook';
    await expect(sendApprovalToFlow(request)).rejects.toThrow(/not an allowed Microsoft endpoint/);
    expect(fetchMock).not.toHaveBeenCalled(); // blocked before any request leaves
  });

  it('never leaks the upstream body into the thrown error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('internal detail: db=prod-7', { status: 500 })));
    await expect(sendApprovalToFlow(request)).rejects.toThrow(/^Approval flow returned HTTP 500$/);
  });

  it('calls back on APP_URL by default', () => {
    expect(approvalCallbackUrl()).toBe('https://finny.example.com/api/integrations/approvals/callback');
  });

  it('calls back on the origin when APP_URL sits behind a challenging CDN', () => {
    // A managed bot challenge answers a machine POST with 403 + HTML, so the
    // decision never lands and the invoice strands in awaiting_approval.
    config.approvalsCallbackBaseUrl = 'https://finny-sb2j.onrender.com';
    expect(approvalCallbackUrl()).toBe(
      'https://finny-sb2j.onrender.com/api/integrations/approvals/callback',
    );
  });

  it('tolerates a trailing slash on the override', () => {
    config.approvalsCallbackBaseUrl = 'https://finny-sb2j.onrender.com/';
    expect(approvalCallbackUrl()).not.toContain('//api/');
  });

  it('reports the flow host but never the signed url', () => {
    const info = approvalsFlowInfo();
    expect(info.configured).toBe(true);
    expect(info.host).toBe('prod-12.westeurope.logic.azure.com');
    expect(JSON.stringify(info)).not.toContain('SECRET');
  });
});

describe('createApprovalRequest via power_automate', () => {
  it('records a pending request when the flow accepts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 202 })));
    const { invoiceId, approverId } = seedInvoiceAndApprover();

    await createApprovalRequest(invoiceId, approverId, 'rick@example.test');

    const req = one<{ status: string; provider: string }>(
      'SELECT status, provider FROM approval_requests WHERE invoice_id = ?', invoiceId,
    )!;
    expect(req.status).toBe('pending');
    expect(req.provider).toBe('power_automate');
    expect(one<{ status: string }>('SELECT status FROM invoices WHERE id = ?', invoiceId)!.status)
      .toBe('awaiting_approval');
  });

  it('never sends a null field, whatever the invoice is missing', async () => {
    // The trigger validates the body against a schema generated from a sample,
    // which types every field as String: one null is rejected outright with
    // TriggerInputSchemaMismatch and no approval is raised. Most invoices have
    // no PO and no project, so this is the common case, not an edge case.
    const fetchMock = vi.fn(async (_url: string, _opts: RequestInit) => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date('2026-08-04T09:00:00Z').toISOString();
    run(
      `INSERT INTO invoices (id, source, attachment_name, attachment_mime, attachment_path, attachment_size,
         status, vendor_name, invoice_ref, gross_cents, category, po_number, received_at, created_at, updated_at)
       VALUES ('inv-bare','test','a.pdf','application/pdf','/tmp/a.pdf',10,'confirmed',NULL,NULL,NULL,NULL,NULL,?,?,?)`,
      now, now, now,
    );
    run(
      `INSERT INTO approvers (id, name, email, teams_user_id, active) VALUES ('app-2','Dana Reid','dana@example.test','aad-2',1)`,
    );

    await createApprovalRequest('inv-bare', 'app-2', 'rick@example.test');

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;
    for (const [key, value] of Object.entries(body)) {
      expect(value, `${key} must not be null`).not.toBeNull();
      expect(typeof value, `${key} must be a string`).toBe('string');
    }
    // The invoice is still identifiable even with every optional field empty.
    expect(body.requestId).toBeTruthy();
    expect(body.callbackUrl).toBeTruthy();
    expect(body.documentUrl).toBeTruthy();
    expect(one<{ status: string }>("SELECT status FROM approval_requests WHERE invoice_id = 'inv-bare'")!.status)
      .toBe('pending');
  });

  it('records a failure and alerts when the flow rejects the request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));
    const { invoiceId, approverId } = seedInvoiceAndApprover();

    await createApprovalRequest(invoiceId, approverId, 'rick@example.test');

    expect(one<{ status: string }>('SELECT status FROM approval_requests WHERE invoice_id = ?', invoiceId)!.status)
      .toBe('failed');
    expect(all("SELECT id FROM alerts WHERE type = 'teams_api_failure'").length).toBe(1);
  });
});

describe('approval decision callback', () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', buildRouter());
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const post = (body: unknown, token = 'callback-secret-token') =>
    fetch(`${base}/integrations/approvals/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  function pendingRequest(): string {
    seedInvoiceAndApprover();
    run(
      `INSERT INTO approval_requests (id, invoice_id, approver_id, provider, status, created_at)
       VALUES ('req-9','inv-1','app-1','power_automate','pending',?)`,
      new Date('2026-08-04T09:00:00Z').toISOString(),
    );
    run(`UPDATE invoices SET status = 'awaiting_approval' WHERE id = 'inv-1'`);
    return 'req-9';
  }

  it('applies an approval and moves the invoice on', async () => {
    const id = pendingRequest();
    const res = await post({ requestId: id, decision: 'approved', decidedBy: 'Dana Reid' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, applied: true });

    const req = one<{ status: string; decided_by_name: string }>(
      'SELECT status, decided_by_name FROM approval_requests WHERE id = ?', id,
    )!;
    expect(req.status).toBe('approved');
    expect(req.decided_by_name).toBe('Dana Reid');
  });

  it('rejects a wrong bearer token', async () => {
    const id = pendingRequest();
    expect((await post({ requestId: id, decision: 'approved' }, 'wrong')).status).toBe(401);
    expect(one<{ status: string }>('SELECT status FROM approval_requests WHERE id = ?', id)!.status)
      .toBe('pending');
  });

  it('rejects a missing bearer token', async () => {
    const id = pendingRequest();
    const res = await fetch(`${base}/integrations/approvals/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: id, decision: 'approved' }),
    });
    expect(res.status).toBe(401);
  });

  it('fails shut when no callback token is configured', async () => {
    config.approvalsCallbackToken = '';
    const id = pendingRequest();
    expect((await post({ requestId: id, decision: 'approved' }, 'anything')).status).toBe(503);
  });

  it('is idempotent — a retried callback cannot double-apply or flip a decision', async () => {
    const id = pendingRequest();
    await post({ requestId: id, decision: 'approved' });
    const res = await post({ requestId: id, decision: 'rejected' });

    expect(res.status).toBe(200); // 200 so the flow stops retrying
    expect(await res.json()).toMatchObject({ applied: false });
    expect(one<{ status: string }>('SELECT status FROM approval_requests WHERE id = ?', id)!.status)
      .toBe('approved'); // the later "rejected" must not overwrite it
  });

  it('answers 200/applied:false for an unknown request rather than retrying forever', async () => {
    const res = await post({ requestId: 'no-such-request', decision: 'approved' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: false });
  });

  it('rejects a malformed decision', async () => {
    const id = pendingRequest();
    expect((await post({ requestId: id, decision: 'maybe' })).status).toBe(400);
  });
});
