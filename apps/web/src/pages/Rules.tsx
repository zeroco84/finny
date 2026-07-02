import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Rule } from '@finny/shared';
import { api } from '../api';
import { dateTime } from '../format';
import { useMeta } from '../meta';
import { Banner, EmptyState } from '../components/ui';

type Tab = 'active' | 'pending' | 'hints' | 'history';

export default function RulesPage() {
  const { user, settings, approvers, approverName, refreshOverview } = useMeta();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [tab, setTab] = useState<Tab>('active');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ category: string; approver_id: string }>({ category: '', approver_id: '' });
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newRule, setNewRule] = useState({ vendor: '', category: '', approver_id: '', kind: 'routing', hint_text: '' });
  const isLead = user.role === 'lead';

  const load = useCallback(async () => {
    setRules(await api.rules());
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (rules === null) return <div className="page-loading">Loading rules…</div>;

  const routing = rules.filter((r) => r.kind === 'routing');
  const byTab: Record<Tab, Rule[]> = {
    active: routing.filter((r) => r.status === 'active'),
    pending: routing.filter((r) => r.status === 'pending'),
    hints: rules.filter((r) => r.kind === 'extraction_hint' && r.status === 'active'),
    history: rules.filter((r) => r.status === 'retired' || r.status === 'rejected'),
  };

  async function decide(rule: Rule, decision: 'approve' | 'reject') {
    setError(null);
    try {
      await api.decideRule(rule.id, decision);
      await load();
      await refreshOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  }

  async function saveEdit(rule: Rule) {
    setError(null);
    try {
      await api.updateRule(rule.id, {
        category: draft.category || null,
        approver_id: draft.approver_id || null,
      });
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  }

  async function createRule() {
    setError(null);
    try {
      await api.createRule({
        kind: newRule.kind as 'routing' | 'extraction_hint',
        vendor: newRule.vendor,
        category: newRule.category || null,
        approver_id: newRule.approver_id || null,
        hint_text: newRule.hint_text || null,
      });
      setShowNew(false);
      setNewRule({ vendor: '', category: '', approver_id: '', kind: 'routing', hint_text: '' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Learned rules</h1>
        {isLead && (
          <button className="btn btn-primary" onClick={() => setShowNew((s) => !s)}>
            {showNew ? 'Cancel' : 'New rule'}
          </button>
        )}
      </div>
      <p className="muted">
        What the AI has learned from the team's corrections — inspectable, editable, and reversible.
        Rules always take precedence over the model's own suggestion.
      </p>
      {error && <Banner kind="error">{error}</Banner>}

      {showNew && (
        <div className="card new-rule">
          <div className="field-grid">
            <label className="field">
              <span className="field-label">Kind</span>
              <select value={newRule.kind} onChange={(e) => setNewRule({ ...newRule, kind: e.target.value })}>
                <option value="routing">Routing (vendor → category → approver)</option>
                <option value="extraction_hint">Extraction hint (injected into the prompt)</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">Vendor</span>
              <input value={newRule.vendor} onChange={(e) => setNewRule({ ...newRule, vendor: e.target.value })} />
            </label>
            {newRule.kind === 'routing' ? (
              <>
                <label className="field">
                  <span className="field-label">Category</span>
                  <select value={newRule.category} onChange={(e) => setNewRule({ ...newRule, category: e.target.value })}>
                    <option value="">— choose —</option>
                    {settings.categories.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Approver</span>
                  <select value={newRule.approver_id} onChange={(e) => setNewRule({ ...newRule, approver_id: e.target.value })}>
                    <option value="">— choose —</option>
                    {approvers.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </label>
              </>
            ) : (
              <label className="field field-wide">
                <span className="field-label">Hint text (e.g. “the PO is printed as ‘Order Code’ in the footer”)</span>
                <input value={newRule.hint_text} onChange={(e) => setNewRule({ ...newRule, hint_text: e.target.value })} />
              </label>
            )}
          </div>
          <button className="btn btn-primary" onClick={() => void createRule()}>Create rule</button>
        </div>
      )}

      <div className="tabs">
        {(['active', 'pending', 'hints', 'history'] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? 'tab-active' : ''}`} onClick={() => setTab(t)}>
            {t === 'active' && `Active (${byTab.active.length})`}
            {t === 'pending' && `Pending approval (${byTab.pending.length})`}
            {t === 'hints' && `Extraction hints (${byTab.hints.length})`}
            {t === 'history' && 'History'}
          </button>
        ))}
      </div>

      {tab === 'pending' && (
        byTab.pending.length === 0 ? (
          <EmptyState title="No proposals waiting" hint="When a reviewer corrects routing, the proposed rule lands here for AP Lead sign-off." />
        ) : (
          <div className="pending-list">
            {byTab.pending.map((rule) => (
              <div className="card pending-card" key={rule.id}>
                <div>
                  <strong>{rule.vendor_pattern}</strong> → {rule.category} → {approverName(rule.approver_id)}
                  <p className="muted small">
                    Proposed by {rule.created_by} · {dateTime(rule.created_at)}
                    {rule.source_invoice_id && (
                      <> · <Link to={`/invoices/${rule.source_invoice_id}`}>source invoice</Link></>
                    )}
                    {rule.supersedes_rule_id && ' · replaces an existing rule'}
                  </p>
                </div>
                {isLead ? (
                  <div className="pending-actions">
                    <button className="btn btn-primary btn-small" onClick={() => void decide(rule, 'approve')}>Approve</button>
                    <button className="btn btn-danger-ghost btn-small" onClick={() => void decide(rule, 'reject')}>Reject</button>
                  </div>
                ) : (
                  <span className="muted small">awaiting AP Lead</span>
                )}
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'active' && (
        byTab.active.length === 0 ? (
          <EmptyState title="No learned rules yet" hint="Review an invoice and set its category/approver — Finny proposes the rule from your decision." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Vendor</th><th>Category</th><th>Approver</th>
                <th className="num" title="applied / confirmed / corrected">Applied · ✓ · ✗</th>
                <th>Origin</th>{isLead && <th />}
              </tr>
            </thead>
            <tbody>
              {byTab.active.map((rule) => (
                <tr key={rule.id}>
                  <td><strong>{rule.vendor_pattern}</strong></td>
                  {editing === rule.id ? (
                    <>
                      <td>
                        <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
                          {settings.categories.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                        </select>
                      </td>
                      <td>
                        <select value={draft.approver_id} onChange={(e) => setDraft({ ...draft, approver_id: e.target.value })}>
                          {approvers.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </select>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>{rule.category}</td>
                      <td>{approverName(rule.approver_id)}</td>
                    </>
                  )}
                  <td className="num">{rule.times_applied} · {rule.times_confirmed} · {rule.times_corrected}</td>
                  <td className="muted">{rule.origin === 'correction' ? 'learned' : 'manual'}</td>
                  {isLead && (
                    <td className="row-actions">
                      {editing === rule.id ? (
                        <>
                          <button className="btn btn-small btn-primary" onClick={() => void saveEdit(rule)}>Save</button>
                          <button className="btn btn-small btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <button className="btn btn-small" onClick={() => {
                            setEditing(rule.id);
                            setDraft({ category: rule.category ?? '', approver_id: rule.approver_id ?? '' });
                          }}>Edit</button>
                          <button className="btn btn-small btn-danger-ghost" onClick={() => {
                            if (window.confirm(`Retire the rule for ${rule.vendor_pattern}?`)) {
                              void api.retireRule(rule.id).then(load);
                            }
                          }}>Retire</button>
                        </>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {tab === 'hints' && (
        byTab.hints.length === 0 ? (
          <EmptyState title="No extraction hints" hint="Hints are vendor-specific notes injected into the extraction prompt, e.g. where an awkward supplier prints the PO." />
        ) : (
          <table className="table">
            <thead><tr><th>Vendor</th><th>Hint</th>{isLead && <th />}</tr></thead>
            <tbody>
              {byTab.hints.map((rule) => (
                <tr key={rule.id}>
                  <td><strong>{rule.vendor_pattern}</strong></td>
                  <td>{rule.hint_text}</td>
                  {isLead && (
                    <td className="row-actions">
                      <button className="btn btn-small btn-danger-ghost" onClick={() => void api.retireRule(rule.id).then(load)}>Retire</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {tab === 'history' && (
        byTab.history.length === 0 ? (
          <EmptyState title="No retired or rejected rules yet" />
        ) : (
          <table className="table">
            <thead><tr><th>Vendor</th><th>Category</th><th>Approver</th><th>Status</th><th>Decided by</th><th>When</th></tr></thead>
            <tbody>
              {byTab.history.map((rule) => (
                <tr key={rule.id} className="muted">
                  <td>{rule.vendor_pattern}</td>
                  <td>{rule.category ?? rule.hint_text}</td>
                  <td>{approverName(rule.approver_id)}</td>
                  <td>{rule.status}</td>
                  <td>{rule.decided_by ?? '—'}</td>
                  <td>{dateTime(rule.decided_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </div>
  );
}
