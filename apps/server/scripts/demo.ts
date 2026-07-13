/**
 * Demo seeder: replays ~4 weeks of AP history through the real pipeline so a
 * fresh checkout has a populated queue, learned rules, accuracy metrics, an
 * export batch and a live alert. Destructive — wipes ./data (requires --force
 * if a database already exists).
 *
 *   npm run demo            # first run
 *   npm run demo -- --force # reset and re-seed
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ReviewSubmission } from '@finny/shared';
import { config, ensureDataDirs } from '../src/config.js';
import { closeDb, all, one, run, openDb } from '../src/db/db.js';
import { seedDefaults, getSettings, updateSettings, listApprovers } from '../src/services/settings.js';
import { simulateIncomingInvoice } from '../src/services/simulator/simulator.js';
import { processInvoice } from '../src/services/extraction/pipeline.js';
import { submitReview } from '../src/services/review.js';
import { listRules, decidePendingRule } from '../src/services/rules.js';
import { generateBatches } from '../src/services/sage.js';
import { latestApproval } from '../src/services/invoices.js';
import { recordApprovalDecision } from '../src/services/approvals/approvals.js';
import { suggestAccountRef } from '../src/domain/util.js';

const PROCESSOR = { email: 'amy@example.com', name: 'Amy Byrne', role: 'processor' as const };
const LEAD = { email: 'ap.lead@example.com', name: 'Niamh Egan', role: 'lead' as const };

// Ground truth: how the AP team actually routes each vendor today.
const ROUTING: Record<string, { category: string; approver: string }> = {
  'Hegarty Steel Ltd': { category: 'Materials', approver: 'James Brennan' },
  'MidWest Plant Hire': { category: 'Plant & Equipment Hire', approver: 'Maeve O’Brien' },
  'Brady & Nolan Solicitors LLP': { category: 'Professional Fees', approver: 'Sinead Kavanagh' },
  'ESB Networks': { category: 'Utilities', approver: 'Aidan Doyle' },
  'Dublin Skip & Waste Co': { category: 'Site Costs', approver: 'James Brennan' },
  'Corrib Ready Mix Concrete': { category: 'Materials', approver: 'James Brennan' },
  'Fastway Office Supplies': { category: 'Office & Admin', approver: 'Sinead Kavanagh' },
};

function daysAgo(days: number, hour = 10): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, Math.floor(Math.random() * 50), 0, 0);
  return d;
}

function backdate(invoiceId: string, when: Date): void {
  const iso = when.toISOString();
  const later = new Date(when.getTime() + 45 * 60 * 1000).toISOString();
  run(
    `UPDATE invoices SET received_at = ?, created_at = ?,
       reviewed_at = CASE WHEN reviewed_at IS NOT NULL THEN ? ELSE NULL END,
       confirmed_at = CASE WHEN confirmed_at IS NOT NULL THEN ? ELSE NULL END,
       updated_at = ? WHERE id = ?`,
    iso, iso, later, later, later, invoiceId,
  );
  run(`UPDATE audit_events SET created_at = ? WHERE invoice_id = ?`, later, invoiceId);
  run(`UPDATE corrections SET created_at = ? WHERE invoice_id = ?`, later, invoiceId);
  run(`UPDATE shadow_comparisons SET created_at = ? WHERE invoice_id = ?`, later, invoiceId);
}

async function reviewInvoice(
  invoiceId: string,
  action: 'shadow_log' | 'confirm',
  who: typeof PROCESSOR | typeof LEAD,
): Promise<void> {
  const row = one('SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!row || row.status !== 'needs_review') return;
  const vendor = row.vendor_name === null ? null : String(row.vendor_name);
  const routing = vendor ? ROUTING[vendor] : undefined;
  const approvers = listApprovers();
  const approver = routing ? approvers.find((a) => a.name === routing.approver) : undefined;
  const settings = getSettings();

  const submission: ReviewSubmission = {
    action,
    fields: {
      vendor_name: vendor ?? 'Unknown Vendor',
      invoice_ref: row.invoice_ref === null ? `MAN-${invoiceId.slice(0, 5).toUpperCase()}` : String(row.invoice_ref),
      invoice_date: row.invoice_date === null ? new Date().toISOString().slice(0, 10) : String(row.invoice_date),
      net_cents: row.net_cents === null ? null : Number(row.net_cents),
      vat_cents: row.vat_cents === null ? null : Number(row.vat_cents),
      gross_cents: row.gross_cents === null ? 100_00 : Number(row.gross_cents),
      vat_rate: row.vat_rate === null ? null : Number(row.vat_rate),
      vat_number: row.vat_number === null ? null : String(row.vat_number),
      po_number: row.po_number === null ? null : String(row.po_number),
      supplier_account_ref:
        row.supplier_account_ref !== null
          ? String(row.supplier_account_ref)
          : suggestAccountRef(vendor ?? 'SUPPLIER'),
    },
    category: routing?.category ?? 'Site Costs',
    approver_id: approver?.id ?? approvers[0].id,
    // When extraction missed the entity, a referenced project pins it down
    // (confirms reject a project posted against another entity's books).
    entity:
      row.entity !== null
        ? String(row.entity)
        : settings.projects.find((p) => p.code === row.project_code)?.entity ||
          settings.entities[0],
    project_code: row.project_code === null ? null : String(row.project_code),
  };
  await submitReview(invoiceId, submission, who);
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  if (fs.existsSync(config.dbPath) && !force) {
    console.error('data/finny.db already exists — run `npm run demo -- --force` to wipe and re-seed.');
    process.exit(1);
  }
  for (const p of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) {
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  for (const dir of [config.attachmentsDir, config.exportsDir, config.inboxDir]) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  }
  ensureDataDirs();
  openDb(config.dbPath);
  seedDefaults();
  console.log('Seeding demo history (this exercises the real pipeline)…');

  const vendorNames = Object.keys(ROUTING);

  // ── Weeks 4..2 ago: shadow mode — humans do today's process, AI observes ──
  let invoiceNo = 0;
  for (let week = 4; week >= 2; week--) {
    for (let i = 0; i < 5; i++) {
      const vendorIndex = invoiceNo % vendorNames.length;
      const when = daysAgo(week * 7 - i, 9 + (i % 6));
      const id = await simulateIncomingInvoice({ vendorIndex, receivedAt: when.toISOString(), date: when });
      await processInvoice(id);
      await reviewInvoice(id, 'shadow_log', PROCESSOR);
      backdate(id, when);
      invoiceNo++;
    }
    // End of each shadow week the AP Lead reviews the learned-rule proposals.
    for (const rule of listRules('pending')) {
      decidePendingRule(rule.id, 'approve', LEAD.email);
    }
  }

  // ── This week: the lead flips to live mode ────────────────────────────────
  updateSettings({ mode: 'live' });
  run(
    `INSERT INTO audit_events (id, invoice_id, type, actor, detail, created_at)
     VALUES (?, NULL, 'mode_changed', ?, ?, ?)`,
    crypto.randomUUID(), LEAD.email, JSON.stringify({ from: 'shadow', to: 'live' }),
    daysAgo(5, 9).toISOString(),
  );

  const confirmed: string[] = [];
  for (let i = 0; i < 6; i++) {
    const when = daysAgo(4 - (i % 4), 9 + i);
    const id = await simulateIncomingInvoice({
      vendorIndex: i % vendorNames.length,
      receivedAt: when.toISOString(),
      date: when,
    });
    await processInvoice(id);
    await reviewInvoice(id, 'confirm', PROCESSOR);
    backdate(id, when);
    confirmed.push(id);
  }

  // A batch goes to Sage; managers decide most of the approvals in Teams.
  await generateBatches(confirmed.slice(0, 4), PROCESSOR.email);
  for (let i = 0; i < confirmed.length - 1; i++) {
    const approval = latestApproval(confirmed[i]);
    if (approval && approval.status === 'pending') {
      recordApprovalDecision(
        approval.id,
        i === 3 ? 'rejected' : 'approved',
        'Manager (simulated)',
        i === 3 ? 'Wrong PO — query with supplier' : null,
      );
    }
  }

  // ── Today: fresh arrivals sitting in the queue + one failure alert ────────
  for (let i = 0; i < 3; i++) {
    const id = await simulateIncomingInvoice({
      vendorIndex: (i + 2) % vendorNames.length,
      scenario: i === 2 ? 'missing_po' : 'normal',
    });
    await processInvoice(id);
  }
  const imageId = await simulateIncomingInvoice({ scenario: 'image' });
  await processInvoice(imageId);
  const corruptId = await simulateIncomingInvoice({ scenario: 'corrupt' });
  await processInvoice(corruptId);

  // ── Summary ───────────────────────────────────────────────────────────────
  const statuses = all<{ status: string; n: number }>(
    'SELECT status, COUNT(*) AS n FROM invoices GROUP BY status ORDER BY n DESC',
  );
  const rules = all<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM rules WHERE kind = 'routing' GROUP BY status`,
  );
  const alerts = one<{ n: number }>(`SELECT COUNT(*) AS n FROM alerts WHERE status = 'open'`);
  const comparisons = one<{ n: number; m: number }>(
    'SELECT COUNT(*) AS n, SUM(matched) AS m FROM shadow_comparisons',
  );
  console.log('\n── Demo data ready ─────────────────────────────');
  console.log('Mode:', getSettings().mode);
  console.log('Invoices:', statuses.map((s) => `${s.status}=${s.n}`).join('  '));
  console.log('Routing rules:', rules.map((r) => `${r.status}=${r.n}`).join('  ') || 'none');
  console.log('Open alerts:', alerts?.n ?? 0);
  if (comparisons && Number(comparisons.n) > 0) {
    console.log(
      `AI-vs-human comparisons: ${comparisons.n} fields, ${Math.round((Number(comparisons.m) / Number(comparisons.n)) * 100)}% match`,
    );
  }
  const batch = one<{ filename: string }>('SELECT filename FROM sage_batches LIMIT 1');
  if (batch) console.log('Sage batch:', path.join(config.exportsDir, String(batch.filename)));
  console.log('\nStart the app:  npm run dev   →  http://localhost:5173');
  console.log('Sign in as anyone (e.g. ap.lead@example.com, role AP Lead).');
  closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
