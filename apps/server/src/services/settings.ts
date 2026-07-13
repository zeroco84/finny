import type { Approver, ApproverSyncResult, Settings } from '@finny/shared';
import { all, jsonParse, one, run } from '../db/db.js';
import { config } from '../config.js';
import { newId } from '../domain/util.js';
import { directoryMode, type DirectoryPerson, fetchEntraGroupMembers } from './entraGroups.js';

export const DEFAULT_SETTINGS: Settings = {
  mode: 'shadow',
  extraction_model: '', // '' = use the deployment default (config.extractionModel)
  confidence_threshold: 0.75,
  review_sla_hours: 4,
  alert_webhook_url: '',
  entities: [
    'Meadowvale Developments Ltd',
    'Meadowvale Construction Ltd',
    'Meadowvale Asset Management Ltd',
  ],
  // One entity runs many projects (Developments carries two below); Asset
  // Management runs none — overhead invoices post without a project.
  projects: [
    { name: 'Clongriffin Phase 3', code: 'CLON3', dept: '26', entity: 'Meadowvale Developments Ltd' },
    { name: 'Dock Mill', code: 'DOCKM', dept: '28', entity: 'Meadowvale Construction Ltd' },
    { name: 'Santry Cross', code: 'SANTX', dept: '30', entity: 'Meadowvale Developments Ltd' },
  ],
  categories: [
    { name: 'Site Costs', nominal_code: '5000' },
    { name: 'Materials', nominal_code: '5200' },
    { name: 'Subcontractors', nominal_code: '5300' },
    { name: 'Plant & Equipment Hire', nominal_code: '5100' },
    { name: 'Professional Fees', nominal_code: '7600' },
    { name: 'Utilities', nominal_code: '7200' },
    { name: 'Office & Admin', nominal_code: '7500' },
  ],
  // Irish VAT rates -> Sage 50 tax codes. Zero-VAT lines post as T9 (outside
  // scope) per the AP team's posting sheet; review against the live Sage
  // config before the first real import.
  tax_codes: { '23': 'T1', '13.5': 'T2', '9': 'T3', '4.8': 'T4', '0': 'T9' },
  default_tax_code: 'T1',
  sage_department: '0',
  next_posting_ref: 10001,
  rule_apply: { category: 'auto', approver: 'review' },
};

const SEED_APPROVERS: Omit<Approver, 'id' | 'source'>[] = [
  { name: 'James Brennan', email: 'j.brennan@example.com', teams_user_id: null, active: true },
  { name: 'Maeve O’Brien', email: 'm.obrien@example.com', teams_user_id: null, active: true },
  { name: 'Sinead Kavanagh', email: 's.kavanagh@example.com', teams_user_id: null, active: true },
  { name: 'Aidan Doyle', email: 'a.doyle@example.com', teams_user_id: null, active: true },
];

// The sample approving-managers group shown in `mock` mode — a stand-in for the
// members of the M365 approvers group. The first four match the seeded
// approvers (a sync fills in their Teams user id); Fiona is new, so a sync
// visibly adds someone. `graph` mode replaces this with the real group.
const MOCK_APPROVERS_GROUP: DirectoryPerson[] = [
  { name: 'James Brennan', email: 'j.brennan@example.com', entraId: 'mock-aad-james', accountEnabled: true },
  { name: 'Maeve O’Brien', email: 'm.obrien@example.com', entraId: 'mock-aad-maeve', accountEnabled: true },
  { name: 'Sinead Kavanagh', email: 's.kavanagh@example.com', entraId: 'mock-aad-sinead', accountEnabled: true },
  { name: 'Aidan Doyle', email: 'a.doyle@example.com', entraId: 'mock-aad-aidan', accountEnabled: true },
  { name: 'Fiona Nolan', email: 'f.nolan@example.com', entraId: 'mock-aad-fiona', accountEnabled: true },
];

