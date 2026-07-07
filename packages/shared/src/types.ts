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

export type DocType = 'invoice' | 'statement' | 'remittance' | 'other' | null;

/** Extraction fields that carry a per-field confidence score. */
export const CONFIDENCE_FIELDS = [
  'vendor_name',
  'invoice_ref',
  'invoice_date',
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
  net_cents: number | null;
  vat_cents: number | null;
  gross_cents: number | null;
  vat_rate: number | null; // percent
  vat_number: string | null;
  po_number: string | null;
  /** Which Meadowvale legal entity the invoice is addressed to. */
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
}

export interface Approver {
  id: string;
  name: string;
  email: string;
  teams_user_id: string | null;
  active: boolean;
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
  email_to: string | null;
  email_status: 'sent' | 'logged' | 'failed';
  email_error: string | null;
  email_sent_at: string | null;
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
  confidence_threshold: number; // 0..1 — below this a field is flagged
  review_sla_hours: number; // low-confidence invoice untouched this long -> alert
  alert_recipients: string[];
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

export interface ConnectorStatus {
  mail_provider: string;
  extraction_provider: string;
  approvals_provider: string;
  email_provider: string;
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

export interface SessionUser {
  email: string;
  name: string;
  role: 'processor' | 'lead';
}

/** Payload for the single review action (shadow log / live confirm / discard). */
export interface ReviewSubmission {
  action: 'confirm' | 'shadow_log' | 'discard';
  discard_reason?: string;
  fields: {
    vendor_name: string | null;
    invoice_ref: string | null;
    invoice_date: string | null;
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
