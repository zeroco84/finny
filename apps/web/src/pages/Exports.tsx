import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ConnectorStatus, InvoiceSummary, SageBatch } from '@finny/shared';
import { api } from '../api';
import { dateTime, euros, shortDate } from '../format';
import { useMeta } from '../meta';
import { Banner, EmptyState, StatusChip } from '../components/ui';

export default function ExportsPage() {
  const { refreshOverview } = useMeta();
  const [pool, setPool] = useState<InvoiceSummary[] | null>(null);
  const [batches, setBatches] = useState<SageBatch[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [connector, setConnector] = useState<ConnectorStatus | null>(null);
  const apiMode = connector?.sage_provider === 'hyperaccounts';

  useEffect(() => {
    void api.status().then(setConnector);
  }, []);

  const load = useCallback(async () => {
    const [p, b] = await Promise.all([api.exportPool(), api.batches()]);
    setPool(p);
    setBatches(b);
    setSelected(new Set(p.map((i) => i.id)));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const [notice, setNotice] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.generateBatches([...selected]);
      if (apiMode) {
        const posted = created.reduce((s, b) => s + b.posted_count, 0);
        const total = created.reduce((s, b) => s + b.invoice_count, 0);
        setNotice(
          posted === total
            ? `Sent to Sage: ${posted} invoice${posted === 1 ? '' : 's'} posted across ${created.length} ${created.length === 1 ? 'company' : 'companies'}.`
            : `Posted ${posted}/${total} — the rest kept their batch; use "Send to Sage" to retry (details in Alerts).`,
        );
      } else {
        setNotice(
          created.length > 1
            ? `Generated ${created.length} batches — one per legal entity (each imports into its own Sage company).`
            : `Generated ${created[0].filename}.`,
        );
      }
      setTimeout(() => setNotice(null), 8000);
      await load();
      await refreshOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  }

  async function sendBatch(id: string) {
    setBusy(true);
    setError(null);
    try {
      const { summary } = await api.sendBatch(id);
      const extras = [
        summary.duplicates > 0 &&
          `${summary.duplicates} already in Sage — linked, not re-posted (see Alerts)`,
        summary.reassigned > 0 && `${summary.reassigned} ref(s) reassigned to avoid a clash`,
      ].filter(Boolean);
      setNotice(
        summary.failed === 0
          ? `Batch posted to Sage (${summary.posted + summary.adopted + summary.duplicates + summary.skipped} invoices).` +
              (extras.length > 0 ? ` ${extras.join('; ')}.` : '')
          : `${summary.failed} invoice(s) still failing — see Alerts for the reason.`,
      );
      setTimeout(() => setNotice(null), 8000);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send failed');
    } finally {
      setBusy(false);
    }
  }

  if (pool === null) return <div className="page-loading">Loading exports…</div>;

  const total = pool.filter((i) => selected.has(i.id)).reduce((s, i) => s + (i.gross_cents ?? 0), 0);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Sage 50 export</h1>
      </div>
      {apiMode ? (
        <p className="muted">
          One-touch mode: generating posts each invoice straight into the entity's Sage company via
          HyperAccounts, with sequential posting refs and the invoice document linked on every
          transaction. The CSV stays as the audit copy. Every step lands on the invoice's history.
        </p>
      ) : (
        <p className="muted">
          Confirmed invoices batch into the AP posting format (A/C · Date · Ref · Ex Ref · N/C · Dept ·
          Details · Net · T/C · Vat · Gross), one file per legal entity, with sequential posting refs
          assigned automatically. Generate, download, post in Sage, then mark imported — every step is
          recorded on the invoice's history.
        </p>
      )}
      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="success">{notice}</Banner>}

      <div className="card">
        <h2>Ready to export ({pool.length})</h2>
        {pool.length === 0 ? (
          <EmptyState title="No confirmed invoices waiting" hint="Confirm invoices in the queue (live mode) and they appear here." />
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th />
                  <th>Vendor</th><th>Ref</th><th>Entity</th><th>Date</th><th className="num">Gross</th><th>Approval</th>
                </tr>
              </thead>
              <tbody>
                {pool.map((inv) => (
                  <tr key={inv.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(inv.id)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          e.target.checked ? next.add(inv.id) : next.delete(inv.id);
                          setSelected(next);
                        }}
                      />
                    </td>
                    <td><Link to={`/invoices/${inv.id}`}>{inv.vendor_name}</Link></td>
                    <td>{inv.invoice_ref}</td>
                    <td className="muted">{inv.entity ?? '—'}{inv.project_code ? ` · ${inv.project_code}` : ''}</td>
                    <td>{shortDate(inv.invoice_date)}</td>
                    <td className="num">{euros(inv.gross_cents)}</td>
                    <td><StatusChip status={inv.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="export-bar">
              <span>
                {selected.size} invoice{selected.size === 1 ? '' : 's'} · {euros(total)}
              </span>
              <button className="btn btn-primary" disabled={busy || selected.size === 0} onClick={() => void generate()}>
                {apiMode ? 'Send to Sage' : 'Generate Sage batch'}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2>Batches</h2>
        {batches.length === 0 ? (
          <EmptyState title="No batches yet" />
        ) : (
          <table className="table">
            <thead>
              <tr><th>Created</th><th>Entity</th><th>File</th><th className="num">Invoices</th><th className="num">Total</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td>{dateTime(b.created_at)} <small className="muted">by {b.created_by}</small></td>
                  <td className="muted">{b.entity ?? '—'}</td>
                  <td><a href={`/api/exports/${b.id}/download`}>{b.filename}</a></td>
                  <td className="num">{b.invoice_count}</td>
                  <td className="num">{euros(b.total_gross_cents)}</td>
                  <td>
                    {b.status === 'marked_imported' ? (
                      <span className="chip status-approved">imported {dateTime(b.marked_imported_at)}</span>
                    ) : b.status === 'posted' ? (
                      <span className="chip status-approved">posted to Sage ({b.posted_count}/{b.invoice_count})</span>
                    ) : b.posted_count > 0 ? (
                      <span className="chip status-needs_review">partially posted ({b.posted_count}/{b.invoice_count})</span>
                    ) : (
                      <span className="chip status-confirmed">generated</span>
                    )}
                  </td>
                  <td className="row-actions">
                    <a className="btn btn-small" href={`/api/exports/${b.id}/download`}>Download</a>
                    {apiMode && b.status === 'generated' && (
                      <button className="btn btn-small btn-primary" disabled={busy} onClick={() => void sendBatch(b.id)}>
                        Send to Sage
                      </button>
                    )}
                    {!apiMode && b.status === 'generated' && (
                      <button
                        className="btn btn-small btn-primary"
                        onClick={() => void api.markImported(b.id).then(load)}
                      >
                        Mark imported
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
