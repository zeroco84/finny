import { config } from '../../config.js';

/**
 * Minimal Microsoft Graph client using the OAuth2 client-credentials flow
 * (app permissions on the shared mailbox / approvals solution). Used by the
 * `graph` mail and approvals providers; exercised only when those providers
 * are enabled and the GRAPH_* env vars are set.
 */

export class GraphAuthError extends Error {}

/**
 * A Graph call that ran past its wall-clock budget. Distinct from a transport
 * error so the mailbox alert and `mail_last_error` can say "timed out" rather
 * than a bare "fetch failed".
 */
export class GraphTimeoutError extends Error {}

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Runs one Graph HTTP exchange under a hard wall-clock cap (headers *and* body
 * read — the signal stays live through res.json()).
 *
 * Node/undici defaults to ~300s of header timeout, so a Graph call that hangs —
 * a stuck connection, a throttled tenant that accepts the request and never
 * answers — parks the caller for five minutes. For the mail poller that is five
 * minutes of no ingestion from a single call, on a 60s poll interval. Capping
 * well below the interval turns a hang into a fast failure the next poll
 * retries, instead of a stall (see the July 2026 ingestion stall).
 */
async function withGraphTimeout<T>(
  what: string,
  send: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal | null,
): Promise<T> {
  const ms = config.graph.timeoutMs;
  const timeout = AbortSignal.timeout(ms);
  try {
    return await send(callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout);
  } catch (err) {
    // Ask the signal, don't sniff the error: runtimes differ on whether the
    // abort reason is rethrown as-is or wrapped in a TypeError.
    if (timeout.aborted) throw new GraphTimeoutError(`${what} timed out after ${ms}ms`);
    throw err;
  }
}

export function graphConfigured(): boolean {
  return Boolean(config.graph.tenantId && config.graph.clientId && config.graph.clientSecret);
}

export async function getGraphToken(): Promise<string> {
  if (!graphConfigured()) {
    throw new GraphAuthError('Graph credentials missing — set GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET');
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;

  const url = `https://login.microsoftonline.com/${config.graph.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: config.graph.clientId,
    client_secret: config.graph.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const json = await withGraphTimeout('Graph token request', async (signal) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GraphAuthError(`Token request failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return (await res.json()) as { access_token: string; expires_in: number };
  });
  cachedToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

export async function graphFetch<T>(path: string, init?: RequestInit & { base?: string }): Promise<T> {
  const token = await getGraphToken();
  const base = init?.base ?? 'https://graph.microsoft.com/v1.0';
  return withGraphTimeout(
    `Graph request for ${path}`,
    async (signal) => {
      const res = await fetch(`${base}${path}`, {
        ...init,
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(init?.headers ?? {}),
        },
      });
      if (res.status === 401 || res.status === 403) {
        cachedToken = null;
        const text = await res.text().catch(() => '');
        throw new GraphAuthError(`Graph returned ${res.status} for ${path}: ${text.slice(0, 300)}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Graph request failed (${res.status}) for ${path}: ${text.slice(0, 300)}`);
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    },
    init?.signal,
  );
}
