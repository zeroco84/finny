import fs from 'node:fs';
import path from 'node:path';
import type { SageBatch, Settings } from '@finny/shared';
import { all, one, run } from '../db/db.js';
import { config } from '../config.js';
import { centsToDecimal, newId, nowIso, toSageDate } from '../domain/util.js';
import { audit } from './audit.js';
import { raiseAlert } from './alerts.js';
import { getSettings, updateSettings } from './settings.js';
import {
  buildPurchaseInvoicePayload,
  findDuplicateInSage,
  findMaxPostingNumber,
  findPurchaseTxByRef,
  isOwnPosting,
  postPurchaseInvoice,
  resolveSageServer,
  type SageServer,
} from './sage/hyperaccounts.js';

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
  // Manager rejected this invoice: it still posts (so the ledger is complete)
  // but is flagged DISPUTED in Details for the AP lead to hold before payment.
  disputed: boolean;
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function taxCodeForRate(rate: number | null, settings: Settings): string {
  if (rate === null) return settings.default_tax_code;
  return settings.tax_codes[String(rate)] ?? settings.default_tax_code;
}

/** "Inv4590 - Bulky Waste (OTN/PO 8749)" — the sheet's Details convention.
 * A manager-rejected invoice is prefixed "DISPUTED " so it is unmistakable in
 * Sage; the prefix leads so it survives the 60-char Details truncation. */
