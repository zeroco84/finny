import { REQUIRED_FIELDS } from '@finny/shared';
import { all, jsonParse, run } from './db/db.js';
import { config } from './config.js';
import { nowIso } from './domain/util.js';
import { pollMail } from './services/ingestion/mailProviders.js';
import { processInvoice } from './services/extraction/pipeline.js';
import { pollGraphApprovals } from './services/approvals/approvals.js';
import { raiseAlert } from './services/alerts.js';
import { getSettings } from './services/settings.js';

let extracting = false;

/** Drain the extraction queue one invoice at a time (keeps ordering simple). */
export async function drainExtractionQueue(): Promise<void> {
  if (extracting) return;
  extracting = true;
  try {
    for (;;) {
      const next = all<{ id: string }>(
        `SELECT id FROM invoices WHERE status = 'received' ORDER BY received_at ASC LIMIT 1`,
      )[0];
      if (!next) break;
      await processInvoice(next.id);
    }
  } finally {
    extracting = false;
  }
}

/**
 * SLA watchdog (spec: required-field confidence below threshold with no human
 * action within X hours -> immediate alert). Failed extractions count too.
 */
export async function runSlaWatchdog(): Promise<void> {
  const settings = getSettings();
  const cutoff = new Date(Date.now() - settings.review_sla_hours * 3600 * 1000).toISOString();
  const candidates = all(
    `SELECT id, vendor_name, invoice_ref, status, field_confidence FROM invoices
     WHERE status IN ('needs_review', 'extraction_failed')
       AND sla_alerted = 0 AND reviewed_at IS NULL AND received_at < ?`,
    cutoff,
  );
  for (const row of candidates) {
    let breach = row.status === 'extraction_failed';
    if (!breach) {
      const confidence = jsonParse<Record<string, number>>(row.field_confidence, {});
      breach = REQUIRED_FIELDS.some((f) => (confidence[f] ?? 0) < settings.confidence_threshold);
    }
    if (!breach) continue;
    await raiseAlert('low_confidence_sla', {
      invoiceId: String(row.id),
      vendor: row.vendor_name === null ? null : String(row.vendor_name),
      invoiceRef: row.invoice_ref === null ? null : String(row.invoice_ref),
      extra: `SLA: ${settings.review_sla_hours}h`,
    });
    run('UPDATE invoices SET sla_alerted = 1, updated_at = ? WHERE id = ?', nowIso(), String(row.id));
  }
}

/**
 * Approvals that have been pending too long.
 *
 * With a callback-driven provider there is nothing polling for the decision, so
 * a callback that never arrives — a deleted flow run, a failed HTTP step, an
 * edge challenging the request — strands the invoice in awaiting_approval
 * permanently. Nothing fails, nothing logs, and the queue looks healthy: the
 * approver sees it decided in Teams while Finny waits forever.
 *
 * This cannot tell "not answered yet" from "answered but lost", so it reports
 * both and the alert's next step tells the reader how to distinguish them.
 * Alerts once per request (stall_alerted), not once per tick.
 */
export async function runApprovalWatchdog(): Promise<void> {
  const settings = getSettings();
  const cutoff = new Date(Date.now() - settings.approval_sla_hours * 3600 * 1000).toISOString();
  const stalled = all(
    `SELECT ar.id, ar.invoice_id, i.vendor_name, i.invoice_ref
     FROM approval_requests ar JOIN invoices i ON i.id = ar.invoice_id
     WHERE ar.status = 'pending' AND ar.stall_alerted = 0 AND ar.created_at < ?`,
    cutoff,
  );
  for (const row of stalled) {
    await raiseAlert('approval_stalled', {
      invoiceId: String(row.invoice_id),
      vendor: row.vendor_name === null ? null : String(row.vendor_name),
      invoiceRef: row.invoice_ref === null ? null : String(row.invoice_ref),
      extra: `${settings.approval_sla_hours}h`,
    });
    run('UPDATE approval_requests SET stall_alerted = 1 WHERE id = ?', String(row.id));
  }
}

export function startWorkers(): void {
  const mailInterval = config.mailProvider === 'mock' ? 3000 : config.mailPollSeconds * 1000;
  setInterval(() => void pollMail().catch((e) => console.error('[worker] mail poll:', e)), mailInterval);
  setInterval(() => void drainExtractionQueue().catch((e) => console.error('[worker] extraction:', e)), 2000);
  setInterval(() => void runSlaWatchdog().catch((e) => console.error('[worker] sla:', e)), 60_000);
  setInterval(
    () => void runApprovalWatchdog().catch((e) => console.error('[worker] approval watchdog:', e)),
    60_000,
  );
  if (config.approvalsProvider === 'graph') {
    setInterval(
      () => void pollGraphApprovals().catch((e) => console.error('[worker] approvals poll:', e)),
      config.approvalsPollSeconds * 1000,
    );
  }
  console.log(
    `[workers] mail=${config.mailProvider} (${mailInterval / 1000}s) · extraction=${config.extractionProvider} · approvals=${config.approvalsProvider}`,
  );
}