export function seedDefaults(): void {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
      key,
      JSON.stringify(value),
    );
  }
  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM approvers');
  if (!count || Number(count.n) === 0) {
    for (const a of SEED_APPROVERS) {
      run(
        'INSERT INTO approvers (id, name, email, teams_user_id, active) VALUES (?, ?, ?, ?, 1)',
        newId(),
        a.name,
        a.email,
        a.teams_user_id,
      );
    }
  }
}

export function getSettings(): Settings {
  const rows = all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    out[row.key] = jsonParse(row.value, (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[row.key]);
  }
  const settings = out as unknown as Settings;
  // The Anthropic API key is stored in this table but is a secret — never let it
  // leave in the Settings object the API returns. Read it via getAnthropicKey().
  delete (settings as unknown as Record<string, unknown>).anthropic_api_key;
  // The webhook URL embeds a secret token in its path — never return it to any
  // client (read it server-side via getAlertWebhookUrl). The UI shows only the
  // host + a configured flag, and writes are validated in the settings route.
  delete (settings as unknown as Record<string, unknown>).alert_webhook_url;
  // Shape migration: projects stored before depts existed get theirs
  // backfilled (seeded codes from the defaults, otherwise blank -> fallback).
  // Projects stored before entities were attached come back unassigned ('') —
  // the Settings UI surfaces them for the AP Lead to place; Finny never
  // guesses which entity owns a project.
  settings.projects = settings.projects.map((p) => ({
    ...p,
    dept: p.dept ?? DEFAULT_SETTINGS.projects.find((d) => d.code === p.code)?.dept ?? '',
    entity: p.entity ?? '',
  }));
  return settings;
}

const ANTHROPIC_KEY_ROW = 'anthropic_api_key';

/** The effective Anthropic API key — a value set in Settings wins over the env. */
export function getAnthropicKey(): string {
  const row = one<{ value: string }>('SELECT value FROM settings WHERE key = ?', ANTHROPIC_KEY_ROW);
  const stored = row ? jsonParse<string>(row.value, '') : '';
  return (stored || config.anthropicKey || '').trim();
}

/** Store (or clear, when empty) the Anthropic API key. Never returned by the API. */
export function setAnthropicKey(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) {
    run('DELETE FROM settings WHERE key = ?', ANTHROPIC_KEY_ROW);
    return;
  }
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ANTHROPIC_KEY_ROW,
    JSON.stringify(trimmed),
  );
}

/**
 * The effective Teams alert webhook URL. Read directly from its row (not via
 * getSettings, which strips it) so the secret token embedded in the URL path
 * never leaves the server.
 */
export function getAlertWebhookUrl(): string {
  const row = one<{ value: string }>(`SELECT value FROM settings WHERE key = 'alert_webhook_url'`);
  const stored = row ? jsonParse<string>(row.value, '') : '';
  return (stored || config.alertWebhookUrl || '').trim();
}

/** Whether a key is configured and where it comes from (for the Settings UI). */
export function anthropicKeyInfo(): { set: boolean; source: 'settings' | 'env' | 'none' } {
  const stored = one<{ value: string }>('SELECT value FROM settings WHERE key = ?', ANTHROPIC_KEY_ROW);
  if (stored && jsonParse<string>(stored.value, '').trim()) return { set: true, source: 'settings' };
  if (config.anthropicKey.trim()) return { set: true, source: 'env' };
  return { set: false, source: 'none' };
}

/** The effective extraction model — the Settings choice wins over the env default. */
export function getExtractionModel(): string {
  return (getSettings().extraction_model || config.extractionModel).trim();
}

/**
 * Effective extraction provider: 'anthropic' when an API key is available (env
 * or Settings), unless EXTRACTION_PROVIDER=mock explicitly forces the offline
 * parser.
 */
export function extractionProviderActive(): 'anthropic' | 'mock' {
  if (config.extractionProviderEnv === 'mock') return 'mock';
  return getAnthropicKey() ? 'anthropic' : 'mock';
}

