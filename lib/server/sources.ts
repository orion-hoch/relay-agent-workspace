import { DatabaseSync } from 'node:sqlite';
import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Client } from 'pg';
import mysql from 'mysql2/promise';
export type SourceKind = 'postgres' | 'mysql' | 'sqlite';
export type SourceTable = { schema: string; name: string; columns: string[] };
export type SourceSelection = { schema: string; table: string; columns: string[]; limit: number };
type Row = Record<string, unknown>;

export async function readSource(kind: SourceKind, address: string, selection?: SourceSelection) {
  let query: (sql: string) => Promise<Row[]>;
  let close: () => Promise<void>;
  if (kind === 'postgres') {
    if (!/^postgres(?:ql)?:\/\//.test(address)) throw new Error('Use a PostgreSQL connection URL.');
    const client = new Client({ connectionString: address, connectionTimeoutMillis: 10000, statement_timeout: 15000, application_name: 'shoal-readonly-source' });
    await client.connect();
    try { await client.query('BEGIN READ ONLY'); }
    catch (error) { await client.end(); throw error; }
    query = async sql => (await client.query(sql)).rows as Row[];
    close = () => client.end();
  } else if (kind === 'mysql') {
    if (!address.startsWith('mysql://')) throw new Error('Use a MySQL connection URL.');
    const client = await mysql.createConnection(address);
    try { await client.query('SET SESSION TRANSACTION READ ONLY'); await client.query('START TRANSACTION READ ONLY'); }
    catch (error) { await client.end(); throw error; }
    query = async sql => (await client.query({ sql, timeout: 15000 }))[0] as Row[];
    close = () => client.end();
  } else {
    const root = await realpath(resolve(process.env.SHOAL_SOURCES_DIR || '.shoal/sources'));
    const path = await realpath(resolve(root, address));
    if (!path.startsWith(root + sep)) throw new Error('SQLite sources must be inside SHOAL_SOURCES_DIR.');
    const client = new DatabaseSync(path, { readOnly: true });
    client.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
    query = async sql => client.prepare(sql).all();
    close = async () => client.close();
  }
  const quote = (value: string) => kind === 'mysql' ? '`' + value.replaceAll('`','``') + '`' : '"' + value.replaceAll('"','""') + '"';
  try {
    let tables: SourceTable[] = [];
    if (kind === 'sqlite') {
      const names = await query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 1000");
      for (const row of names) {
        const name = String(row.name);
        const columns = await query(`PRAGMA table_info(${quote(name)})`);
        tables.push({ schema: '', name, columns: columns.map(row => String(row.name)) });
      }
    } else {
      const sql = kind === 'postgres'
        ? "SELECT table_schema AS schema, table_name AS name, column_name AS column FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema,table_name,ordinal_position LIMIT 10000"
        : "SELECT TABLE_SCHEMA AS `schema`, TABLE_NAME AS name, COLUMN_NAME AS `column` FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION LIMIT 10000";
      const columns = await query(sql);
      const mapped = new Map<string, SourceTable>();
      for (const row of columns) {
        const schema = String(row.schema), name = String(row.name), key = `${schema}.${name}`;
        if (!mapped.has(key)) mapped.set(key, { schema, name, columns: [] });
        mapped.get(key)!.columns.push(String(row.column));
      }
      tables = [...mapped.values()];
    }
    if (!selection) return { tables, rows: [] as Row[], truncated: false };
    const table = tables.find(table => table.name === selection.table && table.schema === selection.schema);
    if (!table || !selection.columns.length || selection.columns.some(column => !table.columns.includes(column))) throw new Error('Choose an existing table and its columns.');
    if (!Number.isInteger(selection.limit) || selection.limit < 1 || selection.limit > 5000) throw new Error('Choose a row limit between 1 and 5,000.');
    const target = table.schema ? `${quote(table.schema)}.${quote(table.name)}` : quote(table.name);
    const rows = await query(`SELECT ${selection.columns.map(quote).join(',')} FROM ${target} LIMIT ${selection.limit + 1}`);
    return { tables, rows: rows.slice(0, selection.limit), truncated: rows.length > selection.limit };
  } finally { await close(); }
}
