import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import {
  buildFlowCookie,
  clearFlowCookie,
  entraConfigError,
  entraRedirectUri,
  readFlowCookie,
  roleForEmail,
  userFromClaims,
} from '../src/api/entra.js';

beforeAll(() => {
  config.sessionSecret = 'test-secret';
  config.appUrl = 'https://finny.example.com';
  config.leadEmails = ['amy@example.com'];
});

describe('roleForEmail / userFromClaims', () => {
  it('FINNY_LEAD_EMAILS become leads (case/whitespace-insensitive), others processors', () => {
    expect(roleForEmail('Amy@Example.com ')).toBe('lead');
    expect(roleForEmail('bob@example.com')).toBe('processor');
  });

  it('prefers the email claim, falls back to preferred_username (the UPN)', () => {
    expect(userFromClaims({ email: 'amy@example.com', name: 'Amy Byrne' })).toEqual({
      email: 'amy@example.com', name: 'Amy Byrne', role: 'lead',
    });
    expect(userFromClaims({ preferred_username: 'bob@example.com' })).toEqual({
      email: 'bob@example.com', name: 'bob@example.com', role: 'processor',
    });
  });

  it('rejects tokens with no usable email', () => {
    expect(userFromClaims({ name: 'No Mail', oid: 'guid' })).toBeNull();
    expect(userFromClaims({ preferred_username: 'not-an-email' })).toBeNull();
  });
});

describe('flow cookie (PKCE state across the redirect)', () => {
  const flow = { verifier: 'v'.repeat(43), state: 'st-1', nonce: 'n-1', iat: Date.now() };

  it('round-trips and is marked Secure + HttpOnly on https deploys', () => {
    const cookie = buildFlowCookie(flow);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(readFlowCookie(cookie.split(';')[0])).toEqual(flow);
    expect(clearFlowCookie()).toContain('Max-Age=0');
  });

  it('rejects tampered payloads and expired flows', () => {
    const cookie = buildFlowCookie(flow).split(';')[0];
    const [name, value] = cookie.split('=');
    const [payload, sig] = value.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...flow, state: 'attacker' }),
    ).toString('base64url');
    expect(readFlowCookie(`${name}=${forged}.${sig}`)).toBeNull();
    const stale = buildFlowCookie({ ...flow, iat: Date.now() - 11 * 60 * 1000 }).split(';')[0];
    expect(readFlowCookie(stale)).toBeNull();
    expect(readFlowCookie(undefined)).toBeNull();
  });
});

describe('config validation', () => {
  it('redirect URI derives from APP_URL unless overridden', () => {
    config.entra.redirectUri = '';
    expect(entraRedirectUri()).toBe('https://finny.example.com/api/auth/entra/callback');
    config.entra.redirectUri = 'https://other/cb';
    expect(entraRedirectUri()).toBe('https://other/cb');
    config.entra.redirectUri = '';
  });

  it('names the first missing variable', () => {
    const saved = { ...config.entra };
    Object.assign(config.entra, { tenantId: '', clientId: '', clientSecret: '', issuer: '' });
    expect(entraConfigError()).toMatch(/TENANT_ID/);
    config.entra.tenantId = 't';
    expect(entraConfigError()).toMatch(/CLIENT_ID/);
    config.entra.clientId = 'c';
    expect(entraConfigError()).toMatch(/CLIENT_SECRET/);
    config.entra.clientSecret = 's';
    expect(entraConfigError()).toBeNull();
    Object.assign(config.entra, saved);
  });
});
