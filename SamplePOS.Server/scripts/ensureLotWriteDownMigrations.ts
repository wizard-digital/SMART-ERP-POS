/**
 * Apply 611/612/613 in filename order and keep schema_migrations consistent.
 *
 * 612 still contains the forged POSTED+NULL JE predicate. If 612 is applied
 * AFTER 613 is already recorded, the hole returns. This helper:
 *   - records 611/612 without re-running them when 613 is already applied;
 *   - otherwise applies pending files in order;
 *   - always re-applies 613 when the live function body is not the 613 contract.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Pool } from 'pg';

export const LWD_MIGRATION_FILES = [
  '611_lot_write_down_clearance.sql',
  '612_lot_write_down_immutability.sql',
  '613_lot_write_down_journal_coupling.sql',
] as const;

function checksum(sql: string): string {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

async function record(
  pool: Pool,
  filename: string,
  sql: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)
     ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, executed_at = now()`,
    [filename, checksum(sql)],
  );
}

export async function liveGuardIs613(pool: Pool): Promise<boolean> {
  const fn = await pool.query<{ def: string }>(
    `SELECT pg_get_functiondef(p.oid) AS def
     FROM pg_proc p WHERE p.proname = 'inventory_batches_carrying_write_down_guard'`,
  );
  const def = fn.rows[0]?.def ?? '';
  const deferred = await pool.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_trigger
       WHERE tgname = 'trg_lot_write_down_posted_journal'
         AND tgrelid = 'lot_write_down_documents'::regclass
         AND tgdeferrable AND tginitdeferred
     ) AS ok`,
  );
  const postedFn = await pool.query<{ def: string }>(
    `SELECT pg_get_functiondef(p.oid) AS def
     FROM pg_proc p WHERE p.proname = 'lot_write_down_posted_requires_journal'`,
  );
  const postedDef = postedFn.rows[0]?.def ?? '';
  return (
    def.includes('cannot increase after lot creation') &&
    !def.includes('journal_entry_id IS NULL') &&
    deferred.rows[0]?.ok === true &&
    postedDef.includes('CAST(rec.id AS TEXT)')
  );
}

export async function ensureLotWriteDownMigrations(
  pool: Pool,
  sqlDir: string,
): Promise<{ applied: string[]; reapplied613: boolean }> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum TEXT
    )
  `);
  await pool.query(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT`);

  const appliedRows = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations',
  );
  const appliedSet = new Set(appliedRows.rows.map((r) => r.filename));
  const applied: string[] = [];

  const sqlByFile = new Map<string, string>();
  for (const filename of LWD_MIGRATION_FILES) {
    const filePath = path.join(sqlDir, filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`missing migration ${filename}`);
    }
    sqlByFile.set(filename, fs.readFileSync(filePath, 'utf8'));
  }

  const has613 = appliedSet.has('613_lot_write_down_journal_coupling.sql');
  if (has613) {
    for (const filename of ['611_lot_write_down_clearance.sql', '612_lot_write_down_immutability.sql'] as const) {
      if (!appliedSet.has(filename)) {
        await record(pool, filename, sqlByFile.get(filename)!);
        appliedSet.add(filename);
        applied.push(`${filename}:recorded-without-rerun`);
      }
    }
  }

  for (const filename of LWD_MIGRATION_FILES) {
    if (appliedSet.has(filename)) continue;
    await pool.query(sqlByFile.get(filename)!);
    await record(pool, filename, sqlByFile.get(filename)!);
    appliedSet.add(filename);
    applied.push(filename);
  }

  let reapplied613 = false;
  if (!(await liveGuardIs613(pool))) {
    const sql613 = sqlByFile.get('613_lot_write_down_journal_coupling.sql')!;
    await pool.query(sql613);
    await record(pool, '613_lot_write_down_journal_coupling.sql', sql613);
    reapplied613 = true;
    applied.push('613_lot_write_down_journal_coupling.sql:reapplied');
  }

  if (!(await liveGuardIs613(pool))) {
    throw new Error('613 carrying-value journal coupling is not live after apply');
  }
  return { applied, reapplied613 };
}
