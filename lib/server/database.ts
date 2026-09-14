import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';

type Value = string | number | null;
type Row = Record<string, unknown>;
type Result = { results: Row[]; success: boolean; meta: { changes: number; last_row_id?: number } };

// Preserve the current D1 contract. This compiles application SQL only;
// external knowledge databases use their native drivers directly.
export function postgresSQL(sql: string): string {
  let query = sql
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY')
    .replace(/CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5\(chunk_id UNINDEXED, document_id UNINDEXED, text\)/g,
      'CREATE TABLE IF NOT EXISTS chunks_fts(chunk_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, text TEXT NOT NULL)')
    .replace(/json_extract\((\w+(?:\.\w+)?),\s*'\$\.([\w.]+)'\)/g,
      (_, column: string, path: string) => `(${column}::jsonb #>> '{${path.split('.').join(',')}}')`)
    .replace(/json_each\((\w+(?:\.\w+)?)\)/g, 'jsonb_array_elements_text($1::jsonb) AS item(value)')
    .replace(/json_insert\(comments,'\$\[#\]',\?\)/g, '(comments::jsonb || jsonb_build_array(?::text))::text')
    .replace(/CASE WHEN \? THEN/g, 'CASE WHEN ? = 1 THEN');
  if (/^INSERT OR IGNORE /i.test(query.trim())) query = query.replace(/INSERT OR IGNORE /i, 'INSERT ') + ' ON CONFLICT DO NOTHING';
  let position = 0;
  return query.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g, token => token === '?' ? `$${++position}` : token);
}

export class Statement {
  constructor(readonly database: Database, readonly sql: string, readonly values: Value[] = []) {}
  bind(...values: unknown[]) {
    if (values.some(value => value !== null && typeof value !== 'string' && typeof value !== 'number')) throw new Error('Invalid SQL binding.');
    return new Statement(this.database, this.sql, values as Value[]);
  }
  async all<T = Row>() { return await this.database.execute(this) as Omit<Result, 'results'> & { results: T[] }; }
  async first<T = Row>(column?: string): Promise<T | null> {
    const { results } = await this.database.execute(this);
    return ((column ? results[0]?.[column] : results[0]) ?? null) as T | null;
  }
  run() { return this.database.execute(this); }
}

export class Database {
  readonly dialect: 'sqlite' | 'postgres';
  readonly sqlite?: DatabaseSync;
  readonly pool?: Pool;
  constructor(url: string, dataDirectory: string) {
    this.dialect = /^postgres(?:ql)?:\/\//.test(url) ? 'postgres' : 'sqlite';
    if (this.dialect === 'postgres') {
      this.pool = new Pool({ connectionString: url, max: 6, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
    } else {
      if (url && !url.startsWith('file:')) throw new Error('DATABASE_URL must use file:, postgres:, or postgresql:.');
      const path = url ? resolve(url.slice(5)) : resolve(dataDirectory, 'shoal.sqlite');
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      this.sqlite = new DatabaseSync(path);
      this.sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;');
    }
  }
  prepare(sql: string) { return new Statement(this, sql); }
  private executeSQLite(statement: Statement): Result {
    const query = this.sqlite!.prepare(statement.sql);
    const results = query.columns().length ? query.all(...statement.values) : [];
    const mutation = query.columns().length ? null : query.run(...statement.values);
    return { results, success: true, meta: { changes: mutation ? Number(mutation.changes) : results.length, last_row_id: mutation ? Number(mutation.lastInsertRowid) : undefined } };
  }
  async execute(statement: Statement, client?: PoolClient): Promise<Result> {
    if (this.sqlite) return this.executeSQLite(statement);
    const result = await (client ?? this.pool!).query(postgresSQL(statement.sql), statement.values);
    return { results: result.rows as Row[], success: true, meta: { changes: result.rowCount ?? 0 } };
  }
  async batch(statements: Statement[]): Promise<Result[]> {
    if (this.sqlite) {
      this.sqlite.exec('BEGIN IMMEDIATE');
      try { const results = statements.map(statement => this.executeSQLite(statement)); this.sqlite.exec('COMMIT'); return results; }
      catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
    }
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      // ponytail: serialize workspace batches to preserve D1 event fencing.
      // Switch to locks per run if workspace write throughput requires it.
      await client.query('SELECT pg_advisory_xact_lock(73646201)');
      const results: Result[] = [];
      for (const statement of statements) results.push(await this.execute(statement, client));
      await client.query('COMMIT');
      return results;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async exec(sql: string) {
    if (this.sqlite) this.sqlite.exec(sql);
    else await this.pool!.query(postgresSQL(sql));
    return { count: 1, duration: 0 };
  }
  async migrate() {
    await this.exec('CREATE TABLE IF NOT EXISTS shoal_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const directory = resolve(process.cwd(), 'migrations');
    for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
      if (await this.prepare('SELECT name FROM shoal_migrations WHERE name=?').bind(name).first()) continue;
      const statements: Statement[] = [];
      for (let sql of readFileSync(resolve(directory, name), 'utf8').split(';')) {
        sql = sql.replace(/^\s*--[^\n]*/gm, '').trim();
        if (!sql) continue;
        const addition = /ALTER TABLE (\w+) ADD COLUMN (\w+)/i.exec(sql);
        if (addition) {
          if (this.sqlite) {
            const columns = this.sqlite.prepare(`PRAGMA table_info(${addition[1]})`).all();
            if (columns.some(column => column.name === addition[2])) continue;
          } else sql = sql.replace('ADD COLUMN ', 'ADD COLUMN IF NOT EXISTS ');
        }
        statements.push(this.prepare(sql));
      }
      statements.push(this.prepare('INSERT INTO shoal_migrations(name,applied_at) VALUES (?,?)').bind(name, new Date().toISOString()));
      await this.batch(statements);
    }
  }
  async close() { this.sqlite?.close(); await this.pool?.end(); }
}
