import type { ExtractionSnapshot, ReviewSubmission, SessionUser } from '@finny/shared';
import { one, run } from '../db/db.js';
import { centsToDecimal, newId, normalizeVendor, nowIso } from '../domain/util.js';
import { audit } from './audit.js';
import { getInvoiceRow, findDuplicate } from './invoices.js';
import { learnFromReview } from './rules.js';
import { getSettings, getApprover } from './settings.js';
import { createApprovalRequest } from './approvals/approvals.js';

export class ReviewError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

type FieldKey = keyof ReviewSubmission['fields'];

/** Fields diffed against the AI snapshot to produce structured corrections. */
const EXTRACTION_FIELDS: { key: FieldKey; snapshot: keyof ExtractionSnapshot; money?: boolean }[] = [
  { key: 'vendor_name', snapshot: 'vendor_name' },
  { key: 'invoice_ref', snapshot: 'invoice_ref' },
  { key: 'invoice_date', snapshot: 'invoice_date' },
  { key: 'net_cents', snapshot: 'net_cents', money: true },
  { key: 'vat_cents', snapshot: 'vat_cents', money: true },
  { key: 'gross_cents', snapshot: 'gross_cents', money: true },
  { key: 'vat_rate', snapshot: 'vat_rate' },
  { key: 'vat_number', snapshot: 'vat_number' },
  { key: 'po_number', snapshot: 'po_number' },
];

function display(value: unknown, money = false): string | null {
  if (value === null || value === undefined) return null;
  if (money) return centsToDecimal(Number(value));
  return String(value);
}

