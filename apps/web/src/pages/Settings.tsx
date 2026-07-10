import { useEffect, useState } from 'react';
import type { ApproverDirectory, ConnectorStatus, Settings, TeamDirectory, TeamRole } from '@finny/shared';
import { api, type SageReferenceCheck } from '../api';
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
  const [refEntity, setRefEntity] = useState('');
  const [refCheck, setRefCheck] = useState<SageReferenceCheck | null>(null);
  const [refBusy, setRefBusy] = useState(false);
  const [nominalSummary, setNominalSummary] = useState<{ entity: string; count: number; pulled_at: string }[]>([]);
  const [pullEntity, setPullEntity] = useState(settings.entities[0] ?? '');
  const [pullBusy, setPullBusy] = useState(false);
  const [team, setTeam] = useState<TeamDirectory | null>(null);
  const [teamBusy, setTeamBusy] = useState(false);
  const [approverDir, setApproverDir] = useState<ApproverDirectory | null>(null);
  const [approverSyncBusy, setApproverSyncBusy] = useState(false);

  const sageConnected = (status?.sage_entities.length ?? 0) > 0;
  const hasPulled = nominalSummary.length > 0;

  useEffect(() => {
    void api.status().then(setStatus);
    void api.sageNominals().then((r) => setNominalSummary(r.summary)).catch(() => undefined);
    void api.team().then(setTeam).catch(() => undefined);
    void api.approversDirectory().then(setApproverDir).catch(() => undefined);
  }, []);

  async function syncApprovers() {
    setApproverSyncBusy(true);
    setError(null);
    try {
      const { summary, provider } = await api.syncApprovers();
      await refreshMeta();
      const bits = [
        summary.added ? `${summary.added} added` : '',
        summary.updated ? `${summary.updated} updated` : '',
        summary.deactivated ? `${summary.deactivated} deactivated` : '',
      ].filter(Boolean);
      setNotice(
        `Synced approving managers from ${provider === 'graph' ? 'Microsoft 365' : 'the sample group'}` +
          (bits.length ? ` — ${bits.join(', ')}.` : ' — no changes.'),
      );
      setTimeout(() => setNotice(null), 6000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approvers sync failed');
    } finally {
      setApproverSyncBusy(false);
    }
  }

  async function syncTeam() {
    setTeamBusy(true);
    setError(null);
    try {
      const dir = await api.syncTeam();
      setTeam(dir);
      setNotice(`Synced ${dir.members.length} people from ${dir.provider === 'graph' ? 'Microsoft 365' : 'the sample group'}.`);
      setTimeout(() => setNotice(null), 5000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Team sync failed');
    } finally {
      setTeamBusy(false);
    }
  }

  async function changeRole(email: string, role: TeamRole) {
    setError(null);
    try {
      await api.setTeamRole(email, role);
      setTeam(await api.team());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change access level');
    }
  }

  async function pullNominals() {
    setPullBusy(true);
    setError(null);
    try {
      const res = await api.pullNominals(pullEntity || undefined);
      setDraft((d) => ({ ...d, categories: res.categories }));
      setNominalSummary((await api.sageNominals()).summary);
      await refreshMeta();
      setNotice(`Pulled ${res.pulled} active nominal codes from ${res.entity} — the coding list now has ${res.categories.length} codes.`);
      setTimeout(() => setNotice(null), 6000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nominal pull failed');
    } finally {
      setPullBusy(false);
    }
  }

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

  async function runReferenceCheck() {
    setRefBusy(true);
    setError(null);
    try {
      setRefCheck(await api.sageReference(refEntity === '*' ? undefined : refEntity || undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sage reference pull failed');
    } finally {
      setRefBusy(false);
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

      {team && (
        <div className="card">
          <h2>Team &amp; privileges</h2>
          <p className="muted small">
            Everyone in {team.group_configured ? 'your Microsoft 365 group' : 'the finance team'} can sign in.
            AP Leads approve rule changes, edit these settings and switch shadow/live; AP Processors review
            invoices. {isLead ? 'Change a level with the dropdown.' : 'Only an AP Lead can change these.'}
            {team.provider === 'mock' && ' Showing a sample group — connect the M365 group to manage the real team.'}
          </p>
          <table className="table table-compact">
            <thead><tr><th>Name</th><th>Email</th><th>Access level</th><th /></tr></thead>
            <tbody>
              {team.members.map((m) => (
                <tr key={m.email} className={m.in_group ? '' : 'muted'}>
                  <td>
                    {m.name}
                    {m.is_self && <span className="chip" style={{ marginLeft: 6 }}>You</span>}
                  </td>
                  <td>{m.email}</td>
                  <td>
                    {isLead && !m.config_lead && !m.is_self ? (
                      <select value={m.role} onChange={(e) => void changeRole(m.email, e.target.value as TeamRole)}>
                        <option value="processor">AP Processor</option>
                        <option value="lead">AP Lead</option>
                      </select>
                    ) : (
                      <span className={`chip ${m.role === 'lead' ? 'status-approved' : ''}`}>
                        {m.role === 'lead' ? 'AP Lead' : 'AP Processor'}
                      </span>
                    )}
                    {m.config_lead && (
                      <span className="muted small" title="Pinned to AP Lead via FINNY_LEAD_EMAILS"> · pinned</span>
                    )}
                    {m.is_self && !m.config_lead && isLead && (
                      <span className="muted small" title="Ask another AP Lead to change your own access"> · you</span>
                    )}
                  </td>
                  <td>
                    {!m.in_group && (
                      <span className="chip status-needs_review" title="Not in the M365 group — cannot sign in">
                        not in group
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {isLead && (
            <div className="row-actions">
              <button className="btn btn-small btn-primary" disabled={teamBusy} onClick={() => void syncTeam()}>
                {teamBusy ? 'Syncing…' : team.group_configured ? 'Sync from Microsoft 365' : 'Refresh sample team'}
              </button>
              {!team.group_configured && (
                <span className="muted small">
                  Set <code>FINNY_TEAM_GROUP_ID</code> (and <code>AUTH_PROVIDER=entra</code>) to manage your real M365 group.
                </span>
              )}
            </div>
          )}
        </div>
      )}

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
        <h2>Nominal codes (the coding list)</h2>
        {sageConnected && (
          <>
            <p className="muted small">
              The coding list comes straight from Sage: pull each company's <strong>active</strong>{' '}
              nominal codes and the combined list below is what invoices are coded to — no
              hand-maintained mapping.
            </p>
            {isLead && (
              <div className="row-actions" style={{ marginBottom: 8 }}>
                <select value={pullEntity} onChange={(e) => setPullEntity(e.target.value)}>
                  {settings.entities.map((e) => <option key={e} value={e}>{e}</option>)}
                  <option value="">Default server</option>
                </select>
                <button className="btn btn-small btn-primary" disabled={pullBusy} onClick={() => void pullNominals()}>
                  {pullBusy ? 'Pulling…' : 'Pull nominals from Sage'}
                </button>
              </div>
            )}
            {nominalSummary.length > 0 && (
              <p className="muted small">
                {nominalSummary.map((s) => `${s.entity}: ${s.count} codes (${dateTime(s.pulled_at)})`).join(' · ')}
              </p>
            )}
          </>
        )}
        {hasPulled ? (
          <div className="nominal-list">
            {draft.categories.map((c) => (
              <div key={c.nominal_code} className="nominal-row">
                <span className="nominal-code">{c.nominal_code}</span> {c.name}
              </div>
            ))}
          </div>
        ) : (
          <>
            {!sageConnected && (
              <p className="muted small">
                Maintained by hand until a HyperAccounts server is configured — then the list is
                pulled straight from each company's Sage and this editor retires.
              </p>
            )}
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
          </>
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
        <h2>Check against Sage</h2>
        {status && status.sage_entities.length === 0 ? (
          <p className="muted">
            Not connected yet. Once a HyperAccounts server is configured (<code>SAGE_API_URL</code> or{' '}
            <code>SAGE_ENTITY_SERVERS</code>), this pulls the live chart of accounts, tax codes,
            departments and projects straight from Sage and validates every mapping above — no more
            typing codes from memory.
          </p>
        ) : (
          <>
            <p className="muted">
              Pulls the live reference data from the Sage company and checks the mappings above
              against it. Read-only — nothing in Sage changes.
            </p>
            <div className="row-actions" style={{ marginBottom: 10 }}>
              {status && status.sage_entities.filter((e) => e !== '*').length > 0 && (
                <select value={refEntity} onChange={(e) => setRefEntity(e.target.value)}>
                  <option value="*">Default server</option>
                  {status.sage_entities.filter((e) => e !== '*').map((e) => (
                    <option key={e} value={e}>{e}</option>
                  ))}
                </select>
              )}
              {isLead && (
                <button className="btn btn-small btn-primary" disabled={refBusy} onClick={() => void runReferenceCheck()}>
                  {refBusy ? 'Checking…' : 'Check against Sage'}
                </button>
              )}
            </div>
            {refCheck && !refCheck.configured && (
              <p className="muted">No HyperAccounts server is configured for that entity.</p>
            )}
            {refCheck?.configured && refCheck.validation && (
              <div className="ref-check">
                <p className="muted small">
                  Pulled from Sage ({refCheck.entity}): {refCheck.counts!.nominals} nominal codes,{' '}
                  {refCheck.counts!.tax_codes} tax codes, {refCheck.counts!.departments} departments,{' '}
                  {refCheck.counts!.projects} projects.
                </p>
                <h3>Categories</h3>
                <ul className="ref-list">
                  {refCheck.validation.categories.map((c) => (
                    <li key={c.name}>
                      {c.name} → {c.nominal_code}{' '}
                      {c.ok ? (
                        <span className="chip status-approved">✓ {c.sage_name}</span>
                      ) : c.inactive ? (
                        <span className="chip status-needs_review">inactive in Sage: {c.sage_name}</span>
                      ) : (
                        <span className="chip status-rejected">not in Sage</span>
                      )}
                    </li>
                  ))}
                </ul>
                <h3>Tax codes</h3>
                <ul className="ref-list">
                  {refCheck.validation.tax_codes.map((t) => (
                    <li key={`${t.rate ?? 'default'}`}>
                      {t.rate === null ? 'Default' : `${t.rate}%`} → {t.code}{' '}
                      {!t.ok ? (
                        <span className="chip status-rejected">not in Sage</span>
                      ) : t.rate_matches ? (
                        <span className="chip status-approved">✓ {t.sage_rate}% {t.sage_description}</span>
                      ) : (
                        <span className="chip status-needs_review">Sage has {t.sage_rate}% — expected {t.rate}%</span>
                      )}
                    </li>
                  ))}
                  <li>
                    Fallback dept {draft.sage_department}{' '}
                    {refCheck.validation.fallback_dept_ok ? (
                      <span className="chip status-approved">✓ exists</span>
                    ) : (
                      <span className="chip status-rejected">not in Sage</span>
                    )}
                  </li>
                </ul>
                <h3>Projects</h3>
                <ul className="ref-list">
                  {refCheck.validation.projects.map((p) => (
                    <li key={p.code}>
                      {p.code} ({p.name}){' '}
                      {p.in_sage ? (
                        <span className="chip status-approved">✓ {p.sage_name}</span>
                      ) : (
                        <span className="chip status-rejected">not in Sage</span>
                      )}{' '}
                      {!p.dept_ok && <span className="chip status-needs_review">dept {p.dept} not in Sage</span>}
                    </li>
                  ))}
                </ul>
                {refCheck.validation.missing_projects.length > 0 && (
                  <>
                    <h3>In Sage but not in Finny</h3>
                    <ul className="ref-list">
                      {refCheck.validation.missing_projects.map((m) => (
                        <li key={m.reference}>
                          {m.reference} ({m.name}){' '}
                          {isLead && (
                            <button className="btn btn-small" onClick={() => {
                              setDraft({
                                ...draft,
                                projects: [...draft.projects, { name: m.name, code: m.reference, dept: draft.sage_department }],
                              });
                              setNotice(`Added ${m.reference} to the projects list above — set its Dept, then press "Save entities & projects".`);
                            }}>
                              Add to Finny
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>Approving managers</h2>
        <p className="muted small">
          Managers who approve invoices in Teams — they don't sign into Finny.{' '}
          {approverDir?.group_configured
            ? 'Synced from your Microsoft 365 approvers group'
            : 'Add them by hand, or sync from a Microsoft 365 group'}
          , which also captures each manager's Teams user id used to raise approvals.
        </p>
        <table className="table table-compact">
          <thead><tr><th>Name</th><th>Email</th><th>Status</th><th /></tr></thead>
          <tbody>
            {approvers.map((a) => (
              <tr key={a.id} className={a.active ? '' : 'muted'}>
                <td>
                  {a.name}
                  {a.source === 'graph' && (
                    <span className="chip" style={{ marginLeft: 6 }} title="Synced from Microsoft 365">M365</span>
                  )}
                </td>
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
          <>
            <div className="row-actions" style={{ marginBottom: 8 }}>
              <button className="btn btn-small btn-primary" disabled={approverSyncBusy} onClick={() => void syncApprovers()}>
                {approverSyncBusy ? 'Syncing…' : approverDir?.group_configured ? 'Sync from Microsoft 365' : 'Refresh sample managers'}
              </button>
              {approverDir && !approverDir.group_configured && (
                <span className="muted small">
                  Set <code>FINNY_APPROVERS_GROUP_ID</code> to pull your real M365 approvers group.
                </span>
              )}
            </div>
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
          </>
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
