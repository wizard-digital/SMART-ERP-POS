/**
 * Second stage of stub rebuild: sync ledger from reference + ensureTenantUpToDate.
 * Invoked by rebuild-stub-tenant-from-template.mjs
 *
 *   npx tsx scripts/rebuild-stub-tenant-sync.ts --slug=acme-store --db=pos_tenant_acme_store
 */
import pg from 'pg';
import { tenantMigrationService } from '../src/modules/system/tenantMigrationService.js';

const MASTER = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/pos_system';
const slug = process.argv.find((a) => a.startsWith('--slug='))?.slice('--slug='.length);
const dbName = process.argv.find((a) => a.startsWith('--db='))?.slice('--db='.length);
if (!slug || !dbName) {
  console.error('Usage: tsx scripts/rebuild-stub-tenant-sync.ts --slug=... --db=...');
  process.exit(1);
}

const u = new URL(MASTER);
const tenantUrl = `${u.protocol}//${u.username}:${u.password}@${u.hostname}:${u.port || 5432}/${dbName}`;

const masterPool = new pg.Pool({ connectionString: MASTER, max: 2 });
const tenantPool = new pg.Pool({ connectionString: tenantUrl, max: 2 });

try {
  await tenantMigrationService.prepareNewTenantDatabase(tenantPool, slug, masterPool);
  const check = await tenantPool.query<{
    min_days: boolean;
    batch_status: boolean;
    product_valuation: boolean;
    mig_count: number;
    schema_version: number;
  }>(`
    SELECT
      EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='products' AND column_name='min_days_before_expiry_sale') AS min_days,
      EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='inventory_batches' AND column_name='status') AS batch_status,
      EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_name='product_valuation') AS product_valuation,
      (SELECT COUNT(*)::int FROM schema_migrations) AS mig_count,
      (SELECT COALESCE(MAX(version),0) FROM schema_version) AS schema_version
  `);
  console.log(JSON.stringify({ ok: true, db: dbName, ...check.rows[0] }, null, 2));
  if (!check.rows[0]?.min_days || !check.rows[0]?.batch_status || !check.rows[0]?.product_valuation) {
    throw new Error('Rebuild incomplete — FEFO columns still missing');
  }
} finally {
  await tenantPool.end();
  await masterPool.end();
}
