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

/** "2026-08" -> "Aug-26". */
function monthLabel(bucket: string): string {
  const [y, m] = bucket.split('-').map(Number);
  // timeZone UTC: without it the label renders in local time and can show
  // the previous month for viewers west of UTC.
  const name = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IE', {
    month: 'short',
    timeZone: 'UTC',
  });
  return `${name}-${String(y).slice(2)}`;
}

/** €183,698.23 -> "€184k" — axis labels stay short. */
function eurosCompact(cents: number): string {
  const v = cents / 100;
  if (v >= 1_000_000) return `€${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `€${Math.round(v / 1000)}k`;
  if (v >= 1_000) return `€${(v / 1000).toFixed(1)}k`;
  return `€${Math.round(v)}`;
}

/**
 * Catmull-Rom smoothing as cubic Béziers, with control points clamped to the
 * plot band so the curve never overshoots below the axis on hard zeros.
 */
function smoothPath(pts: { x: number; y: number }[], yTop: number, yBottom: number): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  const clamp = (v: number) => Math.max(yTop, Math.min(yBottom, v));
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const t = 1 / 6;
    const c1x = p1.x + (p2.x - p0.x) * t;
    const c1y = clamp(p1.y + (p2.y - p0.y) * t);
    const c2x = p2.x - (p3.x - p1.x) * t;
    const c2y = clamp(p2.y - (p3.y - p1.y) * t);
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

/** Dual-series chart: bars = value per month, smooth line = invoice count. */
function VolumeTrend({ metrics }: { metrics: VolumeMetrics }) {
  const series = metrics.series;
  const hasAny = series.some((p) => p.count > 0);
  if (series.length === 0 || !hasAny) {
    return <EmptyState title="No invoices in or before this period" hint="Try a different range." />;
  }
  // Months inside the selected range render brighter than the trailing context.
  const inRange = (b: string) => b >= metrics.from.slice(0, 7) && b <= metrics.to.slice(0, 7);
  const w = 680;
  const h = 235;
  const pad = { l: 52, r: 34, t: 16, b: 32 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const maxGross = Math.max(...series.map((p) => p.gross_cents), 1);
  const maxCount = Math.max(...series.map((p) => p.count), 1);
  const slot = innerW / series.length;
  const barW = Math.max(4, Math.min(38, slot * 0.58));
  const x = (i: number) => pad.l + slot * i + slot / 2;
  const yGross = (v: number) => pad.t + innerH - (v / maxGross) * innerH;
  const yCount = (v: number) => pad.t + innerH - (v / maxCount) * innerH;
  const baseline = h - pad.b;
  const tickStep = Math.max(1, Math.ceil(series.length / 10));
  const showDots = series.length <= 45;
  const line = smoothPath(series.map((p, i) => ({ x: x(i), y: yCount(p.count) })), pad.t, baseline);
  const midCount = Math.ceil(maxCount / 2);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="trend volume-trend" role="img" aria-label="Invoice count and value trend">
      {/* Value gridlines with compact € labels (left) and count labels (right). */}
      {[0.5, 1].map((f) => (
        <g key={f}>
          <line x1={pad.l} y1={yGross(maxGross * f)} x2={w - pad.r} y2={yGross(maxGross * f)} className="volume-grid" />
          <text x={pad.l - 7} y={yGross(maxGross * f) + 4} textAnchor="end" className="volume-axis-label">
            {eurosCompact(maxGross * f)}
          </text>
        </g>
      ))}
      <text x={w - pad.r + 7} y={yCount(maxCount) + 4} textAnchor="start" className="volume-axis-label volume-axis-count">
        {maxCount}
      </text>
      {midCount !== maxCount && (
        <text x={w - pad.r + 7} y={yCount(midCount) + 4} textAnchor="start" className="volume-axis-label volume-axis-count">
          {midCount}
        </text>
      )}
      <line x1={pad.l} y1={baseline} x2={w - pad.r} y2={baseline} className="trend-axis" />

      {series.map((p, i) => (
        <rect
          key={p.bucket}
          x={x(i) - barW / 2}
          y={yGross(p.gross_cents)}
          width={barW}
          height={Math.max(0, baseline - yGross(p.gross_cents))}
          rx={Math.min(4, barW / 3)}
          className={`volume-bar ${inRange(p.bucket) ? 'volume-bar-selected' : ''}`}
        >
          <title>{`${monthLabel(p.bucket)}: ${euros(p.gross_cents)} across ${p.count} invoice${p.count === 1 ? '' : 's'}`}</title>
        </rect>
      ))}
      <path d={line} className="volume-count-line" fill="none" />
      {series.map((p, i) => (
        <g key={`c-${p.bucket}`}>
          {showDots && (
            <circle cx={x(i)} cy={yCount(p.count)} r={4} className="volume-count-dot">
              <title>{`${monthLabel(p.bucket)}: ${p.count} invoice${p.count === 1 ? '' : 's'}`}</title>
            </circle>
          )}
          {(series.length - 1 - i) % tickStep === 0 && (
            <text x={x(i)} y={h - 9} textAnchor="middle" className="trend-tick volume-tick">
              {monthLabel(p.bucket)}
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
              Bars are value (€); the line is the number of invoices — by calendar month, with the
              trailing year for context. The brighter bars are the selected period.
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
