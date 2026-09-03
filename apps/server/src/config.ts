import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function jsonEnv<T>(name: string, fallback: T): T {
  const raw = env(name);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.error(`[config] ${name} is not valid JSON — ignoring`);
    return fallback;
  }
}

const dataDir = path.resolve(process.cwd(), env('DATA_DIR', './data'));

const anthropicKey = env('ANTHROPIC_API_KEY');
const extractionProvider =
  env('EXTRACTION_PROVIDER') || (anthropicKey ? 'anthropic' : 'mock');

const authProvider = env('AUTH_PROVIDER', 'dev') as 'dev' | 'entra';
// Dev sign-in lets anyone pick the AP Lead role, so it may only serve a local
// origin. A public deployment that wants it (the SEED_DEMO sandbox) has to say
// so explicitly — see hardeningProblems() below.
const allowDevAuth = env('ALLOW_DEV_AUTH') === 'true';
// The /api/simulate/* routes fabricate invoices and approval decisions for
// local demos. They must never be reachable in production (a signed-in user
// could forge a manager's approval). Off unless explicitly enabled; defaults
// on only for the dev auth provider.
const simulatorEnabled =
  env('ENABLE_SIMULATOR', authProvider === 'dev' ? 'true' : 'false') === 'true';

// Session cookies get Secure unless we are plainly running local dev over http
// — tied to the auth provider (production uses entra), so a misconfigured
// APP_URL scheme can't silently ship a non-Secure session cookie. Override with
// COOKIE_SECURE=true|false.
const cookieSecure = env('COOKIE_SECURE', authProvider === 'entra' ? 'true' : 'false') === 'true';
// Max session lifetime, enforced server-side: a signed cookie is rejected past
// this age, so a captured cookie is not replayable indefinitely. Entra SSO
// re-auth is seamless, so a short window costs users nothing.
const sessionMaxHours = Number(env('SESSION_MAX_HOURS', '12'));

