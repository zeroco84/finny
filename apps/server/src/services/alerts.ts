import nodemailer from 'nodemailer';
import type { Alert, AlertType } from '@finny/shared';
import { all, one, run } from '../db/db.js';
import { config } from '../config.js';
import { newId, nowIso } from '../domain/util.js';
import { getSettings } from './settings.js';
import { audit } from './audit.js';

interface AlertContext {
  invoiceId?: string | null;
  vendor?: string | null;
  invoiceRef?: string | null;
  attachmentName?: string | null;
  error?: string | null;
  extra?: string | null;
}

interface Template {
  severity: 'warning' | 'critical';
  subject: (ctx: AlertContext) => string;
  body: (ctx: AlertContext) => string;
  nextStep: string;
}

function invoiceLabel(ctx: AlertContext): string {
  const vendor = ctx.vendor || 'unknown vendor';
  return ctx.invoiceRef ? `${ctx.invoiceRef} from ${vendor}` : `from ${vendor}`;
}

function invoiceLink(ctx: AlertContext): string {
  return ctx.invoiceId ? `\n\nOpen in Finny: ${config.appUrl}/invoices/${ctx.invoiceId}` : '';
}

const TEMPLATES: Record<AlertType, Template> = {
  unreadable_attachment: {
    severity: 'critical',
    subject: (ctx) => `[Finny] Unreadable invoice attachment: ${ctx.attachmentName ?? 'unknown file'}`,
    body: (ctx) =>
      `Finny could not read the attachment "${ctx.attachmentName ?? 'unknown'}" ` +
      `(${ctx.error ?? 'unsupported or corrupt file'}).\n\n` +
      `The invoice has NOT been processed and is waiting in the failed queue.` +
      invoiceLink(ctx),
    nextStep:
      'Open the original email, check the attachment, and re-upload a readable copy in Finny — or discard it if it is not an invoice.',
  },
  extraction_failure: {
    severity: 'critical',
    subject: (ctx) => `[Finny] Extraction failed for invoice ${invoiceLabel(ctx)}`,
    body: (ctx) =>
      `The AI extraction step failed for an invoice (${ctx.error ?? 'unknown error'}).\n\n` +
      `The invoice is in the failed queue with empty fields — nothing has been sent to Sage or Teams.` +
      invoiceLink(ctx),
    nextStep: 'Open the invoice in Finny, enter the fields manually, or retry extraction.',
  },
  low_confidence_sla: {
    severity: 'warning',
    subject: (ctx) => `[Finny] Invoice ${invoiceLabel(ctx)} waiting with low-confidence fields`,
    body: (ctx) =>
      `An invoice ${invoiceLabel(ctx)} has low-confidence or missing required fields and nobody ` +
      `has reviewed it within the configured SLA (${ctx.extra ?? ''}).\n\n` +
      `It will not progress until a human reviews it.` +
      invoiceLink(ctx),
    nextStep: 'Open the review queue and confirm or correct the flagged fields.',
  },
  sage_export_failure: {
    severity: 'critical',
    subject: (ctx) => `[Finny] Sage export failed${ctx.invoiceRef ? ` (invoice ${ctx.invoiceRef})` : ''}`,
    body: (ctx) =>
      `Generating the Sage 50 import batch failed: ${ctx.error ?? 'unknown error'}.\n\n` +
      `No batch file was produced; the affected invoices are still marked as un-exported.` +
      invoiceLink(ctx),
    nextStep: 'Check disk space and the category→nominal-code mapping in Settings, then retry the export.',
  },
  teams_api_failure: {
    severity: 'critical',
    subject: (ctx) => `[Finny] Teams approval could not be created for ${invoiceLabel(ctx)}`,
    body: (ctx) =>
      `Creating the Teams Approval request failed: ${ctx.error ?? 'unknown error'}.\n\n` +
      `The invoice is confirmed but has NOT been sent for approval.` +
      invoiceLink(ctx),
    nextStep:
      'Check the assigned approver on the invoice and the Graph credentials, then use "Retry approval" on the invoice page.',
  },
  mailbox_auth_failure: {
    severity: 'critical',
    subject: () => `[Finny] Mailbox connection failed — new invoices are NOT being ingested`,
    body: (ctx) =>
      `Finny could not read the shared mailbox: ${ctx.error ?? 'unknown error'}.\n\n` +
      `Until this is fixed, new invoice emails will sit in the mailbox unprocessed.`,
    nextStep:
      'IT: check the Graph app registration (client secret expiry, Mail.Read permission on the shared mailbox) and the network. Finny retries automatically each poll.',
  },
};

