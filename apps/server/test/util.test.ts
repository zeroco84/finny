import { describe, expect, it } from 'vitest';
import {
  centsToDecimal,
  isoWeekLabel,
  normalizeVendor,
  parseInvoiceDate,
  parseMoneyToCents,
  suggestAccountRef,
  toSageDate,
} from '../src/domain/util.js';

describe('parseMoneyToCents', () => {
  it('parses plain decimals and thousands separators', () => {
    expect(parseMoneyToCents('1234.56')).toBe(123456);
    expect(parseMoneyToCents('1,234.56')).toBe(123456);
    expect(parseMoneyToCents('€12,345.00')).toBe(1234500);
    expect(parseMoneyToCents('0.05')).toBe(5);
  });
  it('handles numbers, nulls and junk', () => {
    expect(parseMoneyToCents(99.99)).toBe(9999);
    expect(parseMoneyToCents(null)).toBeNull();
    expect(parseMoneyToCents('')).toBeNull();
    expect(parseMoneyToCents('n/a')).toBeNull();
  });
});

describe('normalizeVendor', () => {
  it('strips legal suffixes and punctuation', () => {
    expect(normalizeVendor('Hegarty Steel Ltd.')).toBe('HEGARTY STEEL');
    expect(normalizeVendor('Brady & Nolan Solicitors LLP')).toBe('BRADY & NOLAN SOLICITORS');
    expect(normalizeVendor('  ESB   Networks ')).toBe('ESB NETWORKS');
  });
  it('is stable across formatting variants', () => {
    expect(normalizeVendor('MIDWEST PLANT HIRE LIMITED')).toBe(normalizeVendor('MidWest Plant Hire'));
  });
});

describe('dates', () => {
  it('parses common invoice date formats to iso', () => {
    expect(parseInvoiceDate('12/03/2026')).toBe('2026-03-12');
    expect(parseInvoiceDate('3 March 2026')).toBe('2026-03-03');
    expect(parseInvoiceDate('2026-03-12')).toBe('2026-03-12');
    expect(parseInvoiceDate('12-3-26')).toBe('2026-03-12');
    expect(parseInvoiceDate('yesterday')).toBeNull();
  });
  it('formats Sage dates dd/mm/yyyy', () => {
    expect(toSageDate('2026-07-01')).toBe('01/07/2026');
    expect(toSageDate(null)).toBe('');
  });
  it('computes iso week labels', () => {
    expect(isoWeekLabel('2026-01-01T10:00:00Z')).toBe('2026-W01');
    expect(isoWeekLabel('2026-07-01T10:00:00Z')).toBe('2026-W27');
  });
});

describe('misc', () => {
  it('formats cents', () => {
    expect(centsToDecimal(123456)).toBe('1234.56');
    expect(centsToDecimal(null)).toBe('');
  });
  it('suggests account refs', () => {
    expect(suggestAccountRef('Hegarty Steel Ltd')).toBe('HEGARTY1');
  });
});