export const config = {
  port: Number(env('PORT', '4787')),
  dataDir,
  dbPath: path.join(dataDir, 'finny.db'),
  attachmentsDir: path.join(dataDir, 'attachments'),
  inboxDir: path.join(dataDir, 'inbox'),
  exportsDir: path.join(dataDir, 'exports'),
  // On Render, RENDER_EXTERNAL_URL is the service's public URL — used in
  // alert-email links and tokenized attachment links when APP_URL isn't set.
  appUrl: env('APP_URL', env('RENDER_EXTERNAL_URL', 'http://localhost:5173')),
  // Tokenized attachment links (Teams approval cards, Sage document links) are
  // capped at this many days, so a leaked link is never a decade-long
  // unauthenticated capability. Links are also individually revocable.
  attachmentLinkMaxTtlDays: Number(env('ATTACHMENT_LINK_MAX_TTL_DAYS', '365')),

  mailProvider: env('MAIL_PROVIDER', 'mock') as 'mock' | 'graph',
  mailPollSeconds: Number(env('MAIL_POLL_SECONDS', '60')),
  // Largest attachment Finny will store and parse. Bounds disk use and the PDF
  // parser against a huge or decompression-bomb file from the untrusted mailbox.
  attachmentMaxBytes: Number(env('ATTACHMENT_MAX_MB', '25')) * 1024 * 1024,
  graph: {
    tenantId: env('GRAPH_TENANT_ID'),
    clientId: env('GRAPH_CLIENT_ID'),
    clientSecret: env('GRAPH_CLIENT_SECRET'),
    mailbox: env('GRAPH_MAILBOX'),
    markRead: env('GRAPH_MARK_READ', 'true') === 'true',
    // How many days of existing mailbox history to ingest when the poller
    // runs for the FIRST time. 0 = only mail arriving after enablement — the
    // safe default when the team has been processing the mailbox manually.
    backfillDays: Number(env('GRAPH_BACKFILL_DAYS', '0')),
  },

  extractionProvider: extractionProvider as 'anthropic' | 'mock',
  // The raw env value, so an explicit EXTRACTION_PROVIDER=mock keeps the mock
  // parser even when an API key is later set in Settings.
  extractionProviderEnv: env('EXTRACTION_PROVIDER'),
  anthropicKey,
  // Default model when the AP Lead hasn't picked one in Settings.
  extractionModel: env('EXTRACTION_MODEL', 'claude-opus-4-8'),

  // 'mock'           = in-app simulator panel (demo/dev).
  // 'power_automate' = POST to an HTTP-triggered Power Automate flow running
  //                    "Start and wait for an approval"; the flow calls back
  //                    with the decision. The supported production path.
  // 'graph'          = the beta Graph Approvals API. Kept for reference only:
  //                    that endpoint supports DELEGATED permissions exclusively,
  //                    so Finny's client-credentials token can never carry the
  //                    required scope and every create returns 401. See README.
  approvalsProvider: env('APPROVALS_PROVIDER', 'mock') as 'mock' | 'graph' | 'power_automate',
  approvalsPollSeconds: Number(env('APPROVALS_POLL_SECONDS', '60')),
  // HTTP-trigger URL of the Power Automate approval flow. Carries a signature
  // in its query string, so it is treated like the alert webhook: never logged,
  // never returned to a client, and only ever posted to an allowlisted host.
  approvalsFlowUrl: env('APPROVALS_FLOW_URL'),
  // Shared secret the flow presents on the decision callback. Without it the
  // callback endpoint stays closed (503) rather than open.
  approvalsCallbackToken: env('APPROVALS_CALLBACK_TOKEN'),
  // Secret sent in the body of every request to the flow, for the flow to check
  // before it does anything. The flow's HTTP trigger is reachable by anyone
  // holding its URL — the signature in that URL is its only access control, and
  // a signature embedded in a URL leaks easily: into env vars, flow exports,
  // screenshots and chat logs. Without a gate, anyone who obtains the URL can
  // raise Teams approvals that are genuinely from Finny, with an attacker-chosen
  // title, assignee and document link — a phishing card delivered through the
  // one channel AP staff are trained to trust. The flow terminates when this
  // does not match, so a leaked URL alone achieves nothing.
  approvalsFlowSecret: env('APPROVALS_FLOW_SECRET'),
  // Base URL the approval flow calls back on. Defaults to APP_URL, which is
  // right until APP_URL is a domain behind a CDN/WAF: Cloudflare answers a
  // machine-to-machine POST with a managed bot challenge (403 + an HTML
  // interstitial), so the decision never arrives. Worse, challenges are
  // reputation-scored, so some callbacks succeed and some don't and invoices
  // strand at random. Point this at the origin (Render's own URL) to keep the
  // callback off the edge, while user-facing links stay on APP_URL. The
  // endpoint is machine-only, bearer-token authenticated and fails shut, so it
  // gains nothing from bot protection.
  approvalsCallbackBaseUrl: env('APPROVALS_CALLBACK_BASE_URL'),
  // Demo-only invoice/approval simulator routes; never enabled in production.
  simulatorEnabled,

  // Failure alerts are POSTed as an Adaptive Card to a Teams-subscribable
  // Incoming Webhook. Set here as a default, or per-deployment in Settings
  // (the stored value wins). Empty = alerts are stored and shown in the UI only.
  alertWebhookUrl: env('ALERT_WEBHOOK_URL'),
  // SSRF guard: the operator-settable webhook may only target these
  // Microsoft-owned host suffixes (Teams connectors / Power Automate / Power
  // Platform / Logic Apps). Override if your tenant uses a different endpoint.
  alertWebhookAllowedHosts: (
    env(
      'ALERT_WEBHOOK_ALLOWED_HOSTS',
      '.webhook.office.com,.logic.azure.com,.powerplatform.com,.azure-apihub.net',
    )
  )
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // Bearer token for the BlockDocs cost-dashboard pull endpoint; empty = disabled.
  blockdocsToken: env('FINNY_BLOCKDOCS_TOKEN'),

  // Sage 50 output: 'csv' = batch files the AP team imports by hand;
  // 'hyperaccounts' = one-touch posting via the HyperAccounts REST API
  // (on-prem wrapper around Sage 50 — one server per company dataset).
  sage: {
    provider: env('SAGE_PROVIDER', 'csv') as 'csv' | 'hyperaccounts',
    // Header name carrying the API key. The HyperAccounts docs say "API Key
    // (collection-level)" without naming the header — confirm with Hyperext;
    // x-api-key is the Postman default.
    apiKeyHeader: env('SAGE_API_KEY_HEADER', 'x-api-key'),
    defaultServer: { url: env('SAGE_API_URL'), key: env('SAGE_API_KEY') },
    // Per-entity servers (each legal entity = its own Sage company dataset =
    // its own HyperAccounts server). JSON: {"Entity Name": {"url": "...", "key": "..."}}
    // Entities not listed fall back to SAGE_API_URL/SAGE_API_KEY.
    entityServers: jsonEnv<Record<string, { url: string; key: string }>>('SAGE_ENTITY_SERVERS', {}),
  },

  authProvider,
  allowDevAuth,
  cookieSecure,
  sessionMaxHours,
  // Express "trust proxy" setting. Behind Render's load balancer req.ip is the
  // internal hop unless the X-Forwarded-For chain is trusted, which makes the
  // attachment-link audit IPs useless and the rate limiter throttle everyone
  // together. Defaults to one hop on Render (it sets RENDER=true), none
  // elsewhere. Leave it at one hop behind Cloudflare too: api/clientIp.ts
  // reads CF-Connecting-IP when the connecting address is Cloudflare's, and
  // trusting a second hop would let a direct caller forge X-Forwarded-For.
  trustProxy: parseTrustProxy(env('TRUST_PROXY', process.env.RENDER ? '1' : 'false')),
  // Entra ID SSO (AUTH_PROVIDER=entra). The ENTRA_* vars fall back to the
  // GRAPH_* app registration — one registration can serve both mail polling
  // (application permission) and user sign-in (web redirect URI).
  entra: {
    tenantId: env('ENTRA_TENANT_ID', env('GRAPH_TENANT_ID')),
    clientId: env('ENTRA_CLIENT_ID', env('GRAPH_CLIENT_ID')),
    clientSecret: env('ENTRA_CLIENT_SECRET', env('GRAPH_CLIENT_SECRET')),
    // Must exactly match a redirect URI registered on the app registration.
    redirectUri: env('ENTRA_REDIRECT_URI'), // default derived from APP_URL
    // Override the OIDC issuer (tests point this at a mock IdP); default is
    // the tenant's v2.0 endpoint.
    issuer: env('ENTRA_ISSUER'),
    // Test hook only: lets the OIDC flow talk to a plain-HTTP mock IdP.
    allowHttp: env('ENTRA_ALLOW_HTTP') === 'true',
  },
  // Signed-in users with one of these emails get the AP Lead role and cannot
  // be demoted in Settings (the lockout guard); everyone else who can sign in
  // starts as a processor. Roles are otherwise managed in the Team directory.
  leadEmails: env('FINNY_LEAD_EMAILS')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  // Team directory / privilege management. 'mock' shows a seeded finance group
  // (works offline); 'graph' pulls the real members of the Entra security group
  // the SSO is scoped to. Defaults to graph once a group id is set alongside
  // Entra sign-in, otherwise mock.
  team: {
    // Also governs the approving-managers sync (both directories share the
    // Graph wiring). '' = auto (graph once Entra sign-in + Graph creds exist).
    provider: env('TEAM_PROVIDER') as 'mock' | 'graph' | '',
    // Object id of the M365 group whose members may sign in (the group assigned
    // to the enterprise app). Read via Graph GET /groups/{id}/members.
    groupId: env('FINNY_TEAM_GROUP_ID'),
  },
  approvers: {
    // Object id of the M365 group of approving managers. Settings → Approving
    // managers → "Sync" pulls its members (name, email, and AAD id → the Teams
    // user id used to raise approvals). Separate from the sign-in team group.
    groupId: env('FINNY_APPROVERS_GROUP_ID'),
  },
  sessionSecret: '',
};

