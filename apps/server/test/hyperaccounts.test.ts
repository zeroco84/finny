import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { DEFAULT_SETTINGS } from '../src/services/settings.js';
import {
  buildPurchaseInvoicePayload,
  duplicateSearchNeedle,
  isOwnPosting,
  taxCodeNumber,
  HyperAccountsError,
  type AuditHeaderHit,
} from '../src/services/sage/hyperaccounts.js';
import type { SageLineInput } from '../src/services/sage.js';

const line: SageLineInput = {
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
  disputed: false,
};

describe('buildPurchaseInvoicePayload', () => {
  beforeAll(() => {
    config.sessionSecret = 'test-secret';
    config.appUrl = 'https://finny.test';
  });

  it('maps a Finny line onto the TransactionPost shape', () => {
    const p = buildPurchaseInvoicePayload('inv-1', line, DEFAULT_SETTINGS);
    expect(p.accountRef).toBe('HEG001');
    expect(p.invRef).toBe('Inv10001');
    expect(p.date).toBe('28/06/2026');
    expect(p.details).toBe('Inv4590 - Hegarty Steel Ltd (CLON3/PO 8749)');
    expect(p.items).toHaveLength(1);
    const item = p.items[0];
    expect(item.nominalCode).toBe('5200'); // Materials
    expect(item.taxCode).toBe(1); // T1 -> 1 (int per the API)
    expect(item.netAmount).toBe(1000);
    expect(item.taxAmount).toBe(230);
    expect(item.departmentNumber).toBe(26); // CLON3's dept
    expect(item.projectRef).toBe('CLON3');
    expect(item.exRef).toBe('PO 8749'); // 7 chars, within the 8-char cap
    expect(item.isNegativeLine).toBe(0);
    // externalFileURL is required by the API — a long-lived tokenized link.
    expect(item.externalFileURL).toContain('/api/public/invoices/inv-1/attachment?exp=');
  });

  it('zero-VAT lines carry the 0% tax code as an integer (T9 -> 9)', () => {
    const p = buildPurchaseInvoicePayload('inv-1',
      { ...line, net_cents: 79900, vat_cents: 0, gross_cents: 79900, vat_rate: null }, DEFAULT_SETTINGS);
    expect(p.items[0].taxCode).toBe(9);
    expect(p.items[0].taxAmount).toBe(0);
  });

  it('omits exRef when the PO exceeds the API 8-char cap; dept falls back without a project', () => {
    const p = buildPurchaseInvoicePayload('inv-1',
      { ...line, po_number: 'TW-PO-4881', project_code: null }, DEFAULT_SETTINGS);
    expect(p.items[0].exRef).toBeUndefined();
    expect(p.items[0].departmentNumber).toBe(Number(DEFAULT_SETTINGS.sage_department));
    expect(p.items[0].projectRef).toBe('');
  });

  it('truncates details to the API 60-char cap', () => {
    const p = buildPurchaseInvoicePayload('inv-1',
      { ...line, vendor_name: 'A Very Long Vendor Trading Name That Never Seems To End Ltd' }, DEFAULT_SETTINGS);
    expect(p.details.length).toBeLessThanOrEqual(60);
    expect(p.items[0].details.length).toBeLessThanOrEqual(60);
  });

  it('rejects over-long supplier refs and unmapped categories', () => {
    expect(() => buildPurchaseInvoicePayload('inv-1',
      { ...line, supplier_account_ref: 'WAYTOOLONG1' }, DEFAULT_SETTINGS)).toThrow(HyperAccountsError);
    expect(() => buildPurchaseInvoicePayload('inv-1',
      { ...line, category: 'Mystery' }, DEFAULT_SETTINGS)).toThrow(/nominal/i);
  });
});

describe('taxCodeNumber', () => {
  it('converts Sage-style codes to integers', () => {
    expect(taxCodeNumber('T1')).toBe(1);
    expect(taxCodeNumber('T9')).toBe(9);
    expect(taxCodeNumber('t0')).toBe(0);
  });
  it('rejects junk', () => {
    expect(() => taxCodeNumber('EXEMPT')).toThrow(HyperAccountsError);
  });
});

describe('duplicateSearchNeedle', () => {
  it('strips the Inv prefix so "INV-4590" matches a manual "Inv4590 - Vendor" post', () => {
    expect(duplicateSearchNeedle('INV-4590')).toBe('4590');
    expect(duplicateSearchNeedle('inv 123456')).toBe('123456');
  });
  it('keeps non-prefixed refs verbatim', () => {
    expect(duplicateSearchNeedle('SI-2026-0042')).toBe('SI-2026-0042');
  });
  it('falls back to the verbatim ref when the bare digits are too short', () => {
    expect(duplicateSearchNeedle('INV-42')).toBe('INV-42');
  });
  it('refuses refs too short to match on safely', () => {
    expect(duplicateSearchNeedle('789')).toBeNull();
    expect(duplicateSearchNeedle(null)).toBeNull();
    expect(duplicateSearchNeedle('  ')).toBeNull();
  });
});

describe('isOwnPosting', () => {
  const hit: AuditHeaderHit = {
    tranNumber: 4711, invRef: 'Inv10001', accountRef: 'HEG001',
    grossAmount: 1230, type: 'PI', deletedFlag: 0,
  };
  it('matches on supplier account + gross (cents vs Sage euros, fp-tolerant)', () => {
    expect(isOwnPosting(hit, 'HEG001', 123000)).toBe(true);
    expect(isOwnPosting({ ...hit, grossAmount: 1229.9999999 }, 'HEG001', 123000)).toBe(true);
  });
  it('rejects a foreign post squatting on the same ref', () => {
    expect(isOwnPosting(hit, 'OTHER01', 123000)).toBe(false);
    expect(isOwnPosting(hit, 'HEG001', 123001)).toBe(false);
  });
});
