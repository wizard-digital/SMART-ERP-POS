/**
 * Integrity + consistency proof for tenant schema SSOT.
 * Executed against live DBs. Grep is not a pass.
 *
 * A tenant is current only when version, numbered files, required tables,
 * critical columns, and postconditions all match. Copied ledger rows without
 * DDL do not count. Incomplete tenants fail closed and are not marked verified.
 */
import { spawnSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { tenantMigrationService } from '../src/modules/system/tenantMigrationService.js';
import { CURRENT_SCHEMA_VERSION } from '../src/constants/schemaVersion.js';
import {
  CRITICAL_SCHEMA_COLUMNS,
  verifyTenantSchemaIntegrity,
} from '../src/modules/system/tenantSchemaIntegrity.js';
import {
  TENANT_REQUIRED_TABLES,
  findColumnDriftedMigrationFiles,
} from '../src/modules/system/migrationAnchors.js';
import { findPostconditionDriftedMigrationFiles } from '../src/modules/system/migrationPostconditions.js';

const MASTER =
  process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/pos_system';

const outJson = path.resolve(process.cwd(), '..', 'PROOF_TENANT_SCHEMA_SSOT.json');
const outMd = path.resolve(process.cwd(), '..', 'PROOF_TENANT_SCHEMA_SSOT.md');

type SsotFingerprint = {
  label: string;
  version: number | null;
  numberedFileCount: number | null;
  numberedFileHash: string | null;
  lastNumberedFile: string | null;
  pendingCount: number | null;
  pendingSample: string[];
  missingRequiredTables: string[];
  missingCriticalColumns: string[];
  postconditionDrift: string[];
  columnDriftFiles: string[];
  hasParticipants: boolean;
  hasPosSessionPolicy: boolean;
  hasChkPosSessionPolicy: boolean;
  hasCategoryCiIndex: boolean;
  hasSalesSessionId: boolean;
  hasExpensesEmployeeId: boolean;
};

function ssotKey(fp: SsotFingerprint) {
  return JSON.stringify({
    version: fp.version,
    numberedFileCount: fp.numberedFileCount,
    numberedFileHash: fp.numberedFileHash,
    lastNumberedFile: fp.lastNumberedFile,
    pendingCount: fp.pendingCount,
    missingRequiredTables: fp.missingRequiredTables,
    missingCriticalColumns: fp.missingCriticalColumns,
    postconditionDrift: fp.postconditionDrift,
    columnDriftFiles: fp.columnDriftFiles,
    hasParticipants: fp.hasParticipants,
    hasPosSessionPolicy: fp.hasPosSessionPolicy,
    hasChkPosSessionPolicy: fp.hasChkPosSessionPolicy,
    hasCategoryCiIndex: fp.hasCategoryCiIndex,
    hasSalesSessionId: fp.hasSalesSessionId,
    hasExpensesEmployeeId: fp.hasExpensesEmployeeId,
  });
}

async function fingerprint(pool: pg.Pool, label: string): Promise<SsotFingerprint> {
  const version = await pool
    .query(`SELECT COALESCE(MAX(version), 0)::int AS v FROM schema_version`)
    .then((r) => Number(r.rows[0]?.v ?? 0))
    .catch(() => null);

  const files = await pool
    .query<{ n: number; hash: string | null; last: string | null }>(
      `SELECT COUNT(*)::int AS n,
              md5(string_agg(filename, ',' ORDER BY filename)) AS hash,
              MAX(filename) AS last
       FROM schema_migrations
       WHERE filename ~ '^[0-9]{3}_'`
    )
    .catch(() => ({ rows: [{ n: 0, hash: null, last: null }] }));

  const { rows: tables } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  );
  const existing = new Set(tables.map((t) => t.tablename));
  const missingRequiredTables = TENANT_REQUIRED_TABLES.filter((t) => !existing.has(t));

  const integrity = await verifyTenantSchemaIntegrity(pool).catch(() => ({
    ok: false,
    missing: [{ table: '(query)', column: '(failed)' }],
  }));
  const missingCriticalColumns = integrity.missing.map((m) => `${m.table}.${m.column}`);

  const postconditionDrift = existing.size
    ? await findPostconditionDriftedMigrationFiles(pool).catch(() => ['(postcondition query failed)'])
    : ['(no public tables)'];

  const { rows: colRows } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'`
  );
  const columnMap = new Map<string, Set<string>>();
  for (const row of colRows) {
    let cols = columnMap.get(row.table_name);
    if (!cols) {
      cols = new Set();
      columnMap.set(row.table_name, cols);
    }
    cols.add(row.column_name);
  }
  const columnDriftFiles = findColumnDriftedMigrationFiles(columnMap);

  const flags = await pool.query<{
    participants: boolean;
    pos_policy: boolean;
    chk: boolean;
    cat_ci: boolean;
    sales_session: boolean;
    expense_emp: boolean;
  }>(`
    SELECT
      EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_name = 'cash_register_session_participants') AS participants,
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'system_settings' AND column_name = 'pos_session_policy') AS pos_policy,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_pos_session_policy') AS chk,
      EXISTS (SELECT 1 FROM pg_indexes
              WHERE schemaname = 'public' AND indexname = 'uq_product_categories_name_ci') AS cat_ci,
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'sales' AND column_name = 'cash_register_session_id') AS sales_session,
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'expenses' AND column_name = 'employee_id') AS expense_emp
  `);

  let pending: string[] = [];
  if (existing.has('schema_migrations')) {
    pending = await tenantMigrationService._listPendingMigrationFiles(pool).catch(() => [
      '(pending list failed)',
    ]);
  } else {
    pending = ['(no schema_migrations)'];
  }

  return {
    label,
    version,
    numberedFileCount: files.rows[0]?.n ?? null,
    numberedFileHash: files.rows[0]?.hash ?? null,
    lastNumberedFile: files.rows[0]?.last ?? null,
    pendingCount: pending.length,
    pendingSample: pending.slice(0, 8),
    missingRequiredTables,
    missingCriticalColumns,
    postconditionDrift,
    columnDriftFiles,
    hasParticipants: flags.rows[0]?.participants === true,
    hasPosSessionPolicy: flags.rows[0]?.pos_policy === true,
    hasChkPosSessionPolicy: flags.rows[0]?.chk === true,
    hasCategoryCiIndex: flags.rows[0]?.cat_ci === true,
    hasSalesSessionId: flags.rows[0]?.sales_session === true,
    hasExpensesEmployeeId: flags.rows[0]?.expense_emp === true,
  };
}

