import { describe, expect, it } from 'vitest';
import { generateSampleInvoice } from '../src/services/simulator/sampleInvoices.js';
import { mockExtractor } from '../src/services/extraction/mockExtractor.js';
import { UnreadableDocumentError } from '../src/services/extraction/extractor.js';
import { parseMoneyToCents } from '../src/domain/util.js';

const context = { categories: [{ name: 'Materials' }], approvers: [], vendor_rules: [], extraction_hints: [] };

// Deterministic rng so amounts/refs are stable across runs.
function seededRng(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe('sample invoice -> mock extractor round trip', () => {
  it('extracts the core header fields from a generated PDF', async () => {
    const generated = await generateSampleInvoice({ vendorIndex: 0, scenario: 'normal', rng: seededRng() });
    const result = await mockExtractor.extract(generated.buffer, 'application/pdf', context);

    expect(result.doc_type).toBe('invoice');
    expect(result.vendor_name.value).toBe('Hegarty Steel Ltd');
    expect(result.invoice_ref.value).toBe(generated.ref);
    expect(result.gross.value).not.toBeNull();
    expect(result.net.value).not.toBeNull();
    expect(result.vat_rate.value).not.toBeNull();
    // net + vat = gross (within a cent of rounding)
    const net = parseMoneyToCents(result.net.value)!;
    const vat = parseMoneyToCents(result.vat.value)!;
    const gross = parseMoneyToCents(result.gross.value)!;
    expect(Math.abs(net + vat - gross)).toBeLessThanOrEqual(1);
    expect(result.vendor_name.confidence).toBeGreaterThan(0.8);
    expect(result.proposed_category.name).toBe('Materials');
  });

  it('leaves missing fields blank instead of fabricating them', async () => {
    const generated = await generateSampleInvoice({ vendorIndex: 3, scenario: 'missing_po', rng: seededRng(7) });
    const result = await mockExtractor.extract(generated.buffer, 'application/pdf', context);
    expect(result.po_number.value).toBeNull();
    expect(result.po_number.confidence).toBe(0);
  });

  it('rejects corrupt files as unreadable', async () => {
    const generated = await generateSampleInvoice({ scenario: 'corrupt', rng: seededRng(9) });
    await expect(mockExtractor.extract(generated.buffer, 'application/pdf', context)).rejects.toThrow(
      UnreadableDocumentError,
    );
  });

  it('flags image attachments for fully manual review', async () => {
    const generated = await generateSampleInvoice({ scenario: 'image', rng: seededRng(3) });
    const result = await mockExtractor.extract(generated.buffer, 'image/png', context);
    expect(result.vendor_name.value).toBeNull();
    expect(result.vendor_name.confidence).toBe(0);
  });
});
