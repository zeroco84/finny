import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { config, hardeningProblems, isLocalAppUrl, MIN_STATIC_TOKEN_LENGTH } from '../src/config.js';
import { closeDb, one, openDb, run } from '../src/db/db.js';
import { createSessionCookie, readSession } from '../src/api/auth.js';
import { createApp } from '../src/index.js';
import { RATE_LIMITS } from '../src/api/routes.js';
import { seedDefaults, getSettings } from '../src/services/settings.js';
import { nowIso } from '../src/domain/util.js';
import { ensureTeamMemberOnSignIn } from '../src/services/team.js';
import type { Request } from 'express';

/**
 * The September 2026 hardening pass: boot guards, response headers, rate
 * limits, request-shape validation on the AP Lead's PATCH routes, and the
 * directory check on SSO sessions. Each test names the finding it closes.
 */

const strongToken = 'x'.repeat(MIN_STATIC_TOKEN_LENGTH);

describe('boot guards (M1, M4)', () => {
  it('recognises local origins', () => {
    expect(isLocalAppUrl('http://localhost:5173')).toBe(true);
    expect(isLocalAppUrl('http://127.0.0.1:4787')).toBe(true);
    expect(isLocalAppUrl('https://finny.example.com')).toBe(false);
    expect(isLocalAppUrl('not a url')).toBe(false);
  });

  it('refuses dev sign-in on a public URL unless explicitly allowed', () => {
    const base = { ...config, authProvider: 'dev' as const, appUrl: 'https://finny.example.com', allowDevAuth: false };
    expect(hardeningProblems(base).join('\n')).toMatch(/AUTH_PROVIDER=dev/);
    expect(hardeningProblems({ ...base, allowDevAuth: true })).toEqual([]);
    expect(hardeningProblems({ ...base, appUrl: 'http://localhost:5173' })).toEqual([]);
    expect(hardeningProblems({ ...base, authProvider: 'entra' })).toEqual([]);
  });

  it('refuses short machine tokens but accepts unset ones (the endpoint fails shut instead)', () => {
    const base = { ...config, authProvider: 'entra' as const, appUrl: 'https://finny.example.com' };
    expect(hardeningProblems({ ...base, approvalsCallbackToken: 'short' }).join('\n')).toMatch(
      /APPROVALS_CALLBACK_TOKEN is 5 characters/,
    );
    expect(hardeningProblems({ ...base, blockdocsToken: 'short' }).join('\n')).toMatch(/FINNY_BLOCKDOCS_TOKEN/);
    expect(hardeningProblems({ ...base, approvalsFlowSecret: 'short' }).join('\n')).toMatch(/APPROVALS_FLOW_SECRET/);
    expect(
      hardeningProblems({
        ...base,
        approvalsCallbackToken: strongToken,
        blockdocsToken: strongToken,
        approvalsFlowSecret: strongToken,
      }),
    ).toEqual([]);
    expect(hardeningProblems({ ...base, approvalsCallbackToken: '', blockdocsToken: '' })).toEqual([]);
  });
});

describe('SSO sessions end when the person leaves the directory (M6)', () => {
  const saved = { secret: config.sessionSecret, auth: config.authProvider, leads: config.leadEmails };
  const reqWith = (user: { email: string; name: string; role: 'processor' | 'lead' }) =>
    ({ headers: { cookie: createSessionCookie(user).split(';')[0] } }) as unknown as Request;
  const member = (email: string, inGroup: number) =>
    run(
      `INSERT INTO team_members (email, name, role, source, in_group, updated_at) VALUES (?, ?, 'processor', 'group', ?, ?)`,
      email, email, inGroup, nowIso(),
    );

  beforeEach(() => {
    closeDb();
    openDb(':memory:');
    config.sessionSecret = 'test-secret';
    config.authProvider = 'entra';
    config.leadEmails = [];
  });
  afterEach(() => {
    config.sessionSecret = saved.secret;
    config.authProvider = saved.auth;
    config.leadEmails = saved.leads;
  });

  it('accepts a current member and rejects an unknown email or one flagged out of the group', () => {
    member('in@example.com', 1);
    member('left@example.com', 0);
    expect(readSession(reqWith({ email: 'in@example.com', name: 'In', role: 'processor' }))).toMatchObject({
      email: 'in@example.com',
    });
    expect(readSession(reqWith({ email: 'left@example.com', name: 'Left', role: 'processor' }))).toBeNull();
    expect(readSession(reqWith({ email: 'ghost@example.com', name: 'Ghost', role: 'lead' }))).toBeNull();
  });

  it('never locks out a FINNY_LEAD_EMAILS pin', () => {
    config.leadEmails = ['pin@example.com'];
    expect(readSession(reqWith({ email: 'pin@example.com', name: 'Pin', role: 'processor' }))).toMatchObject({
      role: 'lead',
    });
  });

  it('leaves dev sign-in alone (anyone can re-login there anyway)', () => {
    config.authProvider = 'dev';
    expect(readSession(reqWith({ email: 'ghost@example.com', name: 'Ghost', role: 'processor' }))).toMatchObject({
      email: 'ghost@example.com',
    });
  });
});

