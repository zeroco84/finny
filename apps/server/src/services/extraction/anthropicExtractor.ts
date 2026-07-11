import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { getAnthropicKey, getExtractionModel } from '../settings.js';
import {
  UnreadableDocumentError,
  type ExtractionResult,
  type Extractor,
  type RulesContext,
} from './extractor.js';
import { parseMoneyToCents } from '../../domain/util.js';

// Cached by key so a key changed in Settings takes effect without a restart.
let client: { key: string; anthropic: Anthropic } | null = null;
function getClient(): Anthropic {
  const key = getAnthropicKey();
  if (!client || client.key !== key) client = { key, anthropic: new Anthropic({ apiKey: key }) };
  return client.anthropic;
}

/** The models this API key can use — powers the Settings model picker. */
export async function listAvailableModels(): Promise<{ id: string; display_name: string }[]> {
  const page = await getClient().models.list({ limit: 100 });
  return page.data.map((m) => ({ id: m.id, display_name: m.display_name }));
}

const MAX_DOCUMENT_BYTES = 30 * 1024 * 1024; // API request cap is 32MB
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // the API rejects images over 5MB

/** Image types the Claude API accepts (photographed/scanned invoices). */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/**
 * The document/image content block for one attachment. Pure — exported for
 * tests. Throws UnreadableDocumentError (routed to the failed queue with an
 * unreadable-attachment alert) for types or sizes the API would reject,
 * with a message a human can act on.
 */
export function buildAttachmentBlock(buffer: Buffer, mime: string): Anthropic.ContentBlockParam {
  const data = () => buffer.toString('base64');
  if (mime === 'application/pdf') {
    if (buffer.byteLength > MAX_DOCUMENT_BYTES) {
      throw new UnreadableDocumentError(
        `PDF is ${(buffer.byteLength / 1e6).toFixed(1)}MB — over the ${MAX_DOCUMENT_BYTES / 1e6}MB extraction limit. Ask the supplier for a smaller copy.`,
      );
    }
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data() } };
  }
  // Some senders label JPEGs with the non-standard image/jpg.
  const normalized = mime === 'image/jpg' ? 'image/jpeg' : mime;
  if ((IMAGE_MEDIA_TYPES as readonly string[]).includes(normalized)) {
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new UnreadableDocumentError(
        `Image is ${(buffer.byteLength / 1e6).toFixed(1)}MB — the extraction model accepts images up to ${MAX_IMAGE_BYTES / 1e6}MB. Ask the supplier for a smaller photo or a PDF.`,
      );
    }
    return { type: 'image', source: { type: 'base64', media_type: normalized as ImageMediaType, data: data() } };
  }
  throw new UnreadableDocumentError(
    `Unsupported attachment type "${mime}" — Finny reads PDF, PNG, JPG, GIF and WebP. Ask the supplier to resend in one of those formats.`,
  );
}

const fieldSchema = { type: 'object' as const, properties: {
  value: { type: ['string', 'null'] as const, description: 'Exact value as printed on the document, or null if absent/illegible' },
  confidence: { type: 'number' as const, description: 'Your confidence 0..1 that the value is correct; 0 when null' },
}, required: ['value', 'confidence'], additionalProperties: false as const };

