import { useEffect, useState } from 'react';
import type { DashboardMetrics } from '@finny/shared';
import { api } from '../api';
import { pct } from '../format';
import { useMeta } from '../meta';
import { BarRow, EmptyState, TrendLine } from '../components/ui';

const FIELD_LABELS: Record<string, string> = {
  vendor_name: 'Vendor',
  invoice_ref: 'Invoice ref',
  invoice_date: 'Date',
  net_cents: 'Net',
  vat_cents: 'VAT',
  gross_cents: 'Gross',
  vat_rate: 'VAT rate',
  vat_number: 'VAT number',
  po_number: 'PO number',
  entity: 'Billed-to entity',
  project: 'Project',
  category: 'Category',
  approver: 'Approver',
};

const GO_LIVE_TARGET = 0.85; // spec: 85%+ before flipping a field to live

export default function DashboardPage() {
  const { settings } = useMeta();
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);

  useEffect(() => {
    void api.dashboard().then(setMetrics);
  }, []);

  if (!metrics) return <div className="page-loading">Crunching metrics…</div>;

  const readyFields = metrics.shadow_field_accuracy.filter((f) => f.samples >= 5 && f.accuracy >= GO_LIVE_TARGET).length;
  const measuredFields = metrics.shadow_field_accuracy.filter((f) => f.samples > 0).length;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Accuracy dashboard</h1>
      </div>
      <p className="muted">
        AI-vs-human comparisons from every completed review. The spec's go-live gate: 85%+ field accuracy over
        the shadow period before trusting a field. Currently in <strong>{settings.mode} mode</strong>.
      </p>

      <div className="stat-row">
        <div className="stat card">
          <span className="stat-value">{metrics.invoices_processed}</span>
          <span className="stat-label">invoices reviewed<br /><small>{metrics.shadow_completed} shadow · {metrics.live_confirmed} live</small></span>
        </div>
        <div className="stat card">
          <span className="stat-value">
            {metrics.avg_hours_to_process === null ? '—' : `${metrics.avg_hours_to_process}h`}
          </span>
          <span className="stat-label">avg arrival → confirmed<br /><small>live invoices</small></span>
        </div>
        <div className="stat card">
          <span className="stat-value">{measuredFields ? `${readyFields}/${measuredFields}` : '—'}</span>
          <span className="stat-label">fields at the 85% gate<br /><small>min 5 samples</small></span>
        </div>
        <div className="stat card">
          <span className="stat-value">{metrics.stable_rules}/{metrics.active_rules}</span>
          <span className="stat-label">stable rules<br /><small>active with zero corrections</small></span>
        </div>
      </div>

      <div className="dash-grid">
        <div className="card">
          <h2>Extraction accuracy by field</h2>
          {metrics.shadow_field_accuracy.every((f) => f.samples === 0) ? (
            <EmptyState title="No comparisons yet" hint="Complete reviews (shadow or live) to measure the AI against the team." />
          ) : (
            metrics.shadow_field_accuracy.map((f) => (
              <BarRow key={f.field} label={FIELD_LABELS[f.field] ?? f.field} value={f.accuracy} samples={f.samples} target={GO_LIVE_TARGET} />
            ))
          )}
          <p className="muted small">Vertical line = 85% go-live target.</p>
        </div>

        <div className="card">
          <h2>Routing accuracy</h2>
          {metrics.routing_accuracy.map((f) => (
            <BarRow key={f.field} label={FIELD_LABELS[f.field] ?? f.field} value={f.accuracy} samples={f.samples} target={GO_LIVE_TARGET} />
          ))}
          <h2 className="spaced">Routing correction rate by week</h2>
          <TrendLine points={metrics.correction_rate_weekly} />
          <p className="muted small">Share of reviewed invoices needing a category/approver fix. Down and to the right = the rules are sticking.</p>
        </div>
      </div>

      <div className="card">
        <h2>By vendor</h2>
        {metrics.vendor_breakdown.length === 0 ? (
          <EmptyState title="No vendors yet" />
        ) : (
          <table className="table">
            <thead>
              <tr><th>Vendor</th><th className="num">Invoices</th><th className="num">Corrections</th><th className="num">Routing accuracy</th><th>Rule</th></tr>
            </thead>
            <tbody>
              {metrics.vendor_breakdown.map((v) => (
                <tr key={v.vendor}>
                  <td>{v.vendor}</td>
                  <td className="num">{v.invoices}</td>
                  <td className="num">{v.corrections}</td>
                  <td className="num">{v.routing_accuracy === null ? '—' : pct(v.routing_accuracy)}</td>
                  <td>{v.has_rule ? <span className="chip status-approved">learned</span> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
