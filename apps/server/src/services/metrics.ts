import type {
  DashboardMetrics,
  FieldAccuracy,
  VendorMetrics,
  VolumeMetrics,
  WeeklyPoint,
} from '@finny/shared';
import { all, one } from '../db/db.js';
import { isoWeekLabel } from '../domain/util.js';

/**
 * Volume dashboard: how many invoices, worth how much, over a date range.
 * Dated by the printed invoice date when extraction found one, falling back
 * to the arrival date so no document ever drops out. Discarded documents
 * (statements, spam) are not invoices and are excluded.
 */
const EFFECTIVE_DATE = `COALESCE(invoice_date, DATE(received_at))`;
const VOLUME_BASE = `FROM invoices WHERE status != 'discarded' AND ${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} <= ?`;

/** yyyy-mm month label shifted by n months. */
function shiftMonth(month: string, n: number): string {
  let [y, m] = month.split('-').map(Number);
  m += n;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

function eachMonth(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const end = to.slice(0, 7);
  for (;;) {
    const label = `${y}-${String(m).padStart(2, '0')}`;
    out.push(label);
    if (label === end) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

export function volumeMetrics(from: string, to: string): VolumeMetrics {
  const totals = one<{ n: number; gross: number | null }>(
    `SELECT COUNT(*) AS n, SUM(gross_cents) AS gross ${VOLUME_BASE}`,
    from, to,
  );

  // The trend is always actual calendar months: the selected range's months,
  // extended back to at least the trailing twelve so a one-month selection
  // still shows a real time series. Totals and rankings stay on [from, to].
  const twelveBack = `${shiftMonth(to.slice(0, 7), -11)}-01`;
  const seriesFrom = from < twelveBack ? `${from.slice(0, 7)}-01` : twelveBack;
  const rows = all<{ b: string; n: number; gross: number | null }>(
    `SELECT substr(${EFFECTIVE_DATE}, 1, 7) AS b, COUNT(*) AS n, SUM(gross_cents) AS gross
     ${VOLUME_BASE} GROUP BY b ORDER BY b`,
    seriesFrom, to,
  );
  const byBucket = new Map(rows.map((r) => [String(r.b), r]));
  const series = eachMonth(seriesFrom, to).map((b) => {
    const r = byBucket.get(b);
    return { bucket: b, count: r ? Number(r.n) : 0, gross_cents: r ? Number(r.gross ?? 0) : 0 };
  });

  const topBy = (order: string) =>
    all<{ vendor: string; n: number; gross: number | null }>(
      `SELECT COALESCE(vendor_name, '(unknown vendor)') AS vendor, COUNT(*) AS n, SUM(gross_cents) AS gross
       ${VOLUME_BASE} GROUP BY vendor ORDER BY ${order} LIMIT 5`,
      from, to,
    ).map((r) => ({ vendor: r.vendor, count: Number(r.n), gross_cents: Number(r.gross ?? 0) }));

  return {
    from,
    to,
    bucket: 'month',
    series_from: seriesFrom,
    totals: { count: totals ? Number(totals.n) : 0, gross_cents: totals ? Number(totals.gross ?? 0) : 0 },
    series,
    top_by_value: topBy('gross DESC, n DESC'),
    top_by_count: topBy('n DESC, gross DESC'),
  };
}

function fieldAccuracy(fields: string[]): FieldAccuracy[] {
  const rows = all<{ field: string; n: number; m: number }>(
    `SELECT field, COUNT(*) AS n, SUM(matched) AS m FROM shadow_comparisons
     WHERE field IN (${fields.map(() => '?').join(',')}) GROUP BY field`,
    ...fields,
  );
  const byField = new Map(rows.map((r) => [r.field, r]));
  return fields.map((field) => {
    const r = byField.get(field);
    const samples = r ? Number(r.n) : 0;
    const matches = r ? Number(r.m) : 0;
    return { field, samples, matches, accuracy: samples > 0 ? matches / samples : 0 };
  });
}

export function dashboardMetrics(): DashboardMetrics {
  const extractionFields = [
    'vendor_name', 'invoice_ref', 'invoice_date', 'net_cents', 'vat_cents',
    'gross_cents', 'vat_rate', 'vat_number', 'po_number', 'entity', 'project',
  ];

  // Correction rate per week: share of reviewed invoices needing a routing fix.
  const reviewed = all<{ id: string; reviewed_at: string }>(
    `SELECT id, reviewed_at FROM invoices WHERE reviewed_at IS NOT NULL AND status != 'discarded'`,
  );
  const corrected = new Set(
    all<{ invoice_id: string }>(
      `SELECT DISTINCT invoice_id FROM corrections WHERE kind IN ('routing_category', 'routing_approver')`,
    ).map((r) => r.invoice_id),
  );
  const weekly = new Map<string, { corrected: number; total: number }>();
  for (const inv of reviewed) {
    const week = isoWeekLabel(inv.reviewed_at);
    const entry = weekly.get(week) ?? { corrected: 0, total: 0 };
    entry.total++;
    if (corrected.has(inv.id)) entry.corrected++;
    weekly.set(week, entry);
  }
  const correctionRateWeekly: WeeklyPoint[] = [...weekly.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, { corrected: c, total }]) => ({
      week,
      value: total > 0 ? c / total : 0,
      samples: total,
    }));

  const timing = one<{ avg_hours: number | null; n: number }>(
    `SELECT AVG((julianday(confirmed_at) - julianday(received_at)) * 24) AS avg_hours, COUNT(*) AS n
     FROM invoices WHERE confirmed_at IS NOT NULL`,
  );

  // Per-vendor: invoices reviewed, corrections, routing accuracy, rule coverage.
  const vendors = all<{ vendor: string; vendor_normalized: string; invoices: number }>(
    `SELECT COALESCE(vendor_name, '(unknown)') AS vendor, COALESCE(vendor_normalized, '') AS vendor_normalized,
            COUNT(*) AS invoices
     FROM invoices WHERE reviewed_at IS NOT NULL AND status != 'discarded'
     GROUP BY vendor_normalized ORDER BY invoices DESC LIMIT 30`,
  );
  const vendorBreakdown: VendorMetrics[] = vendors.map((v) => {
    const corrections = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM corrections c JOIN invoices i ON i.id = c.invoice_id
       WHERE i.vendor_normalized = ?`,
      v.vendor_normalized,
    );
    const routing = one<{ n: number; m: number }>(
      `SELECT COUNT(*) AS n, SUM(sc.matched) AS m FROM shadow_comparisons sc
       JOIN invoices i ON i.id = sc.invoice_id
       WHERE i.vendor_normalized = ? AND sc.field IN ('category', 'approver')`,
      v.vendor_normalized,
    );
    const hasRule = one(
      `SELECT 1 AS x FROM rules WHERE kind = 'routing' AND status = 'active' AND vendor_normalized = ?`,
      v.vendor_normalized,
    );
    const samples = routing ? Number(routing.n) : 0;
    return {
      vendor: v.vendor,
      invoices: Number(v.invoices),
      corrections: corrections ? Number(corrections.n) : 0,
      routing_accuracy: samples > 0 ? Number(routing!.m) / samples : null,
      has_rule: hasRule !== undefined,
    };
  });

  const stableRules = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM rules WHERE kind = 'routing' AND status = 'active' AND times_corrected = 0`,
  );
  const activeRules = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM rules WHERE kind = 'routing' AND status = 'active'`,
  );
  const liveConfirmed = one<{ n: number }>(`SELECT COUNT(*) AS n FROM invoices WHERE confirmed_at IS NOT NULL`);
  const shadowCompleted = one<{ n: number }>(`SELECT COUNT(*) AS n FROM invoices WHERE status = 'shadow_complete'`);

  return {
    shadow_field_accuracy: fieldAccuracy(extractionFields),
    routing_accuracy: fieldAccuracy(['category', 'approver']),
    correction_rate_weekly: correctionRateWeekly,
    avg_hours_to_process: timing && timing.n > 0 && timing.avg_hours !== null
      ? Math.round(Number(timing.avg_hours) * 10) / 10
      : null,
    invoices_processed: reviewed.length,
    live_confirmed: liveConfirmed ? Number(liveConfirmed.n) : 0,
    shadow_completed: shadowCompleted ? Number(shadowCompleted.n) : 0,
    vendor_breakdown: vendorBreakdown,
    stable_rules: stableRules ? Number(stableRules.n) : 0,
    active_rules: activeRules ? Number(activeRules.n) : 0,
  };
}
