import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import type { LineItem } from '@finny/shared';
import crypto from 'node:crypto';
import {
  emptyField,
  UnreadableDocumentError,
  type ExtractedField,
  type ExtractionResult,
  type Extractor,
  type RulesContext,
} from './extractor.js';
import { parseMoneyToCents } from '../../domain/util.js';
import { classifyStatementLike, isPaymentRecommendation } from './docSteering.js';

/**
 * Offline extractor: parses the PDF text layer with deterministic patterns.
 * It exists so the entire pipeline (queue, review, corrections, rules,
 * exports, approvals, alerts) runs end-to-end with zero API keys. Image
 * attachments have no text layer, so they come back empty/low-confidence and
 * route to human review — which is exactly the spec's fallback behaviour.
 */

// Stable pseudo-random confidence in [0.82, 0.97] so the UI shows realistic,
// repeatable variation per field.
function conf(seed: string): number {
  const h = crypto.createHash('sha1').update(seed).digest()[0];
  return Math.round((0.82 + (h / 255) * 0.15) * 100) / 100;
}

function field(value: string | null | undefined, seed: string): ExtractedField {
  if (value === null || value === undefined || value.trim() === '') return emptyField();
  return { value: value.trim(), confidence: conf(seed + value) };
}

function match(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

/** Any configured project referenced by name or code, anywhere on the document. */
function findProjectCode(text: string, context: RulesContext): string | null {
  const textLower = text.toLowerCase();
  for (const p of context.projects) {
    if (textLower.includes(p.name.toLowerCase()) || new RegExp(`\\b${p.code}\\b`).test(text)) {
      return p.code;
    }
  }
  return null;
}

/**
 * Internal cost-estimating payment recommendations are payment certificates,
 * not invoices — the generic invoice patterns don't fit their layout, so they
 * get their own targeted extraction.
 */
function extractPaymentRecommendation(text: string, context: RulesContext): ExtractionResult {
  // "Contractor : <name>" is who gets paid. Line-anchored so "Main/Principal
  // Contractor" (the paying side) never matches, separator required and the
  // value re-checked so the "SUBCONTRACTOR MONTHLY PAYMENT RECOMMENDATION"
  // title itself can never be read as the vendor.
  let vendor: string | null = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:sub-?)?contractor\s*[:.\-]\s*(.+)/i);
    if (m && !/payment\s+recommendation/i.test(m[1])) {
      vendor = m[1].trim();
      break;
    }
  }
  // The claim/certificate number is the only per-document reference printed —
  // it becomes the invoice ref (unique per subcontractor, drives dedupe).
  const ref = match(text, [
    /(?:^|\n)\s*claim\s*no\.?\s*[:.\-]?\s*(\d+)/i,
    /certificate\s*no\.?\s*[:.\-]?\s*(\d+)/i,
  ]);
  const date = match(text, [
    /date\s*[:.\-]*\s*(\d{1,2}[\/\-.][A-Za-z]{3,9}[\/\-.]\d{2,4})/i,
    /date\s*[:.\-]*\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i,
    /date\s*[:.\-]*\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/i,
  ]);
  // The payable amount is this month's certificate, never the cumulative
  // "recommended to date" or contract totals.
  const net = match(text, [
    /now\s+recommended\s*[:.\-]?\s*€?\s*([\d,]+\.\d{2})/i,
    /amount\s+recommended[^€\n]*?€?\s*([\d,]+\.\d{2})/i,
  ]);
  const po = match(text, [
    /(?:^|\n)\s*po\b\.?\s*(?:number|no\.?|#)\s*[:.\-]?\s*([A-Z0-9][A-Z0-9\-\/]*)/i,
    /(?:^|\n)\s*po\s*[:.\-]\s*([A-Z0-9][A-Z0-9\-\/]*)/i,
  ]);
  // RCT reverse charge: the principal contractor accounts for the VAT, so the
  // certificate carries none and the recommended amount is both net and gross.
  const reverseCharge = /vat\s+to\s+be\s+accounted\s+for\s+by\s+the\s+principal\s+contractor/i.test(text);
  // No Bill To block — the certificate is signed "for <entity>", so match any
  // configured legal entity named anywhere on the document.
  const textLower = text.toLowerCase();
  const entity = context.entities.find((e) => textLower.includes(e.toLowerCase())) ?? null;
  const category = context.categories.some((c) => c.name === 'Subcontractors') ? 'Subcontractors' : null;

  return {
    doc_type: 'payment_recommendation',
    vendor_name: field(vendor, 'vendor'),
    invoice_ref: field(ref, 'ref'),
    invoice_date: field(date, 'date'),
    net: field(net, 'net'),
    vat: reverseCharge && net ? field('0.00', 'vat') : emptyField(),
    gross: reverseCharge && net ? field(net, 'gross') : emptyField(),
    vat_rate: reverseCharge && net ? field('0', 'vat_rate') : emptyField(),
    vat_number: emptyField(),
    po_number: field(po, 'po'),
    billed_to_entity: field(entity, 'entity'),
    project: field(findProjectCode(text, context), 'project'),
    line_items: [],
    proposed_category: {
      name: category,
      confidence: category ? 0.8 : 0,
      rationale: category
        ? 'Subcontractor payment recommendation (mock heuristic).'
        : 'Payment recommendation — no "Subcontractors" category configured, pick one manually.',
    },
    proposed_approver: {
      email_or_name: null,
      confidence: 0,
      rationale: 'Mock extractor does not propose approvers — learned rules or the reviewer decide.',
    },
  };
}