// `strict: true` (GA strict tool use — guarantees the input validates against
// the schema) is accepted by the API but not yet in this SDK version's Tool
// type, hence the cast below. Zod re-validates as defence in depth.
const EXTRACTION_TOOL = {
  name: 'record_extraction',
  description: 'Record the structured data extracted from the supplier document.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      doc_type: {
        type: 'string',
        enum: ['invoice', 'statement', 'remittance', 'other'],
        description: 'What kind of document this is. Only "invoice" proceeds to data entry.',
      },
      vendor_name: fieldSchema,
      invoice_ref: fieldSchema,
      invoice_date: { ...fieldSchema, description: 'Invoice date formatted as yyyy-mm-dd' },
      net: { ...fieldSchema, description: 'Net (ex-VAT) amount as a plain decimal string, e.g. "1234.56"' },
      vat: { ...fieldSchema, description: 'VAT amount as a plain decimal string' },
      gross: { ...fieldSchema, description: 'Gross (inc-VAT) total as a plain decimal string' },
      vat_rate: { ...fieldSchema, description: 'VAT rate percent as a plain number string, e.g. "23"' },
      vat_number: { ...fieldSchema, description: 'Supplier VAT registration number' },
      po_number: { ...fieldSchema, description: 'Purchase order number if present' },
      billed_to_entity: {
        ...fieldSchema,
        description: 'Which of the provided legal entities this invoice is addressed to (exact name from the list), or null',
      },
      project: {
        ...fieldSchema,
        description: 'The CODE of the provided project this document references (by name, code or site), or null',
      },
      line_items: {
        type: 'array',
        description: 'Line items where legible; empty array when not feasible',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            quantity: { type: ['number', 'null'] },
            unit_price: { type: ['string', 'null'], description: 'Decimal string' },
            total: { type: ['string', 'null'], description: 'Decimal string' },
          },
          required: ['description', 'quantity', 'unit_price', 'total'],
          additionalProperties: false,
        },
      },
      proposed_category: {
        type: 'object',
        properties: {
          name: { type: ['string', 'null'], description: 'One of the provided expense categories, or null' },
          confidence: { type: 'number' },
          rationale: { type: 'string', description: 'One short sentence explaining the choice' },
        },
        required: ['name', 'confidence', 'rationale'],
        additionalProperties: false,
      },
      proposed_approver: {
        type: 'object',
        properties: {
          email: { type: ['string', 'null'], description: 'Email of one of the provided approvers, or null' },
          confidence: { type: 'number' },
          rationale: { type: 'string', description: 'One short sentence explaining the choice' },
        },
        required: ['email', 'confidence', 'rationale'],
        additionalProperties: false,
      },
    },
    required: [
      'doc_type', 'vendor_name', 'invoice_ref', 'invoice_date', 'net', 'vat', 'gross',
      'vat_rate', 'vat_number', 'po_number', 'billed_to_entity', 'project',
      'line_items', 'proposed_category', 'proposed_approver',
    ],
    additionalProperties: false,
  },
} as unknown as Anthropic.Tool;

const zField = z.object({ value: z.string().nullable(), confidence: z.number() });
const zResult = z.object({
  doc_type: z.enum(['invoice', 'statement', 'remittance', 'other']),
  vendor_name: zField, invoice_ref: zField, invoice_date: zField,
  net: zField, vat: zField, gross: zField,
  vat_rate: zField, vat_number: zField, po_number: zField,
  billed_to_entity: zField, project: zField,
  line_items: z.array(z.object({
    description: z.string(),
    quantity: z.number().nullable(),
    unit_price: z.string().nullable(),
    total: z.string().nullable(),
  })),
  proposed_category: z.object({ name: z.string().nullable(), confidence: z.number(), rationale: z.string() }),
  proposed_approver: z.object({ email: z.string().nullable(), confidence: z.number(), rationale: z.string() }),
});