let transporter: nodemailer.Transporter | null = null;

export function emailProviderName(): 'smtp' | 'log' {
  return config.smtp.host ? 'smtp' : 'log';
}

function getTransporter(): nodemailer.Transporter | null {
  if (!config.smtp.host) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transporter;
}

/**
 * Raise an alert: store it, audit it, and dispatch email immediately (spec:
 * immediate, not batched). Deduped: an open alert of the same type for the
 * same invoice (or same system-level type) within the last hour is not
 * re-raised.
 */
export async function raiseAlert(type: AlertType, ctx: AlertContext = {}): Promise<string | null> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const existing = ctx.invoiceId
    ? one(
        `SELECT id FROM alerts WHERE type = ? AND invoice_id = ? AND status = 'open' AND created_at > ?`,
        type,
        ctx.invoiceId,
        cutoff,
      )
    : one(
        `SELECT id FROM alerts WHERE type = ? AND invoice_id IS NULL AND status = 'open' AND created_at > ?`,
        type,
        cutoff,
      );
  if (existing) return null;

  const template = TEMPLATES[type];
  const settings = getSettings();
  const recipients = settings.alert_recipients.join(', ');
  const id = newId();
  const subject = template.subject(ctx);
  const body = `${template.body(ctx)}\n\nSuggested next step: ${template.nextStep}\n\n— Finny`;

  run(
    `INSERT INTO alerts (id, type, severity, invoice_id, subject, message, next_step, status, created_at, email_to, email_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 'logged')`,
    id,
    type,
    template.severity,
    ctx.invoiceId ?? null,
    subject,
    body,
    template.nextStep,
    nowIso(),
    recipients,
  );
  audit(ctx.invoiceId ?? null, 'alert_raised', 'system', { alert_type: type, subject });

  const smtp = getTransporter();
  if (smtp) {
    try {
      await smtp.sendMail({ from: config.smtp.from, to: recipients, subject, text: body });
      run(`UPDATE alerts SET email_status = 'sent', email_sent_at = ? WHERE id = ?`, nowIso(), id);
    } catch (err) {
      run(
        `UPDATE alerts SET email_status = 'failed', email_error = ? WHERE id = ?`,
        err instanceof Error ? err.message : String(err),
        id,
      );
      console.error(`[alerts] SMTP send failed for ${id}:`, err);
    }
  } else {
    console.warn(`[alerts] ${subject} (SMTP not configured — alert stored and visible in UI)`);
  }
  return id;
}

function mapAlert(r: Record<string, unknown>): Alert {
  return {
    id: String(r.id),
    type: r.type as AlertType,
    severity: r.severity as Alert['severity'],
    invoice_id: r.invoice_id === null ? null : String(r.invoice_id),
    subject: String(r.subject),
    message: String(r.message),
    next_step: String(r.next_step),
    status: r.status as Alert['status'],
    created_at: String(r.created_at),
    acknowledged_by: r.acknowledged_by === null ? null : String(r.acknowledged_by),
    acknowledged_at: r.acknowledged_at === null ? null : String(r.acknowledged_at),
    email_to: r.email_to === null ? null : String(r.email_to),
    email_status: r.email_status as Alert['email_status'],
    email_error: r.email_error === null ? null : String(r.email_error),
    email_sent_at: r.email_sent_at === null ? null : String(r.email_sent_at),
  };
}

export function listAlerts(status?: string): Alert[] {
  const rows = status
    ? all('SELECT * FROM alerts WHERE status = ? ORDER BY created_at DESC', status)
    : all('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 200');
  return rows.map(mapAlert);
}

export function setAlertStatus(id: string, status: 'acknowledged' | 'resolved', who: string): Alert | null {
  const row = one('SELECT * FROM alerts WHERE id = ?', id);
  if (!row) return null;
  run(
    'UPDATE alerts SET status = ?, acknowledged_by = ?, acknowledged_at = ? WHERE id = ?',
    status,
    who,
    nowIso(),
    id,
  );
  const invoiceId = row.invoice_id === null ? null : String(row.invoice_id);
  audit(invoiceId, `alert_${status}`, who, { alert_id: id });
  const updated = one('SELECT * FROM alerts WHERE id = ?', id);
  return updated ? mapAlert(updated) : null;
}

export function openAlertCount(): number {
  const row = one<{ n: number }>(`SELECT COUNT(*) AS n FROM alerts WHERE status = 'open'`);
  return row ? Number(row.n) : 0;
}
