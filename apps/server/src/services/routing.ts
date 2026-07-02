import { findActiveRoutingRule, bumpRuleStat } from './rules.js';
import { findApproverByEmailOrName, getApprover, getSettings } from './settings.js';

export interface RoutingDecision {
  proposed_category: string | null;
  proposed_approver_id: string | null;
  routing_confidence: number | null;
  routing_rationale: string;
  matched_rule_id: string | null;
}

/**
 * Deterministic rules first, model suggestion second (spec: learned rules —
 * inspectable and reviewable — are the routing authority; the LLM only fills
 * the cold-start gap).
 */
export function resolveRouting(
  vendorName: string | null,
  vendorNormalized: string | null,
  llmCategory: { name: string | null; confidence: number; rationale: string },
  llmApprover: { email_or_name: string | null; confidence: number; rationale: string },
): RoutingDecision {
  const settings = getSettings();
  const rule = findActiveRoutingRule(vendorNormalized);

  if (rule && rule.category && rule.approver_id) {
    bumpRuleStat(rule.id, 'times_applied');
    const approver = getApprover(rule.approver_id);
    const total = rule.times_confirmed + rule.times_corrected;
    const history =
      total > 0
        ? `matched ${rule.times_confirmed}/${total} times previously`
        : 'no review history yet';
    const confidence = Math.min(0.98, 0.85 + rule.times_confirmed * 0.01);
    return {
      proposed_category: rule.category,
      proposed_approver_id: rule.approver_id,
      routing_confidence: confidence,
      routing_rationale: `Learned rule: ${rule.vendor_pattern} → ${rule.category} → ${approver?.name ?? 'unknown approver'} (${history}).`,
      matched_rule_id: rule.id,
    };
  }

  const validCategory =
    llmCategory.name && settings.categories.some((c) => c.name === llmCategory.name)
      ? llmCategory.name
      : null;
  const approver = findApproverByEmailOrName(llmApprover.email_or_name);

  if (!validCategory && !approver) {
    return {
      proposed_category: null,
      proposed_approver_id: null,
      routing_confidence: null,
      routing_rationale:
        'No learned rule for this vendor and no confident AI proposal — assign a category and approver manually. Your choice becomes a rule the AI applies next time.',
      matched_rule_id: null,
    };
  }

  const parts: string[] = ['AI suggestion — no learned rule for this vendor yet.'];
  if (validCategory) parts.push(`Category: ${llmCategory.rationale}`);
  if (approver) parts.push(`Approver: ${llmApprover.rationale}`);
  const confidence = Math.max(
    validCategory ? llmCategory.confidence : 0,
    approver ? llmApprover.confidence : 0,
  );

  return {
    proposed_category: validCategory,
    proposed_approver_id: approver?.id ?? null,
    routing_confidence: Math.max(0, Math.min(1, confidence)),
    routing_rationale: parts.join(' '),
    matched_rule_id: null,
  };
}
