import express, { Router, type Request } from 'express';
import { z } from 'zod';
import type { ConnectorStatus, Overview, ReviewSubmission } from '@finny/shared';
import { config } from '../config.js';
import { getStatus } from '../db/db.js';
import {
  clearSessionCookie,
  createSessionCookie,
  readSession,
  requireAuth,
  requireLead,
} from './auth.js';
import {
  countByTab,
  getInvoiceRow,
  listApprovedForBlockDocs,
  listInvoices,
  reopenInvoice,
  toDetail,
} from '../services/invoices.js';
import { entraCallback, entraLogin } from './entra.js';
import { requireBlockDocsToken } from './integrationAuth.js';
import { ReviewError, retryApproval, submitReview } from '../services/review.js';
import { resetForRetry } from '../services/extraction/pipeline.js';
import { drainExtractionQueue } from '../workers.js';
import {
  createManualRule,
  decidePendingRule,
  listRules,
  pendingRuleCount,
  retireRule,
  updateRule,
} from '../services/rules.js';
import { emailProviderName, listAlerts, openAlertCount, setAlertStatus } from '../services/alerts.js';
import {
  batchFilePath,
  exportPool,
  generateBatches,
  getBatch,
  listBatches,
  markImported,
  sendBatchToSage,
  syncPostingSequence,
} from '../services/sage.js';
import { configuredSageEntities, fetchActiveNominals, fetchSageReference, resolveSageServer } from '../services/sage/hyperaccounts.js';
import { validateAgainstSage } from '../services/sage/reference.js';
import { pullSummary, storePulledNominals } from '../services/sage/nominals.js';
import { dashboardMetrics } from '../services/metrics.js';
import { getApprover, getSettings, listApprovers, updateSettings } from '../services/settings.js';
import { all, one, run } from '../db/db.js';
import { newId, nowIso } from '../domain/util.js';
import { audit } from '../services/audit.js';
import { ingestAttachment } from '../services/ingestion/ingest.js';
import { simulateIncomingInvoice } from '../services/simulator/simulator.js';
import { recordApprovalDecision } from '../services/approvals/approvals.js';
import { verifyAttachmentToken } from '../services/attachmentLinks.js';
import { latestApproval, toSummary } from '../services/invoices.js';

// Express 5 types route params as string | string[] (repeatable segments);
// our :id params are always single strings.
function paramId(req: Request): string {
  const id = (req.params as Record<string, string | string[]>).id;
  return Array.isArray(id) ? id[0] : id;
}

