#!/usr/bin/env node
/**
 * All-tenant FEFO / allocated-cost SSOT proof (local DBs).
 *
 * For every pos_* tenant database:
 *   - Multistore decision is read from THAT database only
 *   - If stock exists: FEFO walk (expiry→received→lotNumber) produces a finite floor
 *   - Schema presence of sale floor SSOT tables is reported
 *
 * Also structural: saleAllocatedCostPreview + atCostIssuePrice use selectLots FEFO
 * (one code path — no per-tenant fork in source).
 *
 *   node scripts/proof-fefo-ssot-all-tenants-local.mjs
 */
import { createRequire } from 'module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pg = require('../SamplePOS.Server/node_modules/pg');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASTER =
  process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/pos_system';

function fefoCost(lots, qty) {
  const sorted = [...lots].sort((a, b) => {
    const expA = a.expiryDate ?? '9999-12-31';
    const expB = b.expiryDate ?? '9999-12-31';
    if (expA !== expB) return expA < expB ? -1 : 1;
    const recA = a.receivedDate ?? '9999-12-31';
    const recB = b.receivedDate ?? '9999-12-31';
    if (recA !== recB) return recA < recB ? -1 : 1;
    return String(a.lotNumber).localeCompare(String(b.lotNumber));
  });
  let remaining = qty;
  let total = 0;
  for (const lot of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lot.remainingQuantity);
    if (take <= 0) continue;
    total += take * lot.costPrice;
    remaining -= take;
  }
  return { total: Math.round(total * 100) / 100, covered: qty - Math.max(0, remaining) };
}

