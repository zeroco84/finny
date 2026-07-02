import type {
  ApprovalRequest,
  ConfidenceField,
  ExtractionSnapshot,
  InvoiceDetail,
  InvoiceStatus,
  InvoiceSummary,
  LineItem,
} from '@finny/shared';
import { REQUIRED_FIELDS } from '@finny/shared';
import { all, jsonParse, one, run } from '../db/db.js';
import { centsToDecimal, newId, nowIso } from '../domain/util.js';
import { auditForInvoice } from './audit.js';

export type InvoiceRow = Record<string, unknown>;

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
function num(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

export function minRequiredConfidence(
  confidence: Partial<Record<ConfidenceField, number>>,
): number | null {
  const values = REQUIRED_FIELDS.map((f) => confidence[f] ?? 0);
  if (values.length === 0) return null;
  return Math.min(...values);
}

export function toSummary(r: InvoiceRow): InvoiceSummary {
  const confidence = jsonParse<Partial<Record<ConfidenceField, number>>>(r.field_confidence, {});
  return {
    id: String(r.id),
    status: r.status as InvoiceStatus,
    shadow: Number(r.shadow) === 1,
    vendor_name: str(r.vendor_name),
    invoice_ref: str(r.invoice_ref),
    invoice_date: str(r.invoice_date),
    gross_cents: num(r.gross_cents),
    currency: String(r.currency ?? 'EUR'),
    proposed_category: str(r.proposed_category),
    category: str(r.category),
    approver_id: str(r.approver_id),
    proposed_approver_id: str(r.proposed_approver_id),
    entity: str(r.entity),
    project_code: str(r.project_code),
    routing_confidence: num(r.routing_confidence),
    min_required_confidence:
      r.status === 'received' || r.status === 'extracting' ? null : minRequiredConfidence(confidence),
    duplicate_of: str(r.duplicate_of),
    doc_type: (str(r.doc_type) as InvoiceSummary['doc_type']) ?? null,
    received_at: String(r.received_at),
    email_from: str(r.email_from),
    email_subject: str(r.email_subject),
    attachment_name: str(r.attachment_name),
    sage_batch_id: str(r.sage_batch_id),
    updated_at: String(r.updated_at),
  };
}

function mapApproval(r: Record<string, unknown>): ApprovalRequest {
  return {
    id: String(r.id),
    invoice_id: String(r.invoice_id),
    approver_id: String(r.approver_id),
    provider: r.provider as ApprovalRequest['provider'],
    external_id: str(r.external_id),
    status: r.status as ApprovalRequest['status'],
    error: str(r.error),
    created_at: String(r.created_at),
    decided_at: str(r.decided_at),
    decided_by_name: str(r.decided_by_name),
    decision_note: str(r.decision_note),
  };
}

export function latestApproval(invoiceId: string): ApprovalRequest | null {
  const row = one(
    'SELECT * FROM approval_requests WHERE invoice_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    invoiceId,
  );
  return row ? mapApproval(row) : null;
}

export function toDetail(r: InvoiceRow): InvoiceDetail {
  const summary = toSummary(r);
  const corrections = all(
    'SELECT * FROM corrections WHERE invoice_id = ? ORDER BY created_at ASC, rowid ASC',
    summary.id,
  ).map((c) => ({
    id: String(c.id),
    invoice_id: String(c.invoice_id),
    kind: c.kind as 'extraction' | 'routing_category' | 'routing_approver',
    field: String(c.field),
    old_value: str(c.old_value),
    new_value: str(c.new_value),
    corrected_by: String(c.corrected_by),
    created_at: String(c.created_at),
  }));

  let duplicateSummary: InvoiceDetail['duplicate_summary'] = null;
  if (summary.duplicate_of) {
    const dup = one('SELECT id, status, received_at FROM invoices WHERE id = ?', summary.duplicate_of);
    if (dup) {
      duplicateSummary = {
        id: String(dup.id),
        status: dup.status as InvoiceStatus,
        received_at: String(dup.received_at),
      };
    }
  }

  return {
    ...summary,
    source: String(r.source),
    email_message_id: str(r.email_message_id),
    attachment_mime: str(r.attachment_mime),
    net_cents: num(r.net_cents),
    vat_cents: num(r.vat_cents),
    vat_rate: num(r.vat_rate),
    vat_number: str(r.vat_number),
    po_number: str(r.po_number),
    supplier_account_ref: str(r.supplier_account_ref),
    line_items: jsonParse<LineItem[]>(r.line_items, []),
    field_confidence: jsonParse(r.field_confidence, {}),
    extraction_snapshot: jsonParse<ExtractionSnapshot | null>(r.extraction_snapshot, null),
    extraction_error: str(r.extraction_error),
    extraction_provider: str(r.extraction_provider),
    routing_rationale: str(r.routing_rationale),
    matched_rule_id: str(r.matched_rule_id),
    reviewed_by: str(r.reviewed_by),
    reviewed_at: str(r.reviewed_at),
    confirmed_at: str(r.confirmed_at),
    discarded_reason: str(r.discarded_reason),
    audit: auditForInvoice(summary.id),
    corrections,
    approval: latestApproval(summary.id),
    duplicate_summary: duplicateSummary,
  };
}

export function getInvoiceRow(id: string): InvoiceRow | undefined {
  return one('SELECT * FROM invoices WHERE id = ?', id);
}

export function touchInvoice(id: string): void {
  run('UPDATE invoices SET updated_at = ? WHERE id = ?', nowIso(), id);
}

export interface NewInvoiceInput {
  source: string;
  email_from?: string | null;
  email_subject?: string | null;
  email_message_id?: string | null;
  attachment_name: string;
  attachment_mime: string;
  attachment_path: string;
  attachment_size: number;
  received_at?: string;
}

export function createInvoice(input: NewInvoiceInput): string {
  const id = newId();
  const now = nowIso();
  run(
    `INSERT INTO invoices (id, source, email_from, email_subject, email_message_id, received_at,
       attachment_name, attachment_mime, attachment_path, attachment_size, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)`,
    id,
    input.source,
    input.email_from ?? null,
    input.email_subject ?? null,
    input.email_message_id ?? null,
    input.received_at ?? now,
    input.attachment_name,
    input.attachment_mime,
    input.attachment_path,
    input.attachment_size,
    now,
    now,
  );
  return id;
}

const TAB_FILTERS: Record<string, string> = {
  needs_review: `status IN ('needs_review')`,
  failed: `status = 'extraction_failed'`,
  awaiting_approval: `status IN ('confirmed', 'awaiting_approval')`,
  completed: `status IN ('approved', 'rejected', 'shadow_complete', 'discarded')`,
  processing: `status IN ('received', 'extracting')`,
  all: '1=1',
};

export function listInvoices(tab: string): InvoiceSummary[] {
  const where = TAB_FILTERS[tab] ?? TAB_FILTERS.all;
  return all(`SELECT * FROM invoices WHERE ${where} ORDER BY received_at DESC LIMIT 500`).map(toSummary);
}

export function countByTab(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [tab, where] of Object.entries(TAB_FILTERS)) {
    const row = one<{ n: number }>(`SELECT COUNT(*) AS n FROM invoices WHERE ${where}`);
    out[tab] = row ? Number(row.n) : 0;
  }
  return out;
}

