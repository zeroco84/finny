import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { all, closeDb, one, openDb, run } from '../src/db/db.js';
import { seedDefaults, updateSettings } from '../src/services/settings.js';
import { listAlerts } from '../src/services/alerts.js';
import { runApprovalWatchdog } from '../src/workers.js';
import { retryApproval } from '../src/services/review.js';

const saved = { provider: config.approvalsProvider, webhook: config.alertWebhookUrl };
const USER = { email: 'rick@example.test', name: 'Rick', role: 'lead' as const };

/** An approval request created `hoursAgo`, still pending. */
function pendingApproval(id: string, hoursAgo: number): void {
  const at = new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
  run(
    `INSERT INTO invoices (id, source, attachment_name, attachment_mime, attachment_path, attachment_size,
       status, vendor_name, invoice_ref, gross_cents, approver_id, received_at, created_at, updated_at)
     VALUES (?, 'test','a.pdf','application/pdf','/tmp/a.pdf',10,'awaiting_approval','Meadowvale Ltd','INV-1',
       110700,'app-1',?,?,?)`,
    `inv-${id}`, at, at, at,
  );
  run(
    `INSERT INTO approval_requests (id, invoice_id, approver_id, provider, status, created_at)
     VALUES (?, ?, 'app-1', 'power_automate', 'pending', ?)`,
    id, `inv-${id}`, at,
  );
}

beforeEach(() => {
  closeDb();
  openDb(':memory:');
  seedDefaults();
  config.alertWebhookUrl = '';
  run(`INSERT INTO approvers (id, name, email, teams_user_id, active) VALUES ('app-1','Dana','dana@example.test','aad-1',1)`);
});
afterEach(() => {
  Object.assign(config, { approvalsProvider: saved.provider, alertWebhookUrl: saved.webhook });
  vi.unstubAllGlobals();
});

describe('runApprovalWatchdog', () => {
  it('alerts on an approval pending past the SLA', async () => {
    pendingApproval('req-old', 72); // default SLA is 48h
    await runApprovalWatchdog();

    const alert = listAlerts().find((a) => a.type === 'approval_stalled');
    expect(alert).toBeDefined();
    expect(alert!.message).toMatch(/never reached Finny/); // names the lost-callback case
    expect(alert!.next_step).toMatch(/Retry approval/);
  });

  it('leaves an approval inside the SLA alone', async () => {
    pendingApproval('req-fresh', 2);
    await runApprovalWatchdog();
    expect(listAlerts().filter((a) => a.type === 'approval_stalled')).toHaveLength(0);
  });

  it('ignores requests that already have a decision', async () => {
    pendingApproval('req-done', 72);
    run(`UPDATE approval_requests SET status = 'approved' WHERE id = 'req-done'`);
    await runApprovalWatchdog();
    expect(listAlerts().filter((a) => a.type === 'approval_stalled')).toHaveLength(0);
  });

  it('alerts once per request, not once per tick', async () => {
    // The watchdog runs every 60s; without the flag a stranded approval would
    // raise an alert every hour until someone acted on it.
    pendingApproval('req-old', 72);
    await runApprovalWatchdog();
    await runApprovalWatchdog();
    await runApprovalWatchdog();

    expect(listAlerts().filter((a) => a.type === 'approval_stalled')).toHaveLength(1);
    expect(one<{ stall_alerted: number }>("SELECT stall_alerted FROM approval_requests WHERE id = 'req-old'")!
      .stall_alerted).toBe(1);
  });

  it('honours a changed SLA threshold', async () => {
    pendingApproval('req-6h', 6);
    updateSettings({ approval_sla_hours: 4 });
    await runApprovalWatchdog();
    expect(listAlerts().filter((a) => a.type === 'approval_stalled')).toHaveLength(1);
  });
});

describe('retryApproval — recovering a stranded invoice', () => {
  beforeEach(() => {
    config.approvalsProvider = 'mock'; // no outbound call
  });

  it('accepts an invoice stuck in awaiting_approval', async () => {
    // Before this, retry required 'confirmed', so a lost callback left the
    // invoice with no route back at all — the exact state we hit in production.
    pendingApproval('req-stuck', 72);
    await expect(retryApproval('inv-req-stuck', USER)).resolves.toBeUndefined();

    const requests = all<{ status: string }>(
      "SELECT status FROM approval_requests WHERE invoice_id = 'inv-req-stuck' ORDER BY created_at",
    );
    expect(requests).toHaveLength(2);
    expect(requests.some((r) => r.status === 'pending')).toBe(true);
  });

  it('supersedes the old pending request so a late callback cannot land', async () => {
    pendingApproval('req-stuck', 72);
    await retryApproval('inv-req-stuck', USER);

    const old = one<{ status: string; error: string }>(
      "SELECT status, error FROM approval_requests WHERE id = 'req-stuck'",
    )!;
    expect(old.status).toBe('failed');
    expect(old.error).toMatch(/Superseded by a retry/);
  });

  it('records the supersede in the audit trail', async () => {
    pendingApproval('req-stuck', 72);
    await retryApproval('inv-req-stuck', USER);
    expect(all("SELECT id FROM audit_events WHERE type = 'approval_superseded'")).toHaveLength(1);
  });

  it('does not claim a supersede when there was nothing pending', async () => {
    // run() returns {changes}, which is always truthy — a naive check would log
    // a supersede on every retry, including a plain failed-request retry.
    pendingApproval('req-plain', 1);
    run(`UPDATE approval_requests SET status = 'failed' WHERE id = 'req-plain'`);
    run(`UPDATE invoices SET status = 'confirmed' WHERE id = 'inv-req-plain'`);

    await retryApproval('inv-req-plain', USER);
    expect(all("SELECT id FROM audit_events WHERE type = 'approval_superseded'")).toHaveLength(0);
  });

  it('still refuses an invoice that is not in an approvable state', async () => {
    pendingApproval('req-done', 1);
    run(`UPDATE invoices SET status = 'approved' WHERE id = 'inv-req-done'`);
    await expect(retryApproval('inv-req-done', USER)).rejects.toThrow(/confirmed or awaiting-approval/);
  });
});
