import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { SessionUser } from '@finny/shared';
import { config } from '../config.js';
import { resolveRole } from '../services/team.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
  }
}

const COOKIE_NAME = 'finny_session';

/**
 * Dev auth: an HMAC-signed session cookie set by /api/auth/dev-login.
 *
 * Production path (Entra ID SSO, per spec): swap `readSession` for a
 * middleware that validates the Entra-issued JWT (issuer + audience + JWKS
 * signature) and maps AD group membership to the processor/lead role. The
 * rest of the app only ever sees `req.user: SessionUser`, so nothing else
 * changes. See README → "Wiring up Entra ID".
 */

function sign(payload: string): string {
  return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

/** Cookies are marked Secure whenever the app's public URL is https. */
function secureSuffix(): string {
  return config.appUrl.startsWith('https') ? '; Secure' : '';
}

export function createSessionCookie(user: SessionUser): string {
  const payload = Buffer.from(JSON.stringify({ ...user, iat: Date.now() })).toString('base64url');
  const value = `${payload}.${sign(payload)}`;
  return `${COOKIE_NAME}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}${secureSuffix()}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureSuffix()}`;
}

export function readSession(req: Request): SessionUser | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const cookie = header
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!cookie) return null;
  const value = cookie.slice(COOKIE_NAME.length + 1);
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  if (signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) as SessionUser & { iat: number };
    if (!parsed.email || (parsed.role !== 'processor' && parsed.role !== 'lead')) return null;
    // The cookie authenticates identity; the role is resolved live from the
    // team directory so a privilege change applies on the next request without
    // re-login. Fall back to the signed role if the directory is unreachable.
    let role: SessionUser['role'] = parsed.role;
    try {
      role = resolveRole(parsed.email);
    } catch {
      /* DB not ready — trust the signed cookie */
    }
    return { email: parsed.email, name: parsed.name ?? parsed.email, role };
  } catch {
    return null;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = readSession(req);
  if (!user) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  req.user = user;
  next();
}

export function requireLead(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'lead') {
    res.status(403).json({ error: 'AP Lead role required' });
    return;
  }
  next();
}
