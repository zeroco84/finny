import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import type { AuditLogEvent, AuditLogFilterOptions, AuditLogPage, AuditLogQuery } from '@finny/shared';
import { api } from '../api';
import { AUDIT_LABELS, detailSummary } from '../audit';
import { useMeta } from '../meta';
import { EmptyState } from '../components/ui';

/** Unlike the shared dateTime(), audit timestamps carry the year and seconds —
 *  the log spans years and ordering within a minute matters to an auditor. */
function auditTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IE', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** Lead-only route: processors get bounced to the dashboard (the nav link is
 *  hidden for them too; the API enforces the same rule server-side). */
export default function AuditLogPage() {
  const { user } = useMeta();
  if (user.role !== 'lead') return <Navigate to="/" replace />;
  return <AuditLogView />;
}

const FILTER_KEYS = ['actor', 'type', 'entity', 'invoice_id', 'from', 'to', 'q'] as const;

function AuditLogView() {
  const { settings } = useMeta();
  const [params, setParams] = useSearchParams();
  const [events, setEvents] = useState<AuditLogEvent[] | null>(null);
  const [page, setPage] = useState<AuditLogPage | null>(null);
  const [options, setOptions] = useState<AuditLogFilterOptions>({ actors: [], types: [] });
  const [q, setQ] = useState(params.get('q') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filterKey = params.toString();
  const filters: AuditLogQuery = {};
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value) filters[key] = value;
  }

  const load = useCallback(async () => {
    const query: AuditLogQuery = {};
    for (const key of FILTER_KEYS) {
      const value = new URLSearchParams(filterKey).get(key);
      if (value) query[key] = value;
    }
    try {
      const p = await api.auditLog(query);
      setPage(p);
      setEvents(p.events);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the audit log');
    }
  }, [filterKey]);

  useEffect(() => {
    setEvents(null);
    void load();
    api.auditFilters().then(setOptions).catch(() => {/* dropdowns just stay as-is */});
  }, [load]);

  // Debounce the free-text search into the URL (which drives the reload).
  useEffect(() => {
    const t = setTimeout(() => setParam('q', q), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (next.toString() !== params.toString()) setParams(next);
  }

  async function loadMore() {
    if (!page?.next_cursor || busy) return;
    setBusy(true);
    try {
      const p = await api.auditLog(filters, { before: page.next_cursor });
      setPage(p);
      setEvents((prev) => [...(prev ?? []), ...p.events]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load more events');
    } finally {
      setBusy(false);
    }
  }

  const hasFilters = FILTER_KEYS.some((k) => params.get(k));

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p className="muted small">
            Every action in Finny, by person and system — append-only and retained for compliance.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => void load()}>
            Refresh
          </button>
          <button
            className="btn"
            onClick={() => window.location.assign(api.auditCsvUrl(filters))}
            title="Download the filtered trail as CSV (the export itself is logged)"
          >
            Export CSV
          </button>
        </div>
      </div>

      <div className="audit-filters">
        <select value={params.get('actor') ?? ''} onChange={(e) => setParam('actor', e.target.value)}>
          <option value="">All actors</option>
          {options.actors.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select value={params.get('type') ?? ''} onChange={(e) => setParam('type', e.target.value)}>
          <option value="">All actions</option>
          {options.types.map((t) => (
            <option key={t} value={t}>
              {AUDIT_LABELS[t] ?? t}
            </option>
          ))}
        </select>
        {settings.entities.length > 0 && (
          <select value={params.get('entity') ?? ''} onChange={(e) => setParam('entity', e.target.value)}>
            <option value="">All entities</option>
            {settings.entities.map((en) => (
              <option key={en} value={en}>
                {en}
              </option>
            ))}
          </select>
        )}
        <input
          type="date"
          value={params.get('from') ?? ''}
          max={params.get('to') ?? undefined}
          onChange={(e) => setParam('from', e.target.value)}
          aria-label="From date"
        />
        <input
          type="date"
          value={params.get('to') ?? ''}
          min={params.get('from') ?? undefined}
          onChange={(e) => setParam('to', e.target.value)}
          aria-label="To date"
        />
        <input
          type="search"
          className="audit-search"
          placeholder="Search actor, action, vendor, detail…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {hasFilters && (
          <button
            className="btn btn-ghost"
            onClick={() => {
              setQ('');
              setParams(new URLSearchParams());
            }}
          >
            Clear
          </button>
        )}
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      {events === null ? (
        <p className="muted">Loading…</p>
      ) : events.length === 0 ? (
        <EmptyState
          title="No matching events"
          hint={hasFilters ? 'Try widening the filters or the date range.' : 'Actions will appear here as the team works.'}
        />
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Invoice</th>
                <th>Entity</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id}>
                  <td className="audit-time" title={ev.created_at}>
                    {auditTime(ev.created_at)}
                  </td>
                  <td>
                    <strong>{AUDIT_LABELS[ev.type] ?? ev.type}</strong>
                    {detailSummary(ev) && <div className="muted small">{detailSummary(ev)}</div>}
                  </td>
                  <td>{ev.actor}</td>
                  <td>
                    {ev.invoice_id ? (
                      <Link to={`/invoices/${ev.invoice_id}`}>{ev.vendor_name ?? ev.invoice_id.slice(0, 8)}</Link>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>{ev.entity ?? <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="audit-foot">
            <span className="muted small">
              Showing {events.length} of {page?.total ?? events.length} event{(page?.total ?? 0) === 1 ? '' : 's'}
            </span>
            {page?.next_cursor && (
              <button className="btn" onClick={() => void loadMore()} disabled={busy}>
                {busy ? 'Loading…' : 'Load older events'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
