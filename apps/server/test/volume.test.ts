import { beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, run } from '../src/db/db.js';
import { seedDefaults } from '../src/services/settings.js';
import { volumeMetrics } from '../src/services/metrics.js';

let seq = 0;
function insertInvoice(opts: {
  vendor?: string | null;
  invoiceDate?: string | null;
  receivedAt?: string;
  gross?: number | null;
  status?: string;
}): void {
  seq += 1;
  run(
    `INSERT INTO invoices (id, source, received_at, attachment_name, attachment_mime, attachment_path,
       attachment_size, status, vendor_name, invoice_date, gross_cents, created_at, updated_at)
     VALUES (?, 'test', ?, 'a.pdf', 'application/pdf', '/tmp/a.pdf', 1, ?, ?, ?, ?, ?, ?)`,
    `inv-${seq}`,
    opts.receivedAt ?? '2026-07-03T10:00:00.000Z',
    opts.status ?? 'needs_review',
    opts.vendor === undefined ? 'Vendor A' : opts.vendor,
    opts.invoiceDate ?? null,
    opts.gross ?? null,
    '2026-07-01T00:00:00.000Z',
    '2026-07-01T00:00:00.000Z',
  );
}

describe('volumeMetrics', () => {
  beforeEach(() => {
    closeDb();
    openDb(':memory:');
    seedDefaults();
    seq = 0;
  });

  it('totals on the range; trend is trailing-12-months of actual calendar months', () => {
    insertInvoice({ invoiceDate: '2026-07-01', gross: 10000 });
    insertInvoice({ invoiceDate: '2026-07-01', gross: 25000 });
    // No printed invoice date -> dated by arrival (3 Jul).
    insertInvoice({ invoiceDate: null, receivedAt: '2026-07-03T09:00:00.000Z', gross: 5000 });
    // Dated inside the range but received outside it — invoice date wins.
    insertInvoice({ invoiceDate: '2026-07-02', receivedAt: '2026-08-09T09:00:00.000Z', gross: null });
    // Before the range: excluded from totals, visible in the trend context.
    insertInvoice({ invoiceDate: '2026-06-30', gross: 99999 });
    // Older than the trailing year: not charted at all.
    insertInvoice({ invoiceDate: '2025-01-15', gross: 11111 });

    const v = volumeMetrics('2026-07-01', '2026-07-04');
    expect(v.totals).toEqual({ count: 4, gross_cents: 40000 });
    expect(v.bucket).toBe('month');
    expect(v.series_from).toBe('2025-08-01');
    expect(v.series).toHaveLength(12); // Aug-25 .. Jul-26, gap-filled
    expect(v.series[0]).toEqual({ bucket: '2025-08', count: 0, gross_cents: 0 });
    expect(v.series[10]).toEqual({ bucket: '2026-06', count: 1, gross_cents: 99999 });
    expect(v.series[11]).toEqual({ bucket: '2026-07', count: 4, gross_cents: 40000 });
  });

  it('excludes discarded documents (filed statements are not invoices)', () => {
    insertInvoice({ invoiceDate: '2026-07-01', gross: 10000 });
    insertInvoice({ invoiceDate: '2026-07-01', gross: 88800, status: 'discarded' });
    const v = volumeMetrics('2026-07-01', '2026-07-31');
    expect(v.totals).toEqual({ count: 1, gross_cents: 10000 });
  });

  it('a custom range longer than a year charts its own months', () => {
    insertInvoice({ invoiceDate: '2025-02-15', gross: 1000 });
    insertInvoice({ invoiceDate: '2026-05-20', gross: 2000 });
    const v = volumeMetrics('2025-01-01', '2026-06-30');
    expect(v.series_from).toBe('2025-01-01'); // range start wins when older than 12 months back
    expect(v.series).toHaveLength(18); // Jan-25 .. Jun-26
    expect(v.series[1]).toEqual({ bucket: '2025-02', count: 1, gross_cents: 1000 });
    expect(v.series[16]).toEqual({ bucket: '2026-05', count: 1, gross_cents: 2000 });
  });

  it('ranks top suppliers by value and by count independently', () => {
    insertInvoice({ vendor: 'Big Once', invoiceDate: '2026-07-02', gross: 900000 });
    for (let i = 0; i < 3; i++) insertInvoice({ vendor: 'Small Often', invoiceDate: '2026-07-03', gross: 1000 });
    insertInvoice({ vendor: null, invoiceDate: '2026-07-04', gross: 500 });

    const v = volumeMetrics('2026-07-01', '2026-07-31');
    expect(v.top_by_value[0]).toEqual({ vendor: 'Big Once', count: 1, gross_cents: 900000 });
    expect(v.top_by_count[0]).toEqual({ vendor: 'Small Often', count: 3, gross_cents: 3000 });
    expect(v.top_by_value.map((r) => r.vendor)).toContain('(unknown vendor)');
  });
});
