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
  database.exec(`CREATE TABLE IF NOT EXISTS sage_nominals (
    entity TEXT NOT NULL,
    account_ref TEXT NOT NULL,
    name TEXT NOT NULL,
    pulled_at TEXT NOT NULL,
    PRIMARY KEY (entity, account_ref)
  )`);
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
