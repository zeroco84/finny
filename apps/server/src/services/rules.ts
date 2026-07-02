import type { Rule, RuleStatus } from '@finny/shared';
import { all, one, run } from '../db/db.js';
import { newId, normalizeVendor, nowIso } from '../domain/util.js';
import { getSettings } from './settings.js';
import { audit } from './audit.js';

function mapRule(r: Record<string, unknown>): Rule {
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    id: String(r.id),
    kind: r.kind as Rule['kind'],
    vendor_pattern: String(r.vendor_pattern),
    vendor_normalized: String(r.vendor_normalized),
    category: s(r.category),
    approver_id: s(r.approver_id),
    hint_text: s(r.hint_text),
    status: r.status as RuleStatus,
    origin: r.origin as Rule['origin'],
    created_by: String(r.created_by),
    created_at: String(r.created_at),
    decided_by: s(r.decided_by),
    decided_at: s(r.decided_at),
    source_invoice_id: s(r.source_invoice_id),
    supersedes_rule_id: s(r.supersedes_rule_id),
    times_applied: Number(r.times_applied),
    times_confirmed: Number(r.times_confirmed),
    times_corrected: Number(r.times_corrected),
    notes: s(r.notes),
    updated_at: String(r.updated_at),
  };
}

export function listRules(status?: RuleStatus): Rule[] {
  const rows = status
    ? all('SELECT * FROM rules WHERE status = ? ORDER BY updated_at DESC', status)
    : all('SELECT * FROM rules ORDER BY updated_at DESC');
  return rows.map(mapRule);
}

export function getRule(id: string): Rule | null {
  const row = one('SELECT * FROM rules WHERE id = ?', id);
  return row ? mapRule(row) : null;
}

export function findActiveRoutingRule(vendorNormalized: string | null): Rule | null {
  if (!vendorNormalized) return null;
  const row = one(
    `SELECT * FROM rules WHERE kind = 'routing' AND status = 'active' AND vendor_normalized = ? LIMIT 1`,
    vendorNormalized,
  );
  return row ? mapRule(row) : null;
}

export function findExtractionHints(vendorNormalized: string | null): Rule[] {
  if (!vendorNormalized) return [];
  return all(
    `SELECT * FROM rules WHERE kind = 'extraction_hint' AND status = 'active' AND vendor_normalized = ?`,
    vendorNormalized,
  ).map(mapRule);
}

export function bumpRuleStat(ruleId: string, stat: 'times_applied' | 'times_confirmed' | 'times_corrected'): void {
  run(`UPDATE rules SET ${stat} = ${stat} + 1, updated_at = ? WHERE id = ?`, nowIso(), ruleId);
}

interface RuleValues {
  vendor: string;
  category: string;
  approverId: string;
}

function insertRule(
  values: RuleValues,
  status: 'pending' | 'active',
  origin: 'correction' | 'manual',
  who: string,
  sourceInvoiceId: string | null,
  supersedesRuleId: string | null,
  notes: string | null,
): string {
  const id = newId();
  const now = nowIso();
  run(
    `INSERT INTO rules (id, kind, vendor_pattern, vendor_normalized, category, approver_id, status, origin,
       created_by, created_at, source_invoice_id, supersedes_rule_id, notes, updated_at, decided_by, decided_at)
     VALUES (?, 'routing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    values.vendor,
    normalizeVendor(values.vendor),
    values.category,
    values.approverId,
    status,
    origin,
    who,
    now,
    sourceInvoiceId,
    supersedesRuleId,
    notes,
    now,
    status === 'active' ? who : null,
    status === 'active' ? now : null,
  );
  return id;
}

/**
 * Learn from a completed review. Called with the final (human-confirmed)
 * category + approver for the invoice's vendor.
 *
 * - Matching active rule confirmed -> bump stats.
 * - Active rule contradicted, or no rule yet -> create/refresh a proposal.
 *   Whether the proposal goes live immediately depends on the per-type
 *   apply mode in settings (spec: category/approver each auto vs review).
 */
export function learnFromReview(opts: {
  vendorName: string;
  finalCategory: string;
  finalApproverId: string;
  matchedRuleId: string | null;
  invoiceId: string;
  who: string;
}): { outcome: 'confirmed_rule' | 'proposed' | 'auto_applied' | 'noop'; ruleId?: string } {
  const vendorNormalized = normalizeVendor(opts.vendorName);
  if (!vendorNormalized) return { outcome: 'noop' };

  const active =
    (opts.matchedRuleId ? getRule(opts.matchedRuleId) : null) ??
    findActiveRoutingRule(vendorNormalized);

  if (
    active &&
    active.status === 'active' &&
    active.category === opts.finalCategory &&
    active.approver_id === opts.finalApproverId
  ) {
    bumpRuleStat(active.id, 'times_confirmed');
    return { outcome: 'confirmed_rule', ruleId: active.id };
  }

  const settings = getSettings();
  const categoryChanged = !active || active.category !== opts.finalCategory;
  const approverChanged = !active || active.approver_id !== opts.finalApproverId;
  // Strictest mode wins: if any changed part requires review, the whole
  // proposal waits for the AP Lead.
  const needsReview =
    (categoryChanged && settings.rule_apply.category === 'review') ||
    (approverChanged && settings.rule_apply.approver === 'review');

  if (active && active.status === 'active') bumpRuleStat(active.id, 'times_corrected');

  const values: RuleValues = {
    vendor: opts.vendorName,
    category: opts.finalCategory,
    approverId: opts.finalApproverId,
  };

  // Refresh an existing pending proposal for this vendor instead of stacking
  // duplicates — the latest correction wins, with a note of how often seen.
  const pending = one(
    `SELECT * FROM rules WHERE kind = 'routing' AND status = 'pending' AND vendor_normalized = ? LIMIT 1`,
    vendorNormalized,
  );

  if (!needsReview) {
    if (active && active.status === 'active') {
      run(`UPDATE rules SET status = 'retired', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`,
        'system (superseded)', nowIso(), nowIso(), active.id);
    }
    if (pending) {
      run(`UPDATE rules SET status = 'rejected', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`,
        'system (superseded by auto-applied rule)', nowIso(), nowIso(), String(pending.id));
    }
    const ruleId = insertRule(values, 'active', 'correction', opts.who, opts.invoiceId,
      active ? active.id : null, 'Auto-applied from a review correction');
    audit(opts.invoiceId, 'rule_auto_applied', opts.who, {
      rule_id: ruleId, vendor: opts.vendorName, category: values.category, approver_id: values.approverId,
    });
    return { outcome: 'auto_applied', ruleId };
  }

  if (pending) {
    const seen = Number(one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM corrections WHERE invoice_id = ?`, opts.invoiceId)?.n ?? 0);
    run(
      `UPDATE rules SET category = ?, approver_id = ?, vendor_pattern = ?, source_invoice_id = ?,
         notes = ?, updated_at = ? WHERE id = ?`,
      values.category,
      values.approverId,
      values.vendor,
      opts.invoiceId,
      `Updated by a later review${seen ? '' : ''} — awaiting AP Lead approval`,
      nowIso(),
      String(pending.id),
    );
    audit(opts.invoiceId, 'rule_proposal_updated', opts.who, { rule_id: String(pending.id) });
    return { outcome: 'proposed', ruleId: String(pending.id) };
  }

  const ruleId = insertRule(values, 'pending', 'correction', opts.who, opts.invoiceId,
    active ? active.id : null, 'Learned from a review — awaiting AP Lead approval');
  audit(opts.invoiceId, 'rule_proposed', opts.who, {
    rule_id: ruleId, vendor: opts.vendorName, category: values.category, approver_id: values.approverId,
  });
  return { outcome: 'proposed', ruleId };
}

