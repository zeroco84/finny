import type { SessionUser, TeamDirectory, TeamMember, TeamRole } from '@finny/shared';
import { config } from '../config.js';
import { all, one, run } from '../db/db.js';
import { nowIso } from '../domain/util.js';
import { directoryMode, fetchEntraGroupMembers } from './entraGroups.js';

/**
 * Team directory & privilege management.
 *
 * The `team_members` table is the source of truth for who is an AP Lead vs an
 * AP Processor. It is seeded from the M365 group the SSO is scoped to (via the
 * team provider — `mock` offline, `graph` against the real Entra group) and
 * from FINNY_LEAD_EMAILS, and adjusted by the AP Lead in Settings.
 *
 * Role is resolved *live* from this table on every request (see auth.ts), so a
 * privilege change takes effect on the member's next request — no re-login.
 * FINNY_LEAD_EMAILS are treated as pinned leads that cannot be demoted (the
 * lockout guard), and the first user to sign in when no lead exists yet is
 * promoted automatically so a fresh deploy always has an admin.
 */

export class TeamError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

interface TeamRow {
  email: string;
  name: string;
  role: string;
  source: string;
  in_group: number | bigint;
  updated_at: string;
  updated_by: string | null;
}

interface GroupPerson {
  name: string;
  email: string;
  role: TeamRole;
}

// The seeded finance group shown in `mock` mode — a stand-in for the members
// of the Entra security group the SSO is scoped to, so the Team page works
// with zero accounts. `graph` mode replaces this with the real group.
const MOCK_GROUP: GroupPerson[] = [
  { name: 'Amy Byrne', email: 'amy@example.com', role: 'lead' },
  { name: 'Rory Gallagher', email: 'rory@example.com', role: 'lead' },
  { name: 'Niamh Walsh', email: 'niamh@example.com', role: 'processor' },
  { name: 'Cian Murphy', email: 'cian@example.com', role: 'processor' },
  { name: 'Orla Kelly', email: 'orla@example.com', role: 'processor' },
  { name: 'Dara Fitzgerald', email: 'dara@example.com', role: 'processor' },
];

// ── Provider selection ───────────────────────────────────────────────────────

export function teamProvider(): 'mock' | 'graph' {
  // Real directory under SSO, sample only in dev — see directoryMode(). Under
  // Entra this is 'graph' even before a group id is set, so no sample team is
  // ever seeded into a live deployment.
  return directoryMode();
}

/** A real M365 group is wired up (so "Sync" hits Graph, not the mock list). */
export function groupConfigured(): boolean {
  return teamProvider() === 'graph' && Boolean(config.team.groupId);
}

// ── Row helpers ──────────────────────────────────────────────────────────────

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

function getMemberRow(email: string): TeamRow | undefined {
  return one<TeamRow>('SELECT * FROM team_members WHERE email = ?', normalize(email));
}

function asRole(value: unknown): TeamRole {
  return value === 'lead' ? 'lead' : 'processor';
}

function asSource(value: unknown): TeamMember['source'] {
  return value === 'config' || value === 'bootstrap' || value === 'manual' ? value : 'group';
}

function mapRow(row: TeamRow, selfEmail: string | null): TeamMember {
  const email = String(row.email);
  return {
    email,
    name: String(row.name),
    role: asRole(row.role),
    source: asSource(row.source),
    in_group: Number(row.in_group) === 1,
    config_lead: config.leadEmails.includes(email),
    is_self: Boolean(selfEmail) && email === normalize(selfEmail as string),
    updated_at: String(row.updated_at),
    updated_by: row.updated_by === null ? null : String(row.updated_by),
  };
}

function countLeads(): number {
  const row = one<{ n: number }>("SELECT COUNT(*) AS n FROM team_members WHERE role = 'lead'");
  return row ? Number(row.n) : 0;
}

// ── Role resolution (used on every authenticated request) ────────────────────

/**
 * The authoritative role for an email. FINNY_LEAD_EMAILS pins win (so a config
 * lead can never be locked out), otherwise the directory row decides, otherwise
 * processor. Safe to call before a member has ever been seen.
 */
export function resolveRole(email: string): TeamRole {
  const normalized = normalize(email);
  if (config.leadEmails.includes(normalized)) return 'lead';
  return asRole(getMemberRow(normalized)?.role);
}

/**
 * Record a successful sign-in: create the member the first time we see them
 * (applying the config pin, the first-user bootstrap, or the sign-in-time role
 * hint), refresh their display name, and return their effective role. Never
 * overrides an existing directory role — Settings governs that.
 */
export function ensureTeamMemberOnSignIn(user: SessionUser): TeamRole {
  const email = normalize(user.email);
  const name = user.name?.trim() || email;
  const isConfigLead = config.leadEmails.includes(email);
  const existing = getMemberRow(email);

  if (existing) {
    const role: TeamRole = isConfigLead ? 'lead' : asRole(existing.role);
    const nameChanged = Boolean(name) && name !== existing.name;
    const roleChanged = role !== asRole(existing.role);
    const rejoined = Number(existing.in_group) !== 1;
    if (nameChanged || roleChanged || rejoined) {
      run(
        'UPDATE team_members SET name = ?, role = ?, in_group = 1 WHERE email = ?',
        nameChanged ? name : existing.name,
        role,
        email,
      );
    }
    return role;
  }

  let role: TeamRole;
  let source: TeamMember['source'];
  if (isConfigLead) {
    role = 'lead';
    source = 'config';
  } else if (config.leadEmails.length === 0 && countLeads() === 0) {
    // First person into a deployment with no configured leads becomes the AP
    // Lead, so there is always someone who can manage the team.
    role = 'lead';
    source = 'bootstrap';
  } else {
    role = asRole(user.role);
    source = 'group';
  }
  run(
    `INSERT INTO team_members (email, name, role, source, in_group, updated_at, updated_by)
     VALUES (?, ?, ?, ?, 1, ?, 'system')`,
    email,
    name,
    role,
    source,
    nowIso(),
  );
  return role;
}