/**
 * Export shape for BlockDocs' budget-vs-invoiced dashboard. Deliberately
 * carries `approved_at`, NOT a payment date: Finny's workflow stops at
 * approval and hands off to Sage 50 — it has no visibility into payment.
 */
export interface BlockDocsInvoiceExport {
  finny_invoice_id: string;
  project_code: string | null;
  category: string | null;
  vendor_name: string | null;
  invoice_ref: string | null;
  invoice_date: string | null;
  amount: string; // decimal string, e.g. "1234.56"
  currency: string;
  approved_at: string | null;
}

/**
 * Approved, project-tagged invoices for the BlockDocs pull endpoint. The
 * approval timestamp comes from approval_requests.decided_at (not
 * invoices.updated_at, which moves on any edit).
 */
export function listApprovedForBlockDocs(
  projectCode?: string,
  since?: string,
): BlockDocsInvoiceExport[] {
  const conditions = [`i.status = 'approved'`, `i.project_code IS NOT NULL`];
  const params: string[] = [];
  if (projectCode) {
    conditions.push('i.project_code = ?');
    params.push(projectCode);
  }
  if (since) {
    conditions.push('ar.decided_at >= ?');
    params.push(since);
  }
  const rows = all(
    `SELECT i.*, ar.decided_at AS approved_at
     FROM invoices i
     LEFT JOIN approval_requests ar
       ON ar.invoice_id = i.id AND ar.status = 'approved'
     WHERE ${conditions.join(' AND ')}
     ORDER BY ar.decided_at DESC`,
    ...params,
  );
  return rows.map((r) => ({
    finny_invoice_id: String(r.id),
    project_code: str(r.project_code),
    category: str(r.category),
    vendor_name: str(r.vendor_name),
    invoice_ref: str(r.invoice_ref),
    invoice_date: str(r.invoice_date),
    amount: centsToDecimal(num(r.gross_cents)),
    currency: String(r.currency ?? 'EUR'),
    approved_at: str(r.approved_at),
  }));
}

/** Duplicate check: same normalized vendor + invoice ref, different invoice. */
export function findDuplicate(
  invoiceId: string,
  vendorNormalized: string | null,
  invoiceRef: string | null,
): string | null {
  if (!vendorNormalized || !invoiceRef) return null;
  const row = one<{ id: string }>(
    `SELECT id FROM invoices
     WHERE id != ? AND vendor_normalized = ? AND invoice_ref = ?
       AND status NOT IN ('discarded', 'extraction_failed')
     ORDER BY received_at ASC LIMIT 1`,
    invoiceId,
    vendorNormalized,
    invoiceRef,
  );
  return row ? String(row.id) : null;
}
