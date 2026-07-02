import fs from 'node:fs';
import type { ConfidenceField, ExtractionSnapshot } from '@finny/shared';
import { one, run } from '../../db/db.js';
import { normalizeVendor, nowIso, parseInvoiceDate, parseMoneyToCents, suggestAccountRef } from '../../domain/util.js';
import { audit } from '../audit.js';
import { raiseAlert } from '../alerts.js';
import { findDuplicate, getInvoiceRow } from '../invoices.js';
import { getSettings } from '../settings.js';
import { resolveRouting } from '../routing.js';
import { buildRulesContext, getExtractor, UnreadableDocumentError } from './extractor.js';

/**
 * Run extraction + classification for one invoice in status 'received'.
 * Never throws: every failure path lands the invoice in a reviewable state
 * and raises the appropriate alert (spec: no invoice silently fails).
 */
export async function processInvoice(invoiceId: string): Promise<void> {
  const row = getInvoiceRow(invoiceId);
  if (!row || row.status !== 'received') return;

  run(`UPDATE invoices SET status = 'extracting', updated_at = ? WHERE id = ?`, nowIso(), invoiceId);
  const extractor = await getExtractor();
  audit(invoiceId, 'extraction_started', 'system', { provider: extractor.name });

  const ctx = {
    vendor: null as string | null,
    invoiceRef: null as string | null,
    attachmentName: row.attachment_name === null ? null : String(row.attachment_name),
  };

  try {
    const buffer = fs.readFileSync(String(row.attachment_path));
    const mime = String(row.attachment_mime);
    const result = await extractor.extract(buffer, mime, buildRulesContext());

    const vendorName = result.vendor_name.value;
    const vendorNormalized = vendorName ? normalizeVendor(vendorName) : null;
    ctx.vendor = vendorName;
    ctx.invoiceRef = result.invoice_ref.value;

    const netCents = parseMoneyToCents(result.net.value);
    const vatCents = parseMoneyToCents(result.vat.value);
    let grossCents = parseMoneyToCents(result.gross.value);
    // If gross is missing but net + VAT are present, derive it (flagged low
    // confidence so the reviewer checks it — derived, not read).
    let grossConfidence = result.gross.confidence;
    if (grossCents === null && netCents !== null && vatCents !== null) {
      grossCents = netCents + vatCents;
      grossConfidence = Math.min(result.net.confidence, result.vat.confidence, 0.6);
    }

    const invoiceDate = parseInvoiceDate(result.invoice_date.value);
    const vatRate = result.vat_rate.value !== null ? Number(result.vat_rate.value) : null;

    // Entity/project only count as extracted when they match the configured
    // lists — accounting must never post to an unknown entity or project.
    const settingsNow = getSettings();
    const entity = settingsNow.entities.includes(result.billed_to_entity.value ?? '')
      ? result.billed_to_entity.value
      : null;
    const projectCode = settingsNow.projects.some((p) => p.code === result.project.value)
      ? result.project.value
      : null;

    const confidence: Partial<Record<ConfidenceField, number>> = {
      vendor_name: result.vendor_name.confidence,
      invoice_ref: result.invoice_ref.confidence,
      invoice_date: invoiceDate ? result.invoice_date.confidence : 0,
      net: netCents !== null ? result.net.confidence : 0,
      vat: vatCents !== null ? result.vat.confidence : 0,
      gross: grossCents !== null ? grossConfidence : 0,
      vat_rate: vatRate !== null && Number.isFinite(vatRate) ? result.vat_rate.confidence : 0,
      vat_number: result.vat_number.confidence,
      po_number: result.po_number.confidence,
      entity: entity ? result.billed_to_entity.confidence : 0,
      project: projectCode ? result.project.confidence : 0,
    };

    const routing = resolveRouting(vendorName, vendorNormalized, result.proposed_category, {
      email_or_name: result.proposed_approver.email_or_name,
      confidence: result.proposed_approver.confidence,
      rationale: result.proposed_approver.rationale,
    });

    const snapshot: ExtractionSnapshot = {
      vendor_name: vendorName,
      invoice_ref: result.invoice_ref.value,
      invoice_date: invoiceDate,
      net_cents: netCents,
      vat_cents: vatCents,
      gross_cents: grossCents,
      vat_rate: Number.isFinite(vatRate as number) ? vatRate : null,
      vat_number: result.vat_number.value,
      po_number: result.po_number.value,
      entity,
      project_code: projectCode,
      category: routing.proposed_category,
      approver_id: routing.proposed_approver_id,
    };

    // Reuse the supplier account ref from this vendor's most recent reviewed
    // invoice so Sage refs stay consistent; otherwise suggest one.
    let accountRef: string | null = null;
    if (vendorNormalized) {
      const prev = one<{ supplier_account_ref: string }>(
        `SELECT supplier_account_ref FROM invoices
         WHERE vendor_normalized = ? AND supplier_account_ref IS NOT NULL AND id != ?
         ORDER BY updated_at DESC LIMIT 1`,
        vendorNormalized,
        invoiceId,
      );
      accountRef = prev?.supplier_account_ref ?? (vendorName ? suggestAccountRef(vendorName) : null);
    }

    const duplicateOf = findDuplicate(invoiceId, vendorNormalized, result.invoice_ref.value);

    run(
      `UPDATE invoices SET
         status = 'needs_review', doc_type = ?, vendor_name = ?, vendor_normalized = ?,
         invoice_ref = ?, invoice_date = ?, net_cents = ?, vat_cents = ?, gross_cents = ?,
         vat_rate = ?, vat_number = ?, po_number = ?, supplier_account_ref = ?,
         entity = ?, project_code = ?,
         line_items = ?, field_confidence = ?, extraction_snapshot = ?, extraction_provider = ?,
         extraction_error = NULL,
         proposed_category = ?, proposed_approver_id = ?, routing_confidence = ?,
         routing_rationale = ?, matched_rule_id = ?, duplicate_of = ?, updated_at = ?
       WHERE id = ?`,
      result.doc_type,
      vendorName,
      vendorNormalized,
      result.invoice_ref.value,
      invoiceDate,
      netCents,
      vatCents,
      grossCents,
      Number.isFinite(vatRate as number) ? vatRate : null,
      result.vat_number.value,
      result.po_number.value,
      accountRef,
      entity,
      projectCode,
      JSON.stringify(result.line_items),
      JSON.stringify(confidence),
      JSON.stringify(snapshot),
      extractor.name,
      routing.proposed_category,
      routing.proposed_approver_id,
      routing.routing_confidence,
      routing.routing_rationale,
      routing.matched_rule_id,
      duplicateOf,
      nowIso(),
      invoiceId,
    );

    audit(invoiceId, 'extraction_completed', 'system', {
      provider: extractor.name,
      doc_type: result.doc_type,
      vendor: vendorName,
      invoice_ref: result.invoice_ref.value,
      confidence,
      routing_rationale: routing.routing_rationale,
      matched_rule_id: routing.matched_rule_id,
    });
    if (duplicateOf) {
      audit(invoiceId, 'duplicate_flagged', 'system', { duplicate_of: duplicateOf });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run(
      `UPDATE invoices SET status = 'extraction_failed', extraction_error = ?, extraction_provider = ?, updated_at = ? WHERE id = ?`,
      message,
      extractor.name,
      nowIso(),
      invoiceId,
    );
    audit(invoiceId, 'extraction_failed', 'system', { error: message });
    if (err instanceof UnreadableDocumentError) {
      await raiseAlert('unreadable_attachment', { invoiceId, attachmentName: ctx.attachmentName, error: message });
    } else {
      await raiseAlert('extraction_failure', {
        invoiceId, vendor: ctx.vendor, invoiceRef: ctx.invoiceRef, error: message,
      });
    }
  }
}

/** Re-queue a failed invoice for another extraction attempt. */
export function resetForRetry(invoiceId: string): boolean {
  const row = getInvoiceRow(invoiceId);
  if (!row || row.status !== 'extraction_failed') return false;
  run(`UPDATE invoices SET status = 'received', extraction_error = NULL, updated_at = ? WHERE id = ?`, nowIso(), invoiceId);
  return true;
}
