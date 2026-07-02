import { beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb } from '../src/db/db.js';
import { seedDefaults, listApprovers, updateSettings } from '../src/services/settings.js';
import { decidePendingRule, findActiveRoutingRule, learnFromReview, listRules } from '../src/services/rules.js';
import { resolveRouting } from '../src/services/routing.js';
import { normalizeVendor } from '../src/domain/util.js';

const noAiProposal = { name: null, confidence: 0, rationale: 'none' };
const noAiApprover = { email_or_name: null, confidence: 0, rationale: 'none' };

describe('learned rules layer', () => {
  beforeEach(() => {
    closeDb();
    openDb(':memory:');
    seedDefaults();
  });

  it('a correction proposes a rule, the lead approves it, the next invoice auto-routes', () => {
    const approver = listApprovers()[0];

    // Review 1: human assigns category+approver for a new vendor -> proposal
    // (default settings: approver changes require AP Lead review).
    const first = learnFromReview({
      vendorName: 'Hegarty Steel Ltd',
      finalCategory: 'Materials',
      finalApproverId: approver.id,
      matchedRuleId: null,
      invoiceId: 'inv-1',
      who: 'amy@example.com',
    });
    expect(first.outcome).toBe('proposed');
    expect(findActiveRoutingRule(normalizeVendor('Hegarty Steel Ltd'))).toBeNull();

    // AP Lead approves the pending rule.
    const approved = decidePendingRule(first.ruleId!, 'approve', 'ap.lead@example.com');
    expect(approved?.status).toBe('active');

    // Next invoice from the vendor: routing resolves from the rule, not the AI.
    const decision = resolveRouting('HEGARTY STEEL LIMITED', normalizeVendor('HEGARTY STEEL LIMITED'), noAiProposal, noAiApprover);
    expect(decision.proposed_category).toBe('Materials');
    expect(decision.proposed_approver_id).toBe(approver.id);
    expect(decision.matched_rule_id).toBe(first.ruleId);
    expect(decision.routing_rationale).toContain('Learned rule');

    // Confirming without changes counts as a confirmation on the rule.
    const second = learnFromReview({
      vendorName: 'Hegarty Steel Ltd',
      finalCategory: 'Materials',
      finalApproverId: approver.id,
      matchedRuleId: first.ruleId!,
      invoiceId: 'inv-2',
      who: 'amy@example.com',
    });
    expect(second.outcome).toBe('confirmed_rule');
  });

  it('auto-applies when both change types are set to auto', () => {
    updateSettings({ rule_apply: { category: 'auto', approver: 'auto' } });
    const approver = listApprovers()[1];
    const result = learnFromReview({
      vendorName: 'MidWest Plant Hire',
      finalCategory: 'Plant & Equipment Hire',
      finalApproverId: approver.id,
      matchedRuleId: null,
      invoiceId: 'inv-3',
      who: 'amy@example.com',
    });
    expect(result.outcome).toBe('auto_applied');
    expect(findActiveRoutingRule(normalizeVendor('MidWest Plant Hire'))?.approver_id).toBe(approver.id);
  });

  it('a contradicting review supersedes the old rule and keeps one pending proposal per vendor', () => {
    updateSettings({ rule_apply: { category: 'auto', approver: 'auto' } });
    const [a1, a2] = listApprovers();
    const first = learnFromReview({
      vendorName: 'ESB Networks', finalCategory: 'Utilities', finalApproverId: a1.id,
      matchedRuleId: null, invoiceId: 'inv-4', who: 'amy@example.com',
    });
    expect(first.outcome).toBe('auto_applied');

    updateSettings({ rule_apply: { category: 'auto', approver: 'review' } });
    // Two corrections in a row: still exactly one pending proposal.
    learnFromReview({
      vendorName: 'ESB Networks', finalCategory: 'Utilities', finalApproverId: a2.id,
      matchedRuleId: first.ruleId!, invoiceId: 'inv-5', who: 'amy@example.com',
    });
    learnFromReview({
      vendorName: 'ESB Networks', finalCategory: 'Utilities', finalApproverId: a2.id,
      matchedRuleId: first.ruleId!, invoiceId: 'inv-6', who: 'amy@example.com',
    });
    const pending = listRules('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].approver_id).toBe(a2.id);
    // Old rule still active (and now marked corrected) until the lead decides.
    const active = findActiveRoutingRule(normalizeVendor('ESB Networks'));
    expect(active?.approver_id).toBe(a1.id);
    expect(active?.times_corrected).toBe(2);
  });
});