export function buildDetails(line: SageLineInput): string {
  const bare = line.invoice_ref.replace(/^inv[\s-]*/i, '');
  const ref = /^\d+$/.test(bare) ? `Inv${bare}` : line.invoice_ref;
  const parenParts = [line.project_code, line.po_number].filter(Boolean);
  const paren = parenParts.length > 0 ? ` (${parenParts.join('/')})` : '';
  const prefix = line.disputed ? 'DISPUTED ' : '';
  return `${prefix}${ref} - ${line.vendor_name}${paren}`;
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

/** Shared row -> line mapping for the CSV builder and the API payload. */
export function lineFromRow(r: Record<string, unknown>, postingRef: string): SageLineInput {
  return {
    supplier_account_ref: String(r.supplier_account_ref ?? ''),
    category: String(r.category ?? ''),
    invoice_date: r.invoice_date === null ? null : String(r.invoice_date),
    invoice_ref: String(r.invoice_ref ?? ''),
    posting_ref: postingRef,
    vendor_name: String(r.vendor_name ?? ''),
    disputed: String(r.status ?? '') === 'rejected',
    net_cents: r.net_cents === null ? null : Number(r.net_cents),
    vat_cents: r.vat_cents === null ? null : Number(r.vat_cents),
    gross_cents: Number(r.gross_cents ?? 0),
    vat_rate: r.vat_rate === null ? null : Number(r.vat_rate),
    po_number: r.po_number === null || r.po_number === undefined ? null : String(r.po_number),
    project_code: r.project_code === null || r.project_code === undefined ? null : String(r.project_code),
  };
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
        return lineFromRow(r, existing ?? `Inv${nextRef++}`);
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
  const posted = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM invoices WHERE sage_batch_id = ? AND sage_tx_number IS NOT NULL`,
    String(r.id),
  );
  return {
    id: String(r.id),
    created_by: String(r.created_by),
    created_at: String(r.created_at),
    entity: r.entity === null || r.entity === undefined ? null : String(r.entity),
    filename: String(r.filename),
    invoice_count: Number(r.invoice_count),
    total_gross_cents: Number(r.total_gross_cents),
    status: r.status as SageBatch['status'],
    posted_count: posted ? Number(posted.n) : 0,
    marked_imported_by: r.marked_imported_by === null ? null : String(r.marked_imported_by),
    marked_imported_at: r.marked_imported_at === null ? null : String(r.marked_imported_at),
  };
}

/** Distinct HyperAccounts servers (by URL) behind a set of entities. */
function serversForEntities(entities: (string | null)[]): SageServer[] {
  const seen = new Map<string, SageServer>();
  for (const entity of entities) {
    const server = resolveSageServer(entity);
    if (server && !seen.has(server.url)) seen.set(server.url, server);
  }
  return [...seen.values()];
}

/**
 * Sequencing pre-check, run BEFORE posting refs are assigned: read every
 * relevant Sage company for the highest existing Inv-series PI reference. If
 * anyone has posted at or past Finny's counter (manual posting still happens
 * during transition), fast-forward the counter so the new batch can't collide.
 * Read-only against Sage; unreachable servers are skipped here because the
 * send step will surface connectivity properly.
 */
export async function syncPostingSequence(
  invoiceIds: string[],
  who: string,
): Promise<{ checked: number; adjusted: boolean; from?: number; to?: number }> {
  if (config.sage.provider !== 'hyperaccounts') return { checked: 0, adjusted: false };
  const wanted = new Set(invoiceIds);
  const entities = exportPool()
    .filter((r) => wanted.has(String(r.id)))
    .map((r) => (r.entity === null || r.entity === undefined ? null : String(r.entity)));
  const servers = serversForEntities(entities);

  let sageMax: number | null = null;
  let checked = 0;
  for (const server of servers) {
    try {
      const max = await findMaxPostingNumber(server);
      checked++;
      if (max !== null && (sageMax === null || max > sageMax)) sageMax = max;
    } catch (err) {
      console.warn(`[sage] sequence pre-check skipped for ${server.entity}: ${err instanceof Error ? err.message : err}`);
    }
  }

  const settings = getSettings();
  if (sageMax === null || sageMax < settings.next_posting_ref) {
    return { checked, adjusted: false };
  }
  const from = settings.next_posting_ref;
  const to = sageMax + 1;
  updateSettings({ next_posting_ref: to });
  audit(null, 'posting_sequence_adjusted', who, { from, to, sage_max_ref: `Inv${sageMax}` });
  await raiseAlert('sage_sequence_adjusted', {
    error: `Sage already holds references up to Inv${sageMax}`,
    extra: `Inv${from} → Inv${to}`,
  });
  return { checked, adjusted: true, from, to };
}

/**
 * A fresh posting ref that is safe against BOTH Finny's counter and what is
 * already in this Sage company — used when a manual post is found squatting
 * on a ref Finny had assigned.
 */
async function nextSafePostingRef(server: SageServer): Promise<string> {
  const sageMax = await findMaxPostingNumber(server).catch(() => null);
  const settings = getSettings();
  const n = Math.max(settings.next_posting_ref, (sageMax ?? 0) + 1);
  updateSettings({ next_posting_ref: n + 1 });
  return `Inv${n}`;
}

/**
 * One-touch "Send to Sage" (SAGE_PROVIDER=hyperaccounts): post every not-yet-
 * posted invoice in a batch to the entity's HyperAccounts server. Finny reads
 * Sage before every write:
 *
 *   1. Own ref already in Sage + same supplier & gross -> a previous send
 *      crashed after posting; adopt the transaction, never post twice.
 *      Same ref but a DIFFERENT supplier/amount -> a manual post took the
 *      ref; reassign a fresh safe ref and carry on.
 *   2. Same supplier account + supplier invoice number in Details + same
 *      gross under another ref -> someone already posted this invoice by
 *      hand; link to that transaction instead of posting, and alert the
 *      team to verify.
 *   3. Otherwise post, and store the returned transaction number.
 *
 * Partial failure leaves the batch 'generated' with an alert; retrying sends
 * only what's still missing.
 */
export async function sendBatchToSage(
  batchId: string,
  who: string,
): Promise<{
  posted: number;
  adopted: number;
  duplicates: number;
  reassigned: number;
  skipped: number;
  failed: number;
  errors: string[];
}> {
  if (config.sage.provider !== 'hyperaccounts') {
    throw new Error('SAGE_PROVIDER is not hyperaccounts — one-touch posting is disabled');
  }
  const batch = getBatch(batchId);
  if (!batch) throw new Error('Batch not found');
  const server = resolveSageServer(batch.entity);
  if (!server) {
    const message = `No HyperAccounts server configured for entity "${batch.entity ?? 'unassigned'}" — set SAGE_API_URL or SAGE_ENTITY_SERVERS`;
    await raiseAlert('sage_export_failure', { error: message });
    throw new Error(message);
  }

  const settings = getSettings();
  const rows = all(`SELECT * FROM invoices WHERE sage_batch_id = ? ORDER BY confirmed_at ASC`, batchId);
  const summary = {
    posted: 0, adopted: 0, duplicates: 0, reassigned: 0, skipped: 0, failed: 0,
    errors: [] as string[],
  };

  const store = (invoiceId: string, txNumber: number) => {
    run(
      `UPDATE invoices SET sage_tx_number = ?, sage_posted_at = ?, updated_at = ? WHERE id = ?`,
      String(txNumber), nowIso(), nowIso(), invoiceId,
    );
  };

  for (const r of rows) {
    const invoiceId = String(r.id);
    if (r.sage_tx_number !== null && r.sage_tx_number !== undefined) {
      summary.skipped++;
      continue;
    }
    try {
      const line = lineFromRow(r, String(r.posting_ref ?? ''));

      // Pre-check 1: is our ref already in Sage?
      const onRef = line.posting_ref ? await findPurchaseTxByRef(server, line.posting_ref) : [];
      const own = onRef.find((h) => isOwnPosting(h, line.supplier_account_ref, line.gross_cents));
      if (own) {
        store(invoiceId, own.tranNumber);
        audit(invoiceId, 'posted_to_sage', who, {
          tx_number: own.tranNumber, entity: batch.entity, batch_id: batchId,
          adopted_existing: true,
        });
        summary.adopted++;
        continue;
      }
      if (onRef.length > 0) {
        // A manual post is squatting on our ref — burn it, take a fresh one.
        const freshRef = await nextSafePostingRef(server);
        run(`UPDATE invoices SET posting_ref = ?, updated_at = ? WHERE id = ?`, freshRef, nowIso(), invoiceId);
        audit(invoiceId, 'posting_ref_reassigned', who, {
          from: line.posting_ref, to: freshRef,
          reason: `Sage tx ${onRef[0].tranNumber} (${onRef[0].accountRef}) already uses ${line.posting_ref}`,
        });
        line.posting_ref = freshRef;
        summary.reassigned++;
      }

      // Pre-check 2: did someone already post this supplier invoice by hand?
      const duplicate = await findDuplicateInSage(
        server, line.supplier_account_ref, line.invoice_ref, line.gross_cents, line.posting_ref,
      );
      if (duplicate) {
        store(invoiceId, duplicate.tranNumber);
        audit(invoiceId, 'linked_to_existing_sage_tx', who, {
          tx_number: duplicate.tranNumber, sage_ref: duplicate.invRef,
          entity: batch.entity, batch_id: batchId,
        });
        await raiseAlert('sage_duplicate_detected', {
          invoiceId,
          vendor: line.vendor_name,
          invoiceRef: line.invoice_ref,
          error: `Sage transaction ${duplicate.tranNumber} (ref ${duplicate.invRef}) on account ${line.supplier_account_ref} already has this invoice number and amount`,
        });
        summary.duplicates++;
        continue;
      }

      // Clear to post.
      const txNumber = await postPurchaseInvoice(server, buildPurchaseInvoicePayload(invoiceId, line, settings));
      store(invoiceId, txNumber);
      audit(invoiceId, 'posted_to_sage', who, {
        tx_number: txNumber, entity: batch.entity, batch_id: batchId,
        ...(line.posting_ref !== String(r.posting_ref ?? '') ? { posting_ref: line.posting_ref } : {}),
      });
      summary.posted++;
    } catch (err) {
      summary.failed++;
      summary.errors.push(`${String(r.invoice_ref ?? invoiceId)}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (summary.failed === 0 && batch.status === 'generated') {
    run(`UPDATE sage_batches SET status = 'posted' WHERE id = ?`, batchId);
    audit(null, 'sage_batch_posted', who, {
      batch_id: batchId, entity: batch.entity,
      posted: summary.posted, adopted: summary.adopted, duplicates: summary.duplicates,
      reassigned: summary.reassigned, skipped: summary.skipped,
    });
  } else if (summary.failed > 0) {
    await raiseAlert('sage_export_failure', {
      error: `Send to Sage: ${summary.failed}/${rows.length} invoice(s) failed for ${batch.entity ?? 'unassigned'} — ${summary.errors[0]}`,
    });
  }
  return summary;
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
