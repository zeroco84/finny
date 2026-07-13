import express, { Router, type Request } from 'express';
import { z } from 'zod';
import type { ConnectorStatus, Overview, ReviewSubmission, WebhookSubscriptionInput } from '@finny/shared';
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
import {
  alertsChannelName,
  isValidWebhookUrl,
  listAlerts,
  openAlertCount,
  sendTestAlert,
  setAlertStatus,
  webhookInfo,
} from '../services/alerts.js';
import {
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  NotificationError,
  sendSubscriptionTest,
  updateSubscription,
} from '../services/notifications.js';
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
import { configuredSageEntities, fetchActiveNominals, fetchDepartments, fetchSageReference, resolveSageServer } from '../services/sage/hyperaccounts.js';
import { validateAgainstSage } from '../services/sage/reference.js';
import { pullSummary, storePulledNominals } from '../services/sage/nominals.js';
import { dashboardMetrics, volumeMetrics } from '../services/metrics.js';
import {
  anthropicKeyInfo,
  approversGroupConfigured,
  approversProvider,
  extractionProviderActive,
  getApprover,
  getExtractionModel,
  getSettings,
  listApprovers,
  setAnthropicKey,
  syncApprovers,
  updateSettings,
} from '../services/settings.js';
import { ensureTeamMemberOnSignIn, listTeam, setMemberRole, syncGroup, TeamError } from '../services/team.js';
import { GraphAuthError } from '../services/graph/graphClient.js';
import { all, one, run } from '../db/db.js';
import { newId, nowIso } from '../domain/util.js';
import { audit, auditFilterOptions, auditLogCsv, listAuditLog } from '../services/audit.js';
import { ingestAttachment } from '../services/ingestion/ingest.js';
import { simulateIncomingInvoice } from '../services/simulator/simulator.js';
import { recordApprovalDecision } from '../services/approvals/approvals.js';
import { redeemAttachmentToken, revokeAttachmentLinks } from '../services/attachmentLinks.js';
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

  // API responses are per-user and authenticated — never cacheable. Without
  // this, a caching layer in front (e.g. a Cloudflare "Cache Everything" rule
  // on a custom domain) can serve a stale /api/me, leaving a signed-out user
  // shown as still signed in, or an old role/team list. `no-store` tells every
  // cache — browser and proxy — not to keep the response at all.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

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
    // Seed/refresh the directory row and sign the cookie with the effective
    // role — an existing directory role wins over the picked one.
    const user = { ...parsed.data, role: ensureTeamMemberOnSignIn(parsed.data) };
    audit(null, 'signed_in', user.email, { provider: 'dev', role: user.role });
    res.setHeader('Set-Cookie', createSessionCookie(user));
    res.json(user);
  });
  router.post('/auth/logout', (req, res) => {
    const user = readSession(req);
    if (user) audit(null, 'signed_out', user.email, {});
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
    // The token is authoritative (it maps to the invoice); the path id is
    // decorative. Redemption is logged with the caller's IP.
    const redeemed = redeemAttachmentToken(
      typeof req.query.t === 'string' ? req.query.t : undefined,
      { ip: req.ip, ua: req.get('user-agent') },
    );
    const row = redeemed ? getInvoiceRow(redeemed.invoiceId) : undefined;
    if (!row || !row.attachment_path) {
      res
        .status(410)
        .type('html')
        .send(
          '<body style="font-family: system-ui, sans-serif; padding: 3rem; color: #1d2721; background: #f7f5f0">' +
            '<h2>This invoice link is invalid, revoked or has expired</h2>' +
            '<p>Ask the AP team to resend it from Finny.</p></body>',
        );
      return;
    }
    const mime = String(row.attachment_mime ?? 'application/octet-stream');
    // Defense-in-depth: never let a served attachment run as active content, and
    // only render the known-safe types inline — anything else downloads.
    const inlineOk = mime === 'application/pdf' || mime.startsWith('image/');
    const filename = String(row.attachment_name ?? 'invoice').replace(/["\r\n]/g, '_');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `${inlineOk ? 'inline' : 'attachment'}; filename="${filename}"`);
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
    const key = anthropicKeyInfo();
    const status: ConnectorStatus = {
      mail_provider: config.mailProvider,
      extraction_provider: extractionProviderActive(),
      extraction_model: getExtractionModel(),
      anthropic_key_set: key.set,
      anthropic_key_source: key.source,
      approvals_provider: config.approvalsProvider,
      alerts_channel: alertsChannelName(),
      alert_webhook_host: webhookInfo().host,
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

  // Revoke every outstanding tokenized attachment link for an invoice (AP
  // Lead) — kills a leaked or forwarded link without rotating the global
  // session secret. Must stay below the requireAuth gate: requireLead reads
  // req.user, which only requireAuth populates.
  router.post('/invoices/:id/revoke-attachment-links', requireLead, (req, res) => {
    const revoked = revokeAttachmentLinks(paramId(req), req.user!.email);
    res.json({ revoked });
  });

  const reviewSchema = z.object({
    action: z.enum(['confirm', 'shadow_log', 'discard']),
    discard_reason: z.string().max(300).optional(),
    fields: z.object({
      vendor_name: z.string().max(200).nullable(),
      invoice_ref: z.string().max(100).nullable(),
      invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
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

  // ── Event-notification subscriptions (self-service, scoped to the caller) ───
  // Any signed-in user manages their own subscriptions to their own Teams chat.
  // The webhook URL is write-only (validated here); GET never returns it. The
  // per-type params semantics are enforced in the notifications service.
  const subscriptionSchema = z.object({
    label: z.string().min(1).max(80),
    event_type: z.enum(['amount_threshold', 'date_threshold', 'supplier_match', 'project_match']),
    params: z.record(z.string(), z.unknown()).default({}),
    active: z.boolean().optional(),
    webhook_url: z.string().max(2000).optional(),
  });
  const subscriptionPatchSchema = subscriptionSchema.partial();
  const onNotificationError = (res: express.Response, err: unknown): void => {
    if (err instanceof NotificationError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    throw err;
  };

  router.get('/subscriptions', (req, res) => {
    res.json(listSubscriptions(req.user!.email));
  });
  router.post('/subscriptions', (req, res) => {
    const parsed = subscriptionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `Invalid subscription: ${parsed.error.issues[0]?.message ?? ''}` });
      return;
    }
    try {
      res.status(201).json(createSubscription(req.user!.email, parsed.data as WebhookSubscriptionInput));
    } catch (err) {
      onNotificationError(res, err);
    }
  });
  router.patch('/subscriptions/:id', (req, res) => {
    const parsed = subscriptionPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `Invalid subscription: ${parsed.error.issues[0]?.message ?? ''}` });
      return;
    }
    try {
      const updated = updateSubscription(req.user!.email, paramId(req), parsed.data as Partial<WebhookSubscriptionInput>);
      updated ? res.json(updated) : res.status(404).json({ error: 'Subscription not found' });
    } catch (err) {
      onNotificationError(res, err);
    }
  });
  router.delete('/subscriptions/:id', (req, res) => {
    const ok = deleteSubscription(req.user!.email, paramId(req));
    ok ? res.json({ ok: true }) : res.status(404).json({ error: 'Subscription not found' });
  });
  router.post('/subscriptions/:id/test', async (req, res) => {
    try {
      const r = await sendSubscriptionTest(req.user!.email, paramId(req));
      res.json({ ok: true, host: r.host });
    } catch (err) {
      if (err instanceof NotificationError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : 'Webhook test failed' });
    }
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
        // Scoped to the entity being checked — its own Sage company can't be
        // expected to contain another entity's projects.
        validation: validateAgainstSage(getSettings(), reference, entity),
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Sage reference pull failed' });
    }
  });

  // Live department list for one entity's Sage company — feeds the Settings
  // department pickers so Dept codes are chosen from Sage, not typed from
  // memory. Read-only against Sage.
  router.get('/sage/departments', requireLead, async (req, res) => {
    const entity = typeof req.query.entity === 'string' && req.query.entity !== '' ? req.query.entity : null;
    const server = resolveSageServer(entity);
    if (!server) {
      res.json({ configured: false, departments: [] });
      return;
    }
    try {
      res.json({ configured: true, entity: server.entity, departments: await fetchDepartments(server) });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Sage department pull failed' });
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
    // Financial data leaving the system — worth a trail entry, like the
    // tokenized attachment views.
    audit(null, 'sage_batch_downloaded', req.user!.email, { batch_id: paramId(req), filename: batch.filename });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${batch.filename}"`);
    res.sendFile(filePath);
  });
  router.post('/exports/:id/mark-imported', (req, res) => {
    const batch = markImported(paramId(req), req.user!.email);
    batch ? res.json(batch) : res.status(404).json({ error: 'Batch not found' });
  });

  // ── Metrics, settings, approvers ──────────────────────────────────────────
  // Volume dashboard: count + value of invoices over a date range
  // (inclusive), dated by invoice date with arrival-date fallback.
  router.get('/metrics/volume', (req, res) => {
    const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    const parsed = z.object({ from: day, to: day }).safeParse({
      from: req.query.from,
      to: req.query.to,
    });
    if (!parsed.success) {
      res.status(400).json({ error: 'from and to are required as yyyy-mm-dd' });
      return;
    }
    const { from, to } = parsed.data;
    const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (!(span >= 0)) {
      res.status(400).json({ error: '"from" must not be after "to"' });
      return;
    }
    if (span > 1100) {
      res.status(400).json({ error: 'Range is limited to three years' });
      return;
    }
    res.json(volumeMetrics(from, to));
  });

  router.get('/metrics/dashboard', (_req, res) => {
    res.json(dashboardMetrics());
  });

  router.get('/settings', (_req, res) => {
    res.json(getSettings());
  });
  router.patch('/settings', requireLead, (req, res) => {
    // Validate the webhook on write so an SSRF/off-tenant URL is rejected at the
    // door (postToTeams also re-checks before every send).
    const webhook = (req.body ?? {}).alert_webhook_url;
    if (typeof webhook === 'string' && webhook.trim() && !isValidWebhookUrl(webhook)) {
      res.status(400).json({
        error: 'The webhook URL must be https on an allowed Microsoft Teams / Power Automate host.',
      });
      return;
    }
    const before = getSettings();
    const updated = updateSettings(req.body ?? {});
    if (before.mode !== updated.mode) {
      audit(null, 'mode_changed', req.user!.email, { from: before.mode, to: updated.mode });
    } else {
      audit(null, 'settings_changed', req.user!.email, { keys: Object.keys(req.body ?? {}) });
    }
    res.json(updated);
  });

  // ── AI extraction: API key + model picker (AP Lead) ───────────────────────
  // The key is write-only — never returned by any GET (see getSettings()).
  const anthropicKeySchema = z.object({ key: z.string().max(400) });
  router.post('/settings/anthropic-key', requireLead, (req, res) => {
    const parsed = anthropicKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'A "key" string is required (send "" to clear it)' });
      return;
    }
    setAnthropicKey(parsed.data.key);
    // Audit the change, never the value.
    audit(null, 'anthropic_key_changed', req.user!.email, { set: parsed.data.key.trim().length > 0 });
    res.json(anthropicKeyInfo());
  });

  // Send a one-off connectivity card to the configured Teams webhook.
  router.post('/settings/webhook-test', requireLead, async (req, res) => {
    try {
      await sendTestAlert();
      audit(null, 'alert_webhook_tested', req.user!.email, {});
      res.json({ ok: true, host: webhookInfo().host });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Webhook test failed' });
    }
  });

  // Ask Anthropic which models this key can use, so the Lead can pick a cheaper
  // one than the default.
  router.get('/models', requireLead, async (_req, res) => {
    if (!anthropicKeyInfo().set) {
      res.status(400).json({ error: 'No Anthropic API key configured — add one first.' });
      return;
    }
    try {
      const { listAvailableModels } = await import('../services/extraction/anthropicExtractor.js');
      res.json(await listAvailableModels());
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Could not fetch models from Anthropic' });
    }
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

  // Whether the approvers sync is backed by a real M365 group (drives the
  // Settings button label / hint).
  router.get('/approvers/directory', (_req, res) => {
    res.json({ provider: approversProvider(), group_configured: approversGroupConfigured() });
  });

  // Pull the approving-managers group from M365 (or the mock list) and
  // reconcile the approver list — see syncApprovers().
  router.post('/approvers/sync', requireLead, async (req, res) => {
    try {
      const result = await syncApprovers();
      audit(null, 'approvers_synced', req.user!.email, { provider: result.provider, ...result.summary });
      res.json(result);
    } catch (err) {
      const message =
        err instanceof GraphAuthError
          ? `Microsoft 365 rejected the request — check the group id and that the app has GroupMember.Read.All: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Approvers sync failed';
      res.status(502).json({ error: message });
    }
  });

  // ── Team & privileges ─────────────────────────────────────────────────────
  // The directory of who can sign in and at what level, seeded from the M365
  // group the SSO is scoped to. Visible to all; only the AP Lead can change it.
  router.get('/team', (req, res) => {
    res.json(listTeam(req.user!.email));
  });

  // Pull the group from Microsoft 365 (or the mock list) and reconcile roles.
  router.post('/team/sync', requireLead, async (req, res) => {
    try {
      const directory = await syncGroup(req.user!.email);
      audit(null, 'team_synced', req.user!.email, {
        provider: directory.provider,
        members: directory.members.length,
      });
      res.json(directory);
    } catch (err) {
      if (err instanceof TeamError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      const message =
        err instanceof GraphAuthError
          ? `Microsoft 365 rejected the request — check the group id and that the app has GroupMember.Read.All: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Team sync failed';
      res.status(502).json({ error: message });
    }
  });

  const teamRoleSchema = z.object({
    email: z.string().email(),
    role: z.enum(['processor', 'lead']),
  });
  router.patch('/team', requireLead, (req, res) => {
    const parsed = teamRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'email and role (processor|lead) are required' });
      return;
    }
    try {
      const member = setMemberRole(parsed.data.email, parsed.data.role, req.user!.email);
      audit(null, 'team_role_changed', req.user!.email, { email: member.email, role: member.role });
      res.json(member);
    } catch (err) {
      if (err instanceof TeamError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // ── Audit log (AP Lead) ───────────────────────────────────────────────────
  // The full user-action trail for compliance review. Events are append-only
  // at the database level (schema triggers) and retained indefinitely.
  const auditQuerySchema = z.object({
    actor: z.string().max(320).optional(),
    type: z.string().max(100).optional(),
    entity: z.string().max(200).optional(),
    invoice_id: z.string().max(60).optional(),
    q: z.string().max(200).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    before: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  });

  router.get('/audit', requireLead, (req, res) => {
    const parsed = auditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid audit query' });
      return;
    }
    const { before, limit, ...filters } = parsed.data;
    res.json(listAuditLog(filters, { before, limit }));
  });

  router.get('/audit/filters', requireLead, (_req, res) => {
    res.json(auditFilterOptions());
  });

  router.get('/audit/export.csv', requireLead, (req, res) => {
    const parsed = auditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid audit query' });
      return;
    }
    const { before: _before, limit: _limit, ...filters } = parsed.data;
    const { csv, rows, truncated } = auditLogCsv(filters);
    // Handing the trail to someone is itself a compliance-relevant action.
    audit(null, 'audit_exported', req.user!.email, { rows, truncated, filters });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="finny-audit-${nowIso().slice(0, 10)}.csv"`);
    res.send(csv);
  });

  // ── Simulators (mock providers only) ──────────────────────────────────────
  router.post('/simulate/invoice', async (req, res) => {
    if (!config.simulatorEnabled) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (config.mailProvider !== 'mock') {
      res.status(400).json({ error: 'Simulator is only available with MAIL_PROVIDER=mock' });
      return;
    }
    const scenario = z
      .enum(['normal', 'missing_po', 'no_ref', 'image', 'corrupt', 'statement', 'payment_recommendation'])
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
    if (!config.simulatorEnabled) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
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
    // Attribute the decision to whoever actually triggered it, not the routed
    // approver — a simulated decision must never masquerade as the real manager.
    const ok = recordApprovalDecision(
      approval.id,
      decision,
      `${req.user!.name} (simulated)`,
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