const CATEGORY_KEYWORDS: [RegExp, string][] = [
  [/steel|rebar|concrete|ready\s*mix|timber|builders|materials|aggregates/i, 'Materials'],
  [/plant|hire|excavator|crane|scaffold/i, 'Plant & Equipment Hire'],
  [/solicitor|legal|consult|engineer|architect|surveyor|accountant/i, 'Professional Fees'],
  [/esb|electric|energy|gas|water|utility|broadband|telecom/i, 'Utilities'],
  [/skip|waste|security|fencing|site|cleaning|welfare/i, 'Site Costs'],
  [/office|supplies|stationery|software|print/i, 'Office & Admin'],
];

export const mockExtractor: Extractor = {
  name: 'mock',

  async extract(buffer: Buffer, mime: string, context: RulesContext): Promise<ExtractionResult> {
    if (mime !== 'application/pdf') {
      // Images: no OCR in the mock provider — flag everything for the human.
      return {
        doc_type: 'invoice',
        vendor_name: emptyField(),
        invoice_ref: emptyField(),
        invoice_date: emptyField(),
        net: emptyField(),
        vat: emptyField(),
        gross: emptyField(),
        vat_rate: emptyField(),
        vat_number: emptyField(),
        po_number: emptyField(),
        billed_to_entity: emptyField(),
        project: emptyField(),
        line_items: [],
        proposed_category: {
          name: null,
          confidence: 0,
          rationale: 'Image attachment — the mock extractor has no OCR, so all fields need manual entry.',
        },
        proposed_approver: { email_or_name: null, confidence: 0, rationale: 'No data to route on.' },
      };
    }

    // pdf-parse's bundled (old) pdf.js reads the WHOLE underlying ArrayBuffer,
    // but Buffers usually live at an offset inside Node's shared 8KB pool —
    // neighbouring slab bytes then corrupt the parse ("bad XRef entry").
    // An exact-bounds copy (fresh ArrayBuffer, byteOffset 0) fixes it.
    const exact = new Uint8Array(buffer);
    let text: string;
    try {
      // Bound the parse: cap pages (a huge page count can't drive an unbounded
      // loop) and select the newer bundled pdf.js build (past CVE-2018-5158)
      // rather than pdf-parse's 2018-era default.
      const parsed = await pdfParse(exact as unknown as Buffer, { max: 50, version: 'v2.0.550' });
      text = parsed.text ?? '';
    } catch (err) {
      throw new UnreadableDocumentError(
        `PDF could not be parsed (${err instanceof Error ? err.message : 'corrupt file'})`,
      );
    }
    if (text.trim().length < 10) {
      throw new UnreadableDocumentError('PDF contains no readable text layer');
    }

    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const vendor = lines[0] ?? null;

    // Statements and remittance advices: classify and stop — the pipeline
    // auto-files these instead of queueing them for review.
    const statementLike = classifyStatementLike(text);
    if (statementLike) {
      return {
        doc_type: statementLike,
        vendor_name: field(vendor, 'vendor'),
        invoice_ref: emptyField(),
        invoice_date: emptyField(),
        net: emptyField(),
        vat: emptyField(),
        gross: emptyField(),
        vat_rate: emptyField(),
        vat_number: emptyField(),
        po_number: emptyField(),
        billed_to_entity: emptyField(),
        project: emptyField(),
        line_items: [],
        proposed_category: { name: null, confidence: 0, rationale: `Not an invoice (${statementLike}) — no routing.` },
        proposed_approver: { email_or_name: null, confidence: 0, rationale: 'Not an invoice.' },
      };
    }

    // Internal payment recommendations: payable like an invoice, but the
    // certificate layout needs its own extraction patterns.
    if (isPaymentRecommendation(text)) {
      return extractPaymentRecommendation(text, context);
    }

    const ref = match(text, [
      /invoice\s*(?:no|number|#)\.?\s*[:.]?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/i,
      /our\s*ref\s*[:.]?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/i,
    ]);
    const date = match(text, [
      /(?:invoice\s*)?date\s*[:.]?\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i,
      /(?:invoice\s*)?date\s*[:.]?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/i,
      /(?:invoice\s*)?date\s*[:.]?\s*(\d{4}-\d{2}-\d{2})/i,
    ]);
    const net = match(text, [/(?:net\s*(?:total|amount)?|subtotal)\s*[:.]?\s*€?\s*([\d,]+\.\d{2})/i]);
    const vatRate = match(text, [/vat\s*@\s*([\d.]+)\s*%/i]);
    const vat = match(text, [/vat(?:\s*@\s*[\d.]+\s*%)?\s*[:.]?\s*€?\s*([\d,]+\.\d{2})/i]);
    const gross = match(text, [
      /(?:total\s*due(?:\s*\(incl[^)]*\))?|amount\s*due|gross\s*total|balance\s*due|total\s*\(incl[^)]*\))\s*[:.]?\s*€?\s*([\d,]+\.\d{2})/i,
    ]);
    const vatNumber = match(text, [/vat\s*(?:reg(?:istration)?\s*)?no\.?\s*[:.]?\s*(IE\s?[0-9A-Z]{7,9})/i]);
    const po = match(text, [
      /(?:po\s*(?:number|no|#)?|purchase\s*order(?:\s*(?:number|no))?|your\s*order\s*ref)\s*[:.]?\s*([A-Z]{2}[A-Z0-9\-]{3,})/i,
    ]);

    // Billed-to entity: read the Bill To line and match it against the
    // configured legal entities (canonical name wins over the raw string).
    const billToLine = match(text, [/bill(?:ed)?\s*to\s*[:.]?\s*(.+)/i]);
    let entity: string | null = null;
    if (billToLine) {
      const lower = billToLine.toLowerCase();
      entity = context.entities.find((e) => lower.includes(e.toLowerCase())) ?? null;
    }

    const project = findProjectCode(text, context);

    const lineItems: LineItem[] = [];
    for (const line of lines) {
      const m = line.match(/^(.{4,60}?)\s{2,}(\d+(?:\.\d+)?)\s{2,}€?([\d,]+\.\d{2})\s{2,}€?([\d,]+\.\d{2})$/);
      if (m) {
        lineItems.push({
          description: m[1].trim(),
          quantity: Number(m[2]),
          unit_cents: parseMoneyToCents(m[3]),
          total_cents: parseMoneyToCents(m[4]),
        });
      }
    }

    // Category heuristic: keyword match on vendor + document text. The learned
    // rules layer (routing service) overrides this upstream when a rule exists,
    // so the learning loop behaves identically in mock and Claude modes.
    let category: string | null = null;
    let categoryRationale = 'No keyword match (mock heuristic) — pick a category manually.';
    const haystack = `${vendor ?? ''} ${text.slice(0, 400)}`;
    for (const [re, cat] of CATEGORY_KEYWORDS) {
      if (re.test(haystack) && context.categories.some((c) => c.name === cat)) {
        category = cat;
        categoryRationale = `Keyword heuristic on the vendor/document text (mock extractor).`;
        break;
      }
    }

    return {
      doc_type: 'invoice',
      vendor_name: field(vendor, 'vendor'),
      invoice_ref: field(ref, 'ref'),
      invoice_date: field(date, 'date'),
      net: field(net, 'net'),
      vat: field(vat, 'vat'),
      gross: field(gross, 'gross'),
      vat_rate: field(vatRate, 'vat_rate'),
      vat_number: field(vatNumber, 'vat_number'),
      po_number: field(po, 'po'),
      billed_to_entity: field(entity, 'entity'),
      project: field(project, 'project'),
      line_items: lineItems,
      proposed_category: { name: category, confidence: category ? 0.7 : 0, rationale: categoryRationale },
      // The mock provider never guesses an approver: routing comes from the
      // learned rules or the human, which showcases the learning loop.
      proposed_approver: {
        email_or_name: null,
        confidence: 0,
        rationale: 'Mock extractor does not propose approvers — learned rules or the reviewer decide.',
      },
    };
  },
};