function systemPrompt(context: RulesContext): string {
  return [
    'You are the invoice-extraction engine for Finny, an accounts-payable intake tool. You read one supplier document per request and record its header data with the record_extraction tool.',
    '',
    'Hard rules:',
    '- Never fabricate a value. If a field is absent or illegible, set value to null and confidence to 0. A blank field is always better than a guessed one — this data feeds the accounting system.',
    '- Values must be exactly what is printed (amounts as plain decimals without currency symbols; dates converted to yyyy-mm-dd; keep reference/PO formatting verbatim).',
    '- Sanity-check amounts: net + VAT should equal gross. If they do not reconcile, still report what is printed but lower your confidence on the amount fields.',
    '- doc_type: only classify as "invoice" if this is a bill requesting payment. Supplier statements, remittance advice, marketing and anything else must be classified accordingly.',
    '- proposed_category.name must be one of the provided categories or null. proposed_approver.email must be one of the provided approver emails or null.',
    '- billed_to_entity.value: the business runs several legal entities — read the "Bill To"/addressee block and return the exact matching name from the provided legal_entities list, or null if it is unclear or matches none of them.',
    '- project.value: if the document references one of the provided projects (by name, code, or the site/development it relates to), return that project\'s CODE from the list; otherwise null. Never invent project codes.',
    '- If a learned vendor rule below matches this vendor, propose its category/approver with high confidence and say so in the rationale. Otherwise propose from the document contents with appropriately lower confidence.',
    '',
    'Structured context (learned rules layer — maintained and audited by the AP team):',
    JSON.stringify(
      {
        expense_categories: context.categories,
        legal_entities: context.entities,
        projects: context.projects,
        approvers: context.approvers,
        learned_vendor_rules: context.vendor_rules,
        extraction_hints: context.extraction_hints,
      },
      null,
      2,
    ),
  ].join('\n');
}

export const anthropicExtractor: Extractor = {
  name: 'anthropic',

  async extract(buffer: Buffer, mime: string, context: RulesContext): Promise<ExtractionResult> {
    const documentBlock = buildAttachmentBlock(buffer, mime);

    let response: Anthropic.Message;
    try {
      response = await getClient().messages.create({
        model: getExtractionModel(),
        max_tokens: 16000,
        system: systemPrompt(context),
        tools: [EXTRACTION_TOOL],
        tool_choice: { type: 'tool', name: 'record_extraction' },
        messages: [
          {
            role: 'user',
            content: [
              documentBlock,
              { type: 'text', text: 'Extract the invoice data from this document and record it.' },
            ],
          },
        ],
      });
    } catch (err) {
      if (err instanceof Anthropic.BadRequestError && /could not process|invalid.*(pdf|image)/i.test(err.message)) {
        throw new UnreadableDocumentError(`The model could not read the document: ${err.message}`);
      }
      throw err; // auth/rate-limit/network — surfaced as an extraction failure alert upstream
    }

    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'record_extraction',
    );
    if (!toolUse) {
      throw new Error(`Extraction model returned no structured result (stop_reason: ${response.stop_reason})`);
    }
    const parsed = zResult.parse(toolUse.input);

    const clamp = (f: { value: string | null; confidence: number }) => ({
      value: f.value,
      confidence: f.value === null ? 0 : Math.max(0, Math.min(1, f.confidence)),
    });

    return {
      doc_type: parsed.doc_type,
      vendor_name: clamp(parsed.vendor_name),
      invoice_ref: clamp(parsed.invoice_ref),
      invoice_date: clamp(parsed.invoice_date),
      net: clamp(parsed.net),
      vat: clamp(parsed.vat),
      gross: clamp(parsed.gross),
      vat_rate: clamp(parsed.vat_rate),
      vat_number: clamp(parsed.vat_number),
      po_number: clamp(parsed.po_number),
      billed_to_entity: clamp(parsed.billed_to_entity),
      project: clamp(parsed.project),
      line_items: parsed.line_items.map((li) => ({
        description: li.description,
        quantity: li.quantity,
        unit_cents: parseMoneyToCents(li.unit_price),
        total_cents: parseMoneyToCents(li.total),
      })),
      proposed_category: {
        name: parsed.proposed_category.name,
        confidence: Math.max(0, Math.min(1, parsed.proposed_category.confidence)),
        rationale: parsed.proposed_category.rationale,
      },
      proposed_approver: {
        email_or_name: parsed.proposed_approver.email,
        confidence: Math.max(0, Math.min(1, parsed.proposed_approver.confidence)),
        rationale: parsed.proposed_approver.rationale,
      },
    };
  },
};
