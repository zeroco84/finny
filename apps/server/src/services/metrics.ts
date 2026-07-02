import type { DashboardMetrics, FieldAccuracy, VendorMetrics, WeeklyPoint } from '@finny/shared';
import { all, one } from '../db/db.js';
import { isoWeekLabel } from '../domain/util.js';

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
    'gross_cents', 'vat_rate', 'vat_number', 'po_number',
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
