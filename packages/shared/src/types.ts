// Shared domain types for Finny. The server is the source of truth; the web
// app consumes these shapes over the JSON API.

export type InvoiceStatus =
  | 'received'
  | 'extracting'
  | 'extraction_failed'
  | 'needs_review'
  | 'shadow_complete'
  | 'confirmed'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'discarded';

export type DocType = 'invoice' | 'payment_recommendation' | 'statement' | 'remittance' | 'other' | null;

/** Extraction fields that carry a per-field confidence score. */
export const CONFIDENCE_FIELDS = [
  'vendor_name',
  'invoice_ref',
  'invoice_date',
  'due_date',
  'net',
  'vat',
  'gross',
  'vat_rate',
  'vat_number',
  'po_number',
  'entity',
  'project',
] as const;
export type ConfidenceField = (typeof CONFIDENCE_FIELDS)[number];

/** Fields required before an invoice can be confirmed (per spec: amount, vendor, ref). */
export const REQUIRED_FIELDS: ConfidenceField[] = ['vendor_name', 'invoice_ref', 'gross'];

export interface LineItem {
  description: string;
  quantity: number | null;
  unit_cents: number | null;
  total_cents: number | null;
}

/** Immutable snapshot of what the AI proposed, kept for corrections/metrics. */
export interface ExtractionSnapshot {
  vendor_name: string | null;
  invoice_ref: string | null;
  invoice_date: string | null; // yyyy-mm-dd
  due_date: string | null; // yyyy-mm-dd payment due date, when stated
  net_cents: number | null;
  vat_cents: number | null;
  gross_cents: number | null;
  vat_rate: number | null; // percent
  vat_number: string | null;
  po_number: string | null;
  /** Which legal entity the invoice is addressed to. */
  entity: string | null;
  /** Project code the document references (from the configured project list). */
  project_code: string | null;
  category: string | null;
  approver_id: string | null;
}

export interface Project {
  name: string;
  code: string; // short code shown in Finny and used in Details
  dept: string; // Sage department number for this site/development (Dept column)
  /** Legal entity this project belongs to — one entity runs many projects.
   *  '' = not yet assigned (legacy rows); usable with any entity until assigned. */
  entity: string;
}

export interface Approver {
  id: string;
  name: string;
  email: string;
  teams_user_id: string | null;
  active: boolean;
  /** 'manual' = added in Settings; 'graph' = synced from the M365 approvers group. */
  source: 'manual' | 'graph';
}

/** Result of POST /approvers/sync — what the M365 pull changed. */
export interface ApproverSyncResult {
  provider: 'mock' | 'graph';
  group_configured: boolean;
  summary: { added: number; updated: number; deactivated: number };
}

/** GET /approvers/directory — whether the approvers sync is backed by real M365. */
export interface ApproverDirectory {
  provider: 'mock' | 'graph';
  group_configured: boolean;
}

export interface Category {
  name: string;
  nominal_code: string;
}

export interface InvoiceSummary {
  id: string;
  status: InvoiceStatus;
  shadow: boolean;
  vendor_name: string | null;
  invoice_ref: string | null;
  invoice_date: string | null;
  due_date: string | null;
  gross_cents: number | null;
  currency: string;
  proposed_category: string | null;
  category: string | null;
  approver_id: string | null;
  proposed_approver_id: string | null;
  entity: string | null;
  project_code: string | null;
  routing_confidence: number | null;
  min_required_confidence: number | null; // lowest confidence among required fields
  duplicate_of: string | null;
  doc_type: DocType;
  received_at: string;
  email_from: string | null;
  email_subject: string | null;
  attachment_name: string | null;
  sage_batch_id: string | null;
  updated_at: string;
}

export interface AuditEvent {
  id: string;
  invoice_id: string | null;
  type: string;
  actor: string;
  detail: Record<string, unknown>;
  created_at: string;
}

/** One row of the global audit log (AP Lead view) — the event plus display
 *  context joined from the linked invoice, when there is one. */
export interface AuditLogEvent extends AuditEvent {
  entity: string | null;
  vendor_name: string | null;
}

