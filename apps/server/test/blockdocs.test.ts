import { beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, run } from '../src/db/db.js';
import { listApprovedForBlockDocs } from '../src/services/invoices.js';
import { newId } from '../src/domain/util.js';

function insertInvoice(opts: {
  status: string;
  project?: string | null;
  gross?: number;
  vendor?: string;
  ref?: string;
  updatedAt?: string;
}): string {
  const id = newId();
  run(
    `INSERT INTO invoices (id, source, received_at, created_at, updated_at, status,
       project_code, category, vendor_name, invoice_ref, invoice_date, gross_cents, currency)
     VALUES (?, 'test', '2026-06-01T09:00:00Z', '2026-06-01T09:00:00Z', ?, ?, ?, 'Materials', ?, ?, '2026-06-14', ?, 'EUR')`,
    id,
    opts.updatedAt ?? '2026-06-01T09:00:00Z',
    opts.status,
    opts.project === undefined ? 'CLON3' : opts.project,
    opts.vendor ?? 'Hegarty Steel Ltd',
    opts.ref ?? 'INV-4471',
    opts.gross ?? 1845000,
  );
  return id;
}

function insertApproval(invoiceId: string, status: string, decidedAt: string | null): void {
  run(
    `INSERT INTO approval_requests (id, invoice_id, approver_id, provider, status, created_at, decided_at)
     VALUES (?, ?, 'appr-1', 'mock', ?, '2026-06-15T08:00:00Z', ?)`,
    newId(), invoiceId, status, decidedAt,
  );
}

describe('listApprovedForBlockDocs', () => {
  beforeEach(() => {
    closeDb();
    openDb(':memory:');
  });

  it('returns only approved, project-tagged invoices with the export shape', () => {
    const approved = insertInvoice({ status: 'approved' });
    insertApproval(approved, 'approved', '2026-06-18T09:22:41.000Z');
    const noProject = insertInvoice({ status: 'approved', project: null });
    insertApproval(noProject, 'approved', '2026-06-18T10:00:00.000Z');
    insertInvoice({ status: 'needs_review' });
    insertInvoice({ status: 'rejected' });

    const out = listApprovedForBlockDocs();
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      finny_invoice_id: approved,
      project_code: 'CLON3',
      category: 'Materials',
      vendor_name: 'Hegarty Steel Ltd',
      invoice_ref: 'INV-4471',
      invoice_date: '2026-06-14',
      amount: '18450.00',
      currency: 'EUR',
      approved_at: '2026-06-18T09:22:41.000Z',
    });
  });

  it('takes approved_at from the approval decision, not updated_at', () => {
    const id = insertInvoice({ status: 'approved', updatedAt: '2026-06-30T23:59:59Z' });
    insertApproval(id, 'approved', '2026-06-18T09:22:41.000Z');
    // A failed attempt alongside must not duplicate or override the row.
    insertApproval(id, 'failed', null);

    const out = listApprovedForBlockDocs();
    expect(out).toHaveLength(1);
    expect(out[0].approved_at).toBe('2026-06-18T09:22:41.000Z');
  });

  it('filters by project_code and since (inclusive)', () => {
    const a = insertInvoice({ status: 'approved', project: 'CLON3', ref: 'A' });
    insertApproval(a, 'approved', '2026-06-10T00:00:00.000Z');
    const b = insertInvoice({ status: 'approved', project: 'DOCKM', ref: 'B' });
    insertApproval(b, 'approved', '2026-06-20T00:00:00.000Z');

    expect(listApprovedForBlockDocs('DOCKM').map((r) => r.invoice_ref)).toEqual(['B']);
    expect(listApprovedForBlockDocs(undefined, '2026-06-20T00:00:00.000Z').map((r) => r.invoice_ref)).toEqual(['B']);
    expect(listApprovedForBlockDocs('CLON3', '2026-06-20T00:00:00.000Z')).toHaveLength(0);
  });

  it('orders newest approval first', () => {
    const older = insertInvoice({ status: 'approved', ref: 'OLD' });
    insertApproval(older, 'approved', '2026-06-01T00:00:00.000Z');
    const newer = insertInvoice({ status: 'approved', ref: 'NEW' });
    insertApproval(newer, 'approved', '2026-06-25T00:00:00.000Z');

    expect(listApprovedForBlockDocs().map((r) => r.invoice_ref)).toEqual(['NEW', 'OLD']);
  });
});
