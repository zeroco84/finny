import { beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb } from '../src/db/db.js';
import { getSettings, seedDefaults } from '../src/services/settings.js';
import {
  buildCategoriesFromPulled,
  listPulledNominals,
  pullSummary,
  storePulledNominals,
  type PulledNominal,
} from '../src/services/sage/nominals.js';

const row = (entity: string, ref: string, name: string): PulledNominal => ({
  entity, account_ref: ref, name, pulled_at: '2026-07-08T00:00:00.000Z',
});

describe('buildCategoriesFromPulled', () => {
  it('dedupes by account ref across entities and sorts numerically', () => {
    const cats = buildCategoriesFromPulled([
      row('B', '5200', 'Materials Purchased'),
      row('A', '5000', 'Site Costs'),
      row('A', '5200', 'Materials Purchased'),
      row('A', '10000', 'Misc'),
    ]);
    expect(cats).toEqual([
      { name: 'Site Costs', nominal_code: '5000' },
      { name: 'Materials Purchased', nominal_code: '5200' },
      { name: 'Misc', nominal_code: '10000' },
    ]);
  });

  it('keeps names unique by baking in the code when two codes share a name', () => {
    const cats = buildCategoriesFromPulled([
      row('A', '7600', 'Professional Fees'),
      row('A', '7601', 'Professional Fees'),
    ]);
    expect(cats).toEqual([
      { name: 'Professional Fees (7600)', nominal_code: '7600' },
      { name: 'Professional Fees (7601)', nominal_code: '7601' },
    ]);
  });
});

describe('storePulledNominals', () => {
  beforeEach(() => {
    closeDb();
    openDb(':memory:');
    seedDefaults();
  });

  it('replaces the entity set, flattens the union into settings.categories, and audits', () => {
    storePulledNominals('Alpha Ltd', [
      { accountRef: '5000', name: 'Site Costs' },
      { accountRef: '5200', name: 'Materials Purchased' },
    ], 'lead@example.com');
    const cats = storePulledNominals('Beta Ltd', [
      { accountRef: '5200', name: 'Materials Purchased' },
      { accountRef: '7200', name: 'Electricity' },
    ], 'lead@example.com');

    expect(cats.map((c) => c.nominal_code)).toEqual(['5000', '5200', '7200']);
    expect(getSettings().categories).toEqual(cats); // hand-typed defaults replaced
    expect(pullSummary()).toEqual([
      { entity: 'Alpha Ltd', count: 2, pulled_at: expect.any(String) },
      { entity: 'Beta Ltd', count: 2, pulled_at: expect.any(String) },
    ]);

    // Re-pulling an entity replaces its rows (a code retired in Sage drops out).
    storePulledNominals('Alpha Ltd', [{ accountRef: '5000', name: 'Site Costs' }], 'lead@example.com');
    expect(listPulledNominals().map((r) => `${r.entity}:${r.account_ref}`)).toEqual(
      ['Alpha Ltd:5000', 'Beta Ltd:5200', 'Beta Ltd:7200'],
    );
    expect(getSettings().categories.map((c) => c.nominal_code)).toEqual(['5000', '5200', '7200']);
  });
});
