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

  it('totals, daily buckets with gap fill, and invoice-date-over-arrival dating', () => {
    insertInvoice({ invoiceDate: '2026-07-01', gross: 10000 });
    insertInvoice({ invoiceDate: '2026-07-01', gross: 25000 });
    // No printed invoice date -> dated by arrival (3 Jul).
    insertInvoice({ invoiceDate: null, receivedAt: '2026-07-03T09:00:00.000Z', gross: 5000 });
    // Dated inside the range but received outside it — invoice date wins.
    insertInvoice({ invoiceDate: '2026-07-02', receivedAt: '2026-08-09T09:00:00.000Z', gross: null });
    // Outside the range entirely.
    insertInvoice({ invoiceDate: '2026-06-30', gross: 99999 });

    const v = volumeMetrics('2026-07-01', '2026-07-04');
    expect(v.bucket).toBe('day');
    expect(v.totals).toEqual({ count: 4, gross_cents: 40000 });
    expect(v.series).toEqual([
      { bucket: '2026-07-01', count: 2, gross_cents: 35000 },
      { bucket: '2026-07-02', count: 1, gross_cents: 0 }, // gross unknown -> counts, adds no value
      { bucket: '2026-07-03', count: 1, gross_cents: 5000 },
      { bucket: '2026-07-04', count: 0, gross_cents: 0 }, // gap filled
    ]);
  });

  it('excludes discarded documents (filed statements are not invoices)', () => {
    insertInvoice({ invoiceDate: '2026-07-01', gross: 10000 });
    insertInvoice({ invoiceDate: '2026-07-01', gross: 88800, status: 'discarded' });
    const v = volumeMetrics('2026-07-01', '2026-07-31');
    expect(v.totals).toEqual({ count: 1, gross_cents: 10000 });
  });

  it('switches to monthly buckets for long ranges', () => {
    insertInvoice({ invoiceDate: '2026-03-15', gross: 1000 });
    insertInvoice({ invoiceDate: '2026-05-20', gross: 2000 });
    const v = volumeMetrics('2026-03-01', '2026-06-30');
    expect(v.bucket).toBe('month');
    expect(v.series.map((p) => p.bucket)).toEqual(['2026-03', '2026-04', '2026-05', '2026-06']);
    expect(v.series[1]).toEqual({ bucket: '2026-04', count: 0, gross_cents: 0 });
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
