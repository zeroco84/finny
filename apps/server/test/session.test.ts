import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { config } from '../src/config.js';
import { createSessionCookie, readSession } from '../src/api/auth.js';

const saved = { secret: config.sessionSecret, hours: config.sessionMaxHours, secure: config.cookieSecure };
const reqWith = (cookieValue: string) => ({ headers: { cookie: cookieValue } }) as unknown as Request;
const cookieValue = (setCookie: string) => setCookie.split(';')[0];

beforeEach(() => {
  config.sessionSecret = 'test-secret';
  config.sessionMaxHours = 12;
  config.cookieSecure = true;
});
afterEach(() => {
  config.sessionSecret = saved.secret;
  config.sessionMaxHours = saved.hours;
  config.cookieSecure = saved.secure;
});

describe('session cookie', () => {
  it('round-trips a fresh session (role falls back to the signed value with no DB)', () => {
    const set = createSessionCookie({ email: 'a@b.co', name: 'A', role: 'lead' });
    expect(readSession(reqWith(cookieValue(set)))).toMatchObject({ email: 'a@b.co', role: 'lead' });
  });

  it('rejects a cookie past the max session lifetime', () => {
    const set = cookieValue(createSessionCookie({ email: 'a@b.co', name: 'A', role: 'lead' }));
    config.sessionMaxHours = -1; // any real cookie is now older than the window
    expect(readSession(reqWith(set))).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const set = cookieValue(createSessionCookie({ email: 'a@b.co', name: 'A', role: 'lead' }));
    expect(readSession(reqWith(set.slice(0, -2) + 'xx'))).toBeNull();
  });

  it('sets Secure only when cookieSecure is on, and Max-Age tracks sessionMaxHours', () => {
    expect(createSessionCookie({ email: 'a@b.co', name: 'A', role: 'lead' })).toContain('; Secure');
    expect(createSessionCookie({ email: 'a@b.co', name: 'A', role: 'lead' })).toContain(`Max-Age=${12 * 60 * 60}`);
    config.cookieSecure = false;
    expect(createSessionCookie({ email: 'a@b.co', name: 'A', role: 'lead' })).not.toContain('Secure');
  });
});
