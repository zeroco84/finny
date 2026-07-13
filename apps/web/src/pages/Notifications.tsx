import { useCallback, useEffect, useState } from 'react';
import type {
  AmountThresholdParams,
  DateThresholdParams,
  ProjectMatchParams,
  SupplierMatchParams,
  WebhookEventType,
  WebhookSubscription,
  WebhookSubscriptionInput,
  WebhookSubscriptionParams,
} from '@finny/shared';
import { api } from '../api';
import { dateTime, euros, inputToCents } from '../format';
import { Banner, EmptyState } from '../components/ui';

const EVENT_LABELS: Record<WebhookEventType, string> = {
  amount_threshold: 'Invoice amount',
  date_threshold: 'Invoice / due date',
  supplier_match: 'Supplier name',
  project_match: 'Project name',
};

interface Draft {
  label: string;
  event_type: WebhookEventType;
  webhook_url: string;
  amount: string;
  postdated: boolean;
  staleOn: boolean;
  staleDays: string;
  dueOn: boolean;
  dueDays: string;
  query: string;
}

const EMPTY: Draft = {
  label: '',
  event_type: 'amount_threshold',
  webhook_url: '',
  amount: '',
  postdated: false,
  staleOn: false,
  staleDays: '',
  dueOn: true,
  dueDays: '30',
  query: '',
};

/** Turn the draft's category-specific inputs into a params object, or throw a message. */
function buildParams(d: Draft): WebhookSubscriptionParams {
  switch (d.event_type) {
    case 'amount_threshold': {
      const min = inputToCents(d.amount);
      if (min === null || min <= 0) throw new Error('Enter a positive amount to alert at or over.');
      return { min_cents: min };
    }
    case 'date_threshold': {
      const p: DateThresholdParams = {};
      if (d.postdated) p.postdated = true;
      if (d.staleOn) {
        const n = Number(d.staleDays);
        if (!Number.isInteger(n) || n < 0) throw new Error('Back-dated days must be a whole number.');
        p.stale_days = n;
      }
      if (d.dueOn) {
        const n = Number(d.dueDays);
        if (!Number.isInteger(n) || n < 0) throw new Error('Due-within days must be a whole number.');
        p.due_within_days = n;
      }
      if (!p.postdated && p.stale_days == null && p.due_within_days == null) {
        throw new Error('Pick at least one date condition.');
      }
      return p;
    }
    case 'supplier_match':
    case 'project_match': {
      const query = d.query.trim();
      if (query.length < 2) throw new Error('Enter at least 2 characters to match on.');
      return { query };
    }
  }
}

/** One-line human summary of a subscription's criteria for the list. */
function describe(sub: WebhookSubscription): string {
  switch (sub.event_type) {
    case 'amount_threshold':
      return `Gross ≥ ${euros((sub.params as AmountThresholdParams).min_cents)}`;
    case 'date_threshold': {
      const p = sub.params as DateThresholdParams;
      const parts: string[] = [];
      if (p.postdated) parts.push('post-dated');
      if (p.stale_days != null) parts.push(`back-dated > ${p.stale_days}d`);
      if (p.due_within_days != null) parts.push(`due within ${p.due_within_days}d`);
      return parts.join(' · ') || 'no conditions';
    }
    case 'supplier_match':
      return `Supplier ~ “${(sub.params as SupplierMatchParams).query}”`;
    case 'project_match':
      return `Project ~ “${(sub.params as ProjectMatchParams).query}”`;
  }
}