export function updateSettings(patch: Partial<Settings>): Settings {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      JSON.stringify(value),
    );
  }
  return getSettings();
}

export function listApprovers(includeInactive = false): Approver[] {
  const rows = all<Record<string, unknown>>(
    includeInactive ? 'SELECT * FROM approvers ORDER BY name' : 'SELECT * FROM approvers WHERE active = 1 ORDER BY name',
  );
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    email: String(r.email),
    teams_user_id: r.teams_user_id === null ? null : String(r.teams_user_id),
    active: Number(r.active) === 1,
    source: r.source === 'graph' ? 'graph' : 'manual',
  }));
}

export function getApprover(id: string | null): Approver | null {
  if (!id) return null;
  return listApprovers(true).find((a) => a.id === id) ?? null;
}

export function findApproverByEmailOrName(hint: string | null): Approver | null {
  if (!hint) return null;
  const needle = hint.trim().toLowerCase();
  return (
    listApprovers().find(
      (a) => a.email.toLowerCase() === needle || a.name.toLowerCase() === needle,
    ) ?? null
  );
}

// ── Approving-managers sync from the M365 group ──────────────────────────────

export function approversProvider(): 'mock' | 'graph' {
  // Same rule as the team directory: real under SSO, sample only in dev.
  return directoryMode();
}

/** A real M365 approvers group is wired up (so "Sync" hits Graph). */
export function approversGroupConfigured(): boolean {
  return approversProvider() === 'graph' && Boolean(config.approvers.groupId);
}

function fetchApproverGroup(): Promise<DirectoryPerson[]> {
  if (approversProvider() === 'mock') return Promise.resolve(MOCK_APPROVERS_GROUP.map((m) => ({ ...m })));
  if (!config.approvers.groupId) {
    throw new Error('FINNY_APPROVERS_GROUP_ID is not set — add the object id of the approving-managers group');
  }
  return fetchEntraGroupMembers(config.approvers.groupId);
}

/**
 * Pull the approving-managers group from M365 and reconcile the approvers list:
 * add newcomers, refresh each member's name + Teams user id (their AAD id, used
 * to raise Graph approvals), and deactivate anyone previously synced who has
 * left the group. Hand-added ('manual') approvers are never touched.
 */
export async function syncApprovers(): Promise<ApproverSyncResult> {
  const provider = approversProvider();
  const people = await fetchApproverGroup();
  const existing = listApprovers(true);
  const byEmail = new Map(existing.map((a) => [a.email.toLowerCase(), a]));
  const seen = new Set<string>();
  const summary = { added: 0, updated: 0, deactivated: 0 };

  for (const person of people) {
    const email = person.email.trim().toLowerCase();
    seen.add(email);
    const match = byEmail.get(email);
    if (match) {
      run(
        "UPDATE approvers SET name = ?, teams_user_id = ?, active = ?, source = 'graph' WHERE id = ?",
        person.name,
        person.entraId,
        person.accountEnabled ? 1 : 0,
        match.id,
      );
      summary.updated++;
    } else {
      run(
        "INSERT INTO approvers (id, name, email, teams_user_id, active, source) VALUES (?, ?, ?, ?, ?, 'graph')",
        newId(),
        person.name,
        person.email,
        person.entraId,
        person.accountEnabled ? 1 : 0,
      );
      summary.added++;
    }
  }

  // Anyone we previously synced but who is no longer in the group loses their
  // approver status; manually-added approvers are left alone.
  for (const approver of existing) {
    if (approver.source === 'graph' && approver.active && !seen.has(approver.email.toLowerCase())) {
      run('UPDATE approvers SET active = 0 WHERE id = ?', approver.id);
      summary.deactivated++;
    }
  }

  return { provider, group_configured: approversGroupConfigured(), summary };
}