/** Filters accepted by GET /audit (all optional; dates are yyyy-mm-dd, inclusive). */
export interface AuditLogQuery {
  actor?: string;
  type?: string;
  entity?: string;
  invoice_id?: string;
  q?: string;
  from?: string;
  to?: string;
}

/** One page of GET /audit. `next_cursor` feeds the `before` param of the next
 *  request; null when there are no older events. */
export interface AuditLogPage {
  events: AuditLogEvent[];
  total: number;
  next_cursor: string | null;
}

/** GET /audit/filters — distinct values for the filter dropdowns. */
export interface AuditLogFilterOptions {
  actors: string[];
  types: string[];
}

export interface Correction {
  id: string;
  invoice_id: string;
  kind: 'extraction' | 'routing_category' | 'routing_approver';
  field: string;
  old_value: string | null;
  new_value: string | null;
  corrected_by: string;
  created_at: string;
}

export interface ApprovalRequest {
  id: string;
  invoice_id: string;
  approver_id: string;
  provider: 'mock' | 'graph';
  external_id: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'failed';
  error: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by_name: string | null;
  decision_note: string | null;
}

export interface InvoiceDetail extends InvoiceSummary {
  source: string;
  email_message_id: string | null;
  attachment_mime: string | null;
  net_cents: number | null;
  vat_cents: number | null;
  vat_rate: number | null;
  vat_number: string | null;
  po_number: string | null;
  supplier_account_ref: string | null;
  line_items: LineItem[];
  field_confidence: Partial<Record<ConfidenceField, number>>;
  extraction_snapshot: ExtractionSnapshot | null;
  extraction_error: string | null;
  extraction_provider: string | null;
  routing_rationale: string | null;
  matched_rule_id: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  confirmed_at: string | null;
  discarded_reason: string | null;
  audit: AuditEvent[];
  corrections: Correction[];
  approval: ApprovalRequest | null;
  duplicate_summary: { id: string; status: InvoiceStatus; received_at: string } | null;
}

export type RuleKind = 'routing' | 'extraction_hint';
export type RuleStatus = 'pending' | 'active' | 'rejected' | 'retired';

export interface Rule {
  id: string;
  kind: RuleKind;
  vendor_pattern: string; // display form of the vendor name
  vendor_normalized: string;
  category: string | null;
  approver_id: string | null;
  hint_text: string | null;
  status: RuleStatus;
  origin: 'correction' | 'manual';
  created_by: string;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  source_invoice_id: string | null;
  times_applied: number;
  times_confirmed: number;
  times_corrected: number;
  notes: string | null;
  updated_at: string;
  /** For pending proposals that modify an existing active rule. */
  supersedes_rule_id: string | null;
}

export type AlertType =
  | 'unreadable_attachment'
  | 'extraction_failure'
  | 'low_confidence_sla'
  | 'sage_export_failure'
  | 'sage_duplicate_detected'
  | 'sage_sequence_adjusted'
  | 'teams_api_failure'
  | 'mailbox_auth_failure';

export interface Alert {
  id: string;
  type: AlertType;
  severity: 'warning' | 'critical';
  invoice_id: string | null;
  subject: string;
  message: string;
  next_step: string;
  status: 'open' | 'acknowledged' | 'resolved';
  created_at: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  /** Notification delivery: `sent` to the Teams webhook, `failed`, or `logged`
   *  (stored only — no webhook configured). */
  delivery_target: string | null; // the Teams webhook host, or null
  delivery_status: 'sent' | 'logged' | 'failed';
  delivery_error: string | null;
  delivery_at: string | null;
}

// ── Notification subscriptions (per-user event webhooks) ─────────────────────
// Distinct from the single operational-alert webhook: any user subscribes their
// OWN Teams chat/channel to invoices matching criteria they choose. Evaluated
// when an invoice arrives (extraction completes and it enters the review queue).

/** The four event categories a subscription can watch for. */
export type WebhookEventType =
  | 'amount_threshold'
  | 'date_threshold'
  | 'supplier_match'
  | 'project_match';

/** Fire when an invoice's gross is at or above `min_cents`. */
export interface AmountThresholdParams {
  min_cents: number;
}