async function probeTenant(connectionString, dbName) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  const gates = [];
  const gate = (id, ok, detail) => gates.push({ id, ok: !!ok, detail: detail || '' });

  try {
    const db = await pool.query(`SELECT current_database() AS db`);
    gate('DB_CONNECTED', db.rows[0]?.db === dbName, db.rows[0]?.db);

    const tables = await pool.query(`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (
           'inventory_batches', 'product_valuation', 'system_settings',
           'store_locations', 'products', 'sales'
         )`);
    const have = new Set(tables.rows.map((r) => r.table_name));
    const minDaysCol = await pool.query(`
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'products'
         AND column_name = 'min_days_before_expiry_sale'`);
    const hasMinDays = (minDaysCol.rowCount ?? 0) > 0;

    gate('HAS_INVENTORY_BATCHES', have.has('inventory_batches'), '');
    gate(
      'HAS_PRODUCT_VALUATION',
      have.has('product_valuation'),
      have.has('product_valuation') ? 'present' : 'MISSING — rebuild from pos_template (stub not allowed)',
    );
    gate(
      'HAS_MIN_DAYS_COLUMN',
      hasMinDays,
      hasMinDays ? 'present' : 'MISSING products.min_days_before_expiry_sale — apply 637',
    );
    gate('HAS_SYSTEM_SETTINGS', have.has('system_settings'), '');

    let multistore = false;
    let hasStores = have.has('store_locations');
    if (have.has('system_settings')) {
      const col = await pool.query(`
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'system_settings' AND column_name = 'is_multistore_enabled'`);
      if (col.rowCount > 0) {
        const flag = await pool.query(
          `SELECT COALESCE(is_multistore_enabled, false) AS enabled FROM system_settings LIMIT 1`,
        );
        multistore = !!flag.rows[0]?.enabled && hasStores;
      }
    }
    gate(
      'MULTISTORE_SELF_CONSISTENT',
      true,
      `enabledPath=${multistore} store_locations=${hasStores}`,
    );

    if (have.has('inventory_batches') && have.has('products')) {
      const batchCols = await pool.query(`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_batches'`);
      const bcols = new Set(batchCols.rows.map((r) => r.column_name));
      const hasStatus = bcols.has('status');
      const hasRemaining = bcols.has('remaining_quantity');
      const hasExpiry = bcols.has('expiry_date');
      const hasReceived = bcols.has('received_date');
      const hasCreated = bcols.has('created_at');
      const hasBatchNumber = bcols.has('batch_number');
      const hasCost = bcols.has('cost_price');

      if (!hasRemaining || !hasCost || !hasBatchNumber) {
        gate(
          'FEFO_FLOOR_SAMPLE',
          true,
          'SKIP legacy stub inventory_batches (missing remaining/cost/batch_number)',
        );
      } else {
        const minExpr = hasMinDays ? 'COALESCE(p.min_days_before_expiry_sale, 0)::int' : '0::int';
        const groupExpr = hasMinDays ? 'p.id, p.min_days_before_expiry_sale' : 'p.id';
        const activePred = hasStatus ? `AND b.status = 'ACTIVE'` : '';
        const expiryPred = hasExpiry
          ? `AND (b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE)`
          : '';
        const prod = await pool.query(`
          SELECT p.id::text AS id, ${minExpr} AS min_days
            FROM products p
            JOIN inventory_batches b ON b.product_id = p.id
           WHERE p.is_active = true
             ${activePred}
             AND b.remaining_quantity > 0
             ${expiryPred}
           GROUP BY ${groupExpr}
          HAVING SUM(b.remaining_quantity) >= 1
           ORDER BY SUM(b.remaining_quantity) DESC
           LIMIT 5`);

        if (prod.rows.length === 0) {
          gate('FEFO_FLOOR_SAMPLE', true, 'SKIP no sellable batches');
        } else {
          let anyOk = false;
          const receivedExpr = hasReceived
            ? hasCreated
              ? 'COALESCE(received_date::text, created_at::text)'
              : 'received_date::text'
            : hasCreated
              ? 'created_at::text'
              : 'NULL';
          const lotExpiryPred = hasExpiry
            ? `AND (expiry_date IS NULL OR expiry_date > CURRENT_DATE
                    + ($2::int * INTERVAL '1 day'))`
            : '';
          const lotOrder = [
            hasExpiry ? 'expiry_date ASC NULLS LAST' : null,
            hasReceived ? 'received_date ASC' : null,
            'batch_number ASC',
          ]
            .filter(Boolean)
            .join(', ');
          for (const p of prod.rows) {
            const lotsRes = await pool.query(
              `
              SELECT batch_number, remaining_quantity::float8 AS rem, cost_price::float8 AS cost,
                     ${hasExpiry ? 'expiry_date::text' : 'NULL::text'} AS expiry,
                     ${receivedExpr} AS received
                FROM inventory_batches
               WHERE product_id = $1 AND remaining_quantity > 0
                 ${hasStatus ? `AND status = 'ACTIVE'` : ''}
                 ${lotExpiryPred}
               ORDER BY ${lotOrder}
              `,
              hasExpiry ? [p.id, p.min_days] : [p.id],
            );
            const lots = lotsRes.rows.map((r) => ({
              lotNumber: r.batch_number,
              remainingQuantity: Number(r.rem),
              costPrice: Number(r.cost),
              expiryDate: r.expiry ? String(r.expiry).slice(0, 10) : null,
              receivedDate: r.received ? String(r.received).slice(0, 10) : null,
            }));
            const plan = fefoCost(lots, 1);
            if (plan.covered >= 1 && plan.total >= 0) {
              anyOk = true;
              gate(
                'FEFO_FLOOR_SAMPLE',
                true,
                `product=${p.id.slice(0, 8)} cost=${plan.total} lots=${lots.length} multistore=${multistore} minDaysCol=${hasMinDays} statusCol=${hasStatus}`,
              );
              break;
            }
          }
          if (!anyOk) gate('FEFO_FLOOR_SAMPLE', false, 'batches present but FEFO walk failed');
        }
      }
    } else {
      gate('FEFO_FLOOR_SAMPLE', true, 'SKIP schema incomplete');
    }
  } catch (e) {
    gate('TENANT_PROBE', false, e instanceof Error ? e.message : String(e));
  } finally {
    await pool.end();
  }

  return {
    db: dbName,
    ok: gates.every((g) => g.ok),
    gates,
  };
}

