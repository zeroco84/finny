import type { Alert, AlertType } from '@finny/shared';
import { all, one, run } from '../db/db.js';
import { config } from '../config.js';
import { newId, nowIso } from '../domain/util.js';
import { getAlertWebhookUrl } from './settings.js';
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
  sage_duplicate_detected: {
    severity: 'warning',
    subject: (ctx) => `[Finny] Invoice ${invoiceLabel(ctx)} was already in Sage — not posted again`,
    body: (ctx) =>
      `Before posting, Finny found what looks like the same invoice already in Sage ` +
      `(${ctx.error ?? 'matching supplier, invoice number and amount'}) — most likely posted manually.\n\n` +
      `Finny did NOT post it again; it linked the invoice to the existing Sage transaction instead.` +
      invoiceLink(ctx),
    nextStep:
      'Open the transaction in Sage and confirm it is the same invoice. If it is genuinely different, correct the supplier invoice number in Finny and use "Send to Sage" again.',
  },
  sage_sequence_adjusted: {
    severity: 'warning',
    subject: (ctx) => `[Finny] Posting ref sequence moved forward (${ctx.extra ?? ''})`,
    body: (ctx) =>
      `Sage already contains posting references at or beyond the number Finny was about to use ` +
      `(${ctx.error ?? 'posted outside Finny'}).\n\n` +
      `To avoid a collision, Finny fast-forwarded its counter (${ctx.extra ?? ''}). No invoices were skipped or lost — the numbering simply jumped.`,
    nextStep:
      'If the team is still posting into Sage by hand, agree who owns the Inv-number sequence — parallel posting keeps causing jumps like this.',
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

/** The configured Teams webhook — a value stored in Settings wins over the env default. */
function webhookUrl(): string {
  return getAlertWebhookUrl();
}

export function alertsChannelName(): 'webhook' | 'off' {
  return webhookUrl() ? 'webhook' : 'off';
}

/** Host of the webhook for display/audit — never store the secret token path. */
function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'webhook';
  }
}

/**
 * SSRF guard: the webhook destination is operator-settable, so restrict it to
 * https on a Microsoft-owned host suffix (Teams connector / Power Automate /
 * Power Platform / Logic Apps). This blocks localhost, cloud metadata and
 * internal hosts regardless of DNS, and no credentials may be embedded.
 */
export function isValidWebhookUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return config.alertWebhookAllowedHosts.some((suffix) => host === suffix.replace(/^\./, '') || host.endsWith(suffix));
}

/** Whether a webhook is configured and its host (never the token) — for the UI. */
export function webhookInfo(): { configured: boolean; host: string | null } {
  const url = webhookUrl();
  return { configured: Boolean(url), host: url ? urlHost(url) : null };
}

/**
 * Neutralise Adaptive-Card / Markdown control characters so untrusted invoice
 * text (vendor, ref, filename, extractor error) cannot inject a clickable
 * phishing link or formatting into an alert card that appears to come from Finny.
 */
