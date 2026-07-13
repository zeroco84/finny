import { beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, run } from '../src/db/db.js';
import { newId } from '../src/domain/util.js';
import { audit, auditLogCsv, auditFilterOptions, listAuditLog } from '../src/services/audit.js';

beforeEach(() => {
  closeDb();
  openDb(':memory:');
});

function insertEvent(type: string, actor: string, createdAt: string, invoiceId: string | null = null, detail = {}) {
  run(
    'INSERT INTO audit_events (id, invoice_id, type, actor, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    newId(), invoiceId, type, actor, JSON.stringify(detail), createdAt,
  );
}

function insertInvoice(id: string, entity: string | null, vendor: string | null) {
  run(
    `INSERT INTO invoices (id, source, received_at, entity, vendor_name, created_at, updated_at)
     VALUES (?, 'mock_email', ?, ?, ?, ?, ?)`,
    id, '2026-07-01T09:00:00.000Z', entity, vendor, '2026-07-01T09:00:00.000Z', '2026-07-01T09:00:00.000Z',
  );
}

describe('audit trail is append-only (compliance)', () => {
  it('rejects UPDATEs and DELETEs at the database level', () => {
    audit(null, 'signed_in', 'aoife@example.com', { provider: 'dev' });
    expect(() => run("UPDATE audit_events SET actor = 'tampered'")).toThrowError(/append-only/);
    expect(() => run('DELETE FROM audit_events')).toThrowError(/append-only/);
    expect(listAuditLog({}).total).toBe(1);
    expect(listAuditLog({}).events[0].actor).toBe('aoife@example.com');
  });
});

describe('listAuditLog', () => {
  it('returns newest first with insertion order as the tiebreaker', () => {
    insertEvent('received', 'system', '2026-07-01T10:00:00.000Z');
    insertEvent('confirmed', 'aoife@example.com', '2026-07-02T10:00:00.000Z');
    insertEvent('signed_in', 'brian@example.com', '2026-07-02T10:00:00.000Z'); // same instant, inserted later
    const page = listAuditLog({});
    expect(page.total).toBe(3);
    expect(page.events.map((e) => e.type)).toEqual(['signed_in', 'confirmed', 'received']);
    expect(page.next_cursor).toBeNull();
  });

  it('filters by actor, type and date range (inclusive)', () => {
    insertEvent('confirmed', 'aoife@example.com', '2026-07-01T10:00:00.000Z');
    insertEvent('discarded', 'aoife@example.com', '2026-07-02T10:00:00.000Z');
    insertEvent('confirmed', 'brian@example.com', '2026-07-03T10:00:00.000Z');

    expect(listAuditLog({ actor: 'aoife@example.com' }).total).toBe(2);
    expect(listAuditLog({ type: 'confirmed' }).total).toBe(2);
    expect(listAuditLog({ from: '2026-07-02', to: '2026-07-03' }).total).toBe(2);
    expect(listAuditLog({ from: '2026-07-03' }).total).toBe(1);
    expect(listAuditLog({ to: '2026-07-01' }).total).toBe(1);
    expect(listAuditLog({ actor: 'aoife@example.com', type: 'confirmed' }).total).toBe(1);
  });

  it('joins the linked invoice for entity/vendor display and filtering', () => {
    insertInvoice('inv-1', 'Larkin Homes Ltd', 'Hegarty Steel');
    insertInvoice('inv-2', 'Larkin Civils Ltd', 'Acme Plant Hire');
    insertEvent('confirmed', 'aoife@example.com', '2026-07-01T10:00:00.000Z', 'inv-1');
    insertEvent('confirmed', 'aoife@example.com', '2026-07-02T10:00:00.000Z', 'inv-2');
    insertEvent('settings_changed', 'aoife@example.com', '2026-07-03T10:00:00.000Z'); // no invoice

    const page = listAuditLog({ entity: 'Larkin Homes Ltd' });
    expect(page.total).toBe(1);
    expect(page.events[0]).toMatchObject({ invoice_id: 'inv-1', entity: 'Larkin Homes Ltd', vendor_name: 'Hegarty Steel' });

    // Events with no invoice carry null context but still appear unfiltered.
    const all = listAuditLog({});
    expect(all.events[0]).toMatchObject({ type: 'settings_changed', entity: null, vendor_name: null });
  });

  it('free-text search spans type, actor, detail and vendor', () => {
    insertInvoice('inv-1', 'Larkin Homes Ltd', 'Hegarty Steel');
    insertEvent('confirmed', 'aoife@example.com', '2026-07-01T10:00:00.000Z', 'inv-1');
    insertEvent('mode_changed', 'brian@example.com', '2026-07-02T10:00:00.000Z', null, { from: 'shadow', to: 'live' });

    expect(listAuditLog({ q: 'hegarty' }).total).toBe(1);
    expect(listAuditLog({ q: 'shadow' }).total).toBe(1);
    expect(listAuditLog({ q: 'aoife' }).total).toBe(1);
    expect(listAuditLog({ q: 'nomatch' }).total).toBe(0);
  });

  it('paginates with a keyset cursor — no duplicates or gaps', () => {
    for (let i = 0; i < 25; i++) {
      insertEvent('received', 'system', `2026-07-01T10:00:${String(i % 10).padStart(2, '0')}.000Z`);
    }
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = listAuditLog({}, { before: cursor, limit: 10 });
      expect(page.total).toBe(25);
      page.events.forEach((e) => seen.add(e.id));
      pages += 1;
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    expect(pages).toBe(3);
    expect(seen.size).toBe(25);
  });
});

