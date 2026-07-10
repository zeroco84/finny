import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { closeDb, openDb, run } from '../src/db/db.js';
import {
  ensureTeamMemberOnSignIn,
  listTeam,
  purgeSampleDirectory,
  resolveRole,
  seedTeam,
  setMemberRole,
  syncGroup,
  TeamError,
} from '../src/services/team.js';
import type { SessionUser } from '@finny/shared';

const saved = {
  leadEmails: [...config.leadEmails],
  provider: config.team.provider,
  groupId: config.team.groupId,
  auth: config.authProvider,
};

function user(email: string, role: SessionUser['role'] = 'processor', name = email): SessionUser {
  return { email, name, role };
}

beforeEach(() => {
  closeDb();
  openDb(':memory:');
  config.leadEmails = [];
  config.team.provider = 'mock';
  config.team.groupId = '';
  config.authProvider = 'dev';
});

afterAll(() => {
  config.leadEmails = saved.leadEmails;
  config.team.provider = saved.provider;
  config.team.groupId = saved.groupId;
  config.authProvider = saved.auth;
});

describe('resolveRole precedence', () => {
  it('config pin > directory row > processor default', () => {
    expect(resolveRole('nobody@example.com')).toBe('processor');

    ensureTeamMemberOnSignIn(user('rowlead@example.com'));
    setMemberRole('rowlead@example.com', 'lead', 'admin@example.com');
    expect(resolveRole('rowlead@example.com')).toBe('lead'); // from the row

    config.leadEmails = ['pinned@example.com'];
    expect(resolveRole('PINNED@example.com')).toBe('lead'); // pin wins, case-insensitive
  });
});

describe('ensureTeamMemberOnSignIn', () => {
  it('promotes the first user to Lead when no lead exists (bootstrap)', () => {
    expect(ensureTeamMemberOnSignIn(user('first@example.com'))).toBe('lead');
    // Once a lead exists, the next newcomer is a processor.
    expect(ensureTeamMemberOnSignIn(user('second@example.com'))).toBe('processor');
  });

  it('does not bootstrap when leads are pinned via config', () => {
    config.leadEmails = ['boss@example.com'];
    expect(ensureTeamMemberOnSignIn(user('first@example.com'))).toBe('processor');
    expect(ensureTeamMemberOnSignIn(user('boss@example.com'))).toBe('lead');
  });

  it('keeps the directory role on re-sign-in but refreshes the name', () => {
    config.leadEmails = ['boss@example.com']; // suppress the first-user bootstrap
    ensureTeamMemberOnSignIn(user('amy@example.com', 'processor', 'Amy'));
    setMemberRole('amy@example.com', 'lead', 'boss@example.com');
    // Signs in again as a "processor" — the directory governs, so she stays lead.
    expect(ensureTeamMemberOnSignIn(user('amy@example.com', 'processor', 'Amy Byrne'))).toBe('lead');
    const amy = listTeam(null).members.find((m) => m.email === 'amy@example.com');
    expect(amy).toMatchObject({ name: 'Amy Byrne', role: 'lead' });
  });
});

describe('setMemberRole guards', () => {
  beforeEach(() => {
    config.leadEmails = ['boss@example.com'];
    ensureTeamMemberOnSignIn(user('boss@example.com'));
    ensureTeamMemberOnSignIn(user('amy@example.com'));
  });

  it('promotes a processor and the new role resolves live', () => {
    expect(resolveRole('amy@example.com')).toBe('processor');
    const updated = setMemberRole('amy@example.com', 'lead', 'boss@example.com');
    expect(updated).toMatchObject({ role: 'lead', source: 'manual' });
    expect(resolveRole('amy@example.com')).toBe('lead');
  });

  it('refuses to demote a config-pinned lead', () => {
    expect(() => setMemberRole('boss@example.com', 'processor', 'boss@example.com')).toThrow(TeamError);
    expect(resolveRole('boss@example.com')).toBe('lead');
  });

  it('refuses to demote the last remaining lead', () => {
    config.leadEmails = []; // unpin, so nothing else protects the count
    setMemberRole('amy@example.com', 'lead', 'boss@example.com'); // leads: boss, amy
    setMemberRole('boss@example.com', 'processor', 'amy@example.com'); // leads: amy
    expect(() => setMemberRole('amy@example.com', 'processor', 'amy@example.com')).toThrow(/at least one ap lead/i);
  });

  it('rejects changing someone not in the directory', () => {
    expect(() => setMemberRole('ghost@example.com', 'lead', 'boss@example.com')).toThrow(/not in the team/i);
  });
});

describe('seedTeam + syncGroup (mock provider)', () => {
  it('seeds the sample finance group and the config pins', () => {
    config.leadEmails = ['boss@example.com'];
    seedTeam();
    const dir = listTeam(null);
    expect(dir.provider).toBe('mock');
    expect(dir.group_configured).toBe(false);
    expect(dir.members.find((m) => m.email === 'boss@example.com')).toMatchObject({
      role: 'lead',
      config_lead: true,
    });
    expect(dir.members.find((m) => m.email === 'amy@example.com')).toBeTruthy();
  });

  it('purgeSampleDirectory clears sample rows under Entra but keeps them in dev', () => {
    seedTeam(); // dev/mock: seeds the @example.com sample group
    purgeSampleDirectory(); // dev → no-op
    expect(listTeam(null).members.some((m) => m.email.endsWith('@example.com'))).toBe(true);

    config.team.provider = ''; // auto
    config.authProvider = 'entra';
    purgeSampleDirectory(); // real SSO → strips the leftover samples
    expect(listTeam(null).members.some((m) => m.email.endsWith('@example.com'))).toBe(false);
  });

  it('under Entra never seeds sample people and bootstraps the first real user', () => {
    config.team.provider = ''; // auto
    config.authProvider = 'entra';
    seedTeam();
    const dir = listTeam(null);
    expect(dir.provider).toBe('graph');
    expect(dir.members).toHaveLength(0); // no amy@example.com etc. in production
    // First real sign-in with no configured lead is promoted to AP Lead...
    expect(ensureTeamMemberOnSignIn(user('boss@corp.com'))).toBe('lead');
    // ...and a colleague who signs in afterwards is a processor.
    expect(ensureTeamMemberOnSignIn(user('clerk@corp.com'))).toBe('processor');
  });

  it('preserves manual roles and flags people who are not in the group', async () => {
    seedTeam();
    // A manual promotion must survive a re-sync.
    setMemberRole('niamh@example.com', 'lead', 'admin@example.com');
    // A hand-added person who is not part of the M365 group roster.
    run(
      `INSERT INTO team_members (email, name, role, source, in_group, updated_at, updated_by)
       VALUES ('contractor@example.com', 'Contractor', 'processor', 'manual', 0, '2026-01-01T00:00:00Z', 'admin@example.com')`,
    );

    const dir = await syncGroup('admin@example.com');
    expect(dir.members.find((m) => m.email === 'niamh@example.com')).toMatchObject({ role: 'lead', in_group: true });
    expect(dir.members.find((m) => m.email === 'amy@example.com')?.in_group).toBe(true);
    expect(dir.members.find((m) => m.email === 'contractor@example.com')?.in_group).toBe(false);
  });
});