function cardSafe(value: string): string {
  return value.replace(/[[\]()`<>]/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

function sanitizeCtx(ctx: AlertContext): AlertContext {
  const clean = (v: string | null | undefined) => (v == null ? v : cardSafe(v));
  return {
    ...ctx,
    vendor: clean(ctx.vendor),
    invoiceRef: clean(ctx.invoiceRef),
    attachmentName: clean(ctx.attachmentName),
    error: clean(ctx.error),
    extra: clean(ctx.extra),
  };
}

/**
 * Build the Microsoft Teams payload: an Adaptive Card wrapped for an Incoming
 * Webhook — the Teams "Workflows → Post to a channel when a webhook request is
 * received" flow, which is what a user subscribes a channel to.
 */
function teamsPayload(opts: {
  subject: string;
  body: string;
  severity: 'warning' | 'critical';
  nextStep: string;
  invoiceUrl: string | null;
}): unknown {
  const card = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    msteams: { width: 'Full' },
    body: [
      {
        type: 'TextBlock',
        size: 'Large',
        weight: 'Bolder',
        wrap: true,
        color: opts.severity === 'critical' ? 'Attention' : 'Warning',
        text: `${opts.severity === 'critical' ? '🔴' : '🟠'} ${opts.subject}`,
      },
      { type: 'TextBlock', wrap: true, text: opts.body },
      {
        type: 'FactSet',
        facts: [
          { title: 'Severity', value: opts.severity },
          { title: 'Next step', value: opts.nextStep },
        ],
      },
    ],
    actions: opts.invoiceUrl
      ? [{ type: 'Action.OpenUrl', title: 'Open in Finny', url: opts.invoiceUrl }]
      : [],
  };
  return {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
  };
}

async function postToTeams(url: string, payload: unknown): Promise<void> {
  if (!isValidWebhookUrl(url)) {
    throw new Error('Refusing to post: the alert webhook URL is not an allowed Microsoft Teams endpoint');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    // Don't follow a redirect off the validated host, and don't hang forever.
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // Never surface the upstream body — echoed into delivery_error it would be
    // an internal-response read oracle. Log it server-side only, return status.
    const body = await res.text().catch(() => '');
    if (body) console.error(`[alerts] webhook ${urlHost(url)} error body:`, body.slice(0, 300));
    throw new Error(`Teams webhook returned HTTP ${res.status}`);
  }
}

/** Post a one-off connectivity card to the configured webhook (the test button). */
export async function sendTestAlert(): Promise<void> {
  const url = webhookUrl();
  if (!url) throw new Error('No alert webhook is configured');
  await postToTeams(
    url,
    teamsPayload({
      subject: '[Finny] Test alert',
      body: 'This is a test alert from Finny. If you can see this card, the Teams webhook is wired up correctly.',
      severity: 'warning',
      nextStep: 'No action needed — this is only a connectivity test.',
      invoiceUrl: null,
    }),
  );
}

/**
 * Raise an alert: store it, audit it, and post it to the Teams webhook
 * immediately (spec: immediate, not batched). Deduped: an open alert of the same type for the
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
  const id = newId();
  // Untrusted invoice-derived fields (vendor/ref/filename/error) are neutralised
  // before they enter the subject/body that render in the Teams card.
  const safeCtx = sanitizeCtx(ctx);
  const subject = template.subject(safeCtx);
  const body = `${template.body(safeCtx)}\n\nSuggested next step: ${template.nextStep}\n\n— Finny`;
  const url = webhookUrl();

  run(
    `INSERT INTO alerts (id, type, severity, invoice_id, subject, message, next_step, status, created_at, delivery_target, delivery_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 'logged')`,
    id,
    type,
    template.severity,
    ctx.invoiceId ?? null,
    subject,
    body,
    template.nextStep,
    nowIso(),
    url ? urlHost(url) : null,
  );
  audit(ctx.invoiceId ?? null, 'alert_raised', 'system', { alert_type: type, subject });

  if (url) {
    try {
      await postToTeams(
        url,
        teamsPayload({
          subject,
          // Card body drops the inline "Open in Finny" link — it becomes a button.
          body: template.body(safeCtx).replace(/\n+Open in Finny:\s*\S+/g, '').trim(),
          severity: template.severity,
          nextStep: template.nextStep,
          invoiceUrl: ctx.invoiceId ? `${config.appUrl}/invoices/${ctx.invoiceId}` : null,
        }),
      );
      run(`UPDATE alerts SET delivery_status = 'sent', delivery_at = ? WHERE id = ?`, nowIso(), id);
    } catch (err) {
      run(
        `UPDATE alerts SET delivery_status = 'failed', delivery_error = ? WHERE id = ?`,
        err instanceof Error ? err.message : String(err),
        id,
      );
      console.error(`[alerts] Teams webhook post failed for ${id}:`, err);
    }
  } else {
    console.warn(`[alerts] ${subject} (no alert webhook configured — stored and visible in UI)`);
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
    delivery_target: r.delivery_target === null ? null : String(r.delivery_target),
    delivery_status: r.delivery_status as Alert['delivery_status'],
    delivery_error: r.delivery_error === null ? null : String(r.delivery_error),
    delivery_at: r.delivery_at === null ? null : String(r.delivery_at),
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
