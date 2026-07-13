import pdfParse from 'pdf-parse/lib/pdf-parse.js';

/**
 * Deterministic document steering, anchored to the top of the document
 * (title/header area). Anchoring matters: a genuine invoice often mentions
 * "remittance advice" in a footer or payment-terms line, and matching the
 * whole body would misfile it as a statement — silently removing a real
 * bill from the review queue.
 */
function documentHead(text: string): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 12)
    .join('\n');
}

/**
 * Classify supplier statements / remittance advices — the pipeline auto-files
 * these instead of queueing them for review. Returns null for anything that
 * should be reviewed.
 */
export function classifyStatementLike(text: string): 'statement' | 'remittance' | null {
  const head = documentHead(text);
  if (/remittance\s+advice/i.test(head)) return 'remittance';
  if (/statement\s+of\s+(?:your\s+)?account/i.test(head)) return 'statement';
  return null;
}

/**
 * Internal payment recommendations: the cost-estimating team sends monthly
 * payment certificates for subcontractor claims to the AP mailbox, and their
 * title always contains "monthly payment recommendation". They are payable
 * documents — they must reach the review queue like an invoice, never be
 * flagged as "other" or auto-filed.
 */
export function isPaymentRecommendation(text: string): boolean {
  return /monthly\s+payment\s+recommendation/i.test(documentHead(text));
}

/**
 * Title check on the raw attachment, independent of which extraction provider
 * ran — the deterministic backstop the pipeline uses to overrule a model that
 * called a payment recommendation something else. PDF-only: images have no
 * text layer to check (the extraction prompt covers those). Best effort — any
 * parse failure means "no override", never an error.
 */
export async function sniffPaymentRecommendation(buffer: Buffer, mime: string): Promise<boolean> {
  if (mime !== 'application/pdf') return false;
  try {
    // Exact-bounds copy: pdf-parse reads the whole underlying ArrayBuffer, and
    // pooled Buffers corrupt the parse ("bad XRef entry"). Title lives on page
    // one, so cap the parse there.
    const exact = new Uint8Array(buffer);
    const parsed = await pdfParse(exact as unknown as Buffer, { max: 1, version: 'v2.0.550' });
    return isPaymentRecommendation(parsed.text ?? '');
  } catch {
    return false;
  }
}
