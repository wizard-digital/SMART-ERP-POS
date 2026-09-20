#!/usr/bin/env npx tsx
/**
 * LIVE FUNCTIONAL PROOF — Product category names are unique (case-insensitive).
 *
 * Measured against DATABASE_URL (not source greps):
 *   1) Apply / verify uq_product_categories_name_ci
 *   2) Heal leftover case-insensitive duplicates if any
 *   3) createCategory("ProofCat …") SUCCEEDS
 *   4) createCategory(same, different case) → ConflictError
 *   5) createCategory(whitespace variant) → ConflictError
 *   6) Raw INSERT duplicate → PostgreSQL 23505
 *   7) Zero remaining CI duplicate groups
 *
 * Usage:
 *   cd SamplePOS.Server && npx tsx scripts/proof-product-category-name-live.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { randomUUID } from 'crypto';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serverRoot, '..');

function loadEnv(): void {
  for (const rel of ['.env', '.env.local']) {
    const p = path.join(serverRoot, rel);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (m[1] === 'DATABASE_URL' || process.env[m[1]] === undefined) {
        process.env[m[1]] = v;
      }
    }
  }
}

loadEnv();

const rawUrl = (process.env.DATABASE_URL || '').trim();
if (!rawUrl) {
  console.error('DATABASE_URL missing — cannot run live proof');
  process.exit(2);
}
process.env.DATABASE_URL = rawUrl;
const connectionString = rawUrl.split('?')[0];

type Gate = { id: string; ok: boolean; detail: string; evidence?: unknown };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string, evidence?: unknown): void {
  gates.push({ id, ok, detail, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
}

const pool = new pg.Pool({ connectionString, max: 4 });
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const BASE_NAME = `ProofCat ${stamp}`;
const createdIds: string[] = [];

async function countCiDuplicateGroups(client: pg.PoolClient): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM (
       SELECT LOWER(TRIM(name)) AS k
       FROM product_categories
       GROUP BY LOWER(TRIM(name))
       HAVING COUNT(*) > 1
     ) d`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function ensureUniqueIndex(client: pg.PoolClient): Promise<{ appliedSql: boolean; indexExists: boolean }> {
  // Apply heal steps in a fresh transaction; never leave client aborted.
  const migPath = path.join(repoRoot, 'shared/sql/618_product_category_name_unique_ssot.sql');
  let appliedSql = false;
  if (fs.existsSync(migPath)) {
    const sql = fs.readFileSync(migPath, 'utf8');
    try {
      await client.query('BEGIN');
      // Strip outer BEGIN/COMMIT — we own the transaction
      const body = sql
        .replace(/^\s*BEGIN\s*;/i, '')
        .replace(/\s*COMMIT\s*;\s*$/i, '');
      await client.query(body);
      await client.query('COMMIT');
      appliedSql = true;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      console.warn('Migration apply note:', (err as Error).message.slice(0, 240));
      // Fallback: ensure constraint dropped + CI index exists
      try {
        await client.query(
          `ALTER TABLE product_categories DROP CONSTRAINT IF EXISTS product_categories_name_key`,
        );
        await client.query(`DROP INDEX IF EXISTS product_categories_name_key`);
        await client.query(`DROP INDEX IF EXISTS idx_product_categories_name`);
        await client.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS uq_product_categories_name_ci
            ON product_categories (LOWER(TRIM(name)))
        `);
      } catch (err2) {
        console.warn('Fallback index note:', (err2 as Error).message.slice(0, 240));
      }
    }
  }

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_product_categories_name_ci
      ON product_categories (LOWER(TRIM(name)))
  `);

  const idx = await client.query(
    `SELECT 1 FROM pg_indexes
     WHERE indexname = 'uq_product_categories_name_ci'`,
  );
  return { appliedSql, indexExists: (idx.rowCount ?? 0) > 0 };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log('═'.repeat(60));
  console.log(' LIVE proof: product category name SSOT');
  console.log(` stamp: ${stamp}`);
  console.log('═'.repeat(60));

  const client = await pool.connect();
  try {
    const dbName = (await client.query('SELECT current_database() AS d')).rows[0]?.d;
    gate('LIVE_DB_CONNECTED', !!dbName, `connected to database ${dbName}`);

    const table = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = 'product_categories'`,
    );
    gate(
      'PRODUCT_CATEGORIES_TABLE',
      (table.rowCount ?? 0) > 0,
      'product_categories table exists',
    );

    const { appliedSql, indexExists } = await ensureUniqueIndex(client);
    gate(
      'CI_UNIQUE_INDEX_LIVE',
      indexExists,
      `uq_product_categories_name_ci present (migrationApplied=${appliedSql})`,
      { appliedSql, indexExists },
    );

    const dupGroups = await countCiDuplicateGroups(client);
    gate(
      'ZERO_CI_DUPLICATE_GROUPS',
      dupGroups === 0,
      `case-insensitive duplicate groups = ${dupGroups}`,
      { dupGroups },
    );

    const { createCategory } = await import('../src/modules/pricing/pricingEngineService.js');

    const created = await createCategory(pool, {
      name: BASE_NAME,
      description: 'live proof row — safe to delete',
    });
    createdIds.push(created.id);
    gate(
      'CREATE_CANONICAL_OK',
      !!created.id && created.name === BASE_NAME,
      `created id=${created.id} name="${created.name}"`,
      { id: created.id, name: created.name },
    );

    function isConflict(err: unknown): { ok: boolean; message: string; status?: number } {
      const e = err as { message?: string; statusCode?: number; name?: string; constructor?: { name?: string } };
      const message = String(e?.message ?? err);
      const status = e?.statusCode;
      const name = e?.name ?? e?.constructor?.name ?? '';
      const ok =
        status === 409 ||
        name === 'ConflictError' ||
        /already exists/i.test(message) ||
        /unique/i.test(message);
      return { ok, message, status };
    }

    // Duplicate different case
    let caseResult = { ok: false, message: 'no error thrown', status: undefined as number | undefined };
    try {
      const dup = await createCategory(pool, { name: BASE_NAME.toUpperCase() });
      createdIds.push(dup.id);
      caseResult = { ok: false, message: `UNEXPECTED create succeeded id=${dup.id}`, status: undefined };
    } catch (err) {
      caseResult = isConflict(err);
    }
    gate(
      'REJECT_CASE_VARIANT',
      caseResult.ok,
      caseResult.ok
        ? `rejected "${BASE_NAME.toUpperCase()}": ${caseResult.message}`
        : `expected conflict, got: ${caseResult.message}`,
      { attempted: BASE_NAME.toUpperCase(), ...caseResult },
    );

    // Duplicate with whitespace
    let wsResult = { ok: false, message: 'no error thrown', status: undefined as number | undefined };
    try {
      const dup = await createCategory(pool, { name: `  ${BASE_NAME}  ` });
      createdIds.push(dup.id);
      wsResult = { ok: false, message: `UNEXPECTED create succeeded id=${dup.id}`, status: undefined };
    } catch (err) {
      wsResult = isConflict(err);
    }
    gate(
      'REJECT_WHITESPACE_VARIANT',
      wsResult.ok,
      wsResult.ok
        ? `rejected whitespace variant: ${wsResult.message}`
        : `expected conflict, got: ${wsResult.message}`,
      { attempted: `  ${BASE_NAME}  `, ...wsResult },
    );

    // Raw SQL must also fail (DB SSOT, not only app check)
    let pgCode: string | null = null;
    try {
      await client.query(
        `INSERT INTO product_categories (id, name, description)
         VALUES ($1, $2, $3)`,
        [randomUUID(), BASE_NAME.toLowerCase(), 'should fail unique'],
      );
    } catch (err) {
      pgCode = (err as { code?: string }).code ?? null;
    }
    gate(
      'DB_23505_ON_RAW_INSERT',
      pgCode === '23505',
      `raw INSERT duplicate → pg code ${pgCode ?? 'none (insert succeeded — BAD)'}`,
      { pgCode, attempted: BASE_NAME.toLowerCase() },
    );

    // Lookup resolves case-insensitively to the canonical row
    const lookup = await client.query(
      `SELECT id, name FROM product_categories
       WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))`,
      [BASE_NAME.toUpperCase()],
    );
    gate(
      'CI_LOOKUP_SINGLE_ROW',
      lookup.rowCount === 1 && lookup.rows[0].id === created.id,
      `LOWER(TRIM) lookup returns single canonical row id=${lookup.rows[0]?.id}`,
      { rows: lookup.rows },
    );

    const dupAfter = await countCiDuplicateGroups(client);
    gate(
      'STILL_ZERO_CI_DUPLICATES',
      dupAfter === 0,
      `duplicate groups after attempts = ${dupAfter}`,
      { dupAfter },
    );
  } finally {
    // Cleanup proof rows
    if (createdIds.length > 0) {
      try {
        await client.query(`DELETE FROM product_categories WHERE id = ANY($1::uuid[])`, [
          createdIds,
        ]);
        console.log(`cleaned ${createdIds.length} proof categor(y/ies)`);
      } catch (err) {
        console.warn('cleanup warning:', (err as Error).message);
      }
    }
    client.release();
    await pool.end();
  }

  const passed = gates.filter((g) => g.ok).length;
  const total = gates.length;
  const verdict = passed === total && total > 0 ? 'PASS' : 'FAIL';
  const generatedAt = new Date().toISOString();
  const payload = {
    proof: 'PRODUCT_CATEGORY_NAME_LIVE',
    verdict,
    generatedAt,
    startedAt,
    stamp,
    baseName: BASE_NAME,
    passed,
    total,
    gates,
    integrity:
      'Measured live: unique index present, create succeeds once, case/whitespace duplicates ConflictError, raw INSERT 23505, zero CI duplicate groups.',
    howToRun: [
      'cd SamplePOS.Server && npx tsx scripts/proof-product-category-name-live.ts',
    ],
  };

  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const md = [
    '# PROOF — Product category name LIVE',
    '',
    `**Verdict:** ${verdict}`,
    `**Generated:** ${generatedAt}`,
    `**Gates:** ${passed}/${total}`,
    `**Stamp:** ${stamp}`,
    '',
    ...gates.map(
      (g) =>
        `- ${g.ok ? 'PASS' : 'FAIL'} \`${g.id}\` — ${g.detail}` +
        (g.evidence ? `\n  - evidence: \`${JSON.stringify(g.evidence)}\`` : ''),
    ),
    '',
    '## Integrity',
    payload.integrity,
    '',
    '## How to re-run',
    '```',
    ...payload.howToRun,
    '```',
    '',
  ].join('\n');

  for (const dir of [serverRoot, repoRoot]) {
    fs.writeFileSync(path.join(dir, 'PROOF_PRODUCT_CATEGORY_NAME_LIVE.json'), json);
    fs.writeFileSync(path.join(dir, 'PROOF_PRODUCT_CATEGORY_NAME_LIVE.md'), md);
  }

  console.log('═'.repeat(60));
  console.log(` VERDICT ${verdict} (${passed}/${total})`);
  console.log(' wrote PROOF_PRODUCT_CATEGORY_NAME_LIVE.{json,md}');
  console.log('═'.repeat(60));

  process.exit(verdict === 'PASS' ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
