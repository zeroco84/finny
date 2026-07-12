import { describe, expect, it } from 'vitest';
import { classifyStatementLike } from '../src/services/extraction/mockExtractor.js';

describe('classifyStatementLike (anchored auto-file heuristic)', () => {
  it('classifies statements and remittance advices by their header', () => {
    expect(classifyStatementLike('MEADOWVALE LTD\nSTATEMENT OF ACCOUNT\nPeriod: June 2026')).toBe('statement');
    expect(classifyStatementLike('MEADOWVALE LTD\nRemittance Advice\nPayment ref 5567')).toBe('remittance');
  });

  it('does NOT misfile a real invoice that mentions "remittance advice" only in a footer', () => {
    const invoice = [
      'MEADOWVALE BUILDERS LTD',
      'INVOICE',
      'Invoice No: 4590',
      'Bill To: Acme Ltd',
      ...Array.from({ length: 20 }, (_, i) => `Line item ${i + 1} .......... 100.00`),
      'Total due: 2,400.00',
      'Please send a remittance advice with your payment.', // footer terms line
    ].join('\n');
    expect(classifyStatementLike(invoice)).toBeNull();
  });

  it('returns null for an ordinary invoice', () => {
    expect(classifyStatementLike('ACME LTD\nINVOICE 1001\nTotal 500.00')).toBeNull();
  });
});
