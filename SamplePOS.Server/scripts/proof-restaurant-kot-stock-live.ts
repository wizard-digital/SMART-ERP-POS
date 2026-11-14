/**
 * LIVE proof: restaurant KOT deducts stock, void restores, pay skips double-deduct.
 * Creates a scratch tenant DB from pos_template, seeds one inventory SKU, exercises
 * restaurantService.sendKot / voidCheckItems / salesService.createSale, then drops DB.
 *
 * Usage (from SamplePOS.Server):
 *   npx tsx scripts/proof-restaurant-kot-stock-live.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Decimal from 'decimal.js';

const MASTER =
  process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/pos_system';
const SCRATCH = `pos_tenant_kot_proof_${Date.now().toString(36)}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outPath = path.join(repoRoot, 'PROOF_RESTAURANT_KOT_STOCK_LIVE.json');

type Step = { step: string; ok?: boolean; detail?: unknown; error?: string };
const report: {
  generatedAt: string;
  scratchDb: string;
  verdict: 'PASS' | 'FAIL';
  steps: Step[];
  checks: Record<string, boolean | number | string | null>;
} = {
  generatedAt: new Date().toISOString(),
  scratchDb: SCRATCH,
  verdict: 'FAIL',
  steps: [],
  checks: {},
};

function add(step: string, ok: boolean, detail?: unknown) {
  report.steps.push({ step, ok, detail });
  if (!ok) throw new Error(`FAIL at ${step}: ${JSON.stringify(detail)}`);
}

function masterUrlToAdmin(url: string): { adminUrl: string; tenantUrl: (db: string) => string } {
  const u = new URL(url);
  const adminUrl = `${u.protocol}//${u.username}:${u.password}@${u.hostname}:${u.port || 5432}/postgres`;
  const tenantUrl = (db: string) =>
    `${u.protocol}//${u.username}:${u.password}@${u.hostname}:${u.port || 5432}/${db}`;
  return { adminUrl, tenantUrl };
}

async function main() {
  const { adminUrl, tenantUrl } = masterUrlToAdmin(MASTER);
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });

  try {
    const tpl = await admin.query(`SELECT 1 FROM pg_database WHERE datname = 'pos_template'`);
    if (!tpl.rowCount) throw new Error('pos_template missing');

    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'pos_template' AND pid <> pg_backend_pid()`,
    );
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
    await admin.query(`CREATE DATABASE ${SCRATCH} TEMPLATE pos_template`);
    add('clone_template', true, { scratch: SCRATCH });

    const pool = new pg.Pool({ connectionString: tenantUrl(SCRATCH), max: 4 });
    try {
      // Heal local template tracking lies (e.g. missing quote_id while version=647).
      const { tenantMigrationService } = await import(
        '../src/modules/system/tenantMigrationService.js'
      );
      await tenantMigrationService.prepareNewTenantDatabase(pool, 'kot-proof-live');
      // Unnumbered heal used in prod tenants; local template can track 647 without this column.
      await pool.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'pos_orders' AND column_name = 'quote_id'
          ) THEN
            ALTER TABLE pos_orders ADD COLUMN quote_id UUID REFERENCES quotations(id) ON DELETE SET NULL;
            CREATE INDEX IF NOT EXISTS idx_pos_orders_quote_id ON pos_orders(quote_id) WHERE quote_id IS NOT NULL;
          END IF;
        END $$;
      `);
      add('prepare_schema', true, {
        version: (
          await pool.query<{ v: string }>(`SELECT COALESCE(MAX(version),0)::text AS v FROM schema_version`)
        ).rows[0]?.v,
        hasQuoteId: (
          await pool.query<{ e: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM information_schema.columns
               WHERE table_name='pos_orders' AND column_name='quote_id'
             ) AS e`,
          )
        ).rows[0]?.e,
      });

      // Seed restaurant + inventory product with FEFO batch
      const ssCount = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM system_settings`);
      if (Number(ssCount.rows[0]?.n || 0) === 0) {
        await pool.query(`INSERT INTO system_settings DEFAULT VALUES`);
      }
      await pool.query(
        `UPDATE system_settings SET restaurant_mode_enabled = TRUE, restaurant_allow_oversell = FALSE`,
      );
      const anyUser = await pool.query<{ id: string; email: string }>(
        `SELECT id, email FROM users ORDER BY CASE WHEN role = 'ADMIN' THEN 0 ELSE 1 END, created_at LIMIT 1`,
      );
      const userId = anyUser.rows[0]?.id;
      if (!userId) throw new Error('No user in scratch DB');
      report.checks.proofUserEmail = anyUser.rows[0]?.email ?? null;

      // Ensure base UoM
      let uomId: string | null = null;
      const uom = await pool.query<{ id: string }>(
        `SELECT id FROM uoms WHERE LOWER(name) IN ('each','ea','piece','pcs') LIMIT 1`,
      );
      uomId = uom.rows[0]?.id ?? null;
      if (!uomId) {
        const ins = await pool.query<{ id: string }>(
          `INSERT INTO uoms (id, name, symbol) VALUES (gen_random_uuid(), 'Each', 'EA') RETURNING id`,
        );
        uomId = ins.rows[0]!.id;
      }

      const prod = await pool.query<{ id: string }>(
        `INSERT INTO products (id, name, sku, product_type, is_active, available_in_restaurant, kitchen_station, base_uom_id)
         VALUES (gen_random_uuid(), 'KOT Proof Lager', 'KOT-PROOF-LAGER', 'inventory', TRUE, TRUE, 'BAR', $1)
         RETURNING id`,
        [uomId],
      );
      const productId = prod.rows[0]!.id;
      await pool.query(
        `INSERT INTO product_uoms (id, product_id, uom_id, conversion_factor, is_default)
         VALUES (gen_random_uuid(), $1, $2, 1, TRUE)
         ON CONFLICT (product_id, uom_id) DO UPDATE SET is_default = TRUE, conversion_factor = 1`,
        [productId, uomId],
      );
      await pool.query(
        `INSERT INTO product_valuation (product_id, selling_price, cost_price, costing_method)
         VALUES ($1, 10000, 4000, 'FIFO')
         ON CONFLICT (product_id) DO UPDATE SET selling_price=EXCLUDED.selling_price, cost_price=EXCLUDED.cost_price`,
        [productId],
      );
      await pool.query(
        `INSERT INTO product_inventory (product_id, quantity_on_hand)
         VALUES ($1, 20)
         ON CONFLICT (product_id) DO UPDATE SET quantity_on_hand = 20`,
        [productId],
      );

      const batch = await pool.query<{ id: string }>(
        `INSERT INTO inventory_batches (
           id, product_id, batch_number, quantity, remaining_quantity,
           cost_price, received_date, status, created_at
         ) VALUES (
           gen_random_uuid(), $1, 'KOT-PROOF-B1', 20, 20,
           4000, CURRENT_DATE, 'ACTIVE', NOW()
         ) RETURNING id`,
        [productId],
      );
      const batchId = batch.rows[0]!.id;

      // Station + table
      await pool.query(
        `INSERT INTO restaurant_stations (code, name, printer_name, sort_order, is_active, is_default)
         SELECT 'BAR', 'Bar', 'BAR', 1, TRUE, TRUE
         WHERE NOT EXISTS (SELECT 1 FROM restaurant_stations WHERE UPPER(code)='BAR')`,
      );
      const table = await pool.query<{ id: string }>(
        `INSERT INTO restaurant_tables (id, code, name, status, seats, sort_order, is_active)
         VALUES (gen_random_uuid(), 'T99', 'Proof Table 99', 'FREE', 4, 99, TRUE)
         RETURNING id`,
      );
      const tableId = table.rows[0]!.id;

      add('seed', true, { productId, batchId, userId, tableId, uomId });

      const { restaurantService } = await import('../src/modules/restaurant/restaurantService.js');
      const { salesService } = await import('../src/modules/sales/salesService.js');
      const { getNetRestaurantKotIssue } = await import(
        '../src/modules/restaurant/restaurantKotStockService.js'
      );

      const opened = await restaurantService.addItemsToTable(pool, {
        tableId,
        waiterId: userId,
        forceNewCheck: true,
        items: [
          {
            productId,
            productName: 'KOT Proof Lager',
            quantity: 3,
            unitPrice: 10000,
          },
        ],
        actor: { userId, role: 'ADMIN' },
      });
      const orderId = opened.order!.id;
      const orderItemId = opened.order!.items![0]!.id;
      add('open_check_add_item', true, { orderId, orderItemId, qty: 3 });

      const beforeKot = await pool.query<{ rem: string }>(
        `SELECT remaining_quantity::text AS rem FROM inventory_batches WHERE id = $1`,
        [batchId],
      );
      const remBefore = Number(beforeKot.rows[0]?.rem);
      report.checks.batchBeforeKot = remBefore;

      const kot = await restaurantService.sendKot(pool, orderId, userId, {
        userId,
        role: 'ADMIN',
      });
      add('sendKot', true, {
        kotCount: kot.kots.length,
        kotNumbers: kot.kots.map((k) => k.kotNumber),
      });

      const afterKot = await pool.query<{ rem: string }>(
        `SELECT remaining_quantity::text AS rem FROM inventory_batches WHERE id = $1`,
        [batchId],
      );
      const remAfterKot = Number(afterKot.rows[0]?.rem);
      report.checks.batchAfterKot = remAfterKot;
      report.checks.kotDeductedQty = remBefore - remAfterKot;
      add('kot_deducted_batch', remBefore - remAfterKot === 3, {
        remBefore,
        remAfterKot,
        delta: remBefore - remAfterKot,
      });

      const movOut = await pool.query(
        `SELECT movement_type, reference_type, reference_id::text, quantity::float8 AS qty, unit_cost::float8 AS unit_cost
         FROM stock_movements
         WHERE reference_id = $1 AND reference_type = 'RESTAURANT_KOT'
         ORDER BY created_at`,
        [orderItemId],
      );
      report.checks.kotMovements = movOut.rowCount;
      add('kot_movements_RESTAURANT_KOT', movOut.rowCount! > 0 && movOut.rows.every((r) => r.movement_type === 'ADJUSTMENT_OUT'), {
        rows: movOut.rows,
      });

      const net = await getNetRestaurantKotIssue(pool, orderItemId);
      report.checks.kotNetQty = net.netQty;
      report.checks.kotNetCost = net.netCost;
      add('kot_net_issue', net.issued && Math.abs(net.netQty - 3) < 1e-6, net);

      // Void 1 of 3 → restore 1
      const voided = await restaurantService.voidCheckItems(pool, orderId, {
        items: [{ itemId: orderItemId, quantity: 1 }],
        reason: 'KOT proof void partial',
        voidedBy: userId,
        actor: { userId, role: 'ADMIN' },
      });
      add('void_partial', true, {
        voidKotCount: voided.voidKots.length,
        checkCancelled: voided.checkCancelled,
      });

      const afterVoid = await pool.query<{ rem: string }>(
        `SELECT remaining_quantity::text AS rem FROM inventory_batches WHERE id = $1`,
        [batchId],
      );
      const remAfterVoid = Number(afterVoid.rows[0]?.rem);
      report.checks.batchAfterVoid1 = remAfterVoid;
      add('void_restored_1', remAfterVoid === remAfterKot + 1, {
        remAfterKot,
        remAfterVoid,
        delta: remAfterVoid - remAfterKot,
      });

      const movIn = await pool.query(
        `SELECT movement_type, reference_type, quantity::float8 AS qty
         FROM stock_movements
         WHERE reference_id = $1 AND reference_type = 'RESTAURANT_KOT_VOID'`,
        [orderItemId],
      );
      add('void_movements_RESTAURANT_KOT_VOID', movIn.rowCount! > 0, { rows: movIn.rows });

      const net2 = await getNetRestaurantKotIssue(pool, orderItemId);
      report.checks.kotNetQtyAfterVoid = net2.netQty;
      add('kot_net_after_void', Math.abs(net2.netQty - 2) < 1e-6, net2);

      // Pay remaining 2 — must NOT double-deduct (batch stays at remAfterVoid)
      const order = await pool.query(
        `SELECT oi.id, oi.product_id, oi.product_name, oi.quantity::float8 AS qty, oi.unit_price::float8 AS unit_price, oi.uom_id
         FROM pos_order_items oi WHERE oi.order_id = $1`,
        [orderId],
      );
      const payItems = order.rows.map((r) => ({
        productId: r.product_id as string,
        productName: r.product_name as string,
        quantity: Number(r.qty),
        unitPrice: Number(r.unit_price),
        uomId: (r.uom_id as string) || undefined,
        sourceOrderItemId: r.id as string,
      }));
      const subtotal = payItems.reduce((s, i) => s + i.quantity * i.unitPrice, 0);

      const sale = await salesService.createSale(pool, {
        items: payItems,
        subtotal,
        discountAmount: 0,
        taxAmount: 0,
        totalAmount: subtotal,
        paymentMethod: 'CASH',
        paymentReceived: subtotal,
        soldBy: userId,
        fromOrderId: orderId,
        paymentLines: [{ paymentMethod: 'CASH', amount: subtotal }],
      });
      add('createSale_pay', true, {
        saleId: sale.sale?.id || (sale as { id?: string }).id,
        saleNumber: sale.sale?.saleNumber || (sale as { saleNumber?: string }).saleNumber,
      });

      const afterPay = await pool.query<{ rem: string }>(
        `SELECT remaining_quantity::text AS rem FROM inventory_batches WHERE id = $1`,
        [batchId],
      );
      const remAfterPay = Number(afterPay.rows[0]?.rem);
      report.checks.batchAfterPay = remAfterPay;
      add('pay_no_double_deduct', remAfterPay === remAfterVoid, {
        remAfterVoid,
        remAfterPay,
        note: 'Batch must be unchanged at pay when KOT already issued',
      });

      const saleMov = await pool.query(
        `SELECT COUNT(*)::int AS n FROM stock_movements
         WHERE movement_type = 'SALE' AND product_id = $1
           AND reference_id = $2`,
        [productId, sale.sale?.id || (sale as { id?: string }).id],
      );
      report.checks.saleMovementsForProduct = saleMov.rows[0]?.n ?? null;
      add('pay_no_sale_stock_movement', (saleMov.rows[0]?.n ?? 0) === 0, saleMov.rows[0]);

      // Final: started 20, KOT -3, void +1 → 18; pay leaves 18; sold net 2 still issued from KOT
      report.checks.expectedFinalBatch = 18;
      add('final_batch_qty', remAfterPay === 18, { remAfterPay, expected: 18 });

      report.verdict = 'PASS';
    } finally {
      await pool.end().catch(() => undefined);
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [SCRATCH],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
      add('drop_scratch_db', true, { scratch: SCRATCH });
    }
  } catch (err) {
    report.verdict = 'FAIL';
    report.steps.push({
      step: 'fatal',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [SCRATCH],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
    } catch {
      /* ignore cleanup */
    }
  } finally {
    await admin.end().catch(() => undefined);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log(`Wrote ${outPath}`);
  }

  if (report.verdict !== 'PASS') process.exit(1);
}

main();
