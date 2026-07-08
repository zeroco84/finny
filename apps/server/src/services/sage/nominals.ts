import type { Category } from '@finny/shared';
import { all, run } from '../../db/db.js';
import { nowIso } from '../../domain/util.js';
import { audit } from '../audit.js';
import { updateSettings } from '../settings.js';

/**
 * The coding list comes FROM Sage: the AP Lead pulls each entity's active
 * nominal codes, and the union becomes settings.categories (name = Sage's
 * account name, nominal_code = the account ref). Everything downstream —
 * extraction context, learned rules, the review dropdown, the export lookup —
 * keeps consuming settings.categories, so a company that never pulls (mock
 * demo, CSV-only setups) keeps the seeded defaults.
 */

export interface PulledNominal {
  entity: string;
  account_ref: string;
  name: string;
  pulled_at: string;
}

export function listPulledNominals(): PulledNominal[] {
  return all<PulledNominal>(
    'SELECT entity, account_ref, name, pulled_at FROM sage_nominals ORDER BY account_ref, entity',
  );
}

export function pullSummary(): { entity: string; count: number; pulled_at: string }[] {
  return all<{ entity: string; count: number; pulled_at: string }>(
    `SELECT entity, COUNT(*) AS count, MAX(pulled_at) AS pulled_at
     FROM sage_nominals GROUP BY entity ORDER BY entity`,
  );
}

/**
 * Union across entities, deduped by account ref. Category names must stay
 * unique (the Sage export resolves name -> code), so if two different codes
 * share an account name the code is baked into the name.
 */
export function buildCategoriesFromPulled(rows: PulledNominal[]): Category[] {
  const byRef = new Map<string, string>(); // account_ref -> name (first pull wins)
  for (const row of rows) {
    if (!byRef.has(row.account_ref)) byRef.set(row.account_ref, row.name);
  }
  const nameCounts = new Map<string, number>();
  for (const name of byRef.values()) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  return [...byRef.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([account_ref, name]) => ({
      name: (nameCounts.get(name) ?? 0) > 1 ? `${name} (${account_ref})` : name,
      nominal_code: account_ref,
    }));
}

/**
 * Replace one entity's pulled set and re-flatten the union into
 * settings.categories. Returns the new coding list.
 */
export function storePulledNominals(
  entity: string,
  nominals: { accountRef: string; name: string }[],
  who: string,
): Category[] {
  const now = nowIso();
  run('DELETE FROM sage_nominals WHERE entity = ?', entity);
  for (const n of nominals) {
    run(
      `INSERT INTO sage_nominals (entity, account_ref, name, pulled_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(entity, account_ref) DO UPDATE SET name = excluded.name, pulled_at = excluded.pulled_at`,
      entity, n.accountRef, n.name, now,
    );
  }
  const categories = buildCategoriesFromPulled(listPulledNominals());
  updateSettings({ categories });
  audit(null, 'sage_nominals_pulled', who, { entity, count: nominals.length, total_codes: categories.length });
  return categories;
}