describe('auditFilterOptions', () => {
  it('returns distinct actors and types, sorted', () => {
    insertEvent('confirmed', 'brian@example.com', '2026-07-01T10:00:00.000Z');
    insertEvent('confirmed', 'aoife@example.com', '2026-07-02T10:00:00.000Z');
    insertEvent('signed_in', 'aoife@example.com', '2026-07-03T10:00:00.000Z');
    expect(auditFilterOptions()).toEqual({
      actors: ['aoife@example.com', 'brian@example.com'],
      types: ['confirmed', 'signed_in'],
    });
  });
});

describe('auditLogCsv', () => {
  it('produces a header row and escapes quotes/commas', () => {
    insertInvoice('inv-1', 'Larkin Homes Ltd', 'Acme, "Steel" Ltd');
    insertEvent('confirmed', 'aoife@example.com', '2026-07-01T10:00:00.000Z', 'inv-1', { note: 'ok' });
    const { csv, rows, truncated } = auditLogCsv({});
    expect(rows).toBe(1);
    expect(truncated).toBe(false);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('time,action,actor,invoice_id,vendor,entity,detail');
    expect(lines[1]).toContain('"Acme, ""Steel"" Ltd"');
    expect(lines[1]).toContain('confirmed,aoife@example.com,inv-1');
  });

  it('neutralises spreadsheet formulas in invoice-derived fields', () => {
    insertInvoice('inv-1', 'Larkin Homes Ltd', '=HYPERLINK("https://evil","click")');
    insertEvent('confirmed', 'aoife@example.com', '2026-07-01T10:00:00.000Z', 'inv-1');
    const { csv } = auditLogCsv({});
    expect(csv).toContain(`'=HYPERLINK`);
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it('honours the same filters as the list', () => {
    insertEvent('confirmed', 'aoife@example.com', '2026-07-01T10:00:00.000Z');
    insertEvent('signed_in', 'brian@example.com', '2026-07-02T10:00:00.000Z');
    const { csv, rows } = auditLogCsv({ actor: 'brian@example.com' });
    expect(rows).toBe(1);
    expect(csv).toContain('signed_in');
    expect(csv).not.toContain('confirmed');
  });
});
