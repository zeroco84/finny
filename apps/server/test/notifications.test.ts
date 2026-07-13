import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { all, closeDb, one, openDb, run } from '../src/db/db.js';
import { nowIso } from '../src/domain/util.js';
import { looseMatch } from '../src/domain/util.js';
import { seedDefaults } from '../src/services/settings.js';
import {
  createSubscription,
  deleteSubscription,
  evaluateSubscriptionsForInvoice,
  listSubscriptions,
  matchSubscription,
  NotificationError,
  updateSubscription,
} from '../src/services/notifications.js';

const A = 'ann@example.com';
const B = 'ben@example.com';
const HOOK = 'https://tenant.webhook.office.com/webhookb2/abc?sig=secret';

beforeEach(() => {
  closeDb();
  openDb(':memory:');
  seedDefaults();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function insertInvoice(over: Record<string, unknown> = {}): string {
  const id = over.id ? String(over.id) : `inv-${Math.floor(Math.random() * 1e9)}`;
  const now = nowIso();
  run(
    `INSERT INTO invoices (id, source, received_at, status, vendor_name, vendor_normalized, invoice_date, due_date,
       gross_cents, currency, entity, project_code, created_at, updated_at)
     VALUES (?, 'mock', ?, 'needs_review', ?, ?, ?, ?, ?, 'EUR', ?, ?, ?, ?)`,
    id,
    over.received_at ?? now,
    over.vendor_name ?? 'Hegarty Steel Ltd',
    over.vendor_normalized ?? 'HEGARTY STEEL',
    over.invoice_date ?? null,
    over.due_date ?? null,
    over.gross_cents ?? null,
    over.entity ?? 'Meadowvale Developments Ltd',
    over.project_code ?? null,
    now,
    now,
  );
  return id;
}

// ── Fuzzy matcher ────────────────────────────────────────────────────────────

describe('looseMatch', () => {
  it('matches on containment ignoring case/suffix/punctuation', () => {
    expect(looseMatch('Hegarty Steel Ltd', 'hegarty')).toBe(true);
    expect(looseMatch('Hegarty Steel Ltd.', 'HEGARTY STEEL')).toBe(true);
  });
  it('tolerates a small typo per token', () => {
    expect(looseMatch('Hegarty Steel Ltd', 'Hegary Steel')).toBe(true); // dropped a "t"
  });
  it('does not match unrelated names', () => {
    expect(looseMatch('Hegarty Steel Ltd', 'Corrib Concrete')).toBe(false);
    expect(looseMatch('Hegarty Steel Ltd', '')).toBe(false);
    expect(looseMatch(null, 'hegarty')).toBe(false);
  });
});

// ── Per-type matchers ────────────────────────────────────────────────────────

describe('matchSubscription', () => {
  it('amount_threshold fires at or over the threshold only', () => {
    expect(matchSubscription({ gross_cents: 1_000_000 }, 'amount_threshold', { min_cents: 1_000_000 }).matched).toBe(true);
    expect(matchSubscription({ gross_cents: 999_999 }, 'amount_threshold', { min_cents: 1_000_000 }).matched).toBe(false);
    expect(matchSubscription({ gross_cents: null }, 'amount_threshold', { min_cents: 1 }).matched).toBe(false);
  });

  it('date_threshold detects post-dated, back-dated and due-soon invoices', () => {
    const received = '2026-07-01T09:00:00Z';
    expect(
      matchSubscription({ received_at: received, invoice_date: '2026-08-01' }, 'date_threshold', { postdated: true }).matched,
    ).toBe(true);
    expect(
      matchSubscription({ received_at: received, invoice_date: '2026-06-30' }, 'date_threshold', { postdated: true }).matched,
    ).toBe(false);
    // back-dated 61 days > 30
    expect(
      matchSubscription({ received_at: received, invoice_date: '2026-05-01' }, 'date_threshold', { stale_days: 30 }).matched,
    ).toBe(true);
    // due within 30 days of today
    const today = nowIso().slice(0, 10);
    expect(
      matchSubscription({ due_date: addDays(today, 10) }, 'date_threshold', { due_within_days: 30 }).matched,
    ).toBe(true);
    expect(
      matchSubscription({ due_date: addDays(today, 60) }, 'date_threshold', { due_within_days: 30 }).matched,
    ).toBe(false);
  });

  it('supplier_match fuzzy-matches the vendor name', () => {
    const row = { vendor_name: 'Hegarty Steel Ltd', vendor_normalized: 'HEGARTY STEEL' };
    expect(matchSubscription(row, 'supplier_match', { query: 'hegarty steel' }).matched).toBe(true);
    expect(matchSubscription(row, 'supplier_match', { query: 'midwest plant' }).matched).toBe(false);
  });

  it('project_match resolves the code to a name and matches either', () => {
    // DOCKM = "Dock Mill" from the seeded settings.
    expect(matchSubscription({ project_code: 'DOCKM' }, 'project_match', { query: 'dock mill' }).matched).toBe(true);
    expect(matchSubscription({ project_code: 'DOCKM' }, 'project_match', { query: 'DOCKM' }).matched).toBe(true);
    expect(matchSubscription({ project_code: null }, 'project_match', { query: 'dock mill' }).matched).toBe(false);
  });
});

// ── CRUD + ownership ─────────────────────────────────────────────────────────

describe('subscription CRUD is scoped to the owner', () => {
  it('lists only the caller’s own subscriptions and never leaks the URL', () => {
    const sub = createSubscription(A, {
      label: 'Big invoices',
      event_type: 'amount_threshold',
      params: { min_cents: 1_000_000 },
      webhook_url: HOOK,
    });
    expect(sub.webhook_host).toBe('tenant.webhook.office.com');
    // The secret URL is never present on the returned shape.
    expect((sub as unknown as Record<string, unknown>).webhook_url).toBeUndefined();
    expect(listSubscriptions(A)).toHaveLength(1);
    expect(listSubscriptions(B)).toHaveLength(0);
  });

  it('another user cannot update or delete your subscription', () => {
    const sub = createSubscription(A, {
      label: 'Mine', event_type: 'supplier_match', params: { query: 'hegarty' }, webhook_url: HOOK,
    });
    expect(updateSubscription(B, sub.id, { active: false })).toBeNull();
    expect(deleteSubscription(B, sub.id)).toBe(false);
    // Owner can.
    expect(updateSubscription(A, sub.id, { active: false })?.active).toBe(false);
    expect(deleteSubscription(A, sub.id)).toBe(true);
    expect(listSubscriptions(A)).toHaveLength(0);
  });

  it('rejects invalid params and non-Microsoft webhook URLs', () => {
    expect(() =>
      createSubscription(A, { label: 'x', event_type: 'amount_threshold', params: { min_cents: 0 }, webhook_url: HOOK }),
    ).toThrow(NotificationError);
    expect(() =>
      createSubscription(A, { label: 'x', event_type: 'supplier_match', params: { query: 'a' }, webhook_url: HOOK }),
    ).toThrow(/at least 2/);
    expect(() =>
      createSubscription(A, {
        label: 'x', event_type: 'amount_threshold', params: { min_cents: 100 },
        webhook_url: 'https://evil.example.com/hook',
      }),
    ).toThrow(/Microsoft Teams/);
  });
});

// ── Evaluation + delivery ────────────────────────────────────────────────────

describe('evaluateSubscriptionsForInvoice', () => {
  it('posts one card per match and dedupes on a second run', async () => {
    createSubscription(A, {
      label: 'Big', event_type: 'amount_threshold', params: { min_cents: 1_000_000 }, webhook_url: HOOK,
    });
    const invoiceId = insertInvoice({ gross_cents: 1_500_000 });
    const fetchMock = vi.fn(async (_url: string, _opts: RequestInit) => new Response('1', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await evaluateSubscriptionsForInvoice(invoiceId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(HOOK);
    const card = JSON.parse(String(opts.body)).attachments[0].content;
    expect(card.type).toBe('AdaptiveCard');
    expect(card.actions[0].url).toContain(`/invoices/${invoiceId}`);

    const delivery = one<{ status: string }>(
      'SELECT status FROM webhook_deliveries WHERE invoice_id = ?', invoiceId,
    );
    expect(delivery?.status).toBe('sent');
    expect(one<{ last_fired_at: string }>('SELECT last_fired_at FROM webhook_subscriptions')?.last_fired_at).toBeTruthy();

    // Second run must not re-post (at-most-once per invoice per subscription).
    await evaluateSubscriptionsForInvoice(invoiceId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not fire paused subscriptions and records a failed delivery on webhook error', async () => {
    const sub = createSubscription(A, {
      label: 'Big', event_type: 'amount_threshold', params: { min_cents: 1_000_000 }, webhook_url: HOOK,
    });
    updateSubscription(A, sub.id, { active: false });
    const invoiceId = insertInvoice({ gross_cents: 1_500_000 });
    const fetchMock = vi.fn(async () => new Response('1', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await evaluateSubscriptionsForInvoice(invoiceId);
    expect(fetchMock).not.toHaveBeenCalled();

    // Re-enable and make the webhook fail — delivery is recorded as failed.
    updateSubscription(A, sub.id, { active: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await evaluateSubscriptionsForInvoice(invoiceId);
    const delivery = one<{ status: string; error: string }>(
      'SELECT status, error FROM webhook_deliveries WHERE subscription_id = ?', sub.id,
    );
    expect(delivery?.status).toBe('failed');
    expect(delivery?.error).toContain('500');
    expect(all('SELECT * FROM webhook_deliveries')).toHaveLength(1);
  });
});
