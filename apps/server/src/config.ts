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

  mailProvider: env('MAIL_PROVIDER', 'mock') as 'mock' | 'graph',
  mailPollSeconds: Number(env('MAIL_POLL_SECONDS', '60')),
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
  anthropicKey,
  extractionModel: env('EXTRACTION_MODEL', 'claude-opus-4-8'),

  approvalsProvider: env('APPROVALS_PROVIDER', 'mock') as 'mock' | 'graph',
  approvalsPollSeconds: Number(env('APPROVALS_POLL_SECONDS', '60')),

  smtp: {
    host: env('SMTP_HOST'),
    port: Number(env('SMTP_PORT', '587')),
    user: env('SMTP_USER'),
    pass: env('SMTP_PASS'),
    from: env('SMTP_FROM', 'finny-alerts@example.com'),
  },

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

  authProvider: env('AUTH_PROVIDER', 'dev') as 'dev' | 'entra',
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
  // Signed-in users with one of these emails get the AP Lead role;
  // everyone else who can sign in is a processor.
  leadEmails: env('FINNY_LEAD_EMAILS')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  sessionSecret: '',
};

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
