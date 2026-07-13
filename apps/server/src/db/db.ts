import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from './schema.js';

export type Row = Record<string, unknown>;

let db: DatabaseSync | null = null;

export function openDb(dbPath: string): DatabaseSync {
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Additive migrations: CREATE TABLE IF NOT EXISTS won't touch existing DBs. */
function migrate(database: DatabaseSync): void {
  const ensureColumn = (table: string, name: string, definition: string) => {
    const cols = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === name)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  };
  ensureColumn('invoices', 'entity', 'TEXT');
  ensureColumn('invoices', 'project_code', 'TEXT');
  ensureColumn('invoices', 'posting_ref', 'TEXT');
  ensureColumn('invoices', 'sage_tx_number', 'TEXT');
  ensureColumn('invoices', 'sage_posted_at', 'TEXT');
  ensureColumn('sage_batches', 'entity', 'TEXT');
  ensureColumn('approvers', 'source', "TEXT NOT NULL DEFAULT 'manual'");
  database.exec(`CREATE TABLE IF NOT EXISTS sage_nominals (
    entity TEXT NOT NULL,
    account_ref TEXT NOT NULL,
    name TEXT NOT NULL,
    pulled_at TEXT NOT NULL,
    PRIMARY KEY (entity, account_ref)
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS team_members (
    email TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'processor',
    source TEXT NOT NULL DEFAULT 'group',
    in_group INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  )`);
  // Revocable, logged, single-purpose tokens backing the public attachment
  // links embedded in Teams approval cards and Sage records.
  database.exec(`CREATE TABLE IF NOT EXISTS attachment_tokens (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    approver_id TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  )`);
  database.exec('CREATE INDEX IF NOT EXISTS idx_attachment_tokens_invoice ON attachment_tokens(invoice_id)');
  // Alerts moved from email to a Teams webhook: rename the email_* delivery
  // columns to channel-agnostic delivery_* (preserving existing rows).
  const alertCols = database.prepare('PRAGMA table_info(alerts)').all() as { name: string }[];
  if (alertCols.some((c) => c.name === 'email_status') && !alertCols.some((c) => c.name === 'delivery_status')) {
    database.exec('ALTER TABLE alerts RENAME COLUMN email_to TO delivery_target');
    database.exec('ALTER TABLE alerts RENAME COLUMN email_status TO delivery_status');
    database.exec('ALTER TABLE alerts RENAME COLUMN email_error TO delivery_error');
    database.exec('ALTER TABLE alerts RENAME COLUMN email_sent_at TO delivery_at');
  }
  // Retired setting: alerts moved from an email recipient list to a webhook.
  database.exec("DELETE FROM settings WHERE key = 'alert_recipients'");
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not opened — call openDb() first');
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

type Bind = string | number | bigint | null | Uint8Array;

/** Coerce undefined -> null and boolean -> 0/1 (node:sqlite rejects both). */
function bind(params: unknown[]): Bind[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p as Bind;
  });
}

export function run(sql: string, ...params: unknown[]): { changes: number | bigint } {
  return getDb().prepare(sql).run(...bind(params));
}

export function one<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return getDb().prepare(sql).get(...bind(params)) as T | undefined;
}

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return getDb().prepare(sql).all(...bind(params)) as T[];
}

export function jsonParse<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function getStatus(key: string): string | null {
  const row = one<{ value: string }>('SELECT value FROM system_status WHERE key = ?', key);
  return row ? row.value : null;
}

export function setStatus(key: string, value: string | null): void {
  if (value === null) {
    run('DELETE FROM system_status WHERE key = ?', key);
    return;
  }
  run(
    'INSERT INTO system_status (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value,
  );
}
