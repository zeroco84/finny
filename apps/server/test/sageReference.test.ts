import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/services/settings.js';
import { validateAgainstSage } from '../src/services/sage/reference.js';
import type { SageReference } from '../src/services/sage/hyperaccounts.js';

/** A Sage company that matches the default settings, plus some extras. */
const ref: SageReference = {
  nominals: [
    { accountRef: '5000', name: 'Site Costs', inactiveFlag: 0 },
    { accountRef: '5100', name: 'Plant Hire', inactiveFlag: 0 },
    { accountRef: '5200', name: 'Materials Purchased', inactiveFlag: 0 },
    { accountRef: '7200', name: 'Electricity', inactiveFlag: 0 },
    { accountRef: '7500', name: 'Office Costs', inactiveFlag: 0 },
    { accountRef: '7600', name: 'Legal Fees', inactiveFlag: 1 }, // inactive!
  ],
  taxCodes: [
    { index: 0, description: 'Zero rated', rate: 0 },
    { index: 1, description: 'Standard rate', rate: 23 },
    { index: 2, description: 'Reduced rate', rate: 13.5 },
    { index: 3, description: 'Second reduced', rate: 9 },
    { index: 4, description: 'Livestock', rate: 4.8 },
    { index: 9, description: 'Non-Vatable Tax Code', rate: 0 },
  ],
  departments: [
    { reference: '0', name: 'Default' },
    { reference: '26', name: 'Clongriffin' },
    { reference: '28', name: 'Dock Mill' },
  ],
  projects: [
    { reference: 'CLON3', name: 'Clongriffin Phase 3', statusID: '1' },
    { reference: 'DOCKM', name: 'Dock Mill', statusID: '1' },
    { reference: 'BALLY1', name: 'Ballymore Rise', statusID: '1' },
    { reference: 'OLD99', name: 'Completed Site', statusID: '2' }, // not active
  ],
};

describe('validateAgainstSage', () => {
  const v = validateAgainstSage(DEFAULT_SETTINGS, ref);

  it('confirms nominal codes that exist and flags inactive/missing ones', () => {
    const byName = Object.fromEntries(v.categories.map((c) => [c.name, c]));
    expect(byName['Materials']).toMatchObject({ ok: true, sage_name: 'Materials Purchased' });
    expect(byName['Professional Fees']).toMatchObject({ ok: false, inactive: true, sage_name: 'Legal Fees' });
  });

  it('checks tax codes by index and compares rates', () => {
    const t23 = v.tax_codes.find((t) => t.rate === '23')!;
    expect(t23).toMatchObject({ code: 'T1', ok: true, rate_matches: true, sage_rate: 23 });
    const t0 = v.tax_codes.find((t) => t.rate === '0')!;
    expect(t0).toMatchObject({ code: 'T9', ok: true, rate_matches: true }); // non-vatable, 0%
    const def = v.tax_codes.find((t) => t.rate === null)!;
    expect(def).toMatchObject({ code: 'T1', ok: true, rate_matches: true });
  });

  it('flags a rate mismatch', () => {
    const v2 = validateAgainstSage(
      { ...DEFAULT_SETTINGS, tax_codes: { ...DEFAULT_SETTINGS.tax_codes, '23': 'T2' } },
      ref,
    );
    const t23 = v2.tax_codes.find((t) => t.rate === '23')!;
    expect(t23).toMatchObject({ ok: true, rate_matches: false, sage_rate: 13.5 });
  });

  it('validates projects + departments, case-insensitively on refs', () => {
    const byCode = Object.fromEntries(v.projects.map((p) => [p.code, p]));
    expect(byCode['CLON3']).toMatchObject({ in_sage: true, dept_ok: true, sage_name: 'Clongriffin Phase 3' });
    // SANTX exists in Finny defaults but not in this Sage company; dept 30 missing too.
    expect(byCode['SANTX']).toMatchObject({ in_sage: false, dept_ok: false });
    expect(v.fallback_dept_ok).toBe(true); // dept '0'
  });

  it('offers active Sage projects Finny lacks, skipping inactive ones', () => {
    expect(v.missing_projects).toEqual([{ reference: 'BALLY1', name: 'Ballymore Rise' }]);
  });

  it('handles junk tax codes without throwing', () => {
    const v3 = validateAgainstSage(
      { ...DEFAULT_SETTINGS, default_tax_code: 'EXEMPT' },
      ref,
    );
    expect(v3.tax_codes.find((t) => t.rate === null)).toMatchObject({ ok: false });
  });
});
