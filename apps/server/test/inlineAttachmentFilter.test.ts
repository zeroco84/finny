import { describe, expect, it } from 'vitest';
import { isInlineAttachment } from '../src/services/ingestion/mailProviders.js';

// The fixtures below are real attachment metadata read back from Graph for
// messages the poller had skipped, and are the reason this filter exists in
// this shape: Exchange Online sets a Content-ID on ordinary invoice PDFs.
describe('isInlineAttachment — email signature logos are not invoices', () => {
  it('skips images the sender marked inline (isInline=true)', () => {
    expect(
      isInlineAttachment({
        isInline: true,
        contentId: 'image001.png@01DD20F5.86675C20',
        contentType: 'image/png',
        size: 33985,
      }),
    ).toBe(true);
  });

  it('skips a small cid: image from a client that omits isInline', () => {
    expect(
      isInlineAttachment({ contentId: '<logo@example.test>', contentType: 'image/png', size: 3026 }),
    ).toBe(true);
  });

  it('keeps genuine invoice attachments (not inline, no Content-ID)', () => {
    expect(isInlineAttachment({ isInline: false, contentId: null })).toBe(false);
    expect(isInlineAttachment({})).toBe(false);
  });
});

describe('isInlineAttachment — Exchange stamps a Content-ID on real attachments', () => {
  // Regression: `isInline || contentId` matched every attachment Exchange
  // relayed, so every invoice in the shared mailbox was silently discarded
  // from 2026-07-11 until it was caught on 2026-08-03.
  it('keeps an invoice PDF that carries an Exchange Content-ID', () => {
    expect(
      isInlineAttachment({
        isInline: false,
        contentId: '021EF164D5E500418B053E1076BD9953@eurprd03.prod.outlook.com',
        contentType: 'application/pdf',
        size: 104464,
      }),
    ).toBe(false);
  });

  it('keeps a large invoice PDF with a Content-ID', () => {
    expect(
      isInlineAttachment({
        isInline: false,
        contentId: 'D397D2A52C517B4D9C3C83A6B4AAE29D@eurprd03.prod.outlook.com',
        contentType: 'application/pdf',
        size: 717196,
      }),
    ).toBe(false);
  });

  it('keeps a non-image attachment with a Content-ID (csv, octet-stream)', () => {
    expect(
      isInlineAttachment({
        isInline: false,
        contentId: '3806F4385911924195389C5EE4925B5D@eurprd03.prod.outlook.com',
        contentType: 'text/csv',
        size: 2480,
      }),
    ).toBe(false);
    expect(
      isInlineAttachment({
        isInline: false,
        contentId: 'AB12@eurprd03.prod.outlook.com',
        contentType: 'application/octet-stream',
        size: 219460,
      }),
    ).toBe(false);
  });

  it('keeps a photographed invoice — a big image is not body furniture', () => {
    expect(
      isInlineAttachment({
        isInline: false,
        contentId: 'CD34@eurprd03.prod.outlook.com',
        contentType: 'image/jpeg',
        size: 239581,
      }),
    ).toBe(false);
  });
});
