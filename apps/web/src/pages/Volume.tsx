import { useCallback, useEffect, useState } from 'react';
import type { VendorVolume, VolumeMetrics } from '@finny/shared';
import { api } from '../api';
import { euros } from '../format';
import { DashboardSwitch, EmptyState } from '../components/ui';

type Preset = 'this' | 'last' | 'custom';

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Calendar-month bounds (1st to last day), per the AP team's definition. */
function monthBounds(offset: number): { from: string; to: string } {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 0));
  return { from: iso(first), to: iso(last) };
}

function bucketLabel(bucket: string, granularity: 'day' | 'month'): string {
  if (granularity === 'day') return bucket.slice(8); // day of month
  const [y, m] = bucket.split('-').map(Number);
  // timeZone UTC: without it the label renders in local time and can show
  // the previous month for viewers west of UTC.
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IE', {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });
}

/** Dual-series chart: bars = value per bucket, line = invoice count. */
function VolumeTrend({ metrics }: { metrics: VolumeMetrics }) {
  const today = iso(new Date());
  // Don't chart the empty future of an in-progress month.
  const series = metrics.series.filter((p) => p.bucket.slice(0, 10) <= today);
  if (series.length === 0 || metrics.totals.count === 0) {
    return <EmptyState title="No invoices in this period" hint="Try a different range." />;
  }
  const w = 680;
  const h = 190;
  const pad = { l: 10, r: 10, t: 14, b: 24 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const maxGross = Math.max(...series.map((p) => p.gross_cents), 1);
  const maxCount = Math.max(...series.map((p) => p.count), 1);
  const slot = innerW / series.length;
  const barW = Math.max(3, Math.min(34, slot * 0.62));
  const x = (i: number) => pad.l + slot * i + slot / 2;
  const yGross = (v: number) => pad.t + innerH - (v / maxGross) * innerH;
  const yCount = (v: number) => pad.t + innerH - (v / maxCount) * innerH;
  const tickStep = Math.max(1, Math.ceil(series.length / 12));
  const line = series
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${yCount(p.count).toFixed(1)}`)
    .join(' ');

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="trend volume-trend" role="img" aria-label="Invoice count and value trend">
      <line x1={pad.l} y1={h - pad.b} x2={w - pad.r} y2={h - pad.b} className="trend-axis" />
      {series.map((p, i) => (
        <rect
          key={p.bucket}
          x={x(i) - barW / 2}
          y={yGross(p.gross_cents)}
          width={barW}
          height={h - pad.b - yGross(p.gross_cents)}
          className="volume-bar"
        >
          <title>{`${p.bucket}: ${euros(p.gross_cents)} across ${p.count} invoice${p.count === 1 ? '' : 's'}`}</title>
        </rect>
      ))}
      <path d={line} className="volume-count-line" fill="none" />
      {series.map((p, i) => (
        <g key={`c-${p.bucket}`}>
          <circle cx={x(i)} cy={yCount(p.count)} r={2.8} className="volume-count-dot">
            <title>{`${p.bucket}: ${p.count} invoice${p.count === 1 ? '' : 's'}`}</title>
          </circle>
          {i % tickStep === 0 && (
            <text x={x(i)} y={h - 8} textAnchor="middle" className="trend-tick">
              {bucketLabel(p.bucket, metrics.bucket)}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

/** Top-supplier bar: width proportional to the leader. */
function RankRow({ row, max, mode }: { row: VendorVolume; max: number; mode: 'value' | 'count' }) {
  const v = mode === 'value' ? row.gross_cents : row.count;
  const width = max > 0 ? (v / max) * 100 : 0;
  return (
    <div className="bar-row rank-row">
      <span className="bar-label" title={row.vendor}>{row.vendor}</span>
      <div className="bar-track">
        <div className="bar-fill bar-ok" style={{ width: `${width}%` }} />
      </div>
      <span className="bar-value">
        {mode === 'value' ? euros(row.gross_cents) : row.count}{' '}
        <small>{mode === 'value' ? `(${row.count} inv)` : `(${euros(row.gross_cents)})`}</small>
      </span>
    </div>
  );
}

export default function VolumePage() {
  const [preset, setPreset] = useState<Preset>('this');
  const [custom, setCustom] = useState(() => monthBounds(0));
  const [metrics, setMetrics] = useState<VolumeMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const range = preset === 'this' ? monthBounds(0) : preset === 'last' ? monthBounds(-1) : custom;

  const load = useCallback(async () => {
    setError(null);
    try {
      setMetrics(await api.volume(range.from, range.to));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load volume metrics');
    }
  }, [range.from, range.to]);

  useEffect(() => {
    void load();
  }, [load]);

  const avg = metrics && metrics.totals.count > 0 ? Math.round(metrics.totals.gross_cents / metrics.totals.count) : null;
  const rangeLabel =
    preset === 'this' ? 'this month' : preset === 'last' ? 'last month' : `${range.from} → ${range.to}`;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Invoice volume</h1>
        <DashboardSwitch active="volume" />
      </div>
      <p className="muted">
        Count and value of invoices by calendar month (1st to last day), dated by the invoice date —
        documents without one use the day they arrived. Filed statements and discarded documents are
        excluded.
      </p>

      <div className="period-row">
        <div className="tabs">
          <button className={`tab ${preset === 'this' ? 'tab-active' : ''}`} onClick={() => setPreset('this')}>
            This month
          </button>
          <button className={`tab ${preset === 'last' ? 'tab-active' : ''}`} onClick={() => setPreset('last')}>
            Last month
          </button>
          <button className={`tab ${preset === 'custom' ? 'tab-active' : ''}`} onClick={() => setPreset('custom')}>
            Custom
          </button>
        </div>
        {preset === 'custom' && (
          <div className="period-custom">
            <input
              type="date"
              value={custom.from}
              max={custom.to}
              onChange={(e) => setCustom({ ...custom, from: e.target.value })}
            />
            <span className="muted">to</span>
            <input
              type="date"
              value={custom.to}
              min={custom.from}
              onChange={(e) => setCustom({ ...custom, to: e.target.value })}
            />
          </div>
        )}
      </div>

      {error && <div className="banner banner-error">{error}</div>}
      {!metrics ? (
        <div className="page-loading">Counting invoices…</div>
      ) : (
        <>
          <div className="stat-row">
            <div className="stat card">
              <span className="stat-value">{metrics.totals.count}</span>
              <span className="stat-label">invoices {rangeLabel}</span>
            </div>
            <div className="stat card">
              <span className="stat-value">{euros(metrics.totals.gross_cents)}</span>
              <span className="stat-label">total value <small>(gross)</small></span>
            </div>
            <div className="stat card">
              <span className="stat-value">{avg === null ? '—' : euros(avg)}</span>
              <span className="stat-label">average per invoice</span>
            </div>
          </div>

          <div className="card">
            <h2>Trend</h2>
            <p className="muted small">
              Bars are value (€); the line is the number of invoices — {metrics.bucket === 'day' ? 'per day' : 'per month'}.
            </p>
            <VolumeTrend metrics={metrics} />
            <div className="volume-legend">
              <span><span className="legend-swatch legend-bar" /> Value (€)</span>
              <span><span className="legend-swatch legend-line" /> Invoices</span>
            </div>
          </div>

          <div className="dash-grid">
            <div className="card">
              <h2>Top 5 suppliers by value</h2>
              {metrics.top_by_value.length === 0 ? (
                <EmptyState title="No invoices in this period" />
              ) : (
                metrics.top_by_value.map((r) => (
                  <RankRow key={r.vendor} row={r} max={metrics.top_by_value[0].gross_cents} mode="value" />
                ))
              )}
            </div>
            <div className="card">
              <h2>Top 5 suppliers by number</h2>
              {metrics.top_by_count.length === 0 ? (
                <EmptyState title="No invoices in this period" />
              ) : (
                metrics.top_by_count.map((r) => (
                  <RankRow key={r.vendor} row={r} max={metrics.top_by_count[0].count} mode="count" />
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