export function buildRouter(): Router {
  const router = Router();
  router.use(express.json({ limit: '2mb' }));

  // ── Health & auth ──────────────────────────────────────────────────────────
  router.get('/health', (_req, res) => {
    res.json({ ok: true, mode: getSettings().mode });
  });

  // Which login UI the SPA should render (public — the login page needs it).
  router.get('/auth/mode', (_req, res) => {
    res.json({ provider: config.authProvider });
  });
  // Entra ID SSO endpoints (no-ops unless AUTH_PROVIDER=entra).
  router.get('/auth/entra/login', (req, res) => {
    if (config.authProvider !== 'entra') {
      res.status(400).json({ error: 'AUTH_PROVIDER is not "entra"' });
      return;
    }
    void entraLogin(req, res);
  });
  router.get('/auth/entra/callback', (req, res) => {
    if (config.authProvider !== 'entra') {
      res.status(400).json({ error: 'AUTH_PROVIDER is not "entra"' });
      return;
    }
    void entraCallback(req, res);
  });

  const loginSchema = z.object({
    email: z.string().email(),
    name: z.string().min(1).max(80),
    role: z.enum(['processor', 'lead']),
  });
  router.post('/auth/dev-login', (req, res) => {
    if (config.authProvider !== 'dev') {
      res.status(400).json({ error: 'Dev login is disabled — AUTH_PROVIDER is not "dev"' });
      return;
    }
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'email, name and role (processor|lead) are required' });
      return;
    }
    res.setHeader('Set-Cookie', createSessionCookie(parsed.data));
    res.json(parsed.data);
  });
  router.post('/auth/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.json({ ok: true });
  });
  router.get('/me', (req, res) => {
    const user = readSession(req);
    if (!user) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }
    res.json(user);
  });

  // ── Tokenized attachment links (no session) ───────────────────────────────
  // Approving managers are not Finny users: the Teams approval card carries a
  // signed, expiring link so they can view the invoice without an account.
  router.get('/public/invoices/:id/attachment', (req, res) => {
    const id = paramId(req);
    const exp = typeof req.query.exp === 'string' ? req.query.exp : undefined;
    const sig = typeof req.query.sig === 'string' ? req.query.sig : undefined;
    const row = verifyAttachmentToken(id, exp, sig) ? getInvoiceRow(id) : undefined;
    if (!row || !row.attachment_path) {
      res
        .status(410)
        .type('html')
        .send(
          '<body style="font-family: system-ui, sans-serif; padding: 3rem; color: #1d2721; background: #f7f5f0">' +
            '<h2>This invoice link is invalid or has expired</h2>' +
            '<p>Links from approval requests are valid for 14 days. Ask the AP team to resend it from Finny.</p></body>',
        );
      return;
    }
    res.setHeader('Content-Type', String(row.attachment_mime ?? 'application/octet-stream'));
    res.setHeader('Content-Disposition', `inline; filename="${String(row.attachment_name ?? 'invoice')}"`);
    res.sendFile(String(row.attachment_path));
  });

  // ── BlockDocs pull endpoint (bearer token, no session) ────────────────────
  // Machine-to-machine: BlockDocs polls approved, project-tagged invoices for
  // its budget-vs-invoiced dashboard. Returns approved_at — Finny stops at
  // approval (Sage handles payment), so there is deliberately no paid date.
  router.get('/integrations/blockdocs/invoices', requireBlockDocsToken, (req, res) => {
    const projectCode = typeof req.query.project_code === 'string' ? req.query.project_code : undefined;
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    res.json(listApprovedForBlockDocs(projectCode, since));
  });

  // Everything below requires a session.
  router.use(requireAuth);

  // ── Overview (nav badges) ─────────────────────────────────────────────────
  router.get('/overview', (_req, res) => {
    const counts = countByTab();
    const overview: Overview = {
      mode: getSettings().mode,
      counts: {
        needs_review: counts.needs_review ?? 0,
        failed: counts.failed ?? 0,
        awaiting_approval: counts.awaiting_approval ?? 0,
        completed: counts.completed ?? 0,
        open_alerts: openAlertCount(),
        pending_rules: pendingRuleCount(),
        export_pool: exportPool().length,
      },
      simulator_enabled: config.mailProvider === 'mock',
      approvals_simulator_enabled: config.approvalsProvider === 'mock',
    };
    res.json(overview);
  });

  router.get('/status', (_req, res) => {
    const status: ConnectorStatus = {
      mail_provider: config.mailProvider,
      extraction_provider: config.extractionProvider,
      approvals_provider: config.approvalsProvider,
      email_provider: emailProviderName(),
      auth_provider: config.authProvider,
      sage_provider: config.sage.provider,
      // Which entities have a HyperAccounts server configured — independent of
      // the provider switch, because the Settings reference check (read-only)
      // is useful before one-touch posting goes live.
      sage_entities: configuredSageEntities(),
      mail_last_poll: getStatus('mail_last_poll'),
      mail_last_error: getStatus('mail_last_error'),
      approvals_last_poll: getStatus('approvals_last_poll'),
      approvals_last_error: getStatus('approvals_last_error'),
    };
    res.json(status);
  });

  // ── Invoices ──────────────────────────────────────────────────────────────
  router.get('/invoices', (req, res) => {
    const tab = typeof req.query.tab === 'string' ? req.query.tab : 'all';
    res.json(listInvoices(tab));
  });

  router.get('/invoices/:id', (req, res) => {
    const row = getInvoiceRow(paramId(req));
    if (!row) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }
    res.json(toDetail(row));
  });

  router.get('/invoices/:id/attachment', (req, res) => {
    const row = getInvoiceRow(paramId(req));
    if (!row || !row.attachment_path) {
      res.status(404).json({ error: 'Attachment not found' });
      return;
    }
    res.setHeader('Content-Type', String(row.attachment_mime ?? 'application/octet-stream'));
    res.setHeader('Content-Disposition', `inline; filename="${String(row.attachment_name ?? 'attachment')}"`);
    res.sendFile(String(row.attachment_path));
  });

  const reviewSchema = z.object({
    action: z.enum(['confirm', 'shadow_log', 'discard']),
    discard_reason: z.string().max(300).optional(),
    fields: z.object({
      vendor_name: z.string().max(200).nullable(),
      invoice_ref: z.string().max(100).nullable(),
      invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
      net_cents: z.number().int().nullable(),
      vat_cents: z.number().int().nullable(),
      gross_cents: z.number().int().nullable(),
      vat_rate: z.number().nullable(),
      vat_number: z.string().max(40).nullable(),
      po_number: z.string().max(60).nullable(),
      supplier_account_ref: z.string().max(30).nullable(),
    }),
    category: z.string().max(100).nullable(),
    approver_id: z.string().max(60).nullable(),
    entity: z.string().max(200).nullable(),
    project_code: z.string().max(30).nullable(),
  });

  router.post('/invoices/:id/review', async (req, res) => {
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `Invalid review payload: ${parsed.error.issues[0]?.message ?? ''}` });
      return;
    }
    try {
      await submitReview(paramId(req), parsed.data as ReviewSubmission, req.user!);
      const row = getInvoiceRow(paramId(req));
      res.json(row ? toDetail(row) : { ok: true });
    } catch (err) {
      if (err instanceof ReviewError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.post('/invoices/:id/retry-extraction', async (req, res) => {
    if (!resetForRetry(paramId(req))) {
      res.status(409).json({ error: 'Only failed invoices can be re-extracted' });
      return;
    }
    audit(paramId(req), 'extraction_retry_requested', req.user!.email);
    void drainExtractionQueue();
    res.json({ ok: true });
  });

  // Safety valve for auto-filed statements (and accidental discards): put
  // the document back into the review queue.
  router.post('/invoices/:id/reopen', (req, res) => {
    if (!reopenInvoice(paramId(req), req.user!.email)) {
      res.status(409).json({ error: 'Only discarded documents can be reopened' });
      return;
    }
    const row = getInvoiceRow(paramId(req));
    res.json(row ? toDetail(row) : { ok: true });
  });

  router.post('/invoices/:id/retry-approval', async (req, res) => {
    try {
      await retryApproval(paramId(req), req.user!);
      const row = getInvoiceRow(paramId(req));
      res.json(row ? toDetail(row) : { ok: true });
    } catch (err) {
      if (err instanceof ReviewError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // Manual upload — drop a real invoice in without email.
  router.post(
    '/invoices/upload',
    express.raw({ type: () => true, limit: '30mb' }),
    async (req, res) => {
      const filename = typeof req.query.filename === 'string' ? req.query.filename : 'upload.pdf';
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        res.status(400).json({ error: 'Empty upload' });
        return;
      }
      const id = await ingestAttachment(body, filename, {
        source: 'upload',
        emailFrom: req.user!.email,
        emailSubject: `Manual upload: ${filename}`,
      });
      void drainExtractionQueue();
      res.json({ id });
    },
  );

  // ── Rules ─────────────────────────────────────────────────────────────────
  router.get('/rules', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    res.json(listRules(status as never));
  });

  const manualRuleSchema = z.object({
    kind: z.enum(['routing', 'extraction_hint']),
    vendor: z.string().min(2).max(200),
    category: z.string().max(100).nullable().optional(),
    approver_id: z.string().max(60).nullable().optional(),
    hint_text: z.string().max(500).nullable().optional(),
  });
  router.post('/rules', requireLead, (req, res) => {
    const parsed = manualRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid rule payload' });
      return;
    }
    if (parsed.data.kind === 'routing' && (!parsed.data.category || !parsed.data.approver_id)) {
      res.status(400).json({ error: 'Routing rules need both a category and an approver' });
      return;
    }
    if (parsed.data.kind === 'extraction_hint' && !parsed.data.hint_text) {
      res.status(400).json({ error: 'Extraction hints need hint text' });
      return;
    }
    res.json(
      createManualRule({
        kind: parsed.data.kind,
        vendor: parsed.data.vendor,
        category: parsed.data.category ?? null,
        approverId: parsed.data.approver_id ?? null,
        hintText: parsed.data.hint_text ?? null,
        who: req.user!.email,
      }),
    );
  });

  router.patch('/rules/:id', requireLead, (req, res) => {
    const rule = updateRule(paramId(req), req.body ?? {}, req.user!.email);
    if (!rule) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }
    res.json(rule);
  });

  router.post('/rules/:id/decide', requireLead, (req, res) => {
    const decision = req.body?.decision;
    if (decision !== 'approve' && decision !== 'reject') {
      res.status(400).json({ error: 'decision must be approve or reject' });
      return;
    }
    const rule = decidePendingRule(paramId(req), decision, req.user!.email);
    if (!rule) {
      res.status(409).json({ error: 'Rule is not pending' });
      return;
    }
    res.json(rule);
  });

  router.post('/rules/:id/retire', requireLead, (req, res) => {
    const rule = retireRule(paramId(req), req.user!.email);
    if (!rule) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }
    res.json(rule);
  });

  // ── Alerts ────────────────────────────────────────────────────────────────
  router.get('/alerts', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    res.json(listAlerts(status));
  });
  router.post('/alerts/:id/ack', (req, res) => {
    const alert = setAlertStatus(paramId(req), 'acknowledged', req.user!.email);
    alert ? res.json(alert) : res.status(404).json({ error: 'Alert not found' });
  });
  router.post('/alerts/:id/resolve', (req, res) => {
    const alert = setAlertStatus(paramId(req), 'resolved', req.user!.email);
    alert ? res.json(alert) : res.status(404).json({ error: 'Alert not found' });
  });

  // ── Sage exports ──────────────────────────────────────────────────────────
  router.get('/exports/pool', (_req, res) => {
    res.json(exportPool().map(toSummary));
  });
  router.get('/exports', (_req, res) => {
    res.json(listBatches());
  });
  router.post('/exports', async (req, res) => {
    const ids = z.array(z.string()).safeParse(req.body?.invoice_ids);
    if (!ids.success || ids.data.length === 0) {
      res.status(400).json({ error: 'invoice_ids is required' });
      return;
    }
    try {
      // Read Sage first: fast-forward the posting-ref counter past anything
      // posted outside Finny, so the refs assigned below cannot collide.
      await syncPostingSequence(ids.data, req.user!.email);
      const batches = await generateBatches(ids.data, req.user!.email);
      // One-touch mode: posting straight into Sage is part of the same click.
      // A send failure never fails the request — the batch stays 'generated'
      // with an alert, and the UI offers "Send to Sage" as a retry.
      if (config.sage.provider === 'hyperaccounts') {
        for (const batch of batches) {
          await sendBatchToSage(batch.id, req.user!.email).catch((err) =>
            console.error(`[sage] send failed for batch ${batch.id}:`, err),
          );
        }
      }
      res.json(batches.map((b) => getBatch(b.id)));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Export failed' });
    }
  });

  // Pull the live Sage company's reference data (nominals, tax codes,
  // departments, projects) and validate the Settings mappings against it.
  // Read-only against Sage; works as soon as a HyperAccounts server is
  // configured, even before SAGE_PROVIDER flips to one-touch mode.
  router.get('/sage/reference', requireLead, async (req, res) => {
    const entity = typeof req.query.entity === 'string' && req.query.entity !== '' ? req.query.entity : null;
    const server = resolveSageServer(entity);
    if (!server) {
      res.json({ configured: false });
      return;
    }
    try {
      const reference = await fetchSageReference(server);
      res.json({
        configured: true,
        entity: server.entity,
        counts: {
          nominals: reference.nominals.length,
          tax_codes: reference.taxCodes.length,
          departments: reference.departments.length,
          projects: reference.projects.length,
        },
        validation: validateAgainstSage(getSettings(), reference),
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Sage reference pull failed' });
    }
  });

  // Adopt an entity's ACTIVE nominal codes from Sage as the coding list —
  // the union across pulled entities becomes settings.categories, so nobody
  // maintains a hand-typed copy of the chart of accounts.
  router.post('/sage/nominals/pull', requireLead, async (req, res) => {
    const entity = typeof req.body?.entity === 'string' && req.body.entity !== '' ? req.body.entity : null;
    const server = resolveSageServer(entity);
    if (!server) {
      res.status(400).json({ error: `No HyperAccounts server configured for "${entity ?? 'default'}" — set SAGE_API_URL or SAGE_ENTITY_SERVERS` });
      return;
    }
    try {
      const nominals = await fetchActiveNominals(server);
      const categories = storePulledNominals(entity ?? server.entity, nominals, req.user!.email);
      res.json({ entity: entity ?? server.entity, pulled: nominals.length, categories });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Nominal pull failed' });
    }
  });
  router.get('/sage/nominals', (_req, res) => {
    res.json({ summary: pullSummary() });
  });

  // Retry/one-touch send for a batch that didn't fully post.
  router.post('/exports/:id/send', async (req, res) => {
    try {
      const summary = await sendBatchToSage(paramId(req), req.user!.email);
      res.json({ batch: getBatch(paramId(req)), summary });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Send failed' });
    }
  });
  router.get('/exports/:id/download', (req, res) => {
    const filePath = batchFilePath(paramId(req));
    const batch = getBatch(paramId(req));
    if (!filePath || !batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${batch.filename}"`);
    res.sendFile(filePath);
  });
  router.post('/exports/:id/mark-imported', (req, res) => {
    const batch = markImported(paramId(req), req.user!.email);
    batch ? res.json(batch) : res.status(404).json({ error: 'Batch not found' });
  });

  // ── Metrics, settings, approvers ──────────────────────────────────────────
  router.get('/metrics/dashboard', (_req, res) => {
    res.json(dashboardMetrics());
  });

  router.get('/settings', (_req, res) => {
    res.json(getSettings());
  });
  router.patch('/settings', requireLead, (req, res) => {
    const before = getSettings();
    const updated = updateSettings(req.body ?? {});
    if (before.mode !== updated.mode) {
      audit(null, 'mode_changed', req.user!.email, { from: before.mode, to: updated.mode });
    } else {
      audit(null, 'settings_changed', req.user!.email, { keys: Object.keys(req.body ?? {}) });
    }
    res.json(updated);
  });

  router.get('/approvers', (_req, res) => {
    res.json(listApprovers(true));
  });
  const approverSchema = z.object({
    name: z.string().min(2).max(100),
    email: z.string().email(),
    teams_user_id: z.string().max(100).nullable().optional(),
  });
  router.post('/approvers', requireLead, (req, res) => {
    const parsed = approverSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'name and email are required' });
      return;
    }
    const id = newId();
    run(
      'INSERT INTO approvers (id, name, email, teams_user_id, active) VALUES (?, ?, ?, ?, 1)',
      id, parsed.data.name, parsed.data.email, parsed.data.teams_user_id ?? null,
    );
    audit(null, 'approver_added', req.user!.email, { approver: parsed.data.name });
    res.json(getApprover(id));
  });
  router.patch('/approvers/:id', requireLead, (req, res) => {
    const existing = getApprover(paramId(req));
    if (!existing) {
      res.status(404).json({ error: 'Approver not found' });
      return;
    }
    run(
      'UPDATE approvers SET name = ?, email = ?, teams_user_id = ?, active = ? WHERE id = ?',
      req.body?.name ?? existing.name,
      req.body?.email ?? existing.email,
      req.body?.teams_user_id !== undefined ? req.body.teams_user_id : existing.teams_user_id,
      req.body?.active !== undefined ? (req.body.active ? 1 : 0) : existing.active ? 1 : 0,
      paramId(req),
    );
    audit(null, 'approver_updated', req.user!.email, { approver_id: paramId(req) });
    res.json(getApprover(paramId(req)));
  });

  // ── Simulators (mock providers only) ──────────────────────────────────────
  router.post('/simulate/invoice', async (req, res) => {
    if (config.mailProvider !== 'mock') {
      res.status(400).json({ error: 'Simulator is only available with MAIL_PROVIDER=mock' });
      return;
    }
    const scenario = z
      .enum(['normal', 'missing_po', 'no_ref', 'image', 'corrupt', 'statement'])
      .catch('normal')
      .parse(req.body?.scenario);
    const count = Math.max(1, Math.min(10, Number(req.body?.count ?? 1)));
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(await simulateIncomingInvoice({ scenario }));
    }
    audit(null, 'simulated_invoices', req.user!.email, { scenario, count });
    void drainExtractionQueue();
    res.json({ ids });
  });

  router.post('/simulate/approval-decision', (req, res) => {
    if (config.approvalsProvider !== 'mock') {
      res.status(400).json({ error: 'Approval simulator is only available with APPROVALS_PROVIDER=mock' });
      return;
    }
    const invoiceId = String(req.body?.invoice_id ?? '');
    const decision = req.body?.decision === 'rejected' ? 'rejected' : 'approved';
    const approval = latestApproval(invoiceId);
    if (!approval || approval.status !== 'pending') {
      res.status(409).json({ error: 'No pending approval for this invoice' });
      return;
    }
    const approver = getApprover(approval.approver_id);
    const ok = recordApprovalDecision(
      approval.id,
      decision,
      `${approver?.name ?? 'Manager'} (simulated)`,
      typeof req.body?.note === 'string' ? req.body.note : null,
    );
    if (!ok) {
      res.status(409).json({ error: 'Approval already decided' });
      return;
    }
    const row = getInvoiceRow(invoiceId);
    res.json(row ? toDetail(row) : { ok: true });
  });

  return router;
}