describe('HTTP hardening over the real app (M3, M4, M5, L4)', () => {
  const saved = { secret: config.sessionSecret, leads: config.leadEmails, auth: config.authProvider, secure: config.cookieSecure };
  let server: Server;
  let base: string;
  let lead = '';
  const json = (method: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, { method, headers: { cookie: lead, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeEach(async () => {
    closeDb();
    openDb(':memory:');
    seedDefaults();
    config.sessionSecret = 'test-secret';
    config.authProvider = 'dev';
    config.cookieSecure = true;
    config.leadEmails = ['lead@example.com'];
    // Signed after the test secret is in place, or every request is a 401.
    lead = createSessionCookie({ email: 'lead@example.com', name: 'Lead', role: 'lead' }).split(';')[0];
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    config.sessionSecret = saved.secret;
    config.leadEmails = saved.leads;
    config.authProvider = saved.auth;
    config.cookieSecure = saved.secure;
  });

  it('sends the security headers on every response, HSTS only when cookies are Secure', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    expect(res.headers.get('content-security-policy')).toContain("frame-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age=\d+/);
    expect(res.headers.get('x-powered-by')).toBeNull();
    config.cookieSecure = false;
    expect((await fetch(`${base}/api/health`)).headers.get('strict-transport-security')).toBeNull();
  });

  it('rate-limits the public attachment route per IP', async () => {
    const url = `${base}/api/public/invoices/x/attachment?t=nope`;
    let last = 0;
    for (let i = 0; i < RATE_LIMITS.public.limit + 1; i++) {
      last = (await fetch(url)).status;
    }
    expect(last).toBe(429);
    // The session-gated API is untouched by the limiter.
    expect((await fetch(`${base}/api/overview`, { headers: { cookie: lead } })).status).toBe(200);
  });

  it('rejects a settings patch that would break getSettings(), keeps a valid one', async () => {
    const bad = await json('PATCH', '/api/settings', { projects: 'not-a-list' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/projects/);
    expect(getSettings().projects.length).toBeGreaterThan(0);
    expect((await json('PATCH', '/api/settings', { mode: 'chaos' })).status).toBe(400);
    expect((await json('PATCH', '/api/settings', { next_posting_ref: -3 })).status).toBe(400);

    const ok = await json('PATCH', '/api/settings', { mode: 'live', next_posting_ref: 20001 });
    expect(ok.status).toBe(200);
    expect(getSettings()).toMatchObject({ mode: 'live', next_posting_ref: 20001 });
  });

  it('validates approver and rule patches instead of binding raw JSON', async () => {
    const approver = one<{ id: string }>('SELECT id FROM approvers LIMIT 1')!;
    expect((await json('PATCH', `/api/approvers/${approver.id}`, { email: 'not-an-email' })).status).toBe(400);
    expect((await json('PATCH', `/api/approvers/${approver.id}`, { name: { evil: true } })).status).toBe(400);
    const ok = await json('PATCH', `/api/approvers/${approver.id}`, { name: 'Renamed Person', active: false });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ name: 'Renamed Person', active: false });

    run(
      `INSERT INTO rules (id, kind, vendor_pattern, vendor_normalized, status, origin, created_by, created_at, updated_at)
       VALUES ('r1', 'routing', 'Acme', 'ACME', 'active', 'manual', 'lead@example.com', ?, ?)`,
      nowIso(), nowIso(),
    );
    expect((await json('PATCH', '/api/rules/r1', { category: 42 })).status).toBe(400);
    expect((await json('PATCH', '/api/rules/r1', { status: 'retired' })).status).toBe(400); // not patchable here
    expect((await json('PATCH', '/api/rules/r1', { category: 'Materials' })).status).toBe(200);
  });
});

describe('a directory seat is pinned to one Entra account (L2)', () => {
  const saved = { secret: config.sessionSecret, auth: config.authProvider, leads: config.leadEmails, provider: config.team.provider };
  const reqWith = (user: { email: string; name: string; role: 'processor' | 'lead'; oid?: string }) =>
    ({ headers: { cookie: createSessionCookie(user).split(';')[0] } }) as unknown as Request;

  beforeEach(() => {
    closeDb();
    openDb(':memory:');
    config.sessionSecret = 'test-secret';
    config.authProvider = 'entra';
    config.leadEmails = [];
    config.team.provider = 'mock';
  });
  afterEach(() => {
    config.sessionSecret = saved.secret;
    config.authProvider = saved.auth;
    config.leadEmails = saved.leads;
    config.team.provider = saved.provider;
  });

  it('records the object id on first sign-in and refuses a different account with the same email', () => {
    const first = { email: 'niamh@example.com', name: 'Niamh', role: 'processor' as const, oid: 'oid-niamh' };
    expect(ensureTeamMemberOnSignIn(first)).toBe('lead'); // first-user bootstrap
    expect(one<{ entra_oid: string }>(`SELECT entra_oid FROM team_members WHERE email = 'niamh@example.com'`)?.entra_oid).toBe('oid-niamh');
    expect(() => ensureTeamMemberOnSignIn({ ...first, oid: 'oid-guest' })).toThrow(/different account/);
    expect(ensureTeamMemberOnSignIn(first)).toBe('lead'); // the real account still signs in
  });

  it('a cookie minted for another account is rejected once the seat is pinned, even for a config lead', () => {
    run(
      `INSERT INTO team_members (email, name, role, source, in_group, updated_at, entra_oid) VALUES ('pin@example.com', 'Pin', 'lead', 'config', 1, ?, 'oid-pin')`,
      nowIso(),
    );
    config.leadEmails = ['pin@example.com'];
    expect(readSession(reqWith({ email: 'pin@example.com', name: 'Pin', role: 'lead', oid: 'oid-pin' }))).toMatchObject({ role: 'lead', oid: 'oid-pin' });
    expect(readSession(reqWith({ email: 'pin@example.com', name: 'Pin', role: 'lead', oid: 'oid-other' }))).toBeNull();
    // A legacy cookie with no oid (minted before this change) still works until it expires.
    expect(readSession(reqWith({ email: 'pin@example.com', name: 'Pin', role: 'lead' }))).toMatchObject({ role: 'lead' });
  });
});
