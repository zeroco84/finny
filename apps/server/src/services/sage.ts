import fs from 'node:fs';
import path from 'node:path';
import type { SageBatch, Settings } from '@finny/shared';
import { all, one, run } from '../db/db.js';
import { config } from '../config.js';
import { centsToDecimal, newId, nowIso, toSageDate } from '../domain/util.js';
import { audit } from './audit.js';
import { raiseAlert } from './alerts.js';
import { getSettings, updateSettings } from './settings.js';

/**
 * Batch-posting CSV matching the AP team's working sheet ("Invoices to be
 * posted") column-for-column — the columns Sage 50's batch supplier invoice
 * entry expects:
 *
 *   A/C, Date, Ref, Ex Ref, N/C, Dept, Details, Net, T/C, Vat, Gross
 *
 * Ref is Finny's own sequential posting reference (the sheet's "Inv27xxx"
 * series); the supplier's invoice number goes inside Details, e.g.
 * "Inv4590 - Bulky Waste (OTN/PO 8749)". Dept comes from the invoice's
 * project (site/development), zero-VAT lines post with the 0% tax code
 * (T9 by default). Nominal + tax codes are configurable in Settings.
 */
export const SAGE_HEADERS = [
  'A/C', 'Date', 'Ref', 'Ex Ref', 'N/C', 'Dept', 'Details', 'Net', 'T/C', 'Vat', 'Gross',
] as const;

