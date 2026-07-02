import { describe, expect, it } from 'vitest';
import { buildDetails, buildSageCsv, taxCodeForRate, SAGE_HEADERS } from '../src/services/sage.js';
import { DEFAULT_SETTINGS } from '../src/services/settings.js';

// Layout mirrors the AP team's posting sheet ("TS - Invoices to be posted"):
// A/C, Date, Ref, Ex Ref, N/C, Dept, Details, Net, T/C, Vat, Gross
const line = {
  supplier_account_ref: 'HEG001',
  category: 'Materials',
  invoice_date: '2026-06-28',
  invoice_ref: '4590',
  posting_ref: 'Inv10001',
  vendor_name: 'Hegarty Steel Ltd',
  net_cents: 100000,
  vat_cents: 23000,
  gross_cents: 123000,
  vat_rate: 23,
  po_number: 'PO 8749',
  project_code: 'CLON3',
};

function row(csv: string, n = 1): string[] {
  return csv.trim().split('\r\n')[n].split(',');
}

describe('buildSageCsv (posting-sheet format)', () => {
  it('emits the exact 11 posting-sheet columns', () => {
    const csv = buildSageCsv([line], DEFAULT_SETTINGS);
    expect(csv.trim().split('\r\n')[0]).toBe('A/C,Date,Ref,Ex Ref,N/C,Dept,Details,Net,T/C,Vat,Gross');
    expect(SAGE_HEADERS).toHaveLength(11);
    const cells = row(csv);
    expect(cells[0]).toBe('HEG001'); // A/C — supplier account
    expect(cells[1]).toBe('28/06/2026'); // Date dd/mm/yyyy
    expect(cells[2]).toBe('Inv10001'); // Ref — Finny's sequential posting ref
    expect(cells[3]).toBe('PO 8749'); // Ex Ref — the PO
    expect(cells[4]).toBe('5200'); // N/C from the category map (Materials)
    expect(cells[5]).toBe('26'); // Dept from the project (CLON3 → 26)
    expect(cells[7]).toBe('1000.00'); // Net
    expect(cells[8]).toBe('T1'); // T/C — VAT present at 23%
    expect(cells[9]).toBe('230.00'); // Vat
    expect(cells[10]).toBe('1230.00'); // Gross
  });

  it('composes Details as Inv<supplier ref> - Vendor (PROJECT/PO)', () => {
    const csv = buildSageCsv([line], DEFAULT_SETTINGS);
    expect(row(csv)[6]).toBe('Inv4590 - Hegarty Steel Ltd (CLON3/PO 8749)');
  });

  it('keeps non-numeric supplier refs verbatim and drops empty paren parts', () => {
    expect(buildDetails({ ...line, invoice_ref: 'HS-1234', project_code: null })).toBe(
      'HS-1234 - Hegarty Steel Ltd (PO 8749)',
    );
    expect(buildDetails({ ...line, invoice_ref: 'Inv110165', po_number: null, project_code: null })).toBe(
      'Inv110165 - Hegarty Steel Ltd',
    );
  });

  it('posts zero-VAT lines with the 0% code (T9), matching the sheet', () => {
    const csv = buildSageCsv(
      [{ ...line, net_cents: 79900, vat_cents: 0, gross_cents: 79900, vat_rate: null }],
      DEFAULT_SETTINGS,
    );
    const cells = row(csv);
    expect(cells[8]).toBe('T9');
    expect(cells[9]).toBe('0.00');
  });

  it('falls back to the default Dept when no project is assigned', () => {
    const csv = buildSageCsv([{ ...line, project_code: null }], DEFAULT_SETTINGS);
    expect(row(csv)[5]).toBe(DEFAULT_SETTINGS.sage_department);
  });

  it('derives net from gross when net is missing', () => {
    const csv = buildSageCsv([{ ...line, net_cents: null }], DEFAULT_SETTINGS);
    expect(row(csv)[7]).toBe('1000.00');
  });

  it('escapes commas and quotes in Details', () => {
    const csv = buildSageCsv(
      [{ ...line, vendor_name: 'Smith, Jones "and" Co' }],
      DEFAULT_SETTINGS,
    );
    expect(csv).toContain('"Inv4590 - Smith, Jones ""and"" Co (CLON3/PO 8749)"');
  });

  it('rejects categories with no nominal mapping', () => {
    expect(() => buildSageCsv([{ ...line, category: 'Mystery' }], DEFAULT_SETTINGS)).toThrow(/nominal/i);
  });
});

describe('taxCodeForRate', () => {
  it('maps configured Irish VAT rates', () => {
    expect(taxCodeForRate(23, DEFAULT_SETTINGS)).toBe('T1');
    expect(taxCodeForRate(13.5, DEFAULT_SETTINGS)).toBe('T2');
    expect(taxCodeForRate(0, DEFAULT_SETTINGS)).toBe('T9');
  });
  it('falls back to the default code', () => {
    expect(taxCodeForRate(null, DEFAULT_SETTINGS)).toBe('T1');
    expect(taxCodeForRate(21, DEFAULT_SETTINGS)).toBe('T1');
  });
});