/** Fire on out-of-range dates. Any enabled condition triggers a match. */
export interface DateThresholdParams {
  /** Invoice dated after it arrived (future/post-dated). */
  postdated?: boolean;
  /** Invoice dated more than this many days before it arrived (stale/back-dated). */
  stale_days?: number | null;
  /** Payment due date falls within this many days (includes already-overdue). */
  due_within_days?: number | null;
}

/** Fire on invoices from a supplier whose name fuzzy-matches `query`. */
export interface SupplierMatchParams {
  query: string;
}

/** Fire on invoices referencing a project whose name or code fuzzy-matches `query`. */
export interface ProjectMatchParams {
  query: string;
}

export type WebhookSubscriptionParams =
  | AmountThresholdParams
  | DateThresholdParams
  | SupplierMatchParams
  | ProjectMatchParams;

/**
 * One subscription as returned to the client. The target webhook URL embeds a
 * secret token, so it is never returned — only its host. Visible only to the
 * user who owns it.
 */
export interface WebhookSubscription {
  id: string;
  label: string;
  event_type: WebhookEventType;
  params: WebhookSubscriptionParams;
  active: boolean;
  /** Host of the target Teams webhook (never the secret token in the path). */
  webhook_host: string;
  created_at: string;
  updated_at: string;
  last_fired_at: string | null;
}

/** Create/update payload. `webhook_url` is write-only; omit on update to keep the current one. */
export interface WebhookSubscriptionInput {
  label: string;
  event_type: WebhookEventType;
  params: WebhookSubscriptionParams;
  active?: boolean;
  /** Teams Incoming-Webhook URL to POST to. Required on create; optional on update. */
  webhook_url?: string;
}

export interface SageBatch {
  id: string;
  created_by: string;
  created_at: string;
  /** Legal entity this batch belongs to — one Sage company dataset per batch. */
  entity: string | null;
  filename: string;
  invoice_count: number;
  total_gross_cents: number;
  /** posted = pushed into Sage via the HyperAccounts API (one-touch mode). */
  status: 'generated' | 'posted' | 'marked_imported';
  /** Invoices in this batch already carrying a Sage transaction number. */
  posted_count: number;
  marked_imported_by: string | null;
  marked_imported_at: string | null;
}

export interface Settings {
  mode: 'shadow' | 'live';
  /** Claude model id used for AI extraction (empty = the deployment default).
   *  Picked by the AP Lead in Settings — the API key is set there too but is
   *  write-only and never returned in this object. */
  extraction_model: string;
  confidence_threshold: number; // 0..1 — below this a field is flagged
  review_sla_hours: number; // low-confidence invoice untouched this long -> alert
  /** Teams-subscribable Incoming Webhook URL alerts are POSTed to (empty = alerts
   *  are stored and shown in the UI only). */
  alert_webhook_url: string;
  categories: Category[];
  /** Legal entities invoices may be addressed to (each = a Sage company dataset). */
  entities: string[];
  projects: Project[];
  tax_codes: Record<string, string>; // vat rate (as string, e.g. "23") -> Sage tax code
  default_tax_code: string;
  sage_department: string; // fallback Dept when an invoice has no project
  /** Next internal posting reference number (the sheet's sequential "Inv27xxx" Ref column). */
  next_posting_ref: number;
  rule_apply: { category: 'auto' | 'review'; approver: 'auto' | 'review' };
}

/** One model returned by GET /models (the Anthropic /v1/models list). */
export interface AiModel {
  id: string;
  display_name: string;
}

export interface ConnectorStatus {
  mail_provider: string;
  extraction_provider: string;
  /** Claude model AI extraction will use (the effective value). */
  extraction_model: string;
  /** Whether an Anthropic API key is configured, and where from. */
  anthropic_key_set: boolean;
  anthropic_key_source: 'settings' | 'env' | 'none';
  approvals_provider: string;
  /** How failure alerts are delivered: 'webhook' (Teams) or 'off'. */
  alerts_channel: string;
  /** Host of the configured webhook (never the secret token), or null. */
  alert_webhook_host: string | null;
  auth_provider: string;
  /** csv = manual batch import; hyperaccounts = one-touch API posting into Sage 50. */
  sage_provider: string;
  /** Entities with a HyperAccounts server configured ('*' = default server for all). */
  sage_entities: string[];
  mail_last_poll: string | null;
  mail_last_error: string | null;
  approvals_last_poll: string | null;
  approvals_last_error: string | null;
}

