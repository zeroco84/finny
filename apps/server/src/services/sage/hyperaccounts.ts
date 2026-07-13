import type { Settings } from '@finny/shared';
import { config } from '../../config.js';
import { toSageDate } from '../../domain/util.js';
import { buildDetails, taxCodeForRate, type SageLineInput } from '../sage.js';
import { buildAttachmentLink } from '../attachmentLinks.js';

/**
 * Client for the HyperAccounts REST API (Hyperext's on-prem wrapper around
 * Sage 50). One server wraps one Sage company dataset, so servers are
 * resolved per legal entity. Endpoints used:
 *   GET  /api/status                    health check
 *   POST /api/purchaseInvoice           TransactionPost -> PI in the ledger
 *   POST /api/search/auditHeaders       preflight: has this invRef already posted?
 */

export interface SageServer {
  url: string;
  key: string;
  entity: string; // display only
}

export class HyperAccountsError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

/** Server for an entity: explicit per-entity config, else the default. */
export function resolveSageServer(entity: string | null): SageServer | null {
  const byEntity = entity ? config.sage.entityServers[entity] : undefined;
  if (byEntity?.url) return { ...byEntity, entity: entity ?? 'default' };
  if (config.sage.defaultServer.url) {
    return { ...config.sage.defaultServer, entity: entity ?? 'default' };
  }
  return null;
}

export function configuredSageEntities(): string[] {
  const named = Object.keys(config.sage.entityServers);
  return config.sage.defaultServer.url ? ['*', ...named] : named;
}