function fingerprintIsCurrent(fp: SsotFingerprint): boolean {
  return (
    fp.version === CURRENT_SCHEMA_VERSION &&
    fp.pendingCount === 0 &&
    fp.missingRequiredTables.length === 0 &&
    fp.missingCriticalColumns.length === 0 &&
    fp.postconditionDrift.length === 0 &&
    fp.columnDriftFiles.length === 0 &&
    fp.hasParticipants &&
    fp.hasPosSessionPolicy &&
    fp.hasChkPosSessionPolicy &&
    fp.hasCategoryCiIndex &&
    fp.hasSalesSessionId &&
    fp.hasExpensesEmployeeId
  );
}

async function provePoisonedLedgerHeal() {
  const dbName = 'proof_schema_ssot_heal';
  const admin = new pg.Client({ connectionString: MASTER });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }

  const u = new URL(MASTER);
  const healUrl = `${u.protocol}//${u.username}:${u.password}@${u.host}/${dbName}`;
  const pool = new pg.Pool({ connectionString: healUrl, max: 2 });
  const sqlDir = path.resolve(process.cwd(), '..', 'shared', 'sql');

  try {
    await pool.query(`
      CREATE TABLE cash_register_sessions (id UUID PRIMARY KEY);
      CREATE TABLE sales (id UUID PRIMARY KEY);
      CREATE TABLE system_settings (id SERIAL PRIMARY KEY);
      CREATE TABLE schema_migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT UNIQUE NOT NULL,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        checksum TEXT
      );
      INSERT INTO schema_migrations (filename, checksum)
      VALUES ('502_pos_session_enforcement.sql', 'poisoned-copy');
    `);

    const before = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'system_settings' AND column_name = 'pos_session_policy'
       ) AS exists`
    );
    if (before.rows[0]?.exists) throw new Error('fixture already had pos_session_policy');

    const { rows: colRows } = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
    );
    const columnMap = new Map<string, Set<string>>();
    for (const row of colRows) {
      let cols = columnMap.get(row.table_name);
      if (!cols) {
        cols = new Set();
        columnMap.set(row.table_name, cols);
      }
      cols.add(row.column_name);
    }
    const drifted502 = findColumnDriftedMigrationFiles(columnMap).includes(
      '502_pos_session_enforcement.sql'
    );

    await tenantMigrationService._applyMigrationFile(
      pool,
      'proof-heal',
      '502_pos_session_enforcement.sql',
      sqlDir
    );

    const after = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'system_settings' AND column_name = 'pos_session_policy'
       ) AS exists`
    );
    const columnRestored = after.rows[0]?.exists === true;
    return { ok: drifted502 && columnRestored, drifted502, columnRestored };
  } catch (err) {
    return {
      ok: false,
      drifted502: false,
      columnRestored: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await pool.end().catch(() => undefined);
    const cleanup = new pg.Client({ connectionString: MASTER });
    await cleanup.connect();
    try {
      await cleanup.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName]
      );
      await cleanup.query(`DROP DATABASE IF EXISTS ${dbName}`);
    } finally {
      await cleanup.end();
    }
  }
}

