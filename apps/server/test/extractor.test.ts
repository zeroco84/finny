import { describe, expect, it } from 'vitest';
import { generateSampleInvoice } from '../src/services/simulator/sampleInvoices.js';
import { mockExtractor } from '../src/services/extraction/mockExtractor.js';
import { UnreadableDocumentError } from '../src/services/extraction/extractor.js';
import { parseMoneyToCents } from '../src/domain/util.js';

const context = {
  categories: [{ name: 'Materials' }, { name: 'Subcontractors' }],
  entities: ['Meadowvale Developments Ltd', 'Meadowvale Construction Ltd', 'Meadowvale Asset Management Ltd'],
  projects: [
    { name: 'Clongriffin Phase 3', code: 'CLON3', entity: 'Meadowvale Developments Ltd' },
    { name: 'Dock Mill', code: 'DOCKM', entity: 'Meadowvale Construction Ltd' },
    { name: 'Santry Cross', code: 'SANTX', entity: 'Meadowvale Developments Ltd' },
  ],
  approvers: [],
  vendor_rules: [],
  extraction_hints: [],
};

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
    // A payment due date is printed on the sample and read back as a date.
    expect(result.due_date.value).not.toBeNull();
    expect(result.due_date.confidence).toBeGreaterThan(0.8);
    expect(result.proposed_category.name).toBe('Materials');
    // Billed-to entity resolves to one of the configured legal entities.
    expect(context.entities).toContain(result.billed_to_entity.value);
    expect(result.billed_to_entity.confidence).toBeGreaterThan(0.8);
    // Project is either absent or one of the configured codes — never invented.
    if (result.project.value !== null) {
      expect(context.projects.map((p) => p.code)).toContain(result.project.value);
    }
  });

  it('leaves missing fields blank instead of fabricating them', async () => {
    const generated = await generateSampleInvoice({ vendorIndex: 3, scenario: 'missing_po', rng: seededRng(7) });
    const result = await mockExtractor.extract(generated.buffer, 'application/pdf', context);
    expect(result.po_number.value).toBeNull();
    expect(result.po_number.confidence).toBe(0);
  });

  it('classifies a statement of account as a statement, not an invoice', async () => {
    const generated = await generateSampleInvoice({ vendorIndex: 0, scenario: 'statement', rng: seededRng(5) });
    const result = await mockExtractor.extract(generated.buffer, 'application/pdf', context);
    expect(result.doc_type).toBe('statement');
    expect(result.vendor_name.value).toBe('Hegarty Steel Ltd');
    // No amounts, ref, or routing — a statement is not a bill.
    expect(result.gross.value).toBeNull();
    expect(result.invoice_ref.value).toBeNull();
    expect(result.proposed_category.name).toBeNull();
  });

  it('extracts a subcontractor payment recommendation as a payable document', async () => {
    const generated = await generateSampleInvoice({ scenario: 'payment_recommendation', rng: seededRng(11) });
    const result = await mockExtractor.extract(generated.buffer, 'application/pdf', context);

    expect(result.doc_type).toBe('payment_recommendation');
    // Vendor is the subcontractor being paid — never the certificate title.
    expect(result.vendor_name.value).toMatch(/Ltd$/);
    expect(result.vendor_name.value).not.toMatch(/payment recommendation/i);
    // Ref is the claim number; net is this month's certificate amount, and the
    // RCT reverse-charge note makes gross = net with zero VAT.
    expect(result.invoice_ref.value).toBe(generated.ref);
    expect(result.net.value).not.toBeNull();
    expect(result.vat.value).toBe('0.00');
    expect(result.gross.value).toBe(result.net.value);
    expect(result.po_number.value).toMatch(/^\d+$/);
    expect(result.invoice_date.value).not.toBeNull();
    // Entity comes from the "for <entity>" signature; project from "Contract :".
    expect(context.entities).toContain(result.billed_to_entity.value);
    expect(context.projects.map((p) => p.code)).toContain(result.project.value);
    expect(result.proposed_category.name).toBe('Subcontractors');
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
