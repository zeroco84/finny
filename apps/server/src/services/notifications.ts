import type {
  AmountThresholdParams,
  DateThresholdParams,
  ProjectMatchParams,
  SupplierMatchParams,
  WebhookEventType,
  WebhookSubscription,
  WebhookSubscriptionInput,
  WebhookSubscriptionParams,
} from '@finny/shared';
import { all, jsonParse, one, run } from '../db/db.js';
import { config } from '../config.js';
import { centsToDecimal, looseMatch, newId, normalizeVendor, nowIso } from '../domain/util.js';
import { getSettings } from './settings.js';
import { getInvoiceRow, type InvoiceRow } from './invoices.js';
import { buildTeamsMessage, cardSafe, isValidWebhookUrl, postCardToWebhook, urlHost } from './teamsWebhook.js';

/**
 * Per-user event-notification subscriptions. Distinct from the single
 * operational-alert webhook: any signed-in user subscribes their own Teams
 * chat/channel to invoices matching criteria they choose. Subscriptions are
 * evaluated on arrival (extraction complete → the invoice enters the review
 * queue) in the extraction pipeline.
 */

export class NotificationError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

const MAX_PER_USER = 20;
const EVENT_TYPES: WebhookEventType[] = ['amount_threshold', 'date_threshold', 'supplier_match', 'project_match'];

const WEBHOOK_HELP = 'The webhook URL must be https on an allowed Microsoft Teams / Power Automate host.';

/** Validate + normalise the type-specific params (defence in depth beyond the route zod). */
export function validateParams(eventType: WebhookEventType, raw: unknown): WebhookSubscriptionParams {
  const p = (raw ?? {}) as Record<string, unknown>;
  const wholeDays = (v: unknown, field: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 3650) throw new NotificationError(`${field} must be a whole number of days`);
    return n;
  };
  switch (eventType) {
    case 'amount_threshold': {
      const min = Number(p.min_cents);
      if (!Number.isInteger(min) || min <= 0) throw new NotificationError('Set a positive amount threshold');
      return { min_cents: min };
    }
    case 'date_threshold': {
      const out: DateThresholdParams = {};
      if (p.postdated === true) out.postdated = true;
      if (p.stale_days != null) out.stale_days = wholeDays(p.stale_days, 'Back-dated days');
      if (p.due_within_days != null) out.due_within_days = wholeDays(p.due_within_days, 'Due-within days');
      if (!out.postdated && out.stale_days == null && out.due_within_days == null) {
        throw new NotificationError('Pick at least one date condition (post-dated, back-dated days, or due within N days)');
      }
      return out;
    }
    case 'supplier_match':
    case 'project_match': {
      const q = typeof p.query === 'string' ? p.query.trim() : '';
      if (q.length < 2) throw new NotificationError('Enter at least 2 characters to match on');
      if (q.length > 120) throw new NotificationError('Match text is too long');
      return { query: q };
    }
    default:
      throw new NotificationError('Unknown event type');
  }
}

function mapSubscription(r: Record<string, unknown>): WebhookSubscription {
  return {
    id: String(r.id),
    label: String(r.label),
    event_type: String(r.event_type) as WebhookEventType,
    params: jsonParse<WebhookSubscriptionParams>(r.params, {} as WebhookSubscriptionParams),
    active: Number(r.active) === 1,
    // Only the host is ever exposed — the URL path carries a secret token.
    webhook_host: urlHost(String(r.webhook_url)),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    last_fired_at: r.last_fired_at == null ? null : String(r.last_fired_at),
  };
}

function ownedRow(id: string, owner: string): Record<string, unknown> | undefined {
  return one('SELECT * FROM webhook_subscriptions WHERE id = ? AND owner_email = ?', id, owner);
}

// ── CRUD (always scoped to the calling user) ─────────────────────────────────

export function listSubscriptions(owner: string): WebhookSubscription[] {
  return all('SELECT * FROM webhook_subscriptions WHERE owner_email = ? ORDER BY created_at DESC', owner).map(
    mapSubscription,
  );
}

