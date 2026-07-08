import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import * as oidc from 'openid-client';
import type { SessionUser } from '@finny/shared';
import { config } from '../config.js';
import { audit } from '../services/audit.js';
import { createSessionCookie } from './auth.js';

/**
 * Entra ID SSO (AUTH_PROVIDER=entra): the standard server-side OpenID Connect
 * authorization-code flow with PKCE, against the tenant's v2.0 endpoint.
 *
 *   GET /api/auth/entra/login     -> 302 to Microsoft sign-in
 *   GET /api/auth/entra/callback  -> code exchange, then the SAME HMAC session
 *                                    cookie dev sign-in uses — the rest of the
 *                                    app is auth-provider-agnostic.
 *
 * Signing in is restricted to the tenant by the tenant-specific endpoint;
 * restrict WHICH tenant users may sign in with "User assignment required" on
 * the enterprise application (no code involved). Role: emails listed in
 * FINNY_LEAD_EMAILS become AP Leads, everyone else is a processor.
 */

export function entraConfigError(): string | null {
  const { tenantId, clientId, clientSecret } = config.entra;
  if (!tenantId && !config.entra.issuer) return 'ENTRA_TENANT_ID (or GRAPH_TENANT_ID) is not set';
  if (!clientId) return 'ENTRA_CLIENT_ID (or GRAPH_CLIENT_ID) is not set';
  if (!clientSecret) return 'ENTRA_CLIENT_SECRET (or GRAPH_CLIENT_SECRET) is not set';
  return null;
}

function issuerUrl(): string {
  return config.entra.issuer || `https://login.microsoftonline.com/${config.entra.tenantId}/v2.0`;
}

export function entraRedirectUri(): string {
  return (
    config.entra.redirectUri ||
    `${config.appUrl.replace(/\/$/, '')}/api/auth/entra/callback`
  );
}

// Discovery result cached for the process lifetime (it's static per tenant);
// resolved lazily so the server boots fine offline.
let discovered: Promise<oidc.Configuration> | null = null;
function getOidcConfig(): Promise<oidc.Configuration> {
  if (!discovered) {
    discovered = oidc
      .discovery(
        new URL(issuerUrl()),
        config.entra.clientId,
        config.entra.clientSecret,
        undefined,
        config.entra.allowHttp ? { execute: [oidc.allowInsecureRequests] } : undefined,
      )
      .catch((err) => {
        discovered = null; // retry on the next attempt rather than caching failure
        throw err;
      });
  }
  return discovered;
}

// ── Transient flow state (PKCE verifier, state, nonce) ──────────────────────
// Carried across the redirect in a short-lived HMAC-signed cookie, so the
// flow is stateless server-side (survives restarts and multiple instances).

const FLOW_COOKIE = 'finny_oidc';
const FLOW_TTL_MS = 10 * 60 * 1000;

interface FlowState {
  verifier: string;
  state: string;
  nonce: string;
  iat: number;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

function secureSuffix(): string {
  return config.appUrl.startsWith('https') ? '; Secure' : '';
}

export function buildFlowCookie(flow: FlowState): string {
  const payload = Buffer.from(JSON.stringify(flow)).toString('base64url');
  return `${FLOW_COOKIE}=${payload}.${sign(payload)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${secureSuffix()}`;
}

export function clearFlowCookie(): string {
  return `${FLOW_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureSuffix()}`;
}

export function readFlowCookie(header: string | undefined): FlowState | null {
  const cookie = (header ?? '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${FLOW_COOKIE}=`));
  if (!cookie) return null;
  const [payload, signature] = cookie.slice(FLOW_COOKIE.length + 1).split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  if (signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }
  try {
    const flow = JSON.parse(Buffer.from(payload, 'base64url').toString()) as FlowState;
    if (!flow.verifier || !flow.state || !flow.nonce) return null;
    if (Date.now() - flow.iat > FLOW_TTL_MS) return null;
    return flow;
  } catch {
    return null;
  }
}

/** Emails in FINNY_LEAD_EMAILS are AP Leads; everyone else is a processor. */
export function roleForEmail(email: string): SessionUser['role'] {
  return config.leadEmails.includes(email.trim().toLowerCase()) ? 'lead' : 'processor';
}

export function userFromClaims(claims: Record<string, unknown>): SessionUser | null {
  const email =
    (typeof claims.email === 'string' && claims.email) ||
    (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
    null;
  if (!email || !email.includes('@')) return null;
  const name = typeof claims.name === 'string' && claims.name ? claims.name : email;
  return { email, name, role: roleForEmail(email) };
}

// ── Route handlers ───────────────────────────────────────────────────────────

export async function entraLogin(_req: Request, res: Response): Promise<void> {
  try {
    const cfg = await getOidcConfig();
    const verifier = oidc.randomPKCECodeVerifier();
    const flow: FlowState = {
      verifier,
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      iat: Date.now(),
    };
    const url = oidc.buildAuthorizationUrl(cfg, {
      redirect_uri: entraRedirectUri(),
      scope: 'openid profile email',
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state: flow.state,
      nonce: flow.nonce,
    });
    res.setHeader('Set-Cookie', buildFlowCookie(flow));
    res.redirect(url.href);
  } catch (err) {
    console.error('[entra] could not start sign-in:', err);
    res.redirect('/login?error=' + encodeURIComponent('Microsoft sign-in is unavailable — try again or contact IT'));
  }
}

export async function entraCallback(req: Request, res: Response): Promise<void> {
  const fail = (log: string, err?: unknown): void => {
    console.error(`[entra] ${log}`, err ?? '');
    res.setHeader('Set-Cookie', clearFlowCookie());
    res.redirect('/login?error=' + encodeURIComponent('Microsoft sign-in failed — please try again'));
  };
  try {
    const flow = readFlowCookie(req.headers.cookie);
    if (!flow) {
      fail('callback without a valid flow cookie (expired, missing, or tampered)');
      return;
    }
    const cfg = await getOidcConfig();
    const currentUrl = new URL(req.originalUrl, new URL(entraRedirectUri()).origin);
    const tokens = await oidc.authorizationCodeGrant(cfg, currentUrl, {
      pkceCodeVerifier: flow.verifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    const user = claims ? userFromClaims(claims) : null;
    if (!user) {
      fail(`ID token carried no usable email (claims: ${Object.keys(claims ?? {}).join(', ')})`);
      return;
    }
    audit(null, 'signed_in', user.email, { provider: 'entra', role: user.role });
    res.setHeader('Set-Cookie', [clearFlowCookie(), createSessionCookie(user)]);
    res.redirect('/');
  } catch (err) {
    fail('code exchange failed:', err);
  }
}
