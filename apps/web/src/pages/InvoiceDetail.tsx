import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { InvoiceDetail, ReviewSubmission } from '@finny/shared';
import { api } from '../api';
import { centsToInput, dateTime, euros, inputToCents, shortDate } from '../format';
import { useMeta } from '../meta';
import { Banner, ConfidenceBadge, StatusChip } from '../components/ui';

interface FormState {
  vendor_name: string;
  invoice_ref: string;
  invoice_date: string;
  net: string;
  vat: string;
  gross: string;
  vat_rate: string;
  vat_number: string;
  po_number: string;
  supplier_account_ref: string;
  category: string;
  approver_id: string;
  entity: string;
  project_code: string;
}

function fromDetail(d: InvoiceDetail): FormState {
  return {
    vendor_name: d.vendor_name ?? '',
    invoice_ref: d.invoice_ref ?? '',
    invoice_date: d.invoice_date ?? '',
    net: centsToInput(d.net_cents),
    vat: centsToInput(d.vat_cents),
    gross: centsToInput(d.gross_cents),
    vat_rate: d.vat_rate === null ? '' : String(d.vat_rate),
    vat_number: d.vat_number ?? '',
    po_number: d.po_number ?? '',
    supplier_account_ref: d.supplier_account_ref ?? '',
    category: d.category ?? d.proposed_category ?? '',
    approver_id: d.approver_id ?? d.proposed_approver_id ?? '',
    entity: d.entity ?? '',
    project_code: d.project_code ?? '',
  };
}

