import { describe, expect, it } from 'vitest';
import { isInlineAttachment } from '../src/services/ingestion/mailProviders.js';

describe('isInlineAttachment — email signature logos are not invoices', () => {
  it('skips images the sender marked inline (isInline=true)', () => {
    expect(isInlineAttachment({ isInline: true, contentId: '<image001@01DA.abc>' })).toBe(true);
  });

  it('skips images referenced by a Content-ID even when isInline is unset', () => {
    // Some clients omit isInline but still reference the logo via cid: in the body.
    expect(isInlineAttachment({ contentId: '<logo@meadowvale.example>' })).toBe(true);
  });

  it('keeps genuine invoice attachments (not inline, no Content-ID)', () => {
    expect(isInlineAttachment({ isInline: false, contentId: null })).toBe(false);
    expect(isInlineAttachment({})).toBe(false);
  });
});
