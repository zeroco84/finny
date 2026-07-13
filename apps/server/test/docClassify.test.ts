import { describe, expect, it } from 'vitest';
import {
  classifyStatementLike,
  isPaymentRecommendation,
  sniffPaymentRecommendation,
} from '../src/services/extraction/docSteering.js';
import { generateSampleInvoice } from '../src/services/simulator/sampleInvoices.js';

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

describe('isPaymentRecommendation (anchored title rule)', () => {
  it('recognises the cost-estimating payment certificates by their title', () => {
    expect(
      isPaymentRecommendation('SUBCONTRACTOR MONTHLY PAYMENT RECOMMENDATION\nContract : Dock Mill'),
    ).toBe(true);
    // Logo/letterhead lines above the title still count as the header area.
    expect(
      isPaymentRecommendation('T\nMeadowvale Construction Ltd\nSubcontractor Monthly Payment Recommendation'),
    ).toBe(true);
  });

  it('ignores a body-only mention on a real invoice', () => {
    const invoice = [
      'BRACKEN GROUNDWORKS LTD',
      'INVOICE',
      'Invoice No: 88',
      ...Array.from({ length: 20 }, (_, i) => `Line item ${i + 1} .......... 100.00`),
      'As per the monthly payment recommendation issued by the QS.', // footer note
    ].join('\n');
    expect(isPaymentRecommendation(invoice)).toBe(false);
  });
});

describe('sniffPaymentRecommendation (pipeline steering backstop on the raw PDF)', () => {
  it('detects a payment recommendation PDF regardless of what the model said', async () => {
    const generated = await generateSampleInvoice({ scenario: 'payment_recommendation' });
    expect(await sniffPaymentRecommendation(generated.buffer, 'application/pdf')).toBe(true);
  });

  it('leaves ordinary invoices, non-PDFs and corrupt files alone', async () => {
    const invoice = await generateSampleInvoice({ vendorIndex: 0, scenario: 'normal' });
    expect(await sniffPaymentRecommendation(invoice.buffer, 'application/pdf')).toBe(false);
    expect(await sniffPaymentRecommendation(invoice.buffer, 'image/png')).toBe(false);
    const corrupt = await generateSampleInvoice({ scenario: 'corrupt' });
    expect(await sniffPaymentRecommendation(corrupt.buffer, 'application/pdf')).toBe(false);
  });
});