export interface Overview {
  mode: 'shadow' | 'live';
  counts: {
    needs_review: number;
    failed: number;
    awaiting_approval: number;
    completed: number;
    open_alerts: number;
    pending_rules: number;
    export_pool: number;
  };
  simulator_enabled: boolean;
  approvals_simulator_enabled: boolean;
}

export interface FieldAccuracy {
  field: string;
  samples: number;
  matches: number;
  accuracy: number; // 0..1
}

export interface WeeklyPoint {
  week: string; // ISO week label e.g. "2026-W26"
  value: number;
  samples: number;
}

export interface VendorMetrics {
  vendor: string;
  invoices: number;
  corrections: number;
  routing_accuracy: number | null;
  has_rule: boolean;
}

export interface DashboardMetrics {
  shadow_field_accuracy: FieldAccuracy[];
  routing_accuracy: FieldAccuracy[]; // category + approver rows
  correction_rate_weekly: WeeklyPoint[];
  avg_hours_to_process: number | null;
  invoices_processed: number;
  live_confirmed: number;
  shadow_completed: number;
  vendor_breakdown: VendorMetrics[];
  stable_rules: number; // active routing rules with zero corrections
  active_rules: number;
}

/** One vendor's share of the volume dashboard's selected period. */
export interface VendorVolume {
  vendor: string;
  count: number;
  gross_cents: number;
}

/** Invoice count + value over a date range (the Volume dashboard). */
export interface VolumeMetrics {
  from: string; // yyyy-mm-dd inclusive
  to: string; // yyyy-mm-dd inclusive
  /** The trend series is always actual calendar months. */
  bucket: 'month';
  /** First day charted: the range start, extended back to ≥12 trailing months. */
  series_from: string;
  totals: { count: number; gross_cents: number };
  series: { bucket: string; count: number; gross_cents: number }[];
  top_by_value: VendorVolume[];
  top_by_count: VendorVolume[];
}

export interface SessionUser {
  email: string;
  name: string;
  role: 'processor' | 'lead';
}

/** Privilege level. Mirrors SessionUser['role'] — the two roles the app knows. */
export type TeamRole = SessionUser['role'];

/**
 * One person in the Finny team directory — the source of truth for who is an
 * AP Lead vs AP Processor. Seeded from the M365 group the SSO is scoped to and
 * adjustable in Settings; `role` here overrides the sign-in-time default.
 */
export interface TeamMember {
  email: string;
  name: string;
  role: TeamRole;
  /** How the row got here: config (FINNY_LEAD_EMAILS pin), bootstrap (first
   *  sign-in), group (an M365 group sync), or manual (set in Settings). */
  source: 'config' | 'bootstrap' | 'group' | 'manual';
  /** Present in the most recent Microsoft 365 group sync (i.e. can sign in). */
  in_group: boolean;
  /** Pinned to Lead via FINNY_LEAD_EMAILS — cannot be demoted in the UI. */
  config_lead: boolean;
  /** True for the row belonging to the signed-in user (the "You" marker). */
  is_self: boolean;
  updated_at: string;
  updated_by: string | null;
}

/** GET /team — the directory plus which provider backs the M365 sync. */
export interface TeamDirectory {
  provider: 'mock' | 'graph';
  /** A group id is configured (graph mode) — the sync will hit real M365. */
  group_configured: boolean;
  members: TeamMember[];
}

/** Payload for the single review action (shadow log / live confirm / discard). */
export interface ReviewSubmission {
  action: 'confirm' | 'shadow_log' | 'discard';
  discard_reason?: string;
  fields: {
    vendor_name: string | null;
    invoice_ref: string | null;
    invoice_date: string | null;
    due_date: string | null;
    net_cents: number | null;
    vat_cents: number | null;
    gross_cents: number | null;
    vat_rate: number | null;
    vat_number: string | null;
    po_number: string | null;
    supplier_account_ref: string | null;
  };
  category: string | null;
  approver_id: string | null;
  /** Required for confirm: which legal entity's books this posts to. */
  entity: string | null;
  /** Optional project assignment (configured project code). */
  project_code: string | null;
}
