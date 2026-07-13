import type { AuditEvent } from '@finny/shared';

/** Human labels for every audit event type the server writes. Types without
 *  an entry render as their raw slug, so a missing label is cosmetic only. */
export const AUDIT_LABELS: Record<string, string> = {
  received: 'Received',
  extraction_started: 'Extraction started',
  extraction_completed: 'Extracted',
  extraction_failed: 'Extraction failed',
  extraction_retry_requested: 'Extraction retry requested',
  duplicate_flagged: 'Flagged as possible duplicate',
  duplicate_override: 'Duplicate flag overridden',
  auto_filed: 'Auto-filed (no review needed)',
  fields_corrected: 'Fields corrected',
  shadow_logged: 'Shadow review logged',
  confirmed: 'Confirmed',
  discarded: 'Discarded',
  reopened: 'Reopened',
  rule_proposed: 'Routing rule proposed',
  rule_proposal_updated: 'Routing rule proposal updated',
  rule_auto_applied: 'Routing rule auto-applied',
  rule_approved: 'Routing rule approved',
  rule_rejected: 'Routing rule rejected',
  rule_created_manually: 'Routing rule created',
  rule_edited: 'Routing rule edited',
  rule_retired: 'Routing rule retired',
  approval_created: 'Sent for approval',
  approval_failed: 'Approval creation failed',
  approval_approved: 'Approved',
  approval_rejected: 'Rejected',
  sent_to_sage_batch: 'Added to Sage batch',
  sage_batch_generated: 'Sage batch generated',
  sage_batch_posted: 'Sage batch posted',
  sage_batch_imported: 'Sage batch marked imported',
  sage_batch_downloaded: 'Sage batch downloaded',
  posted_to_sage: 'Posted to Sage',
  posting_ref_reassigned: 'Posting ref reassigned',
  posting_sequence_adjusted: 'Posting sequence adjusted',
  linked_to_existing_sage_tx: 'Linked to existing Sage transaction',
  sage_nominals_pulled: 'Sage nominal codes pulled',
  alert_raised: 'Alert raised',
  alert_acknowledged: 'Alert acknowledged',
  alert_resolved: 'Alert resolved',
  alert_webhook_tested: 'Alert webhook tested',
  settings_changed: 'Settings changed',
  mode_changed: 'Mode changed',
  anthropic_key_changed: 'AI API key changed',
  approver_added: 'Approver added',
  approver_updated: 'Approver updated',
  approvers_synced: 'Approvers synced from M365',
  team_synced: 'Team synced from M365',
  team_role_changed: 'Team role changed',
  signed_in: 'Signed in',
  signed_out: 'Signed out',
  attachment_link_viewed: 'Attachment link viewed',
  attachment_links_revoked: 'Attachment links revoked',
  simulated_invoices: 'Simulated invoices',
  audit_exported: 'Audit log exported',
};

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Compact one-line rendering of an event's detail payload for the log table,
 *  e.g. "from: shadow · to: live". Empty string when there is no detail. */
export function detailSummary(ev: AuditEvent): string {
  const entries = Object.entries(ev.detail ?? {}).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '';
  const text = entries.map(([k, v]) => `${k}: ${fmtValue(v)}`).join(' · ');
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}