function runJest(): { ok: boolean; passed: number; failed: number; output: string } {
  const r = spawnSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      './node_modules/jest/bin/jest.js',
      '--runInBand',
      '--forceExit',
      'src/modules/system/tenantMigrationDrift.test.ts',
      'src/modules/system/tenantSchemaIntegrity.test.ts',
      'src/modules/system/migrationAnchors.test.ts',
    ],
    { cwd: process.cwd(), encoding: 'utf8' }
  );
  const output = `${r.stdout || ''}\n${r.stderr || ''}`;
  const m = output.match(/Tests:\s+(\d+) failed,\s+(\d+) passed/) 
    || output.match(/Tests:\s+(\d+) passed/);
  let passed = 0;
  let failed = 0;
  if (m && m[2]) {
    failed = Number(m[1]);
    passed = Number(m[2]);
  } else if (m) {
    passed = Number(m[1]);
  }
  return { ok: r.status === 0 && failed === 0 && passed > 0, passed, failed, output: output.slice(-2000) };
}

async function openTenantPool(
  t: { database_name: string; database_host: string; database_port: number }
) {
  const dbUser = process.env.DB_USER || 'postgres';
  const dbPassword = process.env.DB_PASSWORD || process.env.DATABASE_PASSWORD || 'password';
  return new pg.Pool({
    host: t.database_host,
    port: t.database_port,
    database: t.database_name,
    user: dbUser,
    password: dbPassword,
    max: 3,
  });
}

