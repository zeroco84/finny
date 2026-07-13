import { beforeEach, describe, expect, it } from 'vitest';
import type { ReviewSubmission, SessionUser } from '@finny/shared';
import { config } from '../src/config.js';
import { closeDb, openDb, run } from '../src/db/db.js';
import { createInvoice } from '../src/services/invoices.js';
import { submitReview } from '../src/services/review.js';
import { getSettings, listApprovers, seedDefaults, updateSettings } from '../src/services/settings.js';

const LEAD: SessionUser = { email: 'lead@example.com', name: 'A Lead', role: 'lead' };

function seedNeedsReview(): string {
  const id = createInvoice({
    source: 'test',
    attachment_name: 'inv.pdf',
    attachment_mime: 'application/pdf',
    attachment_path: '/dev/null',
    attachment_size: 10,
  });
  run(`UPDATE invoices SET status = 'needs_review' WHERE id = ?`, id);
  return id;
}

function confirmSubmission(entity: string, project: string | null, ref: string): ReviewSubmission {
  return {
    action: 'confirm',
    fields: {
      vendor_name: 'Hegarty Steel Ltd',
      invoice_ref: ref,
      invoice_date: '2026-07-01',
      due_date: null,
      net_cents: 100000,
      vat_cents: 23000,
      gross_cents: 123000,
      vat_rate: 23,
      vat_number: null,
      po_number: null,
      supplier_account_ref: 'HEG001',
    },
    category: 'Materials',
    approver_id: listApprovers()[0].id,
    entity,
    project_code: project,
  };
}

describe('confirm: a project must belong to the billed-to entity', () => {
  beforeEach(() => {
    closeDb();
    openDb(':memory:');
    seedDefaults();
    updateSettings({ mode: 'live' });
    config.sessionSecret = 'test-secret';
  });

  it("rejects a project posted against another entity's books", async () => {
    const id = seedNeedsReview();
    // CLON3 belongs to Meadowvale Developments Ltd in the seeded defaults.
    const sub = confirmSubmission('Meadowvale Construction Ltd', 'CLON3', 'INV-1');
    await expect(submitReview(id, sub, LEAD)).rejects.toThrow(/belongs to Meadowvale Developments Ltd/);
  });

  it("accepts the entity's own project", async () => {
    const id = seedNeedsReview();
    await submitReview(id, confirmSubmission('Meadowvale Construction Ltd', 'DOCKM', 'INV-2'), LEAD);
  });

  it('accepts a not-yet-assigned (legacy) project with any entity', async () => {
    updateSettings({
      projects: [...getSettings().projects, { name: 'Legacy Job', code: 'LEG1', dept: '0', entity: '' }],
    });
    const id = seedNeedsReview();
    await submitReview(id, confirmSubmission('Meadowvale Asset Management Ltd', 'LEG1', 'INV-3'), LEAD);
  });

  it('leaves shadow logs loose — they record the manual process, not a posting', async () => {
    updateSettings({ mode: 'shadow' });
    const id = seedNeedsReview();
    const sub = confirmSubmission('Meadowvale Construction Ltd', 'CLON3', 'INV-4');
    sub.action = 'shadow_log';
    await submitReview(id, sub, LEAD); // cross-entity pair, but only logged
  });
});
