import { describe, expect, it } from 'vitest';
import { buildAttachmentBlock } from '../src/services/extraction/anthropicExtractor.js';
import { UnreadableDocumentError } from '../src/services/extraction/extractor.js';

const small = Buffer.from('fake-bytes');

describe('buildAttachmentBlock (Claude vision input)', () => {
  it('PDFs become document blocks', () => {
    const block = buildAttachmentBlock(small, 'application/pdf');
    expect(block).toMatchObject({ type: 'document', source: { media_type: 'application/pdf' } });
  });

  it('photographed invoices become image blocks (png/jpeg/gif/webp)', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(buildAttachmentBlock(small, mime)).toMatchObject({
        type: 'image',
        source: { media_type: mime },
      });
    }
  });

  it('normalizes the non-standard image/jpg label', () => {
    expect(buildAttachmentBlock(small, 'image/jpg')).toMatchObject({
      source: { media_type: 'image/jpeg' },
    });
  });

  it('rejects images over the 5MB API limit with an actionable message', () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1);
    expect(() => buildAttachmentBlock(big, 'image/png')).toThrow(UnreadableDocumentError);
    expect(() => buildAttachmentBlock(big, 'image/png')).toThrow(/5MB.*smaller photo|smaller photo/i);
    // The same size is fine for a PDF (its cap is 30MB).
    expect(buildAttachmentBlock(big, 'application/pdf')).toMatchObject({ type: 'document' });
  });

  it('rejects unsupported types by name instead of letting the API 400', () => {
    expect(() => buildAttachmentBlock(small, 'application/octet-stream')).toThrow(/Unsupported attachment type/);
    expect(() => buildAttachmentBlock(small, 'image/heic')).toThrow(UnreadableDocumentError);
  });
});
