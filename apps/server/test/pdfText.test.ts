import { describe, expect, it } from 'vitest';
import { extractPdfText, PdfTimeoutError } from '../src/services/extraction/pdfText.js';
import { generateSampleInvoice } from '../src/services/simulator/sampleInvoices.js';

/**
 * Phase 3 of the September 2026 audit: PDF text extraction runs on a
 * maintained pdf.js, inside a worker thread, under a deadline.
 */
describe('extractPdfText', () => {
  it('reads the text layer of a generated invoice, one baseline per line', async () => {
    const generated = await generateSampleInvoice({ vendorIndex: 0, scenario: 'normal' });
    const { text, numPages } = await extractPdfText(generated.buffer);
    expect(numPages).toBe(1);
    expect(text).toContain(generated.ref);
    expect(text.split('\n').length).toBeGreaterThan(5);
  });

  it('honours maxPages and reports the true page count', async () => {
    const generated = await generateSampleInvoice({ scenario: 'payment_recommendation' });
    const full = await extractPdfText(generated.buffer);
    const first = await extractPdfText(generated.buffer, { maxPages: 1 });
    expect(first.numPages).toBe(full.numPages);
    expect(first.text.length).toBeLessThanOrEqual(full.text.length);
    expect(first.text).toMatch(/monthly payment recommendation/i);
  });

  it('works on a pooled Buffer slice (no exact-bounds copy needed by callers)', async () => {
    const generated = await generateSampleInvoice({ vendorIndex: 1, scenario: 'normal' });
    const pooled = Buffer.concat([Buffer.from('junk-before-'), generated.buffer, Buffer.from('-junk-after')]);
    const slice = pooled.subarray(12, 12 + generated.buffer.length);
    expect(slice.byteOffset).not.toBe(0);
    expect((await extractPdfText(slice)).text).toContain(generated.ref);
  });

  it('rejects a corrupt file with an error, not a hang', async () => {
    const corrupt = await generateSampleInvoice({ scenario: 'corrupt' });
    await expect(extractPdfText(corrupt.buffer)).rejects.toThrow();
    await expect(extractPdfText(Buffer.from('not a pdf at all'))).rejects.toThrow();
  });

  it('terminates the worker at the deadline', async () => {
    const generated = await generateSampleInvoice({ vendorIndex: 0, scenario: 'normal' });
    await expect(extractPdfText(generated.buffer, { timeoutMs: 1 })).rejects.toBeInstanceOf(PdfTimeoutError);
  });
});
