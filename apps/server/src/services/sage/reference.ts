import type { Settings } from '@finny/shared';
import { taxCodeNumber, type SageReference } from './hyperaccounts.js';

/**
 * Validation of Finny's Settings mappings against the live Sage company's
 * reference data (chart of accounts, tax codes, departments, projects).
 * Pure — the route fetches, this compares, the UI renders chips.
 */

export interface CategoryCheck {
  name: string;
  nominal_code: string;
  ok: boolean;
  sage_name: string | null;
  inactive: boolean;
}

export interface TaxCodeCheck {
  /** VAT rate this code is mapped from, or null for the default code. */
  rate: string | null;
  code: string;
  ok: boolean;
  rate_matches: boolean;
  sage_rate: number | null;
  sage_description: string | null;
}

export interface ProjectCheck {
  code: string;
  name: string;
  dept: string;
  /** Entity the project is assigned to ('' = unassigned, checked everywhere). */
  entity: string;
  in_sage: boolean;
  dept_ok: boolean;
  sage_name: string | null;
}

export interface ReferenceValidation {
  categories: CategoryCheck[];
  tax_codes: TaxCodeCheck[];
  fallback_dept_ok: boolean;
  projects: ProjectCheck[];
  /** Active Sage projects Finny doesn't know — offered as one-click imports. */
  missing_projects: { reference: string; name: string }[];
}

function checkTaxCode(code: string, rate: string | null, ref: SageReference): TaxCodeCheck {
  let index: number | null = null;
  try {
    index = taxCodeNumber(code);
  } catch {
    index = null;
  }
  const sage = index === null ? undefined : ref.taxCodes.find((t) => t.index === index);
  const expected = rate === null ? null : Number(rate);
  return {
    rate,
    code,
    ok: Boolean(sage),
    // No expected rate (default code) counts as matching; T9-style 0% codes
    // carry rate 0 in Sage, so the sheet's zero-VAT convention checks clean.
    rate_matches: Boolean(sage) && (expected === null || sage!.rate === expected),
    sage_rate: sage ? sage.rate : null,
    sage_description: sage ? sage.description : null,
  };
}

export function validateAgainstSage(
  settings: Settings,
  ref: SageReference,
  entity: string | null = null,
): ReferenceValidation {
  const nominalByRef = new Map(ref.nominals.map((n) => [n.accountRef, n]));
  const deptRefs = new Set(ref.departments.map((d) => d.reference));
  const projectByRef = new Map(ref.projects.map((p) => [p.reference.toUpperCase(), p]));
  const finnyCodes = new Set(settings.projects.map((p) => p.code.toUpperCase()));
  // One Sage company holds one entity's projects — when a specific entity is
  // being checked, another entity's projects are EXPECTED to be absent, so
  // only that entity's own (plus still-unassigned) projects are validated.
  const scopedProjects = settings.projects.filter(
    (p) => !entity || !p.entity || p.entity === entity,
  );

  return {
    categories: settings.categories.map((c) => {
      const nominal = nominalByRef.get(c.nominal_code);
      return {
        name: c.name,
        nominal_code: c.nominal_code,
        ok: Boolean(nominal) && nominal!.inactiveFlag === 0,
        sage_name: nominal ? nominal.name : null,
        inactive: Boolean(nominal) && nominal!.inactiveFlag !== 0,
      };
    }),
    tax_codes: [
      ...Object.entries(settings.tax_codes).map(([rate, code]) => checkTaxCode(code, rate, ref)),
      checkTaxCode(settings.default_tax_code, null, ref),
    ],
    fallback_dept_ok: deptRefs.has(settings.sage_department),
    projects: scopedProjects.map((p) => {
      const sage = projectByRef.get(p.code.toUpperCase());
      return {
        code: p.code,
        name: p.name,
        dept: p.dept,
        entity: p.entity,
        in_sage: Boolean(sage),
        dept_ok: deptRefs.has(p.dept),
        sage_name: sage ? sage.name : null,
      };
    }),
    missing_projects: ref.projects
      .filter((p) => (p.statusID === undefined || p.statusID === '1') && !finnyCodes.has(p.reference.toUpperCase()))
      .map((p) => ({ reference: p.reference, name: p.name })),
  };
}
