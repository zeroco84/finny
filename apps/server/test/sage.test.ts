import { describe, expect, it } from 'vitest';
import { buildSageCsv, taxCodeForRate, SAGE_HEADERS } from '../src/services/sage.js';
import { DEFAULT_SETTINGS } from '../src/services/settings.js';

const line = {
  supplier_account_ref: 'HEGARTY1',
  category: 'Materials',
  invoice_date: '2026-06-28',
  invoice_ref: 'HS-1234',
  vendor_name: 'Hegarty Steel Ltd',
  net_cents: 100000,
  vat_cents: 23000,
  gross_cents: 123000,
  vat_rate: 23,
  po_number: 'TW-PO-4001',
};

describe('buildSageCsv', () => {
  it('produces a PI row with the mapped nominal and tax codes', () => {
    const csv = buildSageCsv([line], DEFAULT_SETTINGS);
    const rows = csv.trim().split('\r\n');
    expect(rows[0]).toBe(SAGE_HEADERS.join(','));
    const cells = rows[1].split(',');
    expect(cells[0]).toBe('PI');
    expect(cells[1]).toBe('HEGARTY1');
    expect(cells[2]).toBe('5200'); // Materials nominal
    expect(cells[4]).toBe('28/06/2026');
    expect(cells[7]).toBe('1000.00');
    expect(cells[8]).toBe('T1');
    expect(cells[9]).toBe('230.00');
    expect(cells[11]).toBe('TW-PO-4001');
  });

  it('derives net from gross when net is missing', () => {
    const csv = buildSageCsv([{ ...line, net_cents: null }], DEFAULT_SETTINGS);
    expect(csv).toContain('1000.00');
  });

  it('escapes commas and quotes in details', () => {
    const csv = buildSageCsv(
      [{ ...line, vendor_name: 'Smith, Jones "and" Co' }],
      DEFAULT_SETTINGS,
    );
    expect(csv).toContain('"Smith, Jones ""and"" Co — Materials"');
  });

  it('rejects categories with no nominal mapping', () => {
    expect(() => buildSageCsv([{ ...line, category: 'Mystery' }], DEFAULT_SETTINGS)).toThrow(/nominal/i);
  });
});

describe('taxCodeForRate', () => {
  it('maps configured Irish VAT rates', () => {
    expect(taxCodeForRate(23, DEFAULT_SETTINGS)).toBe('T1');
    expect(taxCodeForRate(13.5, DEFAULT_SETTINGS)).toBe('T2');
    expect(taxCodeForRate(0, DEFAULT_SETTINGS)).toBe('T0');
  });
  it('falls back to the default code', () => {
    expect(taxCodeForRate(null, DEFAULT_SETTINGS)).toBe('T1');
    expect(taxCodeForRate(21, DEFAULT_SETTINGS)).toBe('T1');
  });
});