// ── Reads / writes for the Settings Team card ────────────────────────────────

export function listTeam(selfEmail: string | null): TeamDirectory {
  const rows = all<TeamRow>('SELECT * FROM team_members');
  const members = rows
    .map((r) => mapRow(r, selfEmail))
    .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'lead' ? -1 : 1));
  return { provider: teamProvider(), group_configured: groupConfigured(), members };
}

/** Change a member's privilege level, with the lockout guards. */
export function setMemberRole(email: string, role: TeamRole, actorEmail: string): TeamMember {
  const target = normalize(email);
  const existing = getMemberRow(target);
  if (!existing) throw new TeamError('That person is not in the team directory', 404);

  if (role === 'processor') {
    if (config.leadEmails.includes(target)) {
      throw new TeamError('This account is pinned as AP Lead via FINNY_LEAD_EMAILS — change it there', 409);
    }
    if (asRole(existing.role) === 'lead' && countLeads() <= 1) {
      throw new TeamError('At least one AP Lead is required — promote someone else first', 409);
    }
  }

  run(
    'UPDATE team_members SET role = ?, source = ?, updated_at = ?, updated_by = ? WHERE email = ?',
    role,
    // A config pin stays a config pin even as the stored role tracks it.
    config.leadEmails.includes(target) ? 'config' : 'manual',
    nowIso(),
    actorEmail,
    target,
  );
  return mapRow(getMemberRow(target)!, actorEmail);
}

// ── M365 group sync ──────────────────────────────────────────────────────────

async function fetchGroupMembers(): Promise<GroupPerson[]> {
  if (teamProvider() === 'mock') {
    // A config pin can promote a mock member; otherwise use their sample role.
    return MOCK_GROUP.map((m) => ({ ...m, role: resolveRole(m.email) === 'lead' ? 'lead' : m.role }));
  }
  if (!config.team.groupId) {
    throw new TeamError('FINNY_TEAM_GROUP_ID is not set — add the object id of the group the SSO is scoped to', 400);
  }
  const members = await fetchEntraGroupMembers(config.team.groupId);
  // A person's Finny role comes from the directory, not Graph — new members
  // default to processor (or a config pin).
  return members.map((m) => ({ name: m.name, email: m.email, role: resolveRole(m.email) }));
}

/**
 * Pull the group from M365 and reconcile the directory: add newcomers (as the
 * role hint — a config pin, else processor), refresh names, and flag anyone who
 * has left the group. Existing roles set in Settings are preserved.
 */
export async function syncGroup(actorEmail: string): Promise<TeamDirectory> {
  const people = await fetchGroupMembers();
  const now = nowIso();
  // Clear the flag on group-sourced rows; the upserts below re-set it for
  // everyone still present, leaving departed members flagged not-in-group.
  run("UPDATE team_members SET in_group = 0 WHERE source = 'group'");
  for (const person of people) {
    const email = normalize(person.email);
    run(
      `INSERT INTO team_members (email, name, role, source, in_group, updated_at, updated_by)
       VALUES (?, ?, ?, 'group', 1, ?, ?)
       ON CONFLICT(email) DO UPDATE SET name = excluded.name, in_group = 1`,
      email,
      person.name,
      person.role,
      now,
      actorEmail,
    );
  }
  return listTeam(actorEmail);
}

/**
 * Boot-time seed: pin the FINNY_LEAD_EMAILS as config leads, and in mock mode
 * pre-populate the demo finance group so the Team page is not empty offline.
 */
export function seedTeam(): void {
  const now = nowIso();
  for (const email of config.leadEmails) {
    run(
      `INSERT INTO team_members (email, name, role, source, in_group, updated_at, updated_by)
       VALUES (?, ?, 'lead', 'config', 1, ?, 'system')
       ON CONFLICT(email) DO UPDATE SET role = 'lead', source = 'config'`,
      email,
      email,
      now,
    );
  }
  if (teamProvider() === 'mock') {
    for (const m of MOCK_GROUP) {
      run(
        `INSERT INTO team_members (email, name, role, source, in_group, updated_at, updated_by)
         VALUES (?, ?, ?, 'group', 1, ?, 'system')
         ON CONFLICT(email) DO NOTHING`,
        normalize(m.email),
        m.name,
        m.role,
        now,
      );
    }
  }
}

/**
 * Self-heal a deployment that seeded the sample directory before it ran under
 * real SSO (an earlier build fell back to `mock` when no group id was set).
 * example.com is RFC-reserved, so under real SSO these rows can only be our own
 * dev samples — never a tenant user. No-op in dev, where the samples are wanted.
 * Removing the sample AP Leads also lets the first-real-user bootstrap work.
 */
export function purgeSampleDirectory(): void {
  if (directoryMode() !== 'graph') return;
  run("DELETE FROM team_members WHERE email LIKE '%@example.com'");
  run("DELETE FROM approvers WHERE source = 'graph' AND email LIKE '%@example.com'");
}
