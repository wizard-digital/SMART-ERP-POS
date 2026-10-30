/**
 * Test helper: throwaway Postgres database with the REAL gl_projection_events DDL
 * (shared/sql/gl-projection-events-migration.sql). Never touches pos_* databases.
 *
 * Connection: PGHOST/PGPORT/PGUSER/PGPASSWORD or the local dev defaults
 * (localhost:5432, postgres/password). If the server is unreachable `connectAdmin`
 * returns null so suites can skip loudly rather than pretend to pass.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const base = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'password',
};

export interface ScratchDb {
  name: string;
  pool: pg.Pool;
  /** A second, independent pool (to observe locks / kill backends from "outside"). */
  observer: pg.Pool;
  drop(): Promise<void>;
}

export async function connectAdmin(): Promise<pg.Client | null> {
  const admin = new pg.Client({ ...base, database: 'postgres', connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
    return admin;
  } catch {
    return null;
  }
}

export async function createScratchDb(extraDdl = ''): Promise<ScratchDb | null> {
  const admin = await connectAdmin();
  if (!admin) return null;
  const name = `outbox_proof_${randomBytes(4).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const pool = new pg.Pool({ ...base, database: name, max: 12 });
  const observer = new pg.Pool({ ...base, database: name, max: 3 });
  pool.on('error', () => undefined);
  observer.on('error', () => undefined);

  const ddl = readFileSync(join(process.cwd(), '..', 'shared', 'sql', 'gl-projection-events-migration.sql'), 'utf8');
  await pool.query(ddl);
  if (extraDdl) await pool.query(extraDdl);

  return {
    name,
    pool,
    observer,
    async drop() {
      await pool.end().catch(() => undefined);
      await observer.end().catch(() => undefined);
      const a = await connectAdmin();
      if (!a) return;
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

/** Insert one projection event per tuple (unique account unless provided). Returns inserted ids. */
export async function insertEvents(
  pool: pg.Pool,
  rows: Array<{
    accountId?: string;
    year?: number;
    period?: number;
    status?: 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED';
    retryCount?: number;
    ageSeconds?: number;
  }>,
): Promise<string[]> {
  const ids: string[] = [];
  for (const r of rows) {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO gl_projection_events
         (account_id, fiscal_year, fiscal_period, transaction_id, idempotency_key, status, retry_count, created_at)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, gen_random_uuid(), $4, $5, $6,
               NOW() - make_interval(secs => $7::int))
       RETURNING id`,
      [
        r.accountId ?? null,
        r.year ?? 2026,
        r.period ?? 5,
        `idem-${randomBytes(6).toString('hex')}`,
        r.status ?? 'PENDING',
        r.retryCount ?? 0,
        r.ageSeconds ?? 0,
      ],
    );
    ids.push(res.rows[0].id);
  }
  return ids;
}

export async function statusOf(pool: pg.Pool, ids: string[]): Promise<Record<string, string>> {
  const res = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM gl_projection_events WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return Object.fromEntries(res.rows.map((r) => [r.id, r.status]));
}

export async function histogram(pool: pg.Pool): Promise<Record<string, number>> {
  const res = await pool.query<{ status: string; n: string }>(
    `SELECT status, count(*) n FROM gl_projection_events GROUP BY 1`,
  );
  return Object.fromEntries(res.rows.map((r) => [r.status, Number(r.n)]));
}
