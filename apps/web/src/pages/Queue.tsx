import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { InvoiceSummary } from '@finny/shared';
import { api } from '../api';
import { ago, euros, shortDate } from '../format';
import { useMeta } from '../meta';
import { ConfidenceBadge, EmptyState, StatusChip } from '../components/ui';

const TABS: { key: string; label: string }[] = [
  { key: 'needs_review', label: 'Needs review' },
  { key: 'failed', label: 'Failed' },
  { key: 'awaiting_approval', label: 'Approvals' },
  { key: 'completed', label: 'Completed' },
  { key: 'all', label: 'All' },
];

const SCENARIOS: { key: string; label: string }[] = [
  { key: 'normal', label: 'Normal invoice' },
  { key: 'missing_po', label: 'Invoice without a PO' },
  { key: 'no_ref', label: 'Invoice without a reference' },
  { key: 'image', label: 'Photographed invoice (image)' },
  { key: 'corrupt', label: 'Corrupt attachment (alert demo)' },
  { key: 'batch', label: 'Batch of 5 invoices' },
];

export default function Queue() {
  const { settings, approverName, overview, refreshOverview } = useMeta();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'needs_review';
  const [rows, setRows] = useState<InvoiceSummary[] | null>(null);
  const [simOpen, setSimOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setRows(await api.invoices(tab));
  }, [tab]);

  useEffect(() => {
    setRows(null);
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  async function simulate(scenario: string) {
    setSimOpen(false);
    const count = scenario === 'batch' ? 5 : 1;
    const actual = scenario === 'batch' ? 'normal' : scenario;
    await api.simulateInvoice(actual, count);
    setNotice(
      scenario === 'corrupt'
        ? 'Corrupt attachment sent — watch the Failed tab and Alerts.'
        : `Simulated ${count} incoming invoice${count > 1 ? 's' : ''} — extraction runs in a few seconds.`,
    );
    setTimeout(() => setNotice(null), 6000);
    await load();
    await refreshOverview();
  }

  async function onUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      await api.upload(file);
    }
    setNotice(`Uploaded ${files.length} file${files.length > 1 ? 's' : ''} — extraction queued.`);
    setTimeout(() => setNotice(null), 6000);
    await load();
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Invoice queue</h1>
        <div className="page-actions">
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg"
            multiple
            hidden
            onChange={(e) => void onUpload(e.target.files)}
          />
          <button className="btn" onClick={() => fileInput.current?.click()}>
            Upload invoice
          </button>
          {overview?.simulator_enabled && (
            <div className="dropdown">
              <button className="btn btn-primary" onClick={() => setSimOpen((o) => !o)}>
                Simulate incoming ▾
              </button>
              {simOpen && (
                <div className="dropdown-menu" onMouseLeave={() => setSimOpen(false)}>
                  {SCENARIOS.map((s) => (
                    <button key={s.key} onClick={() => void simulate(s.key)}>
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {notice && <div className="banner banner-info">{notice}</div>}

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab ${tab === t.key ? 'tab-active' : ''}`}
            onClick={() => setParams({ tab: t.key })}
          >
            {t.label}
            {t.key === 'needs_review' && overview ? ` (${overview.counts.needs_review})` : ''}
            {t.key === 'failed' && overview ? ` (${overview.counts.failed})` : ''}
          </button>
        ))}
      </div>

      {rows === null ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing here"
          hint={
            tab === 'needs_review'
              ? overview?.simulator_enabled
                ? 'Use "Simulate incoming" to generate invoices, drop files into data/inbox/, or upload one.'
                : 'New mail in the shared mailbox will appear here automatically.'
              : undefined
          }
        />
      ) : (
        <table className="table table-click">
          <thead>
            <tr>
              <th>Received</th>
              <th>Vendor</th>
              <th>Ref</th>
              <th className="num">Gross</th>
              <th>AI proposal</th>
              <th>Fields</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((inv) => (
              <tr
                key={inv.id}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('a')) return; // real links handle themselves
                  if (window.getSelection()?.toString()) return; // don't hijack text selection
                  navigate(`/invoices/${inv.id}`);
                }}
              >
                <td>
                  <Link to={`/invoices/${inv.id}`} className="row-link">
                    {shortDate(inv.received_at)} <small className="muted">{ago(inv.received_at)}</small>
                  </Link>
                </td>
                <td>
                  <Link to={`/invoices/${inv.id}`} className="row-link">
                    <strong>{inv.vendor_name ?? <span className="muted">unknown</span>}</strong>
                    {inv.duplicate_of && <span className="flag flag-dup" title="Possible duplicate">DUP</span>}
                    {inv.doc_type && inv.doc_type !== 'invoice' && (
                      <span className="flag flag-doc" title={`AI thinks this is a ${inv.doc_type}`}>
                        {inv.doc_type}
                      </span>
                    )}
                    {inv.entity && (
                      <div className="muted small">
                        {inv.entity}
                        {inv.project_code ? ` · ${inv.project_code}` : ''}
                      </div>
                    )}
                  </Link>
                </td>
                <td>{inv.invoice_ref ?? '—'}</td>
                <td className="num">{euros(inv.gross_cents)}</td>
                <td>
                  {(inv.category ?? inv.proposed_category) ? (
                    <span>
                      {inv.category ?? inv.proposed_category} → {approverName(inv.approver_id ?? inv.proposed_approver_id)}{' '}
                      {inv.status === 'needs_review' && (
                        <ConfidenceBadge value={inv.routing_confidence} threshold={settings.confidence_threshold} />
                      )}
                    </span>
                  ) : (
                    <span className="muted">unrouted</span>
                  )}
                </td>
                <td>
                  {inv.status === 'needs_review' || inv.status === 'extraction_failed' ? (
                    <ConfidenceBadge value={inv.min_required_confidence} threshold={settings.confidence_threshold} />
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <StatusChip status={inv.status} shadow={inv.shadow} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
