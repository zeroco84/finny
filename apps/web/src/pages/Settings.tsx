import { useEffect, useState } from 'react';
import type { ConnectorStatus, Settings } from '@finny/shared';
import { api } from '../api';
import { dateTime } from '../format';
import { useMeta } from '../meta';
import { Banner } from '../components/ui';

export default function SettingsPage() {
  const { user, settings, approvers, refreshMeta, refreshOverview } = useMeta();
  const isLead = user.role === 'lead';
  const [draft, setDraft] = useState<Settings>(settings);
  const [recipients, setRecipients] = useState(settings.alert_recipients.join(', '));
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newApprover, setNewApprover] = useState({ name: '', email: '' });

  useEffect(() => {
    void api.status().then(setStatus);
  }, []);

  async function save(patch: Partial<Settings>, message = 'Saved.') {
    setError(null);
    try {
      await api.updateSettings(patch);
      await refreshMeta();
      await refreshOverview();
      setNotice(message);
      setTimeout(() => setNotice(null), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  async function toggleMode() {
    const next = settings.mode === 'shadow' ? 'live' : 'shadow';
    const warning =
      next === 'live'
        ? 'Go LIVE? Confirm & Send will start generating Sage batches and Teams approval requests. Check the Dashboard accuracy report first.'
        : 'Return to SHADOW mode? Reviewers log comparisons only; nothing is sent to Sage or Teams.';
    if (!window.confirm(warning)) return;
    await save({ mode: next }, next === 'live' ? 'Finny is LIVE.' : 'Back in shadow mode.');
  }

  const dis = !isLead;

  return (
    <div className="page">
      <div className="page-head"><h1>Settings</h1></div>
      {!isLead && <Banner kind="info">You are signed in as an AP Processor — settings are read-only. Ask the AP Lead to change them.</Banner>}
      {notice && <Banner kind="success">{notice}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}

      <div className="card">
        <h2>Mode</h2>
        <div className="mode-card">
          <div>
            <p>
              Finny is in <strong className={settings.mode === 'live' ? 'live-word' : 'shadow-word'}>{settings.mode.toUpperCase()}</strong> mode.
            </p>
            <p className="muted small">
              Shadow: the AI proposes and learns while the team keeps today's process; the Dashboard builds the
              accuracy report. Live: "Confirm &amp; Send" writes the Sage export pool and creates Teams approvals.
              The spec gates go-live on 85%+ shadow accuracy, not a calendar date.
            </p>
          </div>
          {isLead && (
            <button className={`btn ${settings.mode === 'shadow' ? 'btn-primary' : 'btn-danger-ghost'}`} onClick={() => void toggleMode()}>
              {settings.mode === 'shadow' ? 'Switch to LIVE' : 'Back to shadow'}
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Review thresholds &amp; alerts</h2>
        <div className="field-grid">
          <label className="field">
            <span className="field-label">Field confidence threshold (%)</span>
            <input type="number" min={0} max={100} disabled={dis}
              value={Math.round(draft.confidence_threshold * 100)}
              onChange={(e) => setDraft({ ...draft, confidence_threshold: Number(e.target.value) / 100 })} />
            <span className="muted small">Below this a field shows amber and counts towards the SLA alert.</span>
          </label>
          <label className="field">
            <span className="field-label">Review SLA (hours)</span>
            <input type="number" min={1} disabled={dis} value={draft.review_sla_hours}
              onChange={(e) => setDraft({ ...draft, review_sla_hours: Number(e.target.value) })} />
            <span className="muted small">Low-confidence invoice untouched this long → alert email.</span>
          </label>
          <label className="field field-wide">
            <span className="field-label">Alert recipients (comma separated)</span>
            <input disabled={dis} value={recipients} onChange={(e) => setRecipients(e.target.value)} />
          </label>
          <div className="field">
            <span className="field-label">Rule changes go live…</span>
            {(['category', 'approver'] as const).map((kind) => (
              <label key={kind} className="radio-row">
                {kind === 'category' ? 'Category rules' : 'Approver rules'}:
                <select disabled={dis} value={draft.rule_apply[kind]}
                  onChange={(e) => setDraft({
                    ...draft,
                    rule_apply: { ...draft.rule_apply, [kind]: e.target.value as 'auto' | 'review' },
                  })}>
                  <option value="auto">immediately (auto-apply)</option>
                  <option value="review">after AP Lead approval</option>
                </select>
              </label>
            ))}
          </div>
        </div>
        {isLead && (
          <button className="btn btn-primary" onClick={() => void save({
            confidence_threshold: draft.confidence_threshold,
            review_sla_hours: draft.review_sla_hours,
            rule_apply: draft.rule_apply,
            alert_recipients: recipients.split(',').map((s) => s.trim()).filter(Boolean),
          })}>
            Save
          </button>
        )}
      </div>

      <div className="card">
        <h2>Categories → Sage nominal codes</h2>
        <table className="table table-compact">
          <thead><tr><th>Category</th><th>Nominal code</th><th /></tr></thead>
          <tbody>
            {draft.categories.map((c, i) => (
              <tr key={i}>
                <td><input disabled={dis} value={c.name} onChange={(e) => {
                  const categories = [...draft.categories];
                  categories[i] = { ...c, name: e.target.value };
                  setDraft({ ...draft, categories });
                }} /></td>
                <td><input disabled={dis} value={c.nominal_code} onChange={(e) => {
                  const categories = [...draft.categories];
                  categories[i] = { ...c, nominal_code: e.target.value };
                  setDraft({ ...draft, categories });
                }} /></td>
                <td>{isLead && (
                  <button className="btn btn-small btn-danger-ghost"
                    onClick={() => setDraft({ ...draft, categories: draft.categories.filter((_, j) => j !== i) })}>
                    Remove
                  </button>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {isLead && (
          <div className="row-actions">
            <button className="btn btn-small"
              onClick={() => setDraft({ ...draft, categories: [...draft.categories, { name: '', nominal_code: '' }] })}>
              Add category
            </button>
            <button className="btn btn-small btn-primary"
              onClick={() => void save({ categories: draft.categories.filter((c) => c.name && c.nominal_code) })}>
              Save categories
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Legal entities &amp; projects</h2>
        <p className="muted small">
          Entities are the companies invoices can be addressed to — each maps to its own Sage
          company dataset, and exports batch per entity. Projects land in Sage's Project Refn.
        </p>
        <div className="dash-grid">
          <div>
            <table className="table table-compact">
              <thead><tr><th>Entity</th><th /></tr></thead>
              <tbody>
                {draft.entities.map((ent, i) => (
                  <tr key={i}>
                    <td><input disabled={dis} value={ent} onChange={(e) => {
                      const entities = [...draft.entities];
                      entities[i] = e.target.value;
                      setDraft({ ...draft, entities });
                    }} /></td>
                    <td>{isLead && (
                      <button className="btn btn-small btn-danger-ghost"
                        onClick={() => setDraft({ ...draft, entities: draft.entities.filter((_, j) => j !== i) })}>
                        Remove
                      </button>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {isLead && (
              <button className="btn btn-small"
                onClick={() => setDraft({ ...draft, entities: [...draft.entities, ''] })}>
                Add entity
              </button>
            )}
          </div>
          <div>
            <table className="table table-compact">
              <thead><tr><th>Project</th><th>Code</th><th title="Sage department number for this site">Dept</th><th /></tr></thead>
              <tbody>
                {draft.projects.map((p, i) => (
                  <tr key={i}>
                    <td><input disabled={dis} value={p.name} onChange={(e) => {
                      const projects = [...draft.projects];
                      projects[i] = { ...p, name: e.target.value };
                      setDraft({ ...draft, projects });
                    }} /></td>
                    <td><input disabled={dis} value={p.code} onChange={(e) => {
                      const projects = [...draft.projects];
                      projects[i] = { ...p, code: e.target.value.toUpperCase() };
                      setDraft({ ...draft, projects });
                    }} /></td>
                    <td><input disabled={dis} value={p.dept ?? ''} onChange={(e) => {
                      const projects = [...draft.projects];
                      projects[i] = { ...p, dept: e.target.value };
                      setDraft({ ...draft, projects });
                    }} /></td>
                    <td>{isLead && (
                      <button className="btn btn-small btn-danger-ghost"
                        onClick={() => setDraft({ ...draft, projects: draft.projects.filter((_, j) => j !== i) })}>
                        Remove
                      </button>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {isLead && (
              <button className="btn btn-small"
                onClick={() => setDraft({ ...draft, projects: [...draft.projects, { name: '', code: '', dept: '' }] })}>
                Add project
              </button>
            )}
          </div>
        </div>
        {isLead && (
          <button className="btn btn-primary" style={{ marginTop: 10 }} onClick={() => void save({
            entities: draft.entities.map((e) => e.trim()).filter(Boolean),
            projects: draft.projects.filter((p) => p.name && p.code),
          })}>
            Save entities &amp; projects
          </button>
        )}
      </div>

      <div className="card">
        <h2>VAT rates → Sage tax codes</h2>
        <div className="taxcode-row">
          {Object.entries(draft.tax_codes).map(([rate, code]) => (
            <label key={rate} className="field field-tight">
              <span className="field-label">{rate}%</span>
              <input disabled={dis} value={code} onChange={(e) =>
                setDraft({ ...draft, tax_codes: { ...draft.tax_codes, [rate]: e.target.value } })} />
            </label>
          ))}
          <label className="field field-tight">
            <span className="field-label">Default</span>
            <input disabled={dis} value={draft.default_tax_code}
              onChange={(e) => setDraft({ ...draft, default_tax_code: e.target.value })} />
          </label>
          <label className="field field-tight">
            <span className="field-label" title="Dept used when an invoice has no project">Fallback dept</span>
            <input disabled={dis} value={draft.sage_department}
              onChange={(e) => setDraft({ ...draft, sage_department: e.target.value })} />
          </label>
          <label className="field field-tight">
            <span className="field-label" title='Next sequential posting reference (the "Inv27xxx" Ref column)'>Next Ref №</span>
            <input type="number" disabled={dis} value={draft.next_posting_ref}
              onChange={(e) => setDraft({ ...draft, next_posting_ref: Number(e.target.value) })} />
          </label>
        </div>
        <p className="muted small">
          Match these to the live Sage 50 configuration before the first real import. The Ref number
          advances automatically each export (refs land in the CSV and on each invoice).
        </p>
        {isLead && (
          <button className="btn btn-small btn-primary" onClick={() => void save({
            tax_codes: draft.tax_codes,
            default_tax_code: draft.default_tax_code,
            sage_department: draft.sage_department,
            next_posting_ref: draft.next_posting_ref,
          })}>
            Save Sage mapping
          </button>
        )}
      </div>

      <div className="card">
        <h2>Approving managers</h2>
        <table className="table table-compact">
          <thead><tr><th>Name</th><th>Email</th><th>Status</th><th /></tr></thead>
          <tbody>
            {approvers.map((a) => (
              <tr key={a.id} className={a.active ? '' : 'muted'}>
                <td>{a.name}</td>
                <td>{a.email}</td>
                <td>{a.active ? 'active' : 'inactive'}</td>
                <td>{isLead && (
                  <button className="btn btn-small" onClick={() =>
                    void api.updateApprover(a.id, { active: !a.active }).then(refreshMeta)}>
                    {a.active ? 'Deactivate' : 'Reactivate'}
                  </button>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {isLead && (
          <div className="row-actions">
            <input placeholder="Name" value={newApprover.name}
              onChange={(e) => setNewApprover({ ...newApprover, name: e.target.value })} />
            <input placeholder="email@company.com" value={newApprover.email}
              onChange={(e) => setNewApprover({ ...newApprover, email: e.target.value })} />
            <button className="btn btn-small btn-primary" disabled={!newApprover.name || !newApprover.email}
              onClick={() => void api.addApprover(newApprover).then(() => {
                setNewApprover({ name: '', email: '' });
                return refreshMeta();
              })}>
              Add
            </button>
          </div>
        )}
      </div>

      {status && (
        <div className="card">
          <h2>Connectors</h2>
          <table className="table table-compact">
            <tbody>
              <tr>
                <td>Mailbox ingestion</td>
                <td><code>{status.mail_provider}</code></td>
                <td className="muted">
                  {status.mail_last_error
                    ? <span className="form-error">error: {status.mail_last_error}</span>
                    : status.mail_last_poll ? `last poll ${dateTime(status.mail_last_poll)}` : 'not polled yet'}
                </td>
              </tr>
              <tr><td>Extraction</td><td><code>{status.extraction_provider}</code></td>
                <td className="muted">{status.extraction_provider === 'mock' ? 'offline text parser — set ANTHROPIC_API_KEY for Claude extraction' : 'Claude document extraction'}</td></tr>
              <tr>
                <td>Teams Approvals</td>
                <td><code>{status.approvals_provider}</code></td>
                <td className="muted">{status.approvals_provider === 'mock' ? 'simulator panel on the invoice page' : status.approvals_last_error ?? (status.approvals_last_poll ? `last poll ${dateTime(status.approvals_last_poll)}` : '')}</td>
              </tr>
              <tr>
                <td>Sage output</td>
                <td><code>{status.sage_provider}</code></td>
                <td className="muted">
                  {status.sage_provider === 'hyperaccounts'
                    ? `one-touch posting via HyperAccounts — servers: ${status.sage_entities.map((e) => (e === '*' ? 'default (all entities)' : e)).join(', ') || 'NONE CONFIGURED'}`
                    : 'CSV batch files imported by hand — set SAGE_PROVIDER=hyperaccounts for one-touch posting'}
                </td>
              </tr>
              <tr><td>Alert email</td><td><code>{status.email_provider}</code></td>
                <td className="muted">{status.email_provider === 'log' ? 'SMTP not configured — alerts stored & shown in the UI' : 'sending via SMTP'}</td></tr>
              <tr><td>Sign-in</td><td><code>{status.auth_provider}</code></td>
                <td className="muted">{status.auth_provider === 'dev' ? 'dev sign-in — Entra ID SSO seam documented in the README' : ''}</td></tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
