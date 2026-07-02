import type { ReactNode } from 'react';
import { STATUS_LABELS, pct } from '../format';

export function StatusChip({ status, shadow }: { status: string; shadow?: boolean }) {
  return (
    <span className={`chip status-${status}`}>
      {STATUS_LABELS[status] ?? status}
      {shadow && status !== 'shadow_complete' ? ' · shadow' : ''}
    </span>
  );
}

/** Colour-coded confidence: green ≥ threshold, amber below, red missing. */
export function ConfidenceBadge({
  value,
  threshold,
}: {
  value: number | null | undefined;
  threshold: number;
}) {
  if (value === null || value === undefined) return null;
  const level = value <= 0 ? 'missing' : value < threshold ? 'low' : 'ok';
  const label = value <= 0 ? 'not found' : pct(value);
  return (
    <span className={`conf conf-${level}`} title={`AI confidence ${pct(value)} (review threshold ${pct(threshold)})`}>
      {label}
    </span>
  );
}

export function Banner({
  kind,
  children,
}: {
  kind: 'warn' | 'error' | 'info' | 'success';
  children: ReactNode;
}) {
  return <div className={`banner banner-${kind}`}>{children}</div>;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty-state">
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
    </div>
  );
}

/** Horizontal accuracy bar with an optional target line. */
export function BarRow({
  label,
  value,
  samples,
  target,
}: {
  label: string;
  value: number;
  samples: number;
  target?: number;
}) {
  const width = Math.max(0, Math.min(1, value)) * 100;
  const met = target === undefined || value >= target;
  return (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <div className="bar-track">
        <div className={`bar-fill ${met ? 'bar-ok' : 'bar-low'}`} style={{ width: `${width}%` }} />
        {target !== undefined && <div className="bar-target" style={{ left: `${target * 100}%` }} />}
      </div>
      <span className="bar-value">
        {samples > 0 ? pct(value) : '—'} <small>({samples})</small>
      </span>
    </div>
  );
}

/** Tiny SVG line chart for weekly trends. */
export function TrendLine({ points }: { points: { week: string; value: number; samples: number }[] }) {
  if (points.length === 0) return <EmptyState title="No data yet" hint="Complete some reviews to build the trend." />;
  const w = 460;
  const h = 120;
  const pad = 24;
  const xs = (i: number) => pad + (points.length === 1 ? (w - 2 * pad) / 2 : (i / (points.length - 1)) * (w - 2 * pad));
  const ys = (v: number) => h - pad - Math.max(0, Math.min(1, v)) * (h - 2 * pad);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)},${ys(p.value).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="trend" role="img" aria-label="Correction rate trend">
      <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} className="trend-axis" />
      <line x1={pad} y1={pad} x2={pad} y2={h - pad} className="trend-axis" />
      <path d={path} className="trend-line" fill="none" />
      {points.map((p, i) => (
        <g key={p.week}>
          <circle cx={xs(i)} cy={ys(p.value)} r={3.5} className="trend-dot">
            <title>{`${p.week}: ${pct(p.value)} of ${p.samples} invoices needed a routing fix`}</title>
          </circle>
          <text x={xs(i)} y={h - 8} textAnchor="middle" className="trend-tick">
            {p.week.slice(5)}
          </text>
        </g>
      ))}
    </svg>
  );
}
