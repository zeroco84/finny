import type { Approver, Settings } from '@finny/shared';
import { all, jsonParse, one, run } from '../db/db.js';
import { newId } from '../domain/util.js';

export const DEFAULT_SETTINGS: Settings = {
  mode: 'shadow',
  confidence_threshold: 0.75,
  review_sla_hours: 4,
  alert_recipients: ['finance-alerts@example.com'],
  entities: [
    'Meadowvale Developments Ltd',
    'Meadowvale Construction Ltd',
    'Meadowvale Asset Management Ltd',
  ],
  projects: [
    { name: 'Clongriffin Phase 3', code: 'CLON3', dept: '26' },
    { name: 'Dock Mill', code: 'DOCKM', dept: '28' },
    { name: 'Santry Cross', code: 'SANTX', dept: '30' },
  ],
  categories: [
    { name: 'Site Costs', nominal_code: '5000' },
    { name: 'Materials', nominal_code: '5200' },
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

const SEED_APPROVERS: Omit<Approver, 'id'>[] = [
  { name: 'James Brennan', email: 'j.brennan@example.com', teams_user_id: null, active: true },
  { name: 'Maeve O’Brien', email: 'm.obrien@example.com', teams_user_id: null, active: true },
  { name: 'Sinead Kavanagh', email: 's.kavanagh@example.com', teams_user_id: null, active: true },
  { name: 'Aidan Doyle', email: 'a.doyle@example.com', teams_user_id: null, active: true },
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
  // Shape migration: projects stored before depts existed get theirs
  // backfilled (seeded codes from the defaults, otherwise blank -> fallback).
  settings.projects = settings.projects.map((p) => ({
    ...p,
    dept: p.dept ?? DEFAULT_SETTINGS.projects.find((d) => d.code === p.code)?.dept ?? '',
  }));
  return settings;
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
