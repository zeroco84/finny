import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
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
    mailbox: env('GRAPH_MAILBOX', 'apadmin@example.com'),
    markRead: env('GRAPH_MARK_READ', 'true') === 'true',
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

  authProvider: env('AUTH_PROVIDER', 'dev') as 'dev' | 'entra',
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
