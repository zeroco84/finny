import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { closeDb, openDb, run } from '../src/db/db.js';
import { listApprovers, seedDefaults, syncApprovers } from '../src/services/settings.js';

const saved = {
  provider: config.team.provider,
  approversGroupId: config.approvers.groupId,
  auth: config.authProvider,
};

beforeEach(() => {
  closeDb();
  openDb(':memory:');
  config.team.provider = 'mock';
  config.approvers.groupId = '';
  config.authProvider = 'dev';
  seedDefaults(); // seeds the four sample approvers
});

afterAll(() => {
  config.team.provider = saved.provider;
  config.approvers.groupId = saved.approversGroupId;
  config.authProvider = saved.auth;
});

describe('syncApprovers (mock provider)', () => {
  it('fills in Teams user ids for known managers and adds newcomers', async () => {
    const res = await syncApprovers();
    expect(res).toMatchObject({ provider: 'mock', group_configured: false });
    expect(res.summary).toEqual({ added: 1, updated: 4, deactivated: 0 });

    const list = listApprovers(true);
    expect(list.find((a) => a.email === 'j.brennan@example.com')).toMatchObject({
      teams_user_id: 'mock-aad-james',
      source: 'graph',
      active: true,
    });
    // Fiona is only in the group, so the sync creates her.
    expect(list.find((a) => a.email === 'f.nolan@example.com')).toMatchObject({
      source: 'graph',
      active: true,
    });
  });

  it('preserves hand-added approvers and deactivates managers who left the group', async () => {
    await syncApprovers(); // everyone in the sample group is now source=graph

    run(
      "INSERT INTO approvers (id, name, email, teams_user_id, active, source) VALUES ('m1', 'Manual Mgr', 'manual@example.com', NULL, 1, 'manual')",
    );
    run(
      "INSERT INTO approvers (id, name, email, teams_user_id, active, source) VALUES ('g1', 'Gone Mgr', 'gone@example.com', 'x', 1, 'graph')",
    );

    const res = await syncApprovers();
    expect(res.summary.deactivated).toBe(1);

    const list = listApprovers(true);
    // Hand-added approver untouched.
    expect(list.find((a) => a.email === 'manual@example.com')).toMatchObject({ active: true, source: 'manual' });
    // A previously-synced manager no longer in the group is deactivated, not deleted.
    expect(list.find((a) => a.email === 'gone@example.com')).toMatchObject({ active: false });
  });
});