export interface SageLineInput {
  supplier_account_ref: string;
  category: string;
  invoice_date: string | null; // yyyy-mm-dd
  invoice_ref: string; // the SUPPLIER's invoice number (goes into Details)
  posting_ref: string; // Finny's sequential internal ref (the Ref column)
  vendor_name: string;
  net_cents: number | null;
  vat_cents: number | null;
  gross_cents: number;
  vat_rate: number | null;
  po_number: string | null;
  project_code: string | null; // resolves to the project's Dept number
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function taxCodeForRate(rate: number | null, settings: Settings): string {
  if (rate === null) return settings.default_tax_code;
  return settings.tax_codes[String(rate)] ?? settings.default_tax_code;
}

/** "Inv4590 - Bulky Waste (OTN/PO 8749)" — the sheet's Details convention. */
export function buildDetails(line: SageLineInput): string {
  const bare = line.invoice_ref.replace(/^inv[\s-]*/i, '');
  const ref = /^\d+$/.test(bare) ? `Inv${bare}` : line.invoice_ref;
  const parenParts = [line.project_code, line.po_number].filter(Boolean);
  const paren = parenParts.length > 0 ? ` (${parenParts.join('/')})` : '';
  return `${ref} - ${line.vendor_name}${paren}`;
}

export function buildSageCsv(lines: SageLineInput[], settings: Settings): string {
  const rows: string[] = [SAGE_HEADERS.join(',')];
  for (const line of lines) {
    const nominal =
      settings.categories.find((c) => c.name === line.category)?.nominal_code;
    if (!nominal) {
      throw new Error(`No nominal code configured for category "${line.category}" — add it in Settings`);
    }
    const netCents = line.net_cents ?? line.gross_cents - (line.vat_cents ?? 0);
    const vatCents = line.vat_cents ?? line.gross_cents - netCents;
    const dept = line.project_code
      ? settings.projects.find((p) => p.code === line.project_code)?.dept ?? settings.sage_department
      : settings.sage_department;
    // Zero-VAT lines take the 0% code (T9, outside scope, per the AP sheet).
    const taxCode = vatCents === 0
      ? settings.tax_codes['0'] ?? settings.default_tax_code
      : taxCodeForRate(line.vat_rate, settings);
    const cells = [
      line.supplier_account_ref,
      toSageDate(line.invoice_date),
      line.posting_ref,
      line.po_number ?? '',
      nominal,
      dept,
      buildDetails(line),
      centsToDecimal(netCents),
      taxCode,
      centsToDecimal(vatCents),
      centsToDecimal(line.gross_cents),
    ];
    rows.push(cells.map(csvField).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}

/** Confirmed invoices not yet in a batch — the export pool. */
export function exportPool(): Record<string, unknown>[] {
  return all(
    `SELECT * FROM invoices
     WHERE confirmed_at IS NOT NULL AND sage_batch_id IS NULL AND shadow = 0
       AND status IN ('confirmed', 'awaiting_approval', 'approved', 'rejected')
     ORDER BY confirmed_at ASC`,
  );
}

/**
 * Generate import batches for the selected invoices — one batch PER legal
 * entity, because each entity is its own Sage 50 company dataset and a mixed
 * file could be imported into the wrong books.
 */
export async function generateBatches(invoiceIds: string[], who: string): Promise<SageBatch[]> {
  const pool = exportPool();
  const wanted = new Set(invoiceIds);
  const rows = pool.filter((r) => wanted.has(String(r.id)));
  if (rows.length === 0) throw new Error('No exportable invoices selected');

  try {
    const byEntity = new Map<string | null, typeof rows>();
    for (const r of rows) {
      const entity = r.entity === null || r.entity === undefined ? null : String(r.entity);
      const group = byEntity.get(entity) ?? [];
      group.push(r);
      byEntity.set(entity, group);
    }

    const settings = getSettings();
    // One sequential posting-ref series across every batch (the sheet's
    // "Inv27xxx" Ref column); the counter lives in settings.
    let nextRef = settings.next_posting_ref;
    const batches: SageBatch[] = [];
    for (const [entity, group] of byEntity) {
      const lines: SageLineInput[] = group.map((r) => {
        const existing = r.posting_ref === null || r.posting_ref === undefined ? null : String(r.posting_ref);
        return {
          supplier_account_ref: String(r.supplier_account_ref ?? ''),
          category: String(r.category ?? ''),
          invoice_date: r.invoice_date === null ? null : String(r.invoice_date),
          invoice_ref: String(r.invoice_ref ?? ''),
          posting_ref: existing ?? `Inv${nextRef++}`,
          vendor_name: String(r.vendor_name ?? ''),
          net_cents: r.net_cents === null ? null : Number(r.net_cents),
          vat_cents: r.vat_cents === null ? null : Number(r.vat_cents),
          gross_cents: Number(r.gross_cents ?? 0),
          vat_rate: r.vat_rate === null ? null : Number(r.vat_rate),
          po_number: r.po_number === null ? null : String(r.po_number),
          project_code: r.project_code === null || r.project_code === undefined ? null : String(r.project_code),
        };
      });
      const csv = buildSageCsv(lines, settings);

      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '_');
      const id = newId();
      const slug = entity ? entity.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : 'UNASSIGNED';
      const filename = `FINNY_SAGE_${slug}_${stamp}_${id.slice(0, 6)}.csv`;
      const filePath = path.join(config.exportsDir, filename);
      fs.writeFileSync(filePath, csv);

      const total = lines.reduce((sum, l) => sum + l.gross_cents, 0);
      run(
        `INSERT INTO sage_batches (id, created_by, created_at, entity, filename, path, invoice_count, total_gross_cents, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'generated')`,
        id, who, nowIso(), entity, filename, filePath, lines.length, total,
      );
      group.forEach((r, i) => {
        run(
          `UPDATE invoices SET sage_batch_id = ?, posting_ref = ?, updated_at = ? WHERE id = ?`,
          id, lines[i].posting_ref, nowIso(), String(r.id),
        );
        audit(String(r.id), 'sent_to_sage_batch', who, {
          batch_id: id, filename, entity, posting_ref: lines[i].posting_ref,
        });
      });
      audit(null, 'sage_batch_generated', who, { batch_id: id, filename, entity, invoices: lines.length });
      batches.push(getBatch(id)!);
    }
    if (nextRef !== settings.next_posting_ref) {
      updateSettings({ next_posting_ref: nextRef });
    }
    return batches;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await raiseAlert('sage_export_failure', { error: message });
    throw err;
  }
}

function mapBatch(r: Record<string, unknown>): SageBatch {
  return {
    id: String(r.id),
    created_by: String(r.created_by),
    created_at: String(r.created_at),
    entity: r.entity === null || r.entity === undefined ? null : String(r.entity),
    filename: String(r.filename),
    invoice_count: Number(r.invoice_count),
    total_gross_cents: Number(r.total_gross_cents),
    status: r.status as SageBatch['status'],
    marked_imported_by: r.marked_imported_by === null ? null : String(r.marked_imported_by),
    marked_imported_at: r.marked_imported_at === null ? null : String(r.marked_imported_at),
  };
}

export function listBatches(): SageBatch[] {
  return all('SELECT * FROM sage_batches ORDER BY created_at DESC').map(mapBatch);
}

export function getBatch(id: string): SageBatch | null {
  const row = one('SELECT * FROM sage_batches WHERE id = ?', id);
  return row ? mapBatch(row) : null;
}

export function batchFilePath(id: string): string | null {
  const row = one<{ path: string }>('SELECT path FROM sage_batches WHERE id = ?', id);
  return row ? row.path : null;
}

export function markImported(id: string, who: string): SageBatch | null {
  const batch = getBatch(id);
  if (!batch) return null;
  run(
    `UPDATE sage_batches SET status = 'marked_imported', marked_imported_by = ?, marked_imported_at = ? WHERE id = ?`,
    who, nowIso(), id,
  );
  const invoiceIds = all<{ id: string }>('SELECT id FROM invoices WHERE sage_batch_id = ?', id);
  for (const inv of invoiceIds) {
    audit(String(inv.id), 'sage_batch_imported', who, { batch_id: id });
  }
  return getBatch(id);
}