export default function NotificationsPage() {
  const [subs, setSubs] = useState<WebhookSubscription[] | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setSubs(await api.subscriptions());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setError(null);
    setNotice(null);
    let params: WebhookSubscriptionParams;
    try {
      if (!draft.label.trim()) throw new Error('Give the alert a short label.');
      if (!draft.webhook_url.trim()) throw new Error('Paste your Teams webhook URL.');
      params = buildParams(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Check the form and try again.');
      return;
    }
    const body: WebhookSubscriptionInput = {
      label: draft.label.trim(),
      event_type: draft.event_type,
      params,
      webhook_url: draft.webhook_url.trim(),
    };
    setBusy(true);
    try {
      await api.createSubscription(body);
      setDraft({ ...EMPTY, event_type: draft.event_type });
      setNotice('Subscription created.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the subscription.');
    } finally {
      setBusy(false);
    }
  }

  async function toggle(sub: WebhookSubscription) {
    setError(null);
    try {
      await api.updateSubscription(sub.id, { active: !sub.active });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the subscription.');
    }
  }

  async function remove(sub: WebhookSubscription) {
    if (!window.confirm(`Delete the “${sub.label}” alert?`)) return;
    setError(null);
    try {
      await api.deleteSubscription(sub.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the subscription.');
    }
  }

  async function test(sub: WebhookSubscription) {
    setError(null);
    setNotice(null);
    try {
      const r = await api.testSubscription(sub.id);
      setNotice(`Test card sent to ${r.host ?? 'your webhook'} — check the Teams chat.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Webhook test failed.');
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Notifications</h1>
      </div>
      <p className="muted">
        Subscribe your own Teams chat or channel to invoices you care about. When an invoice arrives and matches,
        Finny posts a card to your webhook. These are separate from the operational failure alerts on the{' '}
        <strong>Alerts</strong> page.
      </p>

      {notice && <Banner kind="success">{notice}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}

      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0 }}>New alert</h2>
        <div className="field-grid">
          <label className="field">
            <span className="field-label">Label</span>
            <input value={draft.label} maxLength={80}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              placeholder="e.g. Big invoices to me" />
          </label>
          <label className="field">
            <span className="field-label">Event category</span>
            <select value={draft.event_type}
              onChange={(e) => setDraft({ ...draft, event_type: e.target.value as WebhookEventType })}>
              {(Object.keys(EVENT_LABELS) as WebhookEventType[]).map((k) => (
                <option key={k} value={k}>{EVENT_LABELS[k]}</option>
              ))}
            </select>
          </label>
        </div>

        {draft.event_type === 'amount_threshold' && (
          <label className="field">
            <span className="field-label">Alert at or over (€)</span>
            <input inputMode="decimal" value={draft.amount}
              onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
              placeholder="10000.00" />
          </label>
        )}

        {draft.event_type === 'date_threshold' && (
          <div className="field">
            <span className="field-label">Trigger when the invoice is…</span>
            <label className="radio-row">
              <input type="checkbox" checked={draft.postdated}
                onChange={(e) => setDraft({ ...draft, postdated: e.target.checked })} />
              <span>Post-dated (dated later than the day it arrived)</span>
            </label>
            <label className="radio-row">
              <input type="checkbox" checked={draft.staleOn}
                onChange={(e) => setDraft({ ...draft, staleOn: e.target.checked })} />
              <span>Back-dated more than{' '}
                <input type="number" min={0} className="inline-num" value={draft.staleDays}
                  disabled={!draft.staleOn}
                  onChange={(e) => setDraft({ ...draft, staleDays: e.target.value })} /> days</span>
            </label>
            <label className="radio-row">
              <input type="checkbox" checked={draft.dueOn}
                onChange={(e) => setDraft({ ...draft, dueOn: e.target.checked })} />
              <span>Due within{' '}
                <input type="number" min={0} className="inline-num" value={draft.dueDays}
                  disabled={!draft.dueOn}
                  onChange={(e) => setDraft({ ...draft, dueDays: e.target.value })} /> days</span>
            </label>
          </div>
        )}

        {(draft.event_type === 'supplier_match' || draft.event_type === 'project_match') && (
          <label className="field">
            <span className="field-label">
              {draft.event_type === 'supplier_match' ? 'Supplier name contains' : 'Project name or code contains'}
            </span>
            <input value={draft.query} maxLength={120}
              onChange={(e) => setDraft({ ...draft, query: e.target.value })}
              placeholder={draft.event_type === 'supplier_match' ? 'e.g. Hegarty Steel' : 'e.g. Dock Mill'} />
            <span className="muted small">Fuzzy match — tolerant of Ltd/PLC, punctuation and small typos.</span>
          </label>
        )}

        <label className="field field-wide">
          <span className="field-label">Your Teams webhook URL</span>
          <input type="password" autoComplete="off" value={draft.webhook_url}
            onChange={(e) => setDraft({ ...draft, webhook_url: e.target.value })}
            placeholder="https://…/workflows/…" />
          <span className="muted small">
            In Teams: <strong>Workflows → “Post to a channel when a webhook request is received”</strong>, pick your
            chat or channel, and paste the generated URL. Stored server-side and never shown again.
          </span>
        </label>

        <div className="row-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => void create()}>
            {busy ? 'Saving…' : 'Create alert'}
          </button>
        </div>
      </div>

      {subs === null ? (
        <p className="muted">Loading…</p>
      ) : subs.length === 0 ? (
        <EmptyState title="No alerts yet" hint="Create one above to get a Teams ping when a matching invoice arrives." />
      ) : (
        <div className="sub-list">
          {subs.map((sub) => (
            <div key={sub.id} className={`card sub-card${sub.active ? '' : ' sub-inactive'}`}>
              <div className="sub-head">
                <strong>{sub.label}</strong>
                <span className="chip">{EVENT_LABELS[sub.event_type]}</span>
                {!sub.active && <span className="chip">paused</span>}
              </div>
              <p className="sub-criteria">{describe(sub)}</p>
              <div className="sub-meta muted small">
                <span>→ {sub.webhook_host}</span>
                <span>{sub.last_fired_at ? `last fired ${dateTime(sub.last_fired_at)}` : 'never fired'}</span>
              </div>
              <div className="row-actions">
                <button className="btn btn-small" onClick={() => void test(sub)}>Send test</button>
                <button className="btn btn-small" onClick={() => void toggle(sub)}>
                  {sub.active ? 'Pause' : 'Resume'}
                </button>
                <button className="btn btn-small btn-danger-ghost" onClick={() => void remove(sub)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
