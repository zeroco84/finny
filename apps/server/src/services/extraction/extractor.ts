import type { LineItem } from '@finny/shared';
import { config } from '../../config.js';
import { getSettings, listApprovers } from '../settings.js';
import { findExtractionHints, listRules } from '../rules.js';

export interface ExtractedField {
  /** Raw string as read off the document; null when absent/illegible. */
  value: string | null;
  /** 0..1 — 0 when the field could not be found. */
  confidence: number;
}

export interface ExtractionResult {
  doc_type: 'invoice' | 'statement' | 'remittance' | 'other';
  vendor_name: ExtractedField;
  invoice_ref: ExtractedField;
  invoice_date: ExtractedField;
  net: ExtractedField;
  vat: ExtractedField;
  gross: ExtractedField;
  vat_rate: ExtractedField;
  vat_number: ExtractedField;
  po_number: ExtractedField;
  line_items: LineItem[];
  proposed_category: { name: string | null; confidence: number; rationale: string };
  proposed_approver: { email_or_name: string | null; confidence: number; rationale: string };
}

/**
 * Structured context injected into the extraction/classification prompt.
 * This is the "learned rules" layer feeding the model — a bounded, inspectable
 * table, not an ever-growing prompt string (see spec: Learning mechanism).
 */
export interface RulesContext {
  categories: { name: string }[];
  approvers: { name: string; email: string }[];
  vendor_rules: { vendor: string; category: string | null; approver_email: string | null; confirmed: number }[];
  extraction_hints: { vendor: string; hint: string }[];
}

export function buildRulesContext(vendorNormalizedHint?: string | null): RulesContext {
  const settings = getSettings();
  const approvers = listApprovers();
  const approverById = new Map(approvers.map((a) => [a.id, a]));
  const vendorRules = listRules('active')
    .filter((r) => r.kind === 'routing')
    .slice(0, 100)
    .map((r) => ({
      vendor: r.vendor_pattern,
      category: r.category,
      approver_email: r.approver_id ? approverById.get(r.approver_id)?.email ?? null : null,
      confirmed: r.times_confirmed,
    }));
  const hints = (vendorNormalizedHint ? findExtractionHints(vendorNormalizedHint) : listRules('active').filter((r) => r.kind === 'extraction_hint'))
    .map((r) => ({ vendor: r.vendor_pattern, hint: r.hint_text ?? '' }))
    .filter((h) => h.hint);
  return {
    categories: settings.categories.map((c) => ({ name: c.name })),
    approvers: approvers.map((a) => ({ name: a.name, email: a.email })),
    vendor_rules: vendorRules,
    extraction_hints: hints,
  };
}

export interface Extractor {
  name: string;
  extract(buffer: Buffer, mime: string, context: RulesContext): Promise<ExtractionResult>;
}

/** Thrown when the document itself is unreadable (vs. a provider outage). */
export class UnreadableDocumentError extends Error {}

export async function getExtractor(): Promise<Extractor> {
  if (config.extractionProvider === 'anthropic') {
    const { anthropicExtractor } = await import('./anthropicExtractor.js');
    return anthropicExtractor;
  }
  const { mockExtractor } = await import('./mockExtractor.js');
  return mockExtractor;
}

export function emptyField(): ExtractedField {
  return { value: null, confidence: 0 };
}