async function haFetch<T>(server: SageServer, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${server.url.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        [config.sage.apiKeyHeader]: server.key,
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    throw new HyperAccountsError(
      `HyperAccounts server for ${server.entity} unreachable (${server.url}): ${err instanceof Error ? err.message : err}`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    throw new HyperAccountsError(
      `HyperAccounts ${path} returned ${res.status}: ${text.slice(0, 300)}`,
      res.status,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HyperAccountsError(`HyperAccounts ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

export async function checkSageStatus(server: SageServer): Promise<void> {
  await haFetch(server, '/api/status');
}

/** The TransactionPost body for POST /api/purchaseInvoice. */
export interface PurchaseInvoicePayload {
  accountRef: string;
  invRef: string;
  date: string; // dd/mm/yyyy
  details: string;
  items: {
    nominalCode: string;
    taxCode: number;
    netAmount: number;
    taxAmount: number;
    details: string;
    departmentNumber: number;
    projectRef: string;
    exRef?: string;
    isNegativeLine: 0;
    externalFileURL: string;
  }[];
}


/** 'T1' -> 1 (the API takes tax codes as integers). */
export function taxCodeNumber(code: string): number {
  const n = Number(code.replace(/^t/i, ''));
  if (!Number.isInteger(n) || n < 0) {
    throw new HyperAccountsError(`Tax code "${code}" cannot be converted to a Sage tax code number`);
  }
  return n;
}

/**
 * Map one Finny invoice (as a SageLineInput + its id) onto the API body.
 * Field limits per the HyperAccounts reference: accountRef<=8, invRef<=30,
 * details<=60, item exRef<=8, projectRef<=12, departmentNumber int.
 */
export function buildPurchaseInvoicePayload(
  invoiceId: string,
  line: SageLineInput,
  settings: Settings,
): PurchaseInvoicePayload {
  const nominal = settings.categories.find((c) => c.name === line.category)?.nominal_code;
  if (!nominal) {
    throw new HyperAccountsError(`No nominal code configured for category "${line.category}"`);
  }
  if (line.supplier_account_ref.length === 0 || line.supplier_account_ref.length > 8) {
    throw new HyperAccountsError(
      `Supplier A/C "${line.supplier_account_ref}" must be 1-8 characters for Sage`,
    );
  }
  const netCents = line.net_cents ?? line.gross_cents - (line.vat_cents ?? 0);
  const vatCents = line.vat_cents ?? line.gross_cents - netCents;
  const taxCodeStr = vatCents === 0
    ? settings.tax_codes['0'] ?? settings.default_tax_code
    : taxCodeForRate(line.vat_rate, settings);
  const deptRaw = line.project_code
    ? settings.projects.find((p) => p.code === line.project_code)?.dept ?? settings.sage_department
    : settings.sage_department;
  const dept = Number(deptRaw);
  const details = buildDetails(line).slice(0, 60);
  const exRef = line.po_number && line.po_number.length <= 8 ? line.po_number : undefined;

  return {
    accountRef: line.supplier_account_ref,
    invRef: line.posting_ref.slice(0, 30),
    date: toSageDate(line.invoice_date) || toSageDate(new Date().toISOString().slice(0, 10)),
    details,
    items: [
      {
        nominalCode: nominal,
        taxCode: taxCodeNumber(taxCodeStr),
        netAmount: netCents / 100,
        taxAmount: vatCents / 100,
        details,
        departmentNumber: Number.isInteger(dept) ? dept : 0,
        projectRef: (line.project_code ?? '').slice(0, 12),
        ...(exRef ? { exRef } : {}),
        isNegativeLine: 0,
        externalFileURL: buildAttachmentLink(invoiceId, { scope: 'sage', createdBy: 'sage-export' }),
      },
    ],
  };
}

interface HaPostResponse {
  success: boolean;
  code: number;
  response: number; // the Sage transaction number
  message: string | null;
}

export async function postPurchaseInvoice(
  server: SageServer,
  payload: PurchaseInvoicePayload,
): Promise<number> {
  const out = await haFetch<HaPostResponse>(server, '/api/purchaseInvoice', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!out.success || typeof out.response !== 'number') {
    throw new HyperAccountsError(
      `purchaseInvoice rejected: ${out.message ?? `success=${out.success}`}`,
    );
  }
  return out.response;
}

export interface AuditHeaderHit {
  tranNumber: number;
  invRef: string;
  invRefNumeric?: number;
  accountRef: string;
  grossAmount: number;
  details?: string;
  type: string;
  deletedFlag: number;
}

interface HaSearchResponse {
  results?: AuditHeaderHit[];
  success?: boolean;
}

async function searchAuditHeaders(
  server: SageServer,
  filters: { field: string; type: string; value: string; or?: boolean }[],
): Promise<AuditHeaderHit[]> {
  const out = await haFetch<HaSearchResponse>(server, '/api/search/auditHeaders', {
    method: 'POST',
    body: JSON.stringify(filters),
  });
  return (out.results ?? []).filter((r) => r.type === 'PI' && r.deletedFlag === 0);
}

function grossMatches(sageGross: number, grossCents: number): boolean {
  return Math.abs(sageGross - grossCents / 100) < 0.005;
}

/**
 * Preflight 1 — our own ref: every live PI carrying this invRef (Sage does
 * not enforce ref uniqueness, so there can be more than one). The caller
 * adopts the one that matches supplier + amount (a previous Finny send that
 * crashed before storing its transaction number), or treats a foreign match
 * as a ref collision and reassigns.
 */
export async function findPurchaseTxByRef(
  server: SageServer,
  invRef: string,
): Promise<AuditHeaderHit[]> {
  return searchAuditHeaders(server, [
    { field: 'INV_REF', type: 'eq', value: invRef },
    { field: 'TYPE', type: 'eq', value: 'PI' },
  ]);
}

export function isOwnPosting(hit: AuditHeaderHit, accountRef: string, grossCents: number): boolean {
  return hit.accountRef === accountRef && grossMatches(hit.grossAmount, grossCents);
}

/**
 * The Details search term for duplicate detection, normalized the way the
 * team's posting convention writes supplier refs: "INV-4590" is posted as
 * "Inv4590 - Vendor", so the digits are what both forms share. Returns null
 * when the ref is too short to match on safely.
 */
export function duplicateSearchNeedle(supplierInvoiceRef: string | null): string | null {
  const raw = (supplierInvoiceRef ?? '').trim();
  const bare = raw.replace(/^inv[\s-]*/i, '');
  const needle = bare.length >= 4 ? bare : raw;
  return needle.length >= 4 ? needle : null;
}

/**
 * Preflight 2 — someone already posted this supplier invoice by hand: same
 * supplier account, the supplier's invoice number appearing in the Details
 * (the team's posting convention), and the same gross amount.
 */
export async function findDuplicateInSage(
  server: SageServer,
  accountRef: string,
  supplierInvoiceRef: string | null,
  grossCents: number,
  ownPostingRef: string,
): Promise<AuditHeaderHit | null> {
  const needle = duplicateSearchNeedle(supplierInvoiceRef);
  if (!needle) return null;
  const hits = await searchAuditHeaders(server, [
    { field: 'ACCOUNT_REF', type: 'eq', value: accountRef },
    { field: 'TYPE', type: 'eq', value: 'PI' },
    { field: 'DETAILS', type: 'like', value: needle },
  ]);
  return (
    hits.find((h) => h.invRef !== ownPostingRef && grossMatches(h.grossAmount, grossCents)) ?? null
  );
}

// ── Reference data (Settings "Check against Sage") ──────────────────────────

export interface SageNominal { accountRef: string; name: string; inactiveFlag: number }
export interface SageTaxCode { index: number; description: string; rate: number }
export interface SageDepartment { reference: string; name: string }
export interface SageProjectRecord { reference: string; name: string; statusID: string }

export interface SageReference {
  nominals: SageNominal[];
  taxCodes: SageTaxCode[];
  departments: SageDepartment[];
  projects: SageProjectRecord[];
}

/** The entity's ACTIVE nominal codes — the coding list Finny adopts. */
export async function fetchActiveNominals(server: SageServer): Promise<SageNominal[]> {
  const out = await haFetch<{ results?: SageNominal[] }>(server, '/api/nominal/');
  return (out.results ?? []).filter((n) => n.inactiveFlag === 0);
}

/**
 * The entity's live department list — feeds the Settings department pickers,
 * so Dept codes are chosen from what Sage actually contains, not typed from
 * memory. Bounded: the UI fires one of these per entity on page load, and a
 * dead on-prem box must not hold the page hostage.
 */
export async function fetchDepartments(server: SageServer): Promise<SageDepartment[]> {
  const out = await haFetch<{ results?: SageDepartment[] }>(server, '/api/department', {
    signal: AbortSignal.timeout(8000),
  });
  return out.results ?? [];
}

/**
 * Pull the company's live reference lists — chart of accounts, tax codes,
 * departments, projects — so Finny's mappings can be validated against what
 * Sage actually contains instead of being typed from memory.
 */
export async function fetchSageReference(server: SageServer): Promise<SageReference> {
  const [nominals, taxCodes, departments, projects] = await Promise.all([
    haFetch<{ results?: SageNominal[] }>(server, '/api/nominal/'),
    haFetch<{ results?: SageTaxCode[] }>(server, '/api/taxCode'),
    haFetch<{ results?: SageDepartment[] }>(server, '/api/department'),
    // Empty filter list = no constraints; returns the PROJECT table.
    haFetch<{ results?: SageProjectRecord[] }>(server, '/api/searchProject', {
      method: 'POST',
      body: JSON.stringify([]),
    }),
  ]);
  return {
    nominals: nominals.results ?? [],
    taxCodes: taxCodes.results ?? [],
    departments: departments.results ?? [],
    projects: projects.results ?? [],
  };
}

/**
 * Preflight 3 — sequencing: the highest Inv-series PI reference already in
 * Sage (posted by anyone), so Finny's counter can fast-forward past manual
 * postings instead of colliding with them. Bounded to the last year.
 */
export async function findMaxPostingNumber(server: SageServer): Promise<number | null> {
  const since = new Date();
  since.setFullYear(since.getFullYear() - 1);
  const dd = String(since.getDate()).padStart(2, '0');
  const mm = String(since.getMonth() + 1).padStart(2, '0');
  const hits = await searchAuditHeaders(server, [
    { field: 'INV_REF', type: 'like', value: 'Inv' },
    { field: 'TYPE', type: 'eq', value: 'PI' },
    { field: 'DATE', type: 'gte', value: `${dd}/${mm}/${since.getFullYear()}` },
  ]);
  let max: number | null = null;
  for (const h of hits) {
    const n = h.invRefNumeric ?? Number((h.invRef.match(/(\d+)/) ?? [])[1]);
    if (Number.isFinite(n) && n > 0 && (max === null || n > max)) max = n;
  }
  return max;
}
