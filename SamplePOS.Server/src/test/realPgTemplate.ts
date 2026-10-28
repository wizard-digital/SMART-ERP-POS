/**
 * Test helper: disposable REAL-Postgres database cloned from the LOCAL copy of the production `pos_template`
 * (schema + chart of accounts + governance flags; no tenant data). Build the copy once with:
 *
 *     node scripts/ops/clone-template-local.mjs            (reads production READ-ONLY, writes only locally)
 *
 * If Postgres or the template copy is not available the helper returns null and the suite must SKIP LOUDLY
 * (never pretend to pass). Scratch databases are named `sp_scratch_*` and never touch any pos_* database.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const base = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'password',
};
export const LOCAL_TEMPLATE_DB = 'sp_template_local';

export interface TemplateScratch {
  name: string;
  pool: pg.Pool;
  drop(): Promise<void>;
}

export async function createScratchFromTemplate(): Promise<TemplateScratch | null> {
  const admin = new pg.Client({ ...base, database: 'postgres', connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch {
    return null;
  }
  try {
    const t = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [LOCAL_TEMPLATE_DB]);
    if (t.rowCount === 0) return null;
    const name = `sp_scratch_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${LOCAL_TEMPLATE_DB}`);
    const pool = new pg.Pool({ ...base, database: name, max: 8 });
    pool.on('error', () => undefined);
    return {
      name,
      pool,
      async drop() {
        await pool.end().catch(() => undefined);
        const a = new pg.Client({ ...base, database: 'postgres' });
        await a.connect();
        await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await a.end();
      },
    };
  } finally {
    await admin.end().catch(() => undefined);
  }
}

/** A real customer row (A/R, deposit and credit sales require one). */
export async function insertCustomer(pool: pg.Pool, name = 'Test Customer'): Promise<string> {
  const r = await pool.query<{ id: string }>(`INSERT INTO customers (name) VALUES ($1) RETURNING id`, [name]);
  return r.rows[0].id;
}

/** Debit/credit per account code for every ledger transaction matching a reference. */
export async function journalByAccount(
  pool: pg.Pool,
  where: { referenceType: string; referenceId?: string; referenceNumber?: string },
): Promise<Array<{ code: string; debit: number; credit: number }>> {
  const r = await pool.query(
    `SELECT a."AccountCode" code, COALESCE(SUM(le."DebitAmount"),0)::float8 debit, COALESCE(SUM(le."CreditAmount"),0)::float8 credit
       FROM ledger_transactions lt
       JOIN ledger_entries le ON le."TransactionId" = lt."Id"
       JOIN accounts a ON a."Id" = le."AccountId"
      WHERE lt."ReferenceType" = $1
        AND ($2::text IS NULL OR lt."ReferenceId"::text = $2)
        AND ($3::text IS NULL OR lt."ReferenceNumber" = $3)
        AND lt."Status" = 'POSTED'
      GROUP BY a."AccountCode" ORDER BY a."AccountCode"`,
    [where.referenceType, where.referenceId ?? null, where.referenceNumber ?? null],
  );
  return r.rows;
}

/** Connect to an existing local database (e.g. rehearsal_henber). Returns null if Postgres or the DB is missing. */
export async function connectLocalIfExists(database: string): Promise<pg.Pool | null> {
  if (!/^[a-z][a-z0-9_]*$/.test(database)) return null;
  const admin = new pg.Client({ ...base, database: 'postgres', connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch {
    return null;
  }
  try {
    const t = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database]);
    if (t.rowCount === 0) return null;
    const pool = new pg.Pool({ ...base, database, max: 4 });
    pool.on('error', () => undefined);
    return pool;
  } finally {
    await admin.end().catch(() => undefined);
  }
}