export function decidePendingRule(id: string, decision: 'approve' | 'reject', who: string): Rule | null {
  const rule = getRule(id);
  if (!rule || rule.status !== 'pending') return null;
  const now = nowIso();
  if (decision === 'approve') {
    // Retire whatever active rule this replaces.
    const active = findActiveRoutingRule(rule.vendor_normalized);
    if (active && active.id !== rule.id) {
      run(`UPDATE rules SET status = 'retired', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`,
        `${who} (superseded)`, now, now, active.id);
    }
    run(`UPDATE rules SET status = 'active', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`,
      who, now, now, id);
    audit(rule.source_invoice_id, 'rule_approved', who, { rule_id: id, vendor: rule.vendor_pattern });
  } else {
    run(`UPDATE rules SET status = 'rejected', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`,
      who, now, now, id);
    audit(rule.source_invoice_id, 'rule_rejected', who, { rule_id: id, vendor: rule.vendor_pattern });
  }
  return getRule(id);
}

export function createManualRule(opts: {
  kind: 'routing' | 'extraction_hint';
  vendor: string;
  category?: string | null;
  approverId?: string | null;
  hintText?: string | null;
  who: string;
}): Rule {
  const id = newId();
  const now = nowIso();
  if (opts.kind === 'routing') {
    const active = findActiveRoutingRule(normalizeVendor(opts.vendor));
    if (active) {
      run(`UPDATE rules SET status = 'retired', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`,
        `${opts.who} (superseded)`, now, now, active.id);
    }
  }
  run(
    `INSERT INTO rules (id, kind, vendor_pattern, vendor_normalized, category, approver_id, hint_text,
       status, origin, created_by, created_at, decided_by, decided_at, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'manual', ?, ?, ?, ?, ?, ?)`,
    id,
    opts.kind,
    opts.vendor,
    normalizeVendor(opts.vendor),
    opts.category ?? null,
    opts.approverId ?? null,
    opts.hintText ?? null,
    opts.who,
    now,
    opts.who,
    now,
    'Created manually',
    now,
  );
  audit(null, 'rule_created_manually', opts.who, { rule_id: id, vendor: opts.vendor, kind: opts.kind });
  return getRule(id)!;
}

export function updateRule(
  id: string,
  patch: { category?: string | null; approver_id?: string | null; hint_text?: string | null; vendor_pattern?: string },
  who: string,
): Rule | null {
  const rule = getRule(id);
  if (!rule) return null;
  run(
    `UPDATE rules SET category = ?, approver_id = ?, hint_text = ?, vendor_pattern = ?, vendor_normalized = ?, updated_at = ? WHERE id = ?`,
    patch.category !== undefined ? patch.category : rule.category,
    patch.approver_id !== undefined ? patch.approver_id : rule.approver_id,
    patch.hint_text !== undefined ? patch.hint_text : rule.hint_text,
    patch.vendor_pattern ?? rule.vendor_pattern,
    normalizeVendor(patch.vendor_pattern ?? rule.vendor_pattern),
    nowIso(),
    id,
  );
  audit(null, 'rule_edited', who, { rule_id: id });
  return getRule(id);
}

export function retireRule(id: string, who: string): Rule | null {
  const rule = getRule(id);
  if (!rule) return null;
  run(`UPDATE rules SET status = 'retired', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`,
    who, nowIso(), nowIso(), id);
  audit(null, 'rule_retired', who, { rule_id: id, vendor: rule.vendor_pattern });
  return getRule(id);
}

export function pendingRuleCount(): number {
  const row = one<{ n: number }>(`SELECT COUNT(*) AS n FROM rules WHERE status = 'pending'`);
  return row ? Number(row.n) : 0;
}