const AUDIT_LABELS: Record<string, string> = {
  received: 'Received',
  extraction_started: 'Extraction started',
  extraction_completed: 'Extracted',
  extraction_failed: 'Extraction failed',
  extraction_retry_requested: 'Extraction retry requested',
  duplicate_flagged: 'Flagged as possible duplicate',
  fields_corrected: 'Fields corrected',
  shadow_logged: 'Shadow review logged',
  confirmed: 'Confirmed',
  discarded: 'Discarded',
  rule_proposed: 'Routing rule proposed',
  rule_proposal_updated: 'Routing rule proposal updated',
  rule_auto_applied: 'Routing rule auto-applied',
  rule_approved: 'Routing rule approved',
  rule_rejected: 'Routing rule rejected',
  approval_created: 'Sent for approval',
  approval_failed: 'Approval creation failed',
  approval_approved: 'Approved',
  approval_rejected: 'Rejected',
  sent_to_sage_batch: 'Added to Sage batch',
  sage_batch_imported: 'Sage batch marked imported',
  alert_raised: 'Alert raised',
  alert_acknowledged: 'Alert acknowledged',
  alert_resolved: 'Alert resolved',
};

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { settings, approvers, approverName, user, overview, refreshOverview } = useMeta();
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const d = await api.invoice(id);
    setDetail(d);
    setForm((prev) => (prev === null ? fromDetail(d) : prev));
  }, [id]);

  useEffect(() => {
    setDetail(null);
    setForm(null);
    void load().catch((e: Error) => setError(e.message));
  }, [load]);

  // Keep polling while the pipeline is still working on it.
  useEffect(() => {
    if (!detail || (detail.status !== 'received' && detail.status !== 'extracting')) return;
    const t = setInterval(() => {
      setForm(null);
      void load();
    }, 2000);
    return () => clearInterval(t);
  }, [detail, load]);

  const editable = detail?.status === 'needs_review' || detail?.status === 'extraction_failed';
  const snapshot = detail?.extraction_snapshot ?? null;

  // The billed-to entity's own projects, plus any not yet assigned to one —
  // a Sage project ref lives in exactly one entity's dataset, so the picker
  // only offers projects the confirm will accept. No entity chosen = show all.
  const entityProjects = settings.projects.filter(
    (p) => !p.entity || !form?.entity || p.entity === form.entity,
  );

  const submission = useMemo((): ReviewSubmission['fields'] | null => {
    if (!form) return null;
    return {
      vendor_name: form.vendor_name.trim() || null,
      invoice_ref: form.invoice_ref.trim() || null,
      invoice_date: /^\d{4}-\d{2}-\d{2}$/.test(form.invoice_date) ? form.invoice_date : null,
      net_cents: inputToCents(form.net),
      vat_cents: inputToCents(form.vat),
      gross_cents: inputToCents(form.gross),
      vat_rate: form.vat_rate.trim() === '' ? null : Number(form.vat_rate),
      vat_number: form.vat_number.trim() || null,
      po_number: form.po_number.trim() || null,
      supplier_account_ref: form.supplier_account_ref.trim() || null,
    };
  }, [form]);

  async function act(action: ReviewSubmission['action'], discardReason?: string) {
    if (!id || !form || !submission) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.review(id, {
        action,
        discard_reason: discardReason,
        fields: submission,
        category: form.category || null,
        approver_id: form.approver_id || null,
        entity: form.entity || null,
        project_code: form.project_code || null,
      });
      setDetail(updated);
      setForm(fromDetail(updated));
      await refreshOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  async function simulateDecision(decision: 'approved' | 'rejected') {
    if (!id) return;
    setBusy(true);
    try {
      const note = decision === 'rejected' ? window.prompt('Rejection note (optional)') ?? undefined : undefined;
      const updated = await api.simulateApproval(id, decision, note);
      setDetail(updated);
      await refreshOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Simulation failed');
    } finally {
      setBusy(false);
    }
  }

  if (error && !detail) return <div className="page"><Banner kind="error">{error}</Banner></div>;
  if (!detail || !form) return <div className="page-loading">Loading invoice…</div>;

  const field = (
    label: string,
    key: keyof FormState,
    confKey: string | null,
    opts: { placeholder?: string; aiValue?: string | null } = {},
  ) => {
    const conf = confKey ? detail.field_confidence[confKey as keyof typeof detail.field_confidence] : undefined;
    const aiValue = opts.aiValue;
    const edited = aiValue !== undefined && aiValue !== null && aiValue !== form[key] && form[key] !== '';
    return (
      <label className="field">
        <span className="field-label">
          {label}
          {confKey && editable && <ConfidenceBadge value={conf ?? 0} threshold={settings.confidence_threshold} />}
        </span>
        <input
          value={form[key]}
          disabled={!editable}
          placeholder={opts.placeholder}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        />
        {edited && <span className="ai-ghost">AI read: {aiValue}</span>}
      </label>
    );
  };

  const isImage = detail.attachment_mime?.startsWith('image/');
  const pendingApproval = detail.approval?.status === 'pending';
  const failedApproval = detail.status === 'confirmed' && detail.approval?.status === 'failed';

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <Link to="/queue" className="crumb">← Queue</Link>
          <h1>
            {detail.vendor_name ?? 'Unknown vendor'}{' '}
            <span className="muted">{detail.invoice_ref ?? ''}</span>
          </h1>
          <p className="muted">
            {detail.email_from ? `From ${detail.email_from} · ` : ''}
            received {shortDate(detail.received_at)} · {detail.attachment_name} ·{' '}
            <StatusChip status={detail.status} shadow={detail.shadow} />
          </p>
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {detail.extraction_error && (
        <Banner kind="error">
          Extraction failed: {detail.extraction_error}
          {detail.status === 'extraction_failed' && (
            <>
              {' — '}enter the fields manually below, or{' '}
              <button
                className="btn btn-small"
                disabled={busy}
                onClick={() => void api.retryExtraction(detail.id).then(() => { setForm(null); void load(); })}
              >
                Retry extraction
              </button>
            </>
          )}
        </Banner>
      )}
      {detail.status === 'discarded' ? (
        <Banner kind="info">
          {detail.discarded_reason?.startsWith('Auto-filed') ? (
            <>Finny filed this automatically as a supplier <strong>{detail.doc_type}</strong> — it never
            entered the review queue and nothing was sent anywhere.</>
          ) : (
            <>Discarded{detail.discarded_reason ? <>: {detail.discarded_reason}</> : ''}.</>
          )}{' '}
          <button className="btn btn-small" disabled={busy}
            onClick={() => void api.reopenInvoice(detail.id).then((d) => { setDetail(d); setForm(null); void load(); })}>
            Reopen for review
          </button>
        </Banner>
      ) : detail.doc_type === 'payment_recommendation' ? (
        <Banner kind="info">
          This is an internal <strong>payment recommendation</strong> (cost estimating → AP), not a supplier
          invoice. Process it like an invoice — the recommended amount is the payable amount, and VAT is
          normally accounted for by the principal contractor (reverse charge).
        </Banner>
      ) : detail.doc_type && detail.doc_type !== 'invoice' ? (
        <Banner kind="warn">
          The AI classified this document as a <strong>{detail.doc_type}</strong>, not an invoice. If that is
          right, discard it below.
        </Banner>
      ) : null}
      {detail.duplicate_summary && (
        <Banner kind="warn">
          Possible duplicate: same vendor and reference as{' '}
          <Link to={`/invoices/${detail.duplicate_summary.id}`}>
            an invoice received {shortDate(detail.duplicate_summary.received_at)}
          </Link>{' '}
          ({detail.duplicate_summary.status.replace('_', ' ')}). Check before sending.
        </Banner>
      )}
      {failedApproval && (
        <Banner kind="error">
          The Teams approval could not be created ({detail.approval?.error ?? 'unknown error'}).{' '}
          <button className="btn btn-small" disabled={busy}
            onClick={() => void api.retryApproval(detail.id).then((d) => { setDetail(d); })}>
            Retry approval
          </button>
        </Banner>
      )}

      <div className="detail-grid">
        <section className="attachment-pane">
          {isImage ? (
            <img src={`/api/invoices/${detail.id}/attachment`} alt="Invoice attachment" />
          ) : (
            <iframe title="Invoice attachment" src={`/api/invoices/${detail.id}/attachment`} />
          )}
        </section>

        <section className="review-pane">
          <div className="card">
            <h2>Extracted fields</h2>
            <div className="field-grid">
              {field('Vendor', 'vendor_name', 'vendor_name', { aiValue: snapshot?.vendor_name })}
              {field('Invoice ref', 'invoice_ref', 'invoice_ref', { aiValue: snapshot?.invoice_ref })}
              {field('Invoice date', 'invoice_date', 'invoice_date', {
                placeholder: 'yyyy-mm-dd',
                aiValue: snapshot?.invoice_date,
              })}
              {field('Net €', 'net', 'net', { aiValue: snapshot ? centsToInput(snapshot.net_cents) || null : null })}
              {field('VAT €', 'vat', 'vat', { aiValue: snapshot ? centsToInput(snapshot.vat_cents) || null : null })}
              {field('Gross €', 'gross', 'gross', { aiValue: snapshot ? centsToInput(snapshot.gross_cents) || null : null })}
              {field('VAT rate %', 'vat_rate', 'vat_rate', { aiValue: snapshot?.vat_rate === null || snapshot === null ? null : String(snapshot.vat_rate) })}
              {field('VAT number', 'vat_number', 'vat_number', { aiValue: snapshot?.vat_number })}
              {field('PO number', 'po_number', 'po_number', { aiValue: snapshot?.po_number })}
              {field('Sage supplier A/C', 'supplier_account_ref', null, { placeholder: 'e.g. HEGARTY1' })}
              <label className="field">
                <span className="field-label">
                  Billed to (entity)
                  {editable && (
                    <ConfidenceBadge value={detail.field_confidence.entity ?? 0} threshold={settings.confidence_threshold} />
                  )}
                </span>
                <select
                  value={form.entity}
                  disabled={!editable}
                  onChange={(e) => setForm({ ...form, entity: e.target.value })}
                >
                  <option value="">— choose —</option>
                  {settings.entities.map((ent) => (
                    <option key={ent} value={ent}>{ent}</option>
                  ))}
                </select>
                {snapshot?.entity && snapshot.entity !== form.entity && form.entity !== '' && (
                  <span className="ai-ghost">AI read: {snapshot.entity}</span>
                )}
              </label>
            </div>
            {detail.line_items.length > 0 && (
              <details className="line-items">
                <summary>{detail.line_items.length} line item{detail.line_items.length > 1 ? 's' : ''} read</summary>
                <table className="table">
                  <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Total</th></tr></thead>
                  <tbody>
                    {detail.line_items.map((li, i) => (
                      <tr key={i}>
                        <td>{li.description}</td>
                        <td className="num">{li.quantity ?? '—'}</td>
                        <td className="num">{euros(li.unit_cents)}</td>
                        <td className="num">{euros(li.total_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
          </div>

          <div className="card">
            <h2>Routing</h2>
            {detail.routing_rationale && <p className="rationale">{detail.routing_rationale}</p>}
            <div className="field-grid">
              <label className="field">
                <span className="field-label">Expense category</span>
                <select
                  value={form.category}
                  disabled={!editable}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                >
                  <option value="">— choose —</option>
                  {/* Keep the stored value selectable even if the coding list
                      has since been re-pulled from Sage under different names. */}
                  {form.category && !settings.categories.some((c) => c.name === form.category) && (
                    <option value={form.category}>{form.category} (no longer in the list)</option>
                  )}
                  {settings.categories.map((c) => (
                    <option key={c.name} value={c.name}>{c.name}</option>
                  ))}
                </select>
                {snapshot?.category && snapshot.category !== form.category && form.category !== '' && (
                  <span className="ai-ghost">AI proposed: {snapshot.category}</span>
                )}
              </label>
              <label className="field">
                <span className="field-label">Approving manager</span>
                <select
                  value={form.approver_id}
                  disabled={!editable}
                  onChange={(e) => setForm({ ...form, approver_id: e.target.value })}
                >
                  <option value="">— choose —</option>
                  {approvers.filter((a) => a.active).map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                {snapshot?.approver_id && snapshot.approver_id !== form.approver_id && form.approver_id !== '' && (
                  <span className="ai-ghost">AI proposed: {approverName(snapshot.approver_id)}</span>
                )}
              </label>
              <label className="field">
                <span className="field-label">
                  Project
                  {editable && (
                    <ConfidenceBadge value={detail.field_confidence.project ?? 0} threshold={settings.confidence_threshold} />
                  )}
                </span>
                <select
                  value={form.project_code}
                  disabled={!editable}
                  onChange={(e) => setForm({ ...form, project_code: e.target.value })}
                >
                  <option value="">— none —</option>
                  {/* Only the billed-to entity's projects (plus any not yet
                      assigned to an entity) — a project posts to exactly one
                      entity's books. Keep the stored value selectable so a
                      cross-entity leftover is visible rather than vanishing. */}
                  {form.project_code && !entityProjects.some((p) => p.code === form.project_code) && (
                    <option value={form.project_code}>
                      {(() => {
                        const stored = settings.projects.find((p) => p.code === form.project_code);
                        return stored
                          ? `${stored.name} (${stored.code}) — ${stored.entity}'s project`
                          : `${form.project_code} (no longer in the list)`;
                      })()}
                    </option>
                  )}
                  {entityProjects.map((p) => (
                    <option key={p.code} value={p.code}>{p.name} ({p.code})</option>
                  ))}
                </select>
                {snapshot?.project_code && snapshot.project_code !== form.project_code && form.project_code !== '' && (
                  <span className="ai-ghost">AI read: {snapshot.project_code}</span>
                )}
                {!snapshot?.project_code && form.project_code === '' && editable && (
                  <span className="muted small">No project referenced on the document — assign one if it belongs to a job.</span>
                )}
              </label>
            </div>
            <p className="muted small">
              Correcting the category or approver teaches Finny a rule for this vendor
              {settings.rule_apply.approver === 'review' ? ' (approver changes need AP Lead sign-off in Rules)' : ''}.
            </p>
          </div>

          {editable && (
            <div className="card actions-card">
              {settings.mode === 'shadow' ? (
                <>
                  <button className="btn btn-primary" disabled={busy} onClick={() => void act('shadow_log')}>
                    Log &amp; complete (shadow)
                  </button>
                  <p className="muted small">
                    Shadow mode: your entries are compared against the AI's proposal for the accuracy report.
                    Nothing is sent to Sage or Teams.
                  </p>
                </>
              ) : (
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => {
                    if (detail.duplicate_summary && !window.confirm('This looks like a duplicate. Send anyway?')) return;
                    void act('confirm');
                  }}
                >
                  Confirm &amp; Send → Sage export + Teams approval
                </button>
              )}
              <button
                className="btn btn-danger-ghost"
                disabled={busy}
                onClick={() => {
                  const reason = window.prompt('Why discard? (e.g. statement, spam, duplicate)');
                  if (reason !== null) void act('discard', reason || 'not an invoice');
                }}
              >
                Discard
              </button>
            </div>
          )}

          {pendingApproval && (
            <div className="card">
              <h2>Approval</h2>
              <p>
                Waiting on <strong>{approverName(detail.approval!.approver_id)}</strong> in Teams Approvals since{' '}
                {dateTime(detail.approval!.created_at)}.
              </p>
              {overview?.approvals_simulator_enabled && (
                <div className="sim-panel">
                  <p className="muted small">Approvals simulator (mock provider) — act as the manager:</p>
                  <button className="btn btn-small" disabled={busy} onClick={() => void simulateDecision('approved')}>
                    ✓ Approve
                  </button>{' '}
                  <button className="btn btn-small btn-danger-ghost" disabled={busy} onClick={() => void simulateDecision('rejected')}>
                    ✕ Reject
                  </button>
                </div>
              )}
            </div>
          )}
          {detail.approval && detail.approval.status !== 'pending' && detail.approval.status !== 'failed' && (
            <div className="card">
              <h2>Approval</h2>
              <p>
                <strong>{detail.approval.status === 'approved' ? 'Approved' : 'Rejected'}</strong> by{' '}
                {detail.approval.decided_by_name} at {dateTime(detail.approval.decided_at)}
                {detail.approval.decision_note ? ` — “${detail.approval.decision_note}”` : ''}
              </p>
            </div>
          )}

          <div className="card">
            <h2>History</h2>
            <ul className="timeline">
              {detail.audit.map((ev) => (
                <li key={ev.id}>
                  <span className="timeline-time">{dateTime(ev.created_at)}</span>
                  <span className="timeline-body">
                    <strong>{AUDIT_LABELS[ev.type] ?? ev.type}</strong>
                    {ev.actor !== 'system' ? ` · ${ev.actor}` : ''}
                    {ev.type === 'fields_corrected' && ev.detail.corrections !== undefined
                      ? ` (${String(ev.detail.corrections)} field${Number(ev.detail.corrections) > 1 ? 's' : ''})`
                      : ''}
                    {ev.type === 'sent_to_sage_batch' && ev.detail.filename ? ` — ${String(ev.detail.filename)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
            {detail.corrections.length > 0 && (
              <details>
                <summary>{detail.corrections.length} correction{detail.corrections.length > 1 ? 's' : ''} captured</summary>
                <table className="table">
                  <thead><tr><th>Field</th><th>AI value</th><th>Corrected to</th><th>By</th></tr></thead>
                  <tbody>
                    {detail.corrections.map((c) => (
                      <tr key={c.id}>
                        <td>{c.field}</td>
                        <td className="muted">{c.field === 'approver' ? approverName(c.old_value) : c.old_value ?? '—'}</td>
                        <td>{c.field === 'approver' ? approverName(c.new_value) : c.new_value ?? '—'}</td>
                        <td>{c.corrected_by}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
          </div>

          {user.role === 'lead' && detail.sage_batch_id && (
            <p className="muted small">In Sage batch {detail.sage_batch_id.slice(0, 8)} — see the Sage page.</p>
          )}
          <p className="muted small">
            <button className="btn btn-ghost btn-small" onClick={() => navigate(-1)}>Back</button>
          </p>
        </section>
      </div>
    </div>
  );
}
