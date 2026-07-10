export const SCHEMA = `
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  email_from TEXT,
  email_subject TEXT,
  email_message_id TEXT,
  received_at TEXT NOT NULL,
  attachment_name TEXT,
  attachment_mime TEXT,
  attachment_path TEXT,
  attachment_size INTEGER,
  status TEXT NOT NULL DEFAULT 'received',
  doc_type TEXT,
  vendor_name TEXT,
  vendor_normalized TEXT,
  invoice_ref TEXT,
  invoice_date TEXT,
  net_cents INTEGER,
  vat_cents INTEGER,
  gross_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'EUR',
  vat_rate REAL,
  vat_number TEXT,
  po_number TEXT,
  supplier_account_ref TEXT,
  entity TEXT,
  project_code TEXT,
  line_items TEXT NOT NULL DEFAULT '[]',
  field_confidence TEXT NOT NULL DEFAULT '{}',
  extraction_snapshot TEXT,
  extraction_error TEXT,
  extraction_provider TEXT,
  proposed_category TEXT,
  proposed_approver_id TEXT,
  routing_confidence REAL,
  routing_rationale TEXT,
  matched_rule_id TEXT,
  category TEXT,
  approver_id TEXT,
  shadow INTEGER NOT NULL DEFAULT 0,
  duplicate_of TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  confirmed_at TEXT,
  discarded_reason TEXT,
  sage_batch_id TEXT,
  posting_ref TEXT,
  sage_tx_number TEXT,
  sage_posted_at TEXT,
  sla_alerted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_vendor ON invoices(vendor_normalized);

CREATE TABLE IF NOT EXISTS corrections (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  corrected_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corrections_invoice ON corrections(invoice_id);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  vendor_pattern TEXT NOT NULL,
  vendor_normalized TEXT NOT NULL,
  category TEXT,
  approver_id TEXT,
  hint_text TEXT,
  status TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  source_invoice_id TEXT,
  supersedes_rule_id TEXT,
  times_applied INTEGER NOT NULL DEFAULT 0,
  times_confirmed INTEGER NOT NULL DEFAULT 0,
  times_corrected INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_vendor ON rules(vendor_normalized, status);

CREATE TABLE IF NOT EXISTS approvers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  teams_user_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  -- 'manual' = added by hand in Settings; 'graph' = pulled from the M365
  -- approvers group (so a sync may deactivate them if they leave it).
  source TEXT NOT NULL DEFAULT 'manual'
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  approver_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by_name TEXT,
  decision_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_approval_invoice ON approval_requests(invoice_id);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  invoice_id TEXT,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  next_step TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  acknowledged_by TEXT,
  acknowledged_at TEXT,
  email_to TEXT,
  email_status TEXT NOT NULL DEFAULT 'logged',
  email_error TEXT,
  email_sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  invoice_id TEXT,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_invoice ON audit_events(invoice_id);

CREATE TABLE IF NOT EXISTS sage_batches (
  id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  entity TEXT,
  filename TEXT NOT NULL,
  path TEXT NOT NULL,
  invoice_count INTEGER NOT NULL,
  total_gross_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated',
  marked_imported_by TEXT,
  marked_imported_at TEXT
);

CREATE TABLE IF NOT EXISTS shadow_comparisons (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  field TEXT NOT NULL,
  ai_value TEXT,
  human_value TEXT,
  matched INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shadow_field ON shadow_comparisons(field);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Active nominal codes pulled from each entity's Sage company (the coding
-- list is Sage's, not hand-maintained). Union flattens into settings.categories.
CREATE TABLE IF NOT EXISTS sage_nominals (
  entity TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  name TEXT NOT NULL,
  pulled_at TEXT NOT NULL,
  PRIMARY KEY (entity, account_ref)
);

CREATE TABLE IF NOT EXISTS system_status (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Who may sign into Finny and at what privilege level. Seeded from the M365
-- group the SSO is scoped to (the 'group' source) and from FINNY_LEAD_EMAILS
-- ('config'); the AP Lead adjusts roles in Settings ('manual'). This is the
-- source of truth for role resolution — the sign-in-time default is only used
-- to create a member the first time they appear.
CREATE TABLE IF NOT EXISTS team_members (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'processor',
  source TEXT NOT NULL DEFAULT 'group',
  in_group INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS ingested_messages (
  message_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);
`;
