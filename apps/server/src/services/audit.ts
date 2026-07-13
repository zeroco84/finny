import type { AuditEvent, AuditLogEvent, AuditLogPage, AuditLogQuery } from '@finny/shared';
import { all, jsonParse, one, run } from '../db/db.js';
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

// ── Global audit log (AP Lead view) ─────────────────────────────────────────

export const AUDIT_PAGE_LIMIT = 100;
export const AUDIT_EXPORT_LIMIT = 50_000;

/** WHERE clause + binds for an AuditLogQuery (shared by page, count and CSV).
 *  Events join their invoice (when linked) so the log can show and filter by
 *  the legal entity and vendor. */
function filterSql(query: AuditLogQuery): { where: string; binds: unknown[] } {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (query.actor) {
    clauses.push('e.actor = ?');
    binds.push(query.actor);
  }
  if (query.type) {
    clauses.push('e.type = ?');
    binds.push(query.type);
  }
  if (query.entity) {
    clauses.push('i.entity = ?');
    binds.push(query.entity);
  }
  if (query.invoice_id) {
    clauses.push('e.invoice_id = ?');
    binds.push(query.invoice_id);
  }
  if (query.from) {
    clauses.push('substr(e.created_at, 1, 10) >= ?');
    binds.push(query.from);
  }
  if (query.to) {
    clauses.push('substr(e.created_at, 1, 10) <= ?');
    binds.push(query.to);
  }
  if (query.q) {
    clauses.push('(e.type LIKE ? OR e.actor LIKE ? OR e.detail LIKE ? OR e.invoice_id LIKE ? OR i.vendor_name LIKE ?)');
    const like = `%${query.q}%`;
    binds.push(like, like, like, like, like);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', binds };
}

const FROM_JOINED = 'FROM audit_events e LEFT JOIN invoices i ON i.id = e.invoice_id';

function toLogEvent(r: Record<string, unknown>): AuditLogEvent {
  return {
    id: String(r.id),
    invoice_id: r.invoice_id === null ? null : String(r.invoice_id),
    type: String(r.type),
    actor: String(r.actor),
    detail: jsonParse(r.detail, {}),
    created_at: String(r.created_at),
    entity: r.entity === null || r.entity === undefined ? null : String(r.entity),
    vendor_name: r.vendor_name === null || r.vendor_name === undefined ? null : String(r.vendor_name),
  };
}

/**
 * One page of the global audit log, newest first. Keyset pagination: `before`
 * is the `next_cursor` from the previous page ("created_at|rowid"), so new
 * events arriving mid-scroll never duplicate or skip rows.
 */
export function listAuditLog(
  query: AuditLogQuery,
  opts: { before?: string; limit?: number } = {},
): AuditLogPage {
  const limit = Math.max(1, Math.min(500, opts.limit ?? AUDIT_PAGE_LIMIT));
  const { where, binds } = filterSql(query);

  const total = one<{ n: number }>(`SELECT COUNT(*) AS n ${FROM_JOINED} ${where}`, ...binds)?.n ?? 0;

  let cursorSql = '';
  const cursorBinds: unknown[] = [];
  if (opts.before) {
    const sep = opts.before.lastIndexOf('|');
    const createdAt = sep === -1 ? opts.before : opts.before.slice(0, sep);
    const rowid = sep === -1 ? 0 : Number(opts.before.slice(sep + 1));
    cursorSql = `${where ? 'AND' : 'WHERE'} (e.created_at < ? OR (e.created_at = ? AND e.rowid < ?))`;
    cursorBinds.push(createdAt, createdAt, Number.isFinite(rowid) ? rowid : 0);
  }

  const rows = all<Record<string, unknown>>(
    `SELECT e.*, e.rowid AS rid, i.entity AS entity, i.vendor_name AS vendor_name
     ${FROM_JOINED} ${where} ${cursorSql}
     ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`,
    ...binds,
    ...cursorBinds,
    limit + 1,
  );

  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  return {
    events: pageRows.map(toLogEvent),
    total,
    next_cursor: rows.length > limit && last ? `${String(last.created_at)}|${String(last.rid)}` : null,
  };
}

/** Distinct actors and event types, for the audit log filter dropdowns. */
export function auditFilterOptions(): { actors: string[]; types: string[] } {
  return {
    actors: all<{ actor: string }>('SELECT DISTINCT actor FROM audit_events ORDER BY actor').map((r) => r.actor),
    types: all<{ type: string }>('SELECT DISTINCT type FROM audit_events ORDER BY type').map((r) => r.type),
  };
}

function csvField(value: string): string {
  // Vendor names and detail values originate from invoice content, and this
  // CSV is opened in Excel by auditors — neutralise spreadsheet formulas.
  const safe = /^[=+\-@\t]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The filtered audit log as CSV (newest first), for compliance hand-offs. */
export function auditLogCsv(query: AuditLogQuery): { csv: string; rows: number; truncated: boolean } {
  const { where, binds } = filterSql(query);
  const rows = all<Record<string, unknown>>(
    `SELECT e.*, i.entity AS entity, i.vendor_name AS vendor_name
     ${FROM_JOINED} ${where}
     ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`,
    ...binds,
    AUDIT_EXPORT_LIMIT + 1,
  );
  const truncated = rows.length > AUDIT_EXPORT_LIMIT;
  const lines = ['time,action,actor,invoice_id,vendor,entity,detail'];
  for (const r of rows.slice(0, AUDIT_EXPORT_LIMIT)) {
    lines.push(
      [
        String(r.created_at),
        String(r.type),
        String(r.actor),
        r.invoice_id === null ? '' : String(r.invoice_id),
        r.vendor_name === null || r.vendor_name === undefined ? '' : String(r.vendor_name),
        r.entity === null || r.entity === undefined ? '' : String(r.entity),
        String(r.detail ?? '{}'),
      ]
        .map(csvField)
        .join(','),
    );
  }
  return { csv: lines.join('\r\n') + '\r\n', rows: Math.min(rows.length, AUDIT_EXPORT_LIMIT), truncated };
}
