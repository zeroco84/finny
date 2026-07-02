import type { AuditEvent } from '@finny/shared';
import { all, jsonParse, run } from '../db/db.js';
import { newId, nowIso } from '../domain/util.js';

export function audit(
  invoiceId: string | null,
  type: string,
  actor: string,
  detail: Record<string, unknown> = {},
): void {
  run(
    'INSERT INTO audit_events (id, invoice_id, type, actor, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    newId(),
    invoiceId,
    type,
    actor,
    JSON.stringify(detail),
    nowIso(),
  );
}

export function auditForInvoice(invoiceId: string): AuditEvent[] {
  return all<Record<string, unknown>>(
    'SELECT * FROM audit_events WHERE invoice_id = ? ORDER BY created_at ASC, rowid ASC',
    invoiceId,
  ).map((r) => ({
    id: String(r.id),
    invoice_id: r.invoice_id === null ? null : String(r.invoice_id),
    type: String(r.type),
    actor: String(r.actor),
    detail: jsonParse(r.detail, {}),
    created_at: String(r.created_at),
  }));
}
