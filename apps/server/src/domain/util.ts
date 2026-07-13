import crypto from 'node:crypto';

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** "Hegarty Steel Ltd." -> "HEGARTY STEEL" — used as the rule-matching key. */
export function normalizeVendor(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9 &]/g, ' ')
    .replace(/\b(LIMITED|LTD|PLC|LLP|LLC|INC|GMBH|CO|COMPANY|UC|DAC)\b\.?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Suggest a Sage supplier account ref from a vendor name, e.g. "HEGARTYS1". */
export function suggestAccountRef(vendorName: string): string {
  const compact = normalizeVendor(vendorName).replace(/[^A-Z0-9]/g, '');
  return (compact.slice(0, 7) || 'SUPPLIER') + '1';
}

/** Parse a money string like "1,234.56" or "€1 234,56"-ish inputs into cents. */
export function parseMoneyToCents(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') {
    return Number.isFinite(input) ? Math.round(input * 100) : null;
  }
  const cleaned = input.replace(/[€$£\s]/g, '').replace(/,(?=\d{3}(\D|$))/g, '');
  const normalized = /,\d{1,2}$/.test(cleaned) ? cleaned.replace(',', '.') : cleaned;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

export function centsToDecimal(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2);
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Parse common invoice date formats into yyyy-mm-dd (dd/mm/yyyy assumed — IE/UK). */
export function parseInvoiceDate(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})$/);
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (month) return `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  // "02-Jul-26" / "2 Jul 26" — the cost-estimating payment certificates use this.
  m = s.match(/^(\d{1,2})[\s\/\-.]([A-Za-z]{3,}),?[\s\/\-.](\d{2,4})$/);
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    if (month) return `${year}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

/** yyyy-mm-dd -> dd/mm/yyyy for Sage import. */
export function toSageDate(isoDate: string | null): string {
  if (!isoDate) return '';
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** Normalise for loose matching: uppercase, non-alphanumerics → single spaces. */
function normalizeLoose(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Levenshtein edit distance (iterative, two-row) — for short-token typo tolerance. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Two tokens are "close" when their edit-distance similarity ≥ 0.82 (len ≥ 4). */
function tokensClose(a: string, b: string): boolean {
  if (a.length < 4 || b.length < 4) return false;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length) >= 0.82;
}

/**
 * Deterministic, typo-tolerant fuzzy match for supplier/project alerts.
 * Normalises both sides, then matches on whole-string containment, full
 * query-token subset (each query token found in the candidate as a substring or
 * a close typo of one of its tokens). Empty candidate or query never matches.
 */
export function looseMatch(candidate: string | null | undefined, query: string | null | undefined): boolean {
  const c = normalizeLoose(candidate ?? '');
  const q = normalizeLoose(query ?? '');
  if (!c || !q) return false;
  if (c.includes(q) || q.includes(c)) return true;
  const cTokens = c.split(' ').filter(Boolean);
  const qTokens = q.split(' ').filter(Boolean);
  return qTokens.every((qt) => cTokens.some((ct) => ct.includes(qt) || qt.includes(ct) || tokensClose(ct, qt)));
}

export function isoWeekLabel(dateIso: string): string {
  const d = new Date(dateIso);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