function parseTrustProxy(raw: string): boolean | number | string {
  const v = raw.trim().toLowerCase();
  if (v === '' || v === 'false' || v === '0') return false;
  if (v === 'true') return true;
  return /^\d+$/.test(v) ? Number(v) : raw.trim();
}

/** Only these origins may run dev sign-in without an explicit opt-in. */
export function isLocalAppUrl(appUrl: string): boolean {
  try {
    const host = new URL(appUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/** Shortest static secret Finny will accept for a machine-to-machine token. */
export const MIN_STATIC_TOKEN_LENGTH = 32;

/**
 * Deployment problems the server must refuse to boot with. Each one turns a
 * misconfiguration into an outage that is loud and immediate, instead of an
 * app that quietly runs open. Pure over `cfg` so tests can exercise it.
 */
export function hardeningProblems(cfg: typeof config): string[] {
  const problems: string[] = [];
  if (cfg.authProvider === 'dev' && !cfg.allowDevAuth && !isLocalAppUrl(cfg.appUrl)) {
    problems.push(
      `AUTH_PROVIDER=dev with a non-local APP_URL (${cfg.appUrl}): dev sign-in lets anyone ` +
        'choose the AP Lead role. Set AUTH_PROVIDER=entra, or ALLOW_DEV_AUTH=true for a throwaway demo.',
    );
  }
  const tokens: [string, string][] = [
    ['APPROVALS_CALLBACK_TOKEN', cfg.approvalsCallbackToken],
    ['APPROVALS_FLOW_SECRET', cfg.approvalsFlowSecret],
    ['FINNY_BLOCKDOCS_TOKEN', cfg.blockdocsToken],
  ];
  for (const [name, value] of tokens) {
    if (value && value.length < MIN_STATIC_TOKEN_LENGTH) {
      problems.push(
        `${name} is ${value.length} characters; it must be at least ${MIN_STATIC_TOKEN_LENGTH} ` +
          '(it is the only thing authenticating a machine caller).',
      );
    }
  }
  return problems;
}

export function ensureDataDirs(): void {
  for (const dir of [config.dataDir, config.attachmentsDir, config.inboxDir, config.exportsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Session secret: from env, else generated once and persisted so cookies
  // survive restarts in dev.
  const explicit = env('SESSION_SECRET');
  if (explicit) {
    config.sessionSecret = explicit;
    return;
  }
  const secretPath = path.join(config.dataDir, '.session-secret');
  if (!fs.existsSync(secretPath)) {
    fs.writeFileSync(secretPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  config.sessionSecret = fs.readFileSync(secretPath, 'utf8').trim();
}
