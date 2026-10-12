#!/usr/bin/env node
/**
 * Rebuild an ACTIVE tenant DB that is a schema stub from pos_template,
 * then sync ledger + pending DDL via tenantMigrationService (never replay 001).
 *
 *   node scripts/rebuild-stub-tenant-from-template.mjs --slug=acme-store
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MASTER = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/pos_system';
const slugArg = process.argv.find((a) => a.startsWith('--slug='))?.slice('--slug='.length);
if (!slugArg) {
  console.error('Usage: node scripts/rebuild-stub-tenant-from-template.mjs --slug=<tenant-slug>');
  process.exit(1);
}

const master = new pg.Pool({ connectionString: MASTER, max: 1 });
const u = new URL(MASTER);
const adminUrl = `${u.protocol}//${u.username}:${u.password}@${u.hostname}:${u.port || 5432}/postgres`;

try {
  const { rows } = await master.query(
    `SELECT slug, status, database_name FROM tenants WHERE slug = $1`,
    [slugArg],
  );
  if (!rows[0]) throw new Error(`Tenant slug "${slugArg}" not in registry`);
  const dbName = rows[0].database_name;
  if (!/^pos_tenant_[a-z0-9_]+$/i.test(dbName)) {
    throw new Error(`Refusing to rebuild unexpected database name: ${dbName}`);
  }

  const tpl = await master.query(`SELECT 1 FROM pg_database WHERE datname = 'pos_template'`);
  if (!tpl.rowCount) throw new Error('pos_template missing — start backend or rebuild template first');

  console.log(`Rebuilding ${dbName} (slug=${slugArg}) from pos_template…`);

  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName} TEMPLATE pos_template`);
  } finally {
    await admin.end();
  }

  const result = spawnSync(
    process.execPath,
    [
      path.join(serverRoot, 'node_modules/tsx/dist/cli.mjs'),
      path.join(serverRoot, 'scripts/rebuild-stub-tenant-sync.ts'),
      `--slug=${slugArg}`,
      `--db=${dbName}`,
    ],
    {
      cwd: serverRoot,
      encoding: 'utf8',
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: MASTER },
    },
  );
  if (result.status !== 0) {
    throw new Error(`prepareNewTenantDatabase failed (exit ${result.status})`);
  }
} finally {
  await master.end();
}