export function createSubscription(owner: string, input: WebhookSubscriptionInput): WebhookSubscription {
  const label = (input.label ?? '').trim();
  if (label.length < 1 || label.length > 80) throw new NotificationError('Give the subscription a short label');
  if (!EVENT_TYPES.includes(input.event_type)) throw new NotificationError('Unknown event type');
  const params = validateParams(input.event_type, input.params);
  const url = (input.webhook_url ?? '').trim();
  if (!isValidWebhookUrl(url)) throw new NotificationError(WEBHOOK_HELP);
  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM webhook_subscriptions WHERE owner_email = ?', owner);
  if (count && Number(count.n) >= MAX_PER_USER) {
    throw new NotificationError(`You can have at most ${MAX_PER_USER} subscriptions — delete one first`);
  }
  const id = newId();
  const now = nowIso();
  run(
    `INSERT INTO webhook_subscriptions (id, owner_email, label, webhook_url, event_type, params, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, owner, label, url, input.event_type, JSON.stringify(params), input.active === false ? 0 : 1, now, now,
  );
  return mapSubscription(ownedRow(id, owner)!);
}

export function updateSubscription(
  owner: string,
  id: string,
  input: Partial<WebhookSubscriptionInput>,
): WebhookSubscription | null {
  const existing = ownedRow(id, owner);
  if (!existing) return null;
  const eventType = (input.event_type ?? existing.event_type) as WebhookEventType;
  if (!EVENT_TYPES.includes(eventType)) throw new NotificationError('Unknown event type');
  const label = input.label != null ? input.label.trim() : String(existing.label);
  if (label.length < 1 || label.length > 80) throw new NotificationError('Give the subscription a short label');
  // Re-validate params when either the params or the event type change.
  const params =
    input.params != null || input.event_type != null
      ? validateParams(eventType, input.params ?? jsonParse(existing.params, {}))
      : jsonParse<WebhookSubscriptionParams>(existing.params, {} as WebhookSubscriptionParams);
  let url = String(existing.webhook_url);
  if (input.webhook_url != null && input.webhook_url.trim()) {
    url = input.webhook_url.trim();
    if (!isValidWebhookUrl(url)) throw new NotificationError(WEBHOOK_HELP);
  }
  const active = input.active != null ? (input.active ? 1 : 0) : Number(existing.active);
  run(
    `UPDATE webhook_subscriptions SET label = ?, webhook_url = ?, event_type = ?, params = ?, active = ?, updated_at = ?
     WHERE id = ? AND owner_email = ?`,
    label, url, eventType, JSON.stringify(params), active, nowIso(), id, owner,
  );
  return mapSubscription(ownedRow(id, owner)!);
}

export function deleteSubscription(owner: string, id: string): boolean {
  const res = run('DELETE FROM webhook_subscriptions WHERE id = ? AND owner_email = ?', id, owner);
  if (Number(res.changes) > 0) {
    run('DELETE FROM webhook_deliveries WHERE subscription_id = ?', id);
    return true;
  }
  return false;
}

// ── Matching ─────────────────────────────────────────────────────────────────

export interface MatchResult {
  matched: boolean;
  reason: string;
}

function toDay(iso: unknown): string | null {
  if (iso == null) return null;
  const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function daysBetween(fromDay: string, toDayStr: string): number {
  return Math.round((Date.parse(`${toDayStr}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000);
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Does this invoice row match a subscription's criteria? Returns a card-ready reason when it does. */
export function matchSubscription(
  row: InvoiceRow,
  eventType: WebhookEventType,
  params: WebhookSubscriptionParams,
): MatchResult {
  const no: MatchResult = { matched: false, reason: '' };
  switch (eventType) {
    case 'amount_threshold': {
      const min = (params as AmountThresholdParams).min_cents;
      const gross = row.gross_cents == null ? null : Number(row.gross_cents);
      return gross != null && gross >= min
        ? { matched: true, reason: `Gross €${centsToDecimal(gross)} is at or above your €${centsToDecimal(min)} threshold.` }
        : no;
    }
    case 'date_threshold': {
      const p = params as DateThresholdParams;
      const received = toDay(row.received_at) ?? toDay(nowIso())!;
      const invDate = toDay(row.invoice_date);
      const dueDate = toDay(row.due_date);
      const today = toDay(nowIso())!;
      const reasons: string[] = [];
      if (p.postdated && invDate && invDate > received) {
        reasons.push(`Invoice is post-dated — dated ${invDate} but arrived ${received}.`);
      }
      if (p.stale_days != null && invDate && daysBetween(invDate, received) > p.stale_days) {
        reasons.push(`Invoice is back-dated ${daysBetween(invDate, received)} days (dated ${invDate}).`);
      }
      if (p.due_within_days != null && dueDate && dueDate <= addDays(today, p.due_within_days)) {
        reasons.push(`Payment due ${dueDate} — within ${p.due_within_days} days.`);
      }
      return reasons.length > 0 ? { matched: true, reason: reasons.join(' ') } : no;
    }
    case 'supplier_match': {
      const q = (params as SupplierMatchParams).query;
      const vendor = row.vendor_name == null ? null : String(row.vendor_name);
      const normalized = row.vendor_normalized == null ? null : String(row.vendor_normalized);
      return looseMatch(vendor, q) || looseMatch(normalized, normalizeVendor(q))
        ? { matched: true, reason: `Invoice from ${vendor ?? 'this supplier'} matches your "${q}" supplier alert.` }
        : no;
    }
    case 'project_match': {
      const q = (params as ProjectMatchParams).query;
      const code = row.project_code == null ? null : String(row.project_code);
      if (!code) return no;
      const project = getSettings().projects.find((pr) => pr.code === code);
      const name = project?.name ?? code;
      return looseMatch(name, q) || looseMatch(code, q)
        ? { matched: true, reason: `References project ${name} (${code}), matching your "${q}" project alert.` }
        : no;
    }
    default:
      return no;
  }
}

// ── Card + delivery ──────────────────────────────────────────────────────────

const TITLES: Record<WebhookEventType, string> = {
  amount_threshold: '💶 Large invoice received',
  date_threshold: '📅 Invoice date alert',
  supplier_match: '🏢 Invoice from a watched supplier',
  project_match: '🏗️ Invoice for a watched project',
};

function invoiceCard(row: InvoiceRow, label: string, eventType: WebhookEventType, reason: string): unknown {
  const gross = row.gross_cents == null ? null : Number(row.gross_cents);
  const currency = String(row.currency ?? 'EUR');
  const facts: { title: string; value: string }[] = [
    { title: 'Supplier', value: cardSafe(row.vendor_name == null ? 'Unknown supplier' : String(row.vendor_name)) },
  ];
  if (gross != null) facts.push({ title: 'Amount', value: `${currency} ${centsToDecimal(gross)}` });
  if (row.invoice_ref != null) facts.push({ title: 'Invoice ref', value: cardSafe(String(row.invoice_ref)) });
  if (row.invoice_date != null) facts.push({ title: 'Invoice date', value: String(row.invoice_date) });
  if (row.due_date != null) facts.push({ title: 'Due date', value: String(row.due_date) });
  if (row.project_code != null) facts.push({ title: 'Project', value: cardSafe(String(row.project_code)) });
  if (row.entity != null) facts.push({ title: 'Entity', value: cardSafe(String(row.entity)) });
  return buildTeamsMessage({
    title: TITLES[eventType],
    titleColor: 'Accent',
    body: `${cardSafe(reason)}\n\nAlert: "${cardSafe(label)}"`,
    facts,
    actionUrl: `${config.appUrl}/invoices/${String(row.id)}`,
  });
}

function recordDelivery(subId: string, invoiceId: string, status: 'sent' | 'failed', error: string | null): void {
  run(
    `INSERT INTO webhook_deliveries (subscription_id, invoice_id, fired_at, status, error)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(subscription_id, invoice_id) DO UPDATE SET fired_at = excluded.fired_at, status = excluded.status, error = excluded.error`,
    subId, invoiceId, nowIso(), status, error,
  );
}

/**
 * Evaluate every active subscription against one just-extracted invoice and
 * post a card for each match. At-most-once per (subscription, invoice) via the
 * webhook_deliveries ledger; a prior *failed* attempt may retry. Never throws —
 * a webhook problem must not affect extraction.
 */
export async function evaluateSubscriptionsForInvoice(invoiceId: string): Promise<void> {
  try {
    const row = getInvoiceRow(invoiceId);
    if (!row) return;
    const subs = all('SELECT * FROM webhook_subscriptions WHERE active = 1');
    for (const sub of subs) {
      const subId = String(sub.id);
      try {
        const alreadySent = one(
          `SELECT 1 AS x FROM webhook_deliveries WHERE subscription_id = ? AND invoice_id = ? AND status = 'sent'`,
          subId,
          invoiceId,
        );
        if (alreadySent) continue;
        const eventType = String(sub.event_type) as WebhookEventType;
        const params = jsonParse<WebhookSubscriptionParams>(sub.params, {} as WebhookSubscriptionParams);
        const result = matchSubscription(row, eventType, params);
        if (!result.matched) continue;
        const card = invoiceCard(row, String(sub.label), eventType, result.reason);
        try {
          await postCardToWebhook(String(sub.webhook_url), card);
          recordDelivery(subId, invoiceId, 'sent', null);
          run('UPDATE webhook_subscriptions SET last_fired_at = ? WHERE id = ?', nowIso(), subId);
        } catch (err) {
          recordDelivery(subId, invoiceId, 'failed', err instanceof Error ? err.message : String(err));
          console.error(`[notifications] post failed for sub ${subId} invoice ${invoiceId}:`, err);
        }
      } catch (err) {
        console.error(`[notifications] evaluation error for sub ${subId}:`, err);
      }
    }
  } catch (err) {
    console.error(`[notifications] evaluation failed for invoice ${invoiceId}:`, err);
  }
}

/** Send a one-off test card to a subscription's own webhook (the per-row test button). */
export async function sendSubscriptionTest(owner: string, id: string): Promise<{ host: string }> {
  const row = ownedRow(id, owner);
  if (!row) throw new NotificationError('Subscription not found', 404);
  const url = String(row.webhook_url);
  const eventType = String(row.event_type) as WebhookEventType;
  await postCardToWebhook(
    url,
    buildTeamsMessage({
      title: `${TITLES[eventType]} (test)`,
      titleColor: 'Accent',
      body: `Test of your "${cardSafe(String(row.label))}" Finny alert. If you can see this card, the webhook is wired up correctly.`,
      facts: [{ title: 'Alert', value: cardSafe(String(row.label)) }],
      actionUrl: `${config.appUrl}/`,
    }),
  );
  return { host: urlHost(url) };
}