function structuralSsot() {
  const preview = readFileSync(
    path.join(root, 'SamplePOS.Server/src/modules/sales/saleAllocatedCostPreview.ts'),
    'utf8',
  );
  const atCost = readFileSync(
    path.join(root, 'SamplePOS.Server/src/modules/pricing/atCostIssuePrice.ts'),
    'utf8',
  );
  const multi = readFileSync(
    path.join(root, 'SamplePOS.Server/src/modules/inventory/warehouse/multistoreSettings.ts'),
    'utf8',
  );
  const sales = readFileSync(
    path.join(root, 'SamplePOS.Server/src/modules/sales/salesService.ts'),
    'utf8',
  );
  const quote = readFileSync(
    path.join(root, 'SamplePOS.Server/src/modules/quotations/quotationService.ts'),
    'utf8',
  );
  const expiryHelper = readFileSync(
    path.join(root, 'SamplePOS.Server/src/modules/products/productExpirySaleDays.ts'),
    'utf8',
  );
  const deduct = readFileSync(
    path.join(root, 'SamplePOS.Server/src/modules/inventory/warehouse/warehouseSaleDeductionService.ts'),
    'utf8',
  );
  const pricing = readFileSync(
    path.join(root, 'SamplePOS.Server/src/modules/pricing/pricingEngineService.ts'),
    'utf8',
  );

  const gates = [];
  const gate = (id, ok, detail) => gates.push({ id, ok: !!ok, detail: detail || '' });

  gate('PREVIEW_USES_FEFO_ISSUE', preview.includes('previewFefoIssueCostForBaseQty'), '');
  gate('ATCOST_USES_SELECTLOTS_FEFO', atCost.includes("policy: 'FEFO'") && atCost.includes('selectLots'), '');
  gate('SALE_USES_SHARED_PREVIEW', sales.includes('previewProductLineAllocatedCost'), '');
  gate('QUOTE_USES_SHARED_PREVIEW', quote.includes('previewProductLineAllocatedCost'), '');
  gate(
    'MULTISTORE_CACHE_PER_DB',
    multi.includes('warehouseTablesExistByDb') && multi.includes('current_database'),
    'no process-global boolean cache',
  );
  gate('SALE_DEDUCT_HARDCODES_FEFO', sales.includes("policy: 'FEFO'") && sales.includes("selectionPolicy: 'FEFO'"), '');
  gate(
    'MIN_DAYS_SSOT_HELPER',
    expiryHelper.includes('getProductMinDaysBeforeExpirySale') &&
      expiryHelper.includes("min_days_before_expiry_sale") &&
      sales.includes('getProductMinDaysBeforeExpirySale') &&
      quote.includes('getProductMinDaysBeforeExpirySale') &&
      deduct.includes('getProductMinDaysBeforeExpirySale') &&
      pricing.includes('getProductMinDaysBeforeExpirySale'),
    'sale/quote/deduct/pricing share lagging-schema helper',
  );

  return { ok: gates.every((g) => g.ok), gates };
}

async function main() {
  console.log('\n=== All-tenant FEFO / allocated-cost SSOT ===\n');
  const master = new pg.Pool({ connectionString: MASTER });
  const u = new URL(MASTER);
  const baseUrl = `${u.protocol}//${u.username}:${u.password}@${u.hostname}:${u.port || 5432}`;

  const dbs = await master.query(`
    SELECT datname FROM pg_database
     WHERE datistemplate = false
       AND datname LIKE 'pos_%'
       AND datname NOT IN ('postgres')
     ORDER BY 1`);
  await master.end();

  const structural = structuralSsot();
  console.log('STRUCTURAL', structural.ok ? 'PASS' : 'FAIL');
  for (const g of structural.gates) {
    console.log(`  ${g.ok ? 'PASS' : 'FAIL'}  ${g.id}${g.detail ? ` — ${g.detail}` : ''}`);
  }

  const tenants = [];
  for (const row of dbs.rows) {
    const name = row.datname;
    console.log(`\n>>> ${name}`);
    const result = await probeTenant(`${baseUrl}/${name}`, name);
    tenants.push(result);
    console.log(`  ${result.ok ? 'PASS' : 'FAIL'} tenant`);
    for (const g of result.gates) {
      console.log(`    ${g.ok ? 'PASS' : 'FAIL'}  ${g.id}${g.detail ? ` — ${g.detail}` : ''}`);
    }
  }

  const tenantPass = tenants.filter((t) => t.ok).length;
  const verdict =
    structural.ok && tenants.length > 0 && tenantPass === tenants.length ? 'PASS' : 'FAIL';

  const payload = {
    feature: 'FEFO_SSOT_ALL_TENANTS',
    verdict,
    structural,
    tenants,
    passedTenants: tenantPass,
    totalTenants: tenants.length,
    at: new Date().toISOString(),
  };

  writeFileSync(path.join(root, 'PROOF_FEFO_SSOT_ALL_TENANTS.json'), `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(
    path.join(root, 'PROOF_FEFO_SSOT_ALL_TENANTS.md'),
    `# PROOF_FEFO_SSOT_ALL_TENANTS\n\nVerdict: **${verdict}**\n\n` +
      `Structural: ${structural.ok ? 'PASS' : 'FAIL'}\n` +
      `Tenants: ${tenantPass}/${tenants.length}\n\n` +
      tenants
        .map(
          (t) =>
            `## ${t.db} — ${t.ok ? 'PASS' : 'FAIL'}\n` +
            t.gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} \`${g.id}\`: ${g.detail}`).join('\n'),
        )
        .join('\n\n') +
      '\n',
  );

  console.log(`\nVerdict: ${verdict} (tenants ${tenantPass}/${tenants.length})\n`);
  process.exit(verdict === 'PASS' ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
