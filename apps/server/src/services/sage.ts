import fs from 'node:fs';
import path from 'node:path';
import type { SageBatch, Settings } from '@finny/shared';
import { all, one, run } from '../db/db.js';
import { config } from '../config.js';
import { centsToDecimal, newId, nowIso, toSageDate } from '../domain/util.js';
import { audit } from './audit.js';
import { raiseAlert } from './alerts.js';
import { getSettings } from './settings.js';

/**
 * Sage 50 (UK/Ireland) audit-trail transaction import, type PI (purchase
 * invoice). Column layout follows Sage's standard CSV import template —
 * validate one batch against the live Sage 50 install before relying on it
 * (nominal codes and tax codes are configurable in Settings).
 */
export const SAGE_HEADERS = [
  'Type', 'Account Reference', 'Nominal A/C Ref', 'Department Code', 'Date',
  'Reference', 'Details', 'Net Amount', 'Tax Code', 'Tax Amount',
  'Exchange Rate', 'Extra Reference', 'User Name', 'Project Refn', 'Cost Code Refn',
] as const;

export interface SageLineInput {
  supplier_account_ref: string;
  category: string;
  invoice_date: string | null; // yyyy-mm-dd
  invoice_ref: string;
  vendor_name: string;
  net_cents: number | null;
  vat_cents: number | null;
  gross_cents: number;
  vat_rate: number | null;
  po_number: string | null;
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function taxCodeForRate(rate: number | null, settings: Settings): string {
  if (rate === null) return settings.default_tax_code;
  const key = Number.isInteger(rate) ? String(rate) : String(rate);
  return settings.tax_codes[key] ?? settings.default_tax_code;
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
    const cells = [
      'PI',
      line.supplier_account_ref,
      nominal,
      settings.sage_department,
      toSageDate(line.invoice_date),
      line.invoice_ref,
      `${line.vendor_name} — ${line.category}`,
      centsToDecimal(netCents),
      taxCodeForRate(line.vat_rate, settings),
      centsToDecimal(vatCents),
      '1',
      line.po_number ?? '',
      'Finny',
      '',
      '',
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

export async function generateBatch(invoiceIds: string[], who: string): Promise<SageBatch> {
  const pool = exportPool();
  const wanted = new Set(invoiceIds);
  const rows = pool.filter((r) => wanted.has(String(r.id)));
  if (rows.length === 0) throw new Error('No exportable invoices selected');

  try {
    const lines: SageLineInput[] = rows.map((r) => ({
      supplier_account_ref: String(r.supplier_account_ref ?? ''),
      category: String(r.category ?? ''),
      invoice_date: r.invoice_date === null ? null : String(r.invoice_date),
      invoice_ref: String(r.invoice_ref ?? ''),
      vendor_name: String(r.vendor_name ?? ''),
      net_cents: r.net_cents === null ? null : Number(r.net_cents),
      vat_cents: r.vat_cents === null ? null : Number(r.vat_cents),
      gross_cents: Number(r.gross_cents ?? 0),
      vat_rate: r.vat_rate === null ? null : Number(r.vat_rate),
      po_number: r.po_number === null ? null : String(r.po_number),
    }));
    const csv = buildSageCsv(lines, getSettings());

    const now = new Date();
    const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '_');
    const id = newId();
    const filename = `FINNY_SAGE_${stamp}_${id.slice(0, 6)}.csv`;
    const filePath = path.join(config.exportsDir, filename);
    fs.writeFileSync(filePath, csv);

    const total = lines.reduce((sum, l) => sum + l.gross_cents, 0);
    run(
      `INSERT INTO sage_batches (id, created_by, created_at, filename, path, invoice_count, total_gross_cents, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'generated')`,
      id, who, nowIso(), filename, filePath, lines.length, total,
    );
    for (const r of rows) {
      run(`UPDATE invoices SET sage_batch_id = ?, updated_at = ? WHERE id = ?`, id, nowIso(), String(r.id));
      audit(String(r.id), 'sent_to_sage_batch', who, { batch_id: id, filename });
    }
    audit(null, 'sage_batch_generated', who, { batch_id: id, filename, invoices: lines.length });
    return getBatch(id)!;
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