function recordCorrection(
  invoiceId: string,
  kind: 'extraction' | 'routing_category' | 'routing_approver',
  field: string,
  oldValue: string | null,
  newValue: string | null,
  who: string,
): void {
  run(
    `INSERT INTO corrections (id, invoice_id, kind, field, old_value, new_value, corrected_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(), invoiceId, kind, field, oldValue, newValue, who, nowIso(),
  );
}

function recordComparison(
  invoiceId: string,
  field: string,
  aiValue: string | null,
  humanValue: string | null,
): void {
  if (aiValue === null && humanValue === null) return; // nothing to compare
  run(
    `INSERT INTO shadow_comparisons (id, invoice_id, field, ai_value, human_value, matched, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    newId(), invoiceId, field, aiValue, humanValue, aiValue === humanValue ? 1 : 0, nowIso(),
  );
}

/**
 * The single review action. Applies the human's values, captures every
 * difference from the AI proposal as structured feedback, feeds the rules
 * layer, and (live confirm) hands the invoice to the approval flow.
 */
export async function submitReview(
  invoiceId: string,
  submission: ReviewSubmission,
  user: SessionUser,
): Promise<void> {
  const row = getInvoiceRow(invoiceId);
  if (!row) throw new ReviewError('Invoice not found', 404);
  const status = String(row.status);
  if (status !== 'needs_review' && status !== 'extraction_failed') {
    throw new ReviewError(`Invoice is ${status} — it can no longer be reviewed`, 409);
  }

  const settings = getSettings();
  const who = user.email;
  const now = nowIso();

  if (submission.action === 'discard') {
    run(
      `UPDATE invoices SET status = 'discarded', discarded_reason = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`,
      submission.discard_reason ?? 'not an invoice',
      who, now, now, invoiceId,
    );
    audit(invoiceId, 'discarded', who, { reason: submission.discard_reason ?? 'not an invoice' });
    return;
  }

  if (submission.action === 'confirm' && settings.mode !== 'live') {
    throw new ReviewError(
      'Finny is in shadow mode — confirming to Sage/Teams is disabled. Use "Log & complete (shadow)" or switch to live mode in Settings.',
      409,
    );
  }
  if (submission.action === 'shadow_log' && settings.mode !== 'shadow') {
    throw new ReviewError('Finny is in live mode — use Confirm & Send.', 409);
  }

  const f = submission.fields;
  if (submission.action === 'confirm') {
    const missing: string[] = [];
    if (!f.vendor_name) missing.push('vendor');
    if (!f.invoice_ref) missing.push('invoice ref');
    if (f.gross_cents === null) missing.push('gross amount');
    if (!submission.category) missing.push('category');
    if (!submission.approver_id) missing.push('approver');
    if (!f.supplier_account_ref) missing.push('supplier account ref');
    if (missing.length > 0) {
      throw new ReviewError(`Cannot confirm — missing: ${missing.join(', ')}`);
    }
    if (submission.approver_id && !getApprover(submission.approver_id)) {
      throw new ReviewError('Unknown approver');
    }
    if (submission.category && !settings.categories.some((c) => c.name === submission.category)) {
      throw new ReviewError('Unknown category');
    }
  }

  // ── Structured feedback: diff human values against the AI snapshot ────────
  const snapshot = ((): ExtractionSnapshot | null => {
    const raw = row.extraction_snapshot;
    if (typeof raw !== 'string' || !raw) return null;
    try { return JSON.parse(raw) as ExtractionSnapshot; } catch { return null; }
  })();

  let correctionCount = 0;
  if (snapshot) {
    for (const spec of EXTRACTION_FIELDS) {
      const aiVal = display(snapshot[spec.snapshot], spec.money);
      const humanVal = display(f[spec.key], spec.money);
      recordComparison(invoiceId, spec.key, aiVal, humanVal);
      if (aiVal !== humanVal) {
        recordCorrection(invoiceId, 'extraction', spec.key, aiVal, humanVal, who);
        correctionCount++;
      }
    }
    recordComparison(invoiceId, 'category', snapshot.category, submission.category);
    if (snapshot.category !== submission.category) {
      recordCorrection(invoiceId, 'routing_category', 'category', snapshot.category, submission.category, who);
      correctionCount++;
    }
    recordComparison(invoiceId, 'approver', snapshot.approver_id, submission.approver_id);
    if (snapshot.approver_id !== submission.approver_id) {
      recordCorrection(invoiceId, 'routing_approver', 'approver', snapshot.approver_id, submission.approver_id, who);
      correctionCount++;
    }
  }

  const vendorNormalized = f.vendor_name ? normalizeVendor(f.vendor_name) : null;
  const isShadow = submission.action === 'shadow_log';

  run(
    `UPDATE invoices SET
       vendor_name = ?, vendor_normalized = ?, invoice_ref = ?, invoice_date = ?,
       net_cents = ?, vat_cents = ?, gross_cents = ?, vat_rate = ?, vat_number = ?, po_number = ?,
       supplier_account_ref = ?, category = ?, approver_id = ?,
       duplicate_of = ?, reviewed_by = ?, reviewed_at = ?, shadow = ?,
       status = ?, confirmed_at = ?, updated_at = ?
     WHERE id = ?`,
    f.vendor_name, vendorNormalized, f.invoice_ref, f.invoice_date,
    f.net_cents, f.vat_cents, f.gross_cents, f.vat_rate, f.vat_number, f.po_number,
    f.supplier_account_ref, submission.category, submission.approver_id,
    findDuplicate(invoiceId, vendorNormalized, f.invoice_ref),
    who, now, isShadow ? 1 : 0,
    isShadow ? 'shadow_complete' : 'confirmed',
    isShadow ? null : now,
    now, invoiceId,
  );

  if (correctionCount > 0) {
    audit(invoiceId, 'fields_corrected', who, { corrections: correctionCount });
  }
  audit(invoiceId, isShadow ? 'shadow_logged' : 'confirmed', who, {
    mode: isShadow ? 'shadow' : 'live',
    category: submission.category,
    approver_id: submission.approver_id,
  });

  // ── Feed the learned-rules layer ──────────────────────────────────────────
  if (f.vendor_name && submission.category && submission.approver_id) {
    learnFromReview({
      vendorName: f.vendor_name,
      finalCategory: submission.category,
      finalApproverId: submission.approver_id,
      matchedRuleId: row.matched_rule_id === null ? null : String(row.matched_rule_id),
      invoiceId,
      who,
    });
  }

  // ── Live confirm: create the Teams approval request ───────────────────────
  if (!isShadow && submission.approver_id) {
    await createApprovalRequest(invoiceId, submission.approver_id, who);
  }
}

/** Manual retry of a failed approval creation from the invoice page. */
export async function retryApproval(invoiceId: string, user: SessionUser): Promise<void> {
  const row = getInvoiceRow(invoiceId);
  if (!row) throw new ReviewError('Invoice not found', 404);
  if (row.status !== 'confirmed') {
    throw new ReviewError('Only confirmed invoices with a failed approval can be retried', 409);
  }
  const approverId = row.approver_id === null ? null : String(row.approver_id);
  if (!approverId) throw new ReviewError('Invoice has no approver assigned');
  await createApprovalRequest(invoiceId, approverId, user.email);
}

export function invoiceExists(invoiceId: string): boolean {
  return one('SELECT 1 AS x FROM invoices WHERE id = ?', invoiceId) !== undefined;
}