async function main() {
  const generatedAt = new Date().toISOString();
  tenantMigrationService.clearCache();

  const jestResult = runJest();

  const master = new pg.Pool({ connectionString: MASTER });
  const tenants = await master.query<{
    slug: string;
    database_name: string;
    database_host: string;
    database_port: number;
    status: string;
  }>(
    `SELECT slug, database_name, database_host, database_port, status
     FROM tenants WHERE status = 'ACTIVE' ORDER BY slug`
  );

  const subjects: Array<{
    slug: string;
    fingerprintBefore?: SsotFingerprint;
    fingerprintAfter: SsotFingerprint;
    ensure: 'pass' | 'fail-closed' | 'reference';
    verified: boolean;
    error?: string;
  }> = [];

  const posPool = new pg.Pool({ connectionString: MASTER, max: 3 });
  try {
    const before = await fingerprint(posPool, 'pos_system');
    let ensure: 'pass' | 'fail-closed' | 'reference' = 'pass';
    let error: string | undefined;
    try {
      await tenantMigrationService.ensureTenantUpToDate(posPool, 'pos_system');
    } catch (err) {
      ensure = 'fail-closed';
      error = err instanceof Error ? err.message : String(err);
    }
    const after = await fingerprint(posPool, 'pos_system');
    const verified = tenantMigrationService.isVerified('pos_system');
    if (ensure === 'pass' && (!verified || !fingerprintIsCurrent(after))) {
      throw new Error('pos_system ensure pass but fingerprint is not current');
    }
    if (ensure === 'fail-closed' && verified) {
      throw new Error('pos_system failed but marked verified');
    }
    subjects.push({
      slug: 'pos_system',
      fingerprintBefore: before,
      fingerprintAfter: after,
      ensure,
      verified,
      error,
    });
  } finally {
    await posPool.end();
  }

  for (const t of tenants.rows) {
    if (t.database_host && t.database_host !== 'localhost') {
      subjects.push({
        slug: t.slug,
        fingerprintAfter: {
          label: t.slug,
          version: null,
          numberedFileCount: null,
          numberedFileHash: null,
          lastNumberedFile: null,
          pendingCount: null,
          pendingSample: [],
          missingRequiredTables: ['(remote skipped)'],
          missingCriticalColumns: [],
          postconditionDrift: [],
          columnDriftFiles: [],
          hasParticipants: false,
          hasPosSessionPolicy: false,
          hasChkPosSessionPolicy: false,
          hasCategoryCiIndex: false,
          hasSalesSessionId: false,
          hasExpensesEmployeeId: false,
        },
        ensure: 'fail-closed',
        verified: false,
        error: `remote ${t.database_host}`,
      });
      continue;
    }

    const pool = await openTenantPool(t);
    try {
      const before = await fingerprint(pool, t.slug);
      let ensure: 'pass' | 'fail-closed' = 'pass';
      let error: string | undefined;
      try {
        await tenantMigrationService.ensureTenantUpToDate(pool, t.slug);
      } catch (err) {
        ensure = 'fail-closed';
        error = err instanceof Error ? err.message : String(err);
      }
      const after = await fingerprint(pool, t.slug);
      const verified = tenantMigrationService.isVerified(t.slug);

      if (ensure === 'pass' && !verified) {
        throw new Error(`${t.slug}: ensure pass without verified flag`);
      }
      if (ensure === 'pass' && !fingerprintIsCurrent(after)) {
        throw new Error(`${t.slug}: ensure pass but schema fingerprint is not current`);
      }
      if (ensure === 'fail-closed' && verified) {
        throw new Error(`${t.slug}: fail-closed but marked verified`);
      }
      if (ensure === 'fail-closed' && fingerprintIsCurrent(after)) {
        throw new Error(`${t.slug}: fail-closed on a current schema (false failure)`);
      }

      subjects.push({
        slug: t.slug,
        fingerprintBefore: before,
        fingerprintAfter: after,
        ensure,
        verified,
        error,
      });
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  await master.end();

  const poisonedHeal = await provePoisonedLedgerHeal();

  const current = subjects.filter((s) => s.ensure === 'pass');
  const failClosed = subjects.filter((s) => s.ensure === 'fail-closed');

  const ref = current[0];
  const mismatches: Array<{ slug: string; vs: string; detail: string }> = [];
  if (ref) {
    const refKey = ssotKey(ref.fingerprintAfter);
    for (const s of current) {
      if (ssotKey(s.fingerprintAfter) !== refKey) {
        mismatches.push({
          slug: s.slug,
          vs: ref.slug,
          detail: 'SSOT fingerprint differs from reference complete tenant',
        });
      }
    }
  } else {
    mismatches.push({ slug: '(none)', vs: '', detail: 'no complete tenant to use as reference' });
  }

  const requiredCritical = [
    'customers.customer_group_id',
    'system_settings.pos_session_policy',
    'sales.cash_register_session_id',
    'expenses.employee_id',
  ];
  const criticalCoverage = requiredCritical.every((k) =>
    Object.entries(CRITICAL_SCHEMA_COLUMNS).some(([table, cols]) =>
      cols.some((c) => `${table}.${c}` === k)
    )
  );

  const versionFile = fs.readFileSync(
    path.resolve(process.cwd(), '..', 'shared', 'sql', '621_tenant_schema_ssot.sql'),
    'utf8'
  );
  const versionConst = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'constants', 'schemaVersion.ts'),
    'utf8'
  );
  const versionAligned =
    CURRENT_SCHEMA_VERSION === 622 &&
    versionFile.includes('SELECT 621') &&
    /CURRENT_SCHEMA_VERSION = 622/.test(versionConst);

  const ok =
    jestResult.ok &&
    poisonedHeal.ok &&
    versionAligned &&
    criticalCoverage &&
    mismatches.length === 0 &&
    current.length > 0 &&
    current.every((s) => s.verified && fingerprintIsCurrent(s.fingerprintAfter)) &&
    failClosed.every((s) => !s.verified && !fingerprintIsCurrent(s.fingerprintAfter));

  const proof = {
    ok,
    generatedAt,
    currentSchemaVersion: CURRENT_SCHEMA_VERSION,
    gates: {
      jest: jestResult.ok,
      jestPassed: jestResult.passed,
      jestFailed: jestResult.failed,
      versionAligned,
      criticalCoverage,
      poisonedLedgerHeal: poisonedHeal.ok,
      completeTenantsConsistent: mismatches.length === 0 && current.length > 0,
      failClosedHonest: failClosed.every((s) => !s.verified),
    },
    complete: current.map((s) => s.slug),
    failClosed: failClosed.map((s) => ({ slug: s.slug, error: s.error, verified: s.verified })),
    mismatches,
    poisonedLedgerHeal: poisonedHeal,
    fingerprints: subjects.map((s) => ({
      slug: s.slug,
      ensure: s.ensure,
      verified: s.verified,
      error: s.error,
      after: s.fingerprintAfter,
    })),
  };

  const md = [
    '# PROOF — Tenant schema integrity and consistency',
    '',
    `**Generated:** ${generatedAt}`,
    `**Verdict:** **${ok ? 'PASS' : 'FAIL'}**`,
    `**CURRENT_SCHEMA_VERSION:** ${CURRENT_SCHEMA_VERSION}`,
    '',
    'A tenant is current only when numbered files, integer version, required tables, critical columns, and postconditions all match. Copied `schema_migrations` rows without DDL do not count.',
    '',
    '## Gates (executed)',
    '',
    `| Gate | Result | Detail |`,
    `|------|--------|--------|`,
    `| Jest SSOT tests | ${jestResult.ok ? 'PASS' : 'FAIL'} | ${jestResult.passed} passed, ${jestResult.failed} failed |`,
    `| Version 622 + 621 stamp | ${versionAligned ? 'PASS' : 'FAIL'} | const 622 and 621 stamp file |`,
    `| Critical column coverage | ${criticalCoverage ? 'PASS' : 'FAIL'} | customer_group_id, pos_session_policy, cash_register_session_id, employee_id |`,
    `| Poisoned 502 ledger heal | ${poisonedHeal.ok ? 'PASS' : 'FAIL'} | drifted=${poisonedHeal.drifted502} restored=${poisonedHeal.columnRestored} |`,
    `| Complete tenants identical SSOT | ${mismatches.length === 0 && current.length > 0 ? 'PASS' : 'FAIL'} | ${current.map((s) => s.slug).join(', ') || '(none)'} |`,
    `| Fail-closed not marked verified | ${failClosed.every((s) => !s.verified) ? 'PASS' : 'FAIL'} | ${failClosed.map((s) => s.slug).join(', ') || 'none'} |`,
    '',
    '## Complete tenant fingerprints (must match)',
    '',
    '| Tenant | version | numbered files | hash | pending | required missing | critical missing | post drift | 620 participants | policy col | policy chk | 618 CI |',
    '|--------|---------|----------------|------|---------|------------------|------------------|------------|------------------|------------|------------|--------|',
    ...current.map((s) => {
      const f = s.fingerprintAfter;
      return `| ${s.slug} | ${f.version} | ${f.numberedFileCount} | ${(f.numberedFileHash || '').slice(0, 8)} | ${f.pendingCount} | ${f.missingRequiredTables.length} | ${f.missingCriticalColumns.length} | ${f.postconditionDrift.length} | ${f.hasParticipants} | ${f.hasPosSessionPolicy} | ${f.hasChkPosSessionPolicy} | ${f.hasCategoryCiIndex} |`;
    }),
    '',
    mismatches.length
      ? `## Mismatches\n\n${mismatches.map((m) => `- ${m.slug} vs ${m.vs}: ${m.detail}`).join('\n')}`
      : 'No SSOT fingerprint mismatches among complete tenants.',
    '',
    '## Fail closed',
    '',
    ...failClosed.map(
      (s) =>
        `- **${s.slug}**: verified=${s.verified}, current=${fingerprintIsCurrent(s.fingerprintAfter)}, ${s.error || 'failed'}`
    ),
    failClosed.length === 0 ? '- none' : '',
    '',
    'Not deployed.',
    '',
  ].join('\n');

  fs.writeFileSync(outJson, JSON.stringify(proof, null, 2));
  fs.writeFileSync(outMd, md);

  console.log(JSON.stringify({ ok, gates: proof.gates, complete: proof.complete, failClosed: proof.failClosed, mismatches }, null, 2));
  if (!ok) {
    console.error(jestResult.ok ? '' : jestResult.output);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
