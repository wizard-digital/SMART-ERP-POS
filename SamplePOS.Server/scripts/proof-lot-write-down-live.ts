#!/usr/bin/env npx tsx
/**
 * LIVE FUNCTIONAL PROOF — Near-expiry lot write-down (NRV)
 *
 * Executes writeDownNearExpiryLot against DATABASE_URL and asserts measured SQL/GL:
 *   1) Seed product + batches (critical / 60d / 61d / expired / no-expiry / quarantined)
 *   2) Rejects throw LOT_WRITE_DOWN_* (unexpected errors are rethrown)
 *   3) Critical write-down: qty unchanged, original_cost_price preserved, carrying falls
 *   4) Ledger: DR 5140 / CR 1300, source INVENTORY_MOVE, no 5110/5120/5130, no stock_movements
 *   5) FEFO cost_price = new carrying; POS floor blocks below new carrying
 *
 * Usage:
 *   cd SamplePOS.Server && npx tsx scripts/proof-lot-write-down-live.ts
 *   npm run proof:lot-write-down:live
 *
 * Env:
 *   DATABASE_URL from SamplePOS.Server/.env (required — exit 2 if missing)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { BusinessError } from '../src/middleware/errorHandler.js';
import { assertSaleLineNotBelowAllocatedCost } from '../src/modules/sales/saleBelowCostGuard.js';
import { addDaysToDateString, getBusinessDate } from '../src/utils/dateRange.js';
import {
  assertWriteDownCouplesSubledger,
  isNearExpiryWriteDownBand,
  LOT_WRITE_DOWN_MAX_DAYS,
} from '../../shared/inventory-lot/lotWriteDown.js';
import { classifyExpiryUrgency } from '../../shared/reports/expiringItemsSsot.js';
import { ensureLotWriteDownMigrations, liveGuardIs613 } from './ensureLotWriteDownMigrations.js';
import { seedSellableBalance, seedUom } from './lotWriteDownLiveSurfaces.js';

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
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (m[1] === 'DATABASE_URL' || process.env[m[1]] === undefined) {
        process.env[m[1]] = v;
      }
    }
  }
}

loadEnv();

const rawUrl = (process.env.DATABASE_URL || process.env.TENANT_DATABASE_URL || '').trim();
if (!rawUrl) {
  console.error('DATABASE_URL missing — set SamplePOS.Server/.env');
  process.exit(2);
}
process.env.DATABASE_URL = rawUrl;
const connectionString = rawUrl.split('?')[0];

type Gate = { id: string; ok: boolean; detail: string; measured?: Record<string, unknown> };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string, measured?: Record<string, unknown>): void {
  gates.push({ id, ok, detail, ...(measured ? { measured } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
}

function requireGate(
  id: string,
  ok: boolean,
  detail: string,
  measured?: Record<string, unknown>,
): void {
  gate(id, ok, detail, measured);
  if (!ok) throw new Error(`Gate ${id} failed: ${detail}`);
}

function near(a: number, b: number, tol = 0.02): boolean {
  return Math.abs(Number(a) - Number(b)) <= tol;
}

const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const SKU = `LWD-${stamp}`;
const QTY = 10;
const CARRYING = 10000;
const NEW_COST = 6000;
const MARKDOWN = QTY * (CARRYING - NEW_COST);

const pool = new pg.Pool({ connectionString, max: 8 });
let poolEnded = false;

async function closePool(): Promise<void> {
  if (poolEnded) return;
  poolEnded = true;
  await pool.end();
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 LIMIT 1`,
    [table, column],
  );
  return r.rows.length > 0;
}

async function tableExists(table: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    [table],
  );
  return r.rows.length > 0;
}

async function ensureLotWriteDownSchema(): Promise<void> {
  const sqlDir = path.join(repoRoot, 'shared/sql');
  const applied = await ensureLotWriteDownMigrations(pool, sqlDir);
  requireGate('MIG_611', await columnExists('inventory_batches', 'original_cost_price'), 'original_cost_price present');
  requireGate('MIG_612', await tableExists('lot_write_down_documents'), 'lot_write_down_documents present');
  requireGate(
    'MIG_613',
    await liveGuardIs613(pool),
    `carrying increase blocked + deferred journal; applied=${applied.applied.join(',') || 'already-current'}`,
  );
}

async function expectPgIntegrity(id: string, needle: RegExp, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    gate(id, false, 'expected integrity rejection but statement succeeded');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!needle.test(msg)) throw e;
    gate(id, true, msg.slice(0, 180));
  }
}

async function expectBusinessCode(
  id: string,
  code: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    gate(id, false, `expected ${code} but call succeeded`);
  } catch (e) {
    if (e instanceof BusinessError && e.errorCode === code) {
      gate(id, true, e.errorCode, { message: e.message });
      return;
    }
    throw e;
  }
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log('═'.repeat(60));
  console.log(' LIVE proof: near-expiry lot write-down');
  console.log(` stamp: ${stamp}`);
  console.log('═'.repeat(60));

  await ensureLotWriteDownSchema();

  const userRes = await pool.query<{ id: string; role: string | null }>(
    `SELECT id::text AS id, role::text AS role FROM users
     WHERE id::text <> '00000000-0000-0000-0000-000000000000'
       AND UPPER(COALESCE(role::text, '')) IN ('ADMIN', 'SUPER_ADMIN')
     ORDER BY created_at NULLS LAST
     LIMIT 1`,
  );
  const userId = userRes.rows[0]?.id;
  requireGate(
    'USER',
    Boolean(userId),
    userId ? `adminUserId=${userId} role=${userRes.rows[0]?.role}` : 'no ADMIN/SUPER_ADMIN user',
  );

  const accounts = await pool.query<{ code: string }>(
    `SELECT "AccountCode" AS code FROM accounts
     WHERE "AccountCode" IN ('1300','5140') AND "IsActive" = true`,
  );
  const codes = new Set(accounts.rows.map((r) => r.code));
  requireGate(
    'GL_ACCOUNTS',
    codes.has('1300') && codes.has('5140'),
    `accounts present: ${[...codes].join(',')}`,
  );

  const biz = getBusinessDate();
  const criticalExpiry = addDaysToDateString(biz, 5);
  const sixtyExpiry = addDaysToDateString(biz, 60);
  const beyondExpiry = addDaysToDateString(biz, 61);
  const expiredExpiry = biz;

  const productId = randomUUID();
  const criticalId = randomUUID();
  const sixtyId = randomUUID();
  const warningId = randomUUID();
  const expiredId = randomUUID();
  const noExpiryId = randomUUID();
  const quarantinedId = randomUUID();
  const raceId = randomUUID();
  const disposeId = randomUUID();
  const disposeProductId = randomUUID();
  const forgeId = randomUUID();

  await pool.query(
    `INSERT INTO products (id, name, sku, barcode, cost_price, selling_price, quantity_on_hand, is_active, track_expiry)
     VALUES ($1, $2, $3, $3, $4, $5, $6, true, true)`,
    [productId, `Lot write-down proof ${stamp}`, SKU, CARRYING, NEW_COST, QTY * 7],
  );
  await pool.query(
    `INSERT INTO products (id, name, sku, barcode, cost_price, selling_price, quantity_on_hand, is_active, track_expiry)
     VALUES ($1, $2, $3, $3, $4, $5, $6, true, true)`,
    [disposeProductId, `Lot write-down dispose ${stamp}`, `${SKU}-D`, CARRYING, NEW_COST, QTY],
  );
  requireGate(
    'SEED_PRODUCT',
    (await pool.query(`SELECT id::text FROM products WHERE id = $1`, [productId])).rows.length === 1,
    `productId=${productId} sku=${SKU}`,
  );

  await pool.query(
    `INSERT INTO inventory_batches (
       id, product_id, batch_number, quantity, remaining_quantity,
       cost_price, received_date, expiry_date, status, source_type
     ) VALUES
       ($1, $6, $7, $11, $11, $12, CURRENT_DATE, $13, 'ACTIVE', 'ADJUSTMENT'),
       ($2, $6, $8, $11, $11, $12, CURRENT_DATE, $14, 'ACTIVE', 'ADJUSTMENT'),
       ($3, $6, $9, $11, $11, $12, CURRENT_DATE, $15, 'ACTIVE', 'ADJUSTMENT'),
       ($4, $6, $10, $11, $11, $12, CURRENT_DATE, NULL, 'ACTIVE', 'ADJUSTMENT'),
       ($5, $6, $16, $11, $11, $12, CURRENT_DATE, $13, 'ACTIVE', 'ADJUSTMENT')`,
    [
      criticalId,
      warningId,
      expiredId,
      noExpiryId,
      quarantinedId,
      productId,
      `${SKU}-C`,
      `${SKU}-W`,
      `${SKU}-E`,
      `${SKU}-N`,
      QTY,
      CARRYING,
      criticalExpiry,
      beyondExpiry,
      expiredExpiry,
      `${SKU}-Q`,
    ],
  );
  await pool.query(`UPDATE inventory_batches SET status = 'QUARANTINED' WHERE id = $1`, [quarantinedId]);

  await pool.query(
    `INSERT INTO inventory_batches (
       id, product_id, batch_number, quantity, remaining_quantity,
       cost_price, received_date, expiry_date, status, source_type
     ) VALUES
       ($1, $3, $4, $6, $6, $7, CURRENT_DATE, $8, 'ACTIVE', 'ADJUSTMENT'),
       ($2, $5, $9, $6, $6, $7, CURRENT_DATE, $8, 'ACTIVE', 'ADJUSTMENT')`,
    [raceId, disposeId, productId, `${SKU}-R`, disposeProductId, QTY, CARRYING, criticalExpiry, `${SKU}-D`],
  );
  await pool.query(
    `INSERT INTO inventory_batches (
       id, product_id, batch_number, quantity, remaining_quantity,
       cost_price, received_date, expiry_date, status, source_type
     ) VALUES ($1, $2, $3, $4, $4, $5, CURRENT_DATE, $6, 'ACTIVE', 'ADJUSTMENT')`,
    [forgeId, productId, `${SKU}-G`, QTY, CARRYING, criticalExpiry],
  );
  await pool.query(
    `INSERT INTO inventory_batches (
       id, product_id, batch_number, quantity, remaining_quantity,
       cost_price, received_date, expiry_date, status, source_type
     ) VALUES ($1, $2, $3, $4, $4, $5, CURRENT_DATE, $6, 'ACTIVE', 'ADJUSTMENT')`,
    [sixtyId, productId, `${SKU}-60`, QTY, CARRYING, sixtyExpiry],
  );

  const seeded = await pool.query<{
    id: string;
    batch_number: string;
    remaining_quantity: string;
    status: string;
    expiry_date: string | null;
    cost_price: string;
    original_cost_price: string | null;
  }>(
    `SELECT id::text, batch_number, remaining_quantity::text,
            COALESCE(status::text,'ACTIVE') AS status, expiry_date::text,
            cost_price::text, original_cost_price::text
     FROM inventory_batches WHERE id = ANY($1::uuid[])
     ORDER BY batch_number`,
    [[criticalId, warningId, expiredId, noExpiryId, quarantinedId, raceId, disposeId, forgeId, sixtyId]],
  );
  requireGate('SEED_BATCHES', seeded.rows.length === 9, `seeded 9 batches biz=${biz}`, {
    rows: seeded.rows,
  });

  const critSeed = seeded.rows.find((r) => r.id === criticalId);
  requireGate(
    'SEED_ORIGINAL',
    near(Number(critSeed?.original_cost_price), CARRYING) &&
      near(Number(critSeed?.cost_price), CARRYING),
    `critical original=${critSeed?.original_cost_price} carrying=${critSeed?.cost_price}`,
  );

  const forgeDocId = randomUUID();
  const forgeDocNumber = `FORGE-${stamp}`;
  const beforeForge = await pool.query<{ cost_price: string; remaining_quantity: string }>(
    `SELECT cost_price::text, remaining_quantity::text FROM inventory_batches WHERE id = $1`,
    [forgeId],
  );
  try {
    await pool.query(
      `INSERT INTO lot_write_down_documents (
         id, document_number, status, reason, product_id, inventory_batch_id, quantity,
         original_unit_cost, previous_carrying_unit_cost, new_carrying_unit_cost,
         total_amount, expense_account_code, created_by, posted_at
       ) VALUES ($1,$2,'POSTED','NEAR_EXPIRY',$3,$4,$5,$6,$6,1,99999,'5140',$7,NOW())`,
      [forgeDocId, forgeDocNumber, productId, forgeId, QTY, CARRYING, userId],
    );
    gate('LIVE_FORGE_POSTED_NULL_JE', false, 'forged POSTED+NULL JE document committed');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const docs = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM lot_write_down_documents WHERE id = $1`,
      [forgeDocId],
    );
    gate(
      'LIVE_FORGE_POSTED_NULL_JE',
      /posted journal/i.test(msg) && Number(docs.rows[0]?.n ?? 1) === 0,
      msg.slice(0, 180),
      { docs: docs.rows[0] },
    );
  }

  const cForge = await pool.connect();
  try {
    await cForge.query('BEGIN');
    await cForge.query(
      `INSERT INTO lot_write_down_documents (
         id, document_number, status, reason, product_id, inventory_batch_id, quantity,
         original_unit_cost, previous_carrying_unit_cost, new_carrying_unit_cost,
         total_amount, expense_account_code, created_by, posted_at
       ) VALUES ($1,$2,'POSTED','NEAR_EXPIRY',$3,$4,$5,$6,$6,1,99999,'5140',$7,NOW())`,
      [randomUUID(), `FORGETX-${stamp}`, productId, forgeId, QTY, CARRYING, userId],
    );
    await cForge.query(`UPDATE inventory_batches SET cost_price = 1 WHERE id = $1`, [forgeId]);
    await cForge.query('COMMIT');
    gate('LIVE_FORGE_TX_COST_DROP', false, 'forged TX committed carrying drop');
  } catch (e) {
    await cForge.query('ROLLBACK').catch(() => undefined);
    const after = await pool.query<{ cost_price: string; remaining_quantity: string }>(
      `SELECT cost_price::text, remaining_quantity::text FROM inventory_batches WHERE id = $1`,
      [forgeId],
    );
    const docs = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM lot_write_down_documents WHERE document_number = $1`,
      [`FORGETX-${stamp}`],
    );
    gate(
      'LIVE_FORGE_TX_COST_DROP',
      near(Number(after.rows[0]?.cost_price), Number(beforeForge.rows[0]?.cost_price)) &&
        after.rows[0]?.remaining_quantity === beforeForge.rows[0]?.remaining_quantity &&
        Number(docs.rows[0]?.n ?? 1) === 0,
      `after carrying=${after.rows[0]?.cost_price} qty=${after.rows[0]?.remaining_quantity} docs=${docs.rows[0]?.n} err=${e instanceof Error ? e.message.slice(0, 120) : String(e)}`,
      { before: beforeForge.rows[0], after: after.rows[0] },
    );
  } finally {
    cForge.release();
  }

  await expectPgIntegrity('LIVE_COST_INCREASE_FORBIDDEN', /cannot increase after lot creation/i, () =>
    pool.query(`UPDATE inventory_batches SET cost_price = 20000 WHERE id = $1`, [forgeId]),
  );

  const { writeDownNearExpiryLot } = await import('../src/modules/inventory-lot/lotWriteDownService.js');

  await expectBusinessCode('LIVE_REJECT_QUARANTINE', 'LOT_WRITE_DOWN_NOT_ACTIVE', () =>
    writeDownNearExpiryLot(pool, {
      inventoryBatchId: quarantinedId,
      newUnitCost: NEW_COST,
      userId,
      memo: `LIVE reject quarantine ${stamp}`,
    }),
  );
  await expectBusinessCode('LIVE_REJECT_EXPIRED', 'LOT_WRITE_DOWN_EXPIRED', () =>
    writeDownNearExpiryLot(pool, {
      inventoryBatchId: expiredId,
      newUnitCost: NEW_COST,
      userId,
      memo: `LIVE reject expired ${stamp}`,
    }),
  );
  await expectBusinessCode('LIVE_REJECT_NO_EXPIRY', 'LOT_WRITE_DOWN_NO_EXPIRY', () =>
    writeDownNearExpiryLot(pool, {
      inventoryBatchId: noExpiryId,
      newUnitCost: NEW_COST,
      userId,
      memo: `LIVE reject no-expiry ${stamp}`,
    }),
  );
  await expectBusinessCode('LIVE_REJECT_BEYOND_60', 'LOT_WRITE_DOWN_NOT_CRITICAL', () =>
    writeDownNearExpiryLot(pool, {
      inventoryBatchId: warningId,
      newUnitCost: NEW_COST,
      userId,
      memo: `LIVE reject beyond-60 ${stamp}`,
    }),
  );
  await expectBusinessCode('LIVE_REJECT_SAME_COST', 'LOT_WRITE_DOWN_NOT_BELOW_CARRYING', () =>
    writeDownNearExpiryLot(pool, {
      inventoryBatchId: criticalId,
      newUnitCost: CARRYING,
      userId,
      memo: `LIVE reject same cost ${stamp}`,
    }),
  );

  const sixtyResult = await writeDownNearExpiryLot(pool, {
    inventoryBatchId: sixtyId,
    newUnitCost: NEW_COST,
    userId,
    memo: `LIVE write-down 60d ${stamp}`,
  });
  gate(
    'LIVE_ACCEPT_60',
    near(sixtyResult.totalAmount, MARKDOWN) && sixtyResult.expenseAccountCode === '5140',
    `60d markdown=${sixtyResult.totalAmount} doc=${sixtyResult.documentNumber}`,
    { sixtyResult: sixtyResult as unknown as Record<string, unknown> },
  );

  const WINDOW_ACCEPT_DAYS = [1, 7, 8, 20, 30, 45, LOT_WRITE_DOWN_MAX_DAYS] as const;
  const WINDOW_REJECT_DAY = LOT_WRITE_DOWN_MAX_DAYS + 1;
  const WINDOW_QTY = 2;
  const WINDOW_MARKDOWN = WINDOW_QTY * (CARRYING - NEW_COST);
  const windowProductId = randomUUID();
  const windowSku = `${SKU}-WIN`;
  const windowIds = new Map<number, string>();
  await pool.query(
    `INSERT INTO products (id, name, sku, barcode, cost_price, selling_price, quantity_on_hand, is_active, track_expiry)
     VALUES ($1, $2, $3, $3, $4, $5, $6, true, true)`,
    [
      windowProductId,
      `Lot write-down window ${stamp}`,
      windowSku,
      CARRYING,
      NEW_COST,
      WINDOW_QTY * (WINDOW_ACCEPT_DAYS.length + 1),
    ],
  );
  for (const d of [...WINDOW_ACCEPT_DAYS, WINDOW_REJECT_DAY]) {
    const id = randomUUID();
    windowIds.set(d, id);
    await pool.query(
      `INSERT INTO inventory_batches (
         id, product_id, batch_number, quantity, remaining_quantity,
         cost_price, received_date, expiry_date, status, source_type
       ) VALUES ($1, $2, $3, $4, $4, $5, CURRENT_DATE, $6, 'ACTIVE', 'ADJUSTMENT')`,
      [id, windowProductId, `${windowSku}-${d}`, WINDOW_QTY, CARRYING, addDaysToDateString(biz, d)],
    );
  }

  const windowPosted: Array<Record<string, unknown>> = [];
  for (const d of WINDOW_ACCEPT_DAYS) {
    const band = classifyExpiryUrgency(d);
    const eligible = isNearExpiryWriteDownBand(d);
    const posted = await writeDownNearExpiryLot(pool, {
      inventoryBatchId: windowIds.get(d)!,
      newUnitCost: NEW_COST,
      userId,
      memo: `LIVE window ${d}d ${stamp}`,
    });
    const afterW = await pool.query<{
      cost_price: string;
      original_cost_price: string;
      remaining_quantity: string;
      status: string;
    }>(
      `SELECT cost_price::text, original_cost_price::text, remaining_quantity::text,
              COALESCE(status::text,'ACTIVE') AS status
       FROM inventory_batches WHERE id = $1`,
      [windowIds.get(d)],
    );
    const rowW = afterW.rows[0];
    const ok =
      eligible &&
      near(posted.totalAmount, WINDOW_MARKDOWN) &&
      posted.expenseAccountCode === '5140' &&
      near(Number(rowW?.cost_price), NEW_COST) &&
      near(Number(rowW?.original_cost_price), CARRYING) &&
      near(Number(rowW?.remaining_quantity), WINDOW_QTY) &&
      rowW?.status === 'ACTIVE';
    windowPosted.push({
      days: d,
      band,
      eligible,
      amount: posted.totalAmount,
      carrying: rowW?.cost_price,
      original: rowW?.original_cost_price,
    });
    requireGate(
      `LIVE_WINDOW_${d}`,
      ok,
      `${d}d band=${band} markdown=${posted.totalAmount} carrying=${rowW?.cost_price} original=${rowW?.original_cost_price}`,
      { posted: posted as unknown as Record<string, unknown>, after: rowW, band },
    );
  }

  await expectBusinessCode('LIVE_WINDOW_REJECT_61', 'LOT_WRITE_DOWN_NOT_CRITICAL', () =>
    writeDownNearExpiryLot(pool, {
      inventoryBatchId: windowIds.get(WINDOW_REJECT_DAY)!,
      newUnitCost: NEW_COST,
      userId,
      memo: `LIVE window ${WINDOW_REJECT_DAY}d ${stamp}`,
    }),
  );

  const warningPosted = windowPosted.find((r) => r.days === 20);
  const watchPosted = windowPosted.find((r) => r.days === 45);
  requireGate(
    'LIVE_WINDOW_WARNING_WATCH',
    warningPosted?.band === 'warning' && watchPosted?.band === 'watch',
    `20d band=${String(warningPosted?.band)} 45d band=${String(watchPosted?.band)} (Critical KPI stays ≤7d)`,
    { warningPosted, watchPosted },
  );

  try {
    assertSaleLineNotBelowAllocatedCost({
      productId: windowProductId,
      quantity: 1,
      lineRevenue: NEW_COST,
      totalAllocatedCost: NEW_COST,
      costPerSellingUnit: NEW_COST,
      unitPrice: NEW_COST,
    });
    requireGate(
      'LIVE_WINDOW_POS_AT_NEW',
      true,
      `POS at new carrying ${NEW_COST} allowed after warning/watch markdown (below original ${CARRYING})`,
    );
  } catch (e) {
    requireGate('LIVE_WINDOW_POS_AT_NEW', false, e instanceof Error ? e.message : String(e));
  }
  try {
    assertSaleLineNotBelowAllocatedCost({
      productId: windowProductId,
      quantity: 1,
      lineRevenue: NEW_COST - 0.02,
      totalAllocatedCost: NEW_COST,
      costPerSellingUnit: NEW_COST,
      unitPrice: NEW_COST - 0.02,
    });
    requireGate('LIVE_WINDOW_POS_BELOW_NEW', false, 'sale 0.02 below new carrying should throw');
  } catch (e) {
    const code =
      e && typeof e === 'object' && 'errorCode' in e ? String((e as { errorCode: unknown }).errorCode) : '';
    requireGate(
      'LIVE_WINDOW_POS_BELOW_NEW',
      code === 'BELOW_ALLOCATED_COST',
      `POS below new carrying rejected (${code || (e instanceof Error ? e.message : String(e))})`,
    );
  }

  const reportHorizonSql = `b.expiry_date::date <= ($1::date + ($2::text || ' days')::interval)`;
  async function reportBatchIds(horizon: number): Promise<Set<string>> {
    const r = await pool.query<{ id: string }>(
      `SELECT b.id::text AS id
       FROM inventory_batches b
       INNER JOIN products p ON p.id = b.product_id
       WHERE b.expiry_date IS NOT NULL
         AND COALESCE(b.status, 'ACTIVE') = 'ACTIVE'
         AND b.remaining_quantity > 0
         AND ${reportHorizonSql}
         AND p.id = $3`,
      [biz, horizon, windowProductId],
    );
    return new Set(r.rows.map((row) => row.id));
  }
  const inDefaultHorizon = await reportBatchIds(LOT_WRITE_DOWN_MAX_DAYS);
  const inThirty = await reportBatchIds(30);
  const id60 = windowIds.get(LOT_WRITE_DOWN_MAX_DAYS)!;
  const id45 = windowIds.get(45)!;
  const id20 = windowIds.get(20)!;
  const id61 = windowIds.get(WINDOW_REJECT_DAY)!;
  requireGate(
    'LIVE_REPORT_HORIZON_60',
    inDefaultHorizon.has(id20) &&
      inDefaultHorizon.has(id45) &&
      inDefaultHorizon.has(id60) &&
      !inDefaultHorizon.has(id61),
    `Expiring Items horizon ${LOT_WRITE_DOWN_MAX_DAYS} lists 20/45/60d, excludes ${WINDOW_REJECT_DAY}d`,
    {
      horizon: LOT_WRITE_DOWN_MAX_DAYS,
      has20: inDefaultHorizon.has(id20),
      has45: inDefaultHorizon.has(id45),
      has60: inDefaultHorizon.has(id60),
      has61: inDefaultHorizon.has(id61),
    },
  );
  requireGate(
    'LIVE_REPORT_HORIZON_30_MISS_WATCH',
    inThirty.has(id20) && !inThirty.has(id45) && !inThirty.has(id60),
    'Horizon 30 lists 20d warning, misses 45/60d watch — default UI horizon must be 60',
    { horizon: 30, has20: inThirty.has(id20), has45: inThirty.has(id45), has60: inThirty.has(id60) },
  );
  requireGate(
    'LIVE_WINDOW_MATRIX',
    WINDOW_ACCEPT_DAYS.every((d) => isNearExpiryWriteDownBand(d)) &&
      !isNearExpiryWriteDownBand(WINDOW_REJECT_DAY) &&
      LOT_WRITE_DOWN_MAX_DAYS === 60,
    `SSOT window 1–${LOT_WRITE_DOWN_MAX_DAYS}; reject ${WINDOW_REJECT_DAY}`,
    { accept: [...WINDOW_ACCEPT_DAYS], reject: WINDOW_REJECT_DAY, posted: windowPosted },
  );

  const POS_SELL = 10000;
  const POS_CATALOG_COST = 5000;
  const POS_CARRY = 3000;
  const POS_QTY = 4;
  const posProductId = randomUUID();
  const posBatchId = randomUUID();
  const posSku = `${SKU}-POS`;
  const posExpiry = addDaysToDateString(biz, 20);
  await pool.query(
    `INSERT INTO products (id, name, sku, barcode, cost_price, selling_price, quantity_on_hand, is_active, track_expiry)
     VALUES ($1, $2, $3, $3, $4, $5, $6, true, true)`,
    [posProductId, `Lot WD POS journey ${stamp}`, posSku, POS_CATALOG_COST, POS_SELL, POS_QTY],
  );
  await pool.query(
    `INSERT INTO product_valuation (product_id, cost_price, selling_price, costing_method, average_cost, last_cost, auto_update_price)
     VALUES ($1, $2, $3, 'FIFO', $2, $2, false)
     ON CONFLICT (product_id) DO UPDATE SET
       cost_price = EXCLUDED.cost_price,
       selling_price = EXCLUDED.selling_price`,
    [posProductId, POS_CATALOG_COST, POS_SELL],
  );
  await pool.query(
    `INSERT INTO inventory_batches (
       id, product_id, batch_number, quantity, remaining_quantity,
       cost_price, received_date, expiry_date, status, source_type
     ) VALUES ($1, $2, $3, $4, $4, $5, CURRENT_DATE, $6, 'ACTIVE', 'ADJUSTMENT')`,
    [posBatchId, posProductId, `${posSku}-B`, POS_QTY, POS_CATALOG_COST, posExpiry],
  );
  await seedUom(pool, posProductId);
  const posWd = await writeDownNearExpiryLot(pool, {
    inventoryBatchId: posBatchId,
    newUnitCost: POS_CARRY,
    userId,
    memo: `LIVE POS journey markdown ${stamp}`,
  });
  await seedSellableBalance(pool, {
    productId: posProductId,
    batchId: posBatchId,
    qty: POS_QTY,
    cost: POS_CARRY,
    expiry: posExpiry,
    userId,
  });
  const catalogAfter = await pool.query<{
    selling_price: string;
    cost_price: string;
    product_selling: string;
    product_cost: string;
  }>(
    `SELECT pv.selling_price::text, pv.cost_price::text,
            p.selling_price::text AS product_selling, p.cost_price::text AS product_cost
     FROM products p
     JOIN product_valuation pv ON pv.product_id = p.id
     WHERE p.id = $1`,
    [posProductId],
  );
  const batchAfter = await pool.query<{ cost_price: string; original_cost_price: string }>(
    `SELECT cost_price::text, original_cost_price::text FROM inventory_batches WHERE id = $1`,
    [posBatchId],
  );
  requireGate(
    'LIVE_POS_CATALOG_UNCHANGED',
    near(Number(catalogAfter.rows[0]?.selling_price), POS_SELL) &&
      near(Number(catalogAfter.rows[0]?.cost_price), POS_CATALOG_COST) &&
      near(Number(catalogAfter.rows[0]?.product_selling), POS_SELL) &&
      near(Number(catalogAfter.rows[0]?.product_cost), POS_CATALOG_COST) &&
      near(Number(batchAfter.rows[0]?.cost_price), POS_CARRY) &&
      near(Number(batchAfter.rows[0]?.original_cost_price), POS_CATALOG_COST) &&
      near(posWd.newCarryingUnitCost, POS_CARRY),
    `valSell=${catalogAfter.rows[0]?.selling_price} valCost=${catalogAfter.rows[0]?.cost_price} batch=${batchAfter.rows[0]?.cost_price} original=${batchAfter.rows[0]?.original_cost_price}`,
    { catalogAfter: catalogAfter.rows[0], batchAfter: batchAfter.rows[0] },
  );

  const { getFinalPrice, getFinalPricesBulk } = await import('../src/modules/pricing/pricingEngineService.js');
  const enginePrice = await getFinalPrice(posProductId, undefined, undefined, 1, pool);
  const bulkPrice = (await getFinalPricesBulk([{ productId: posProductId, quantity: 1 }], undefined, undefined, pool))[0];
  requireGate(
    'LIVE_POS_ENGINE_FLOOR',
    near(enginePrice.finalPrice, POS_SELL) &&
      enginePrice.appliedRule.scope === 'base' &&
      near(Number(enginePrice.allocatedCostPerBase), POS_CARRY) &&
      near(Number(bulkPrice?.allocatedCostPerBase), POS_CARRY) &&
      near(Number(bulkPrice?.finalPrice), POS_SELL),
    `engine sell=${enginePrice.finalPrice} allocated=${enginePrice.allocatedCostPerBase} bulkAlloc=${bulkPrice?.allocatedCostPerBase} scope=${enginePrice.appliedRule.scope}`,
    { enginePrice: enginePrice as unknown as Record<string, unknown>, bulkPrice: bulkPrice as unknown as Record<string, unknown> },
  );

  const { salesService } = await import('../src/modules/sales/salesService.js');
  async function posTrySale(
    price: number,
    key: string,
  ): Promise<{ ok: boolean; code: string; message?: string; saleId?: string }> {
    const line = price;
    try {
      const created = await salesService.createSale(pool, {
        items: [
          {
            productId: posProductId,
            productName: posSku,
            quantity: 1,
            unitPrice: price,
            discountAmount: 0,
            isTaxable: false,
            taxRate: 0,
          },
        ],
        subtotal: line,
        discountAmount: 0,
        taxAmount: 0,
        totalAmount: line,
        paymentMethod: 'CASH',
        paymentReceived: line,
        soldBy: userId,
        idempotencyKey: key,
      });
      return { ok: true, code: '', saleId: created.sale.id };
    } catch (e) {
      const code =
        e && typeof e === 'object' && 'errorCode' in e ? String((e as { errorCode: unknown }).errorCode) : '';
      const message = e instanceof Error ? e.message.slice(0, 240) : String(e);
      return { ok: false, code, message };
    }
  }

  const saleAtCarry = await posTrySale(POS_CARRY, `POS-AT-${stamp}`);
  requireGate(
    'LIVE_POS_SALE_AT_NEW_CARRYING',
    saleAtCarry.ok === true,
    saleAtCarry.ok
      ? `createSale at ${POS_CARRY} after markdown (catalog sell ${POS_SELL}) saleId=${saleAtCarry.saleId}`
      : `expected accept at ${POS_CARRY}, got ${saleAtCarry.code} ${saleAtCarry.message ?? ''}`,
    { saleAtCarry },
  );
  const saleBelow = await posTrySale(POS_CARRY - 0.02, `POS-BELOW-${stamp}`);
  requireGate(
    'LIVE_POS_SALE_BELOW_NEW_CARRYING',
    saleBelow.ok === false && saleBelow.code === 'BELOW_ALLOCATED_COST',
    saleBelow.ok ? `createSale accepted ${POS_CARRY - 0.02}` : `${saleBelow.code}`,
    { saleBelow },
  );
  const saleCatalog = await posTrySale(POS_SELL, `POS-CAT-${stamp}`);
  requireGate(
    'LIVE_POS_SALE_AT_CATALOG',
    saleCatalog.ok === true,
    saleCatalog.ok
      ? `createSale at unchanged catalog ${POS_SELL} saleId=${saleCatalog.saleId}`
      : `expected accept at ${POS_SELL}, got ${saleCatalog.code} ${saleCatalog.message ?? ''}`,
    { saleCatalog },
  );

  const posDocSql = await pool.query<{
    document_number: string;
    status: string;
    reason: string;
    quantity: string;
    original_unit_cost: string;
    previous_carrying_unit_cost: string;
    new_carrying_unit_cost: string;
    total_amount: string;
    expense_account_code: string;
    journal_entry_id: string | null;
  }>(
    `SELECT document_number, status, reason, quantity::text,
            original_unit_cost::text, previous_carrying_unit_cost::text,
            new_carrying_unit_cost::text, total_amount::text,
            expense_account_code, journal_entry_id::text
     FROM lot_write_down_documents WHERE id = $1`,
    [posWd.documentId],
  );
  const posDoc = posDocSql.rows[0];
  const posMarkdown = POS_QTY * (POS_CATALOG_COST - POS_CARRY);
  requireGate(
    'LIVE_POS_SQL_DOC',
    posDoc?.status === 'POSTED' &&
      posDoc.reason === 'NEAR_EXPIRY' &&
      posDoc.expense_account_code === '5140' &&
      Boolean(posDoc.journal_entry_id) &&
      near(Number(posDoc.original_unit_cost), POS_CATALOG_COST) &&
      near(Number(posDoc.previous_carrying_unit_cost), POS_CATALOG_COST) &&
      near(Number(posDoc.new_carrying_unit_cost), POS_CARRY) &&
      near(Number(posDoc.total_amount), posMarkdown) &&
      near(Number(posDoc.quantity), POS_QTY),
    `doc=${posDoc?.document_number} status=${posDoc?.status} orig=${posDoc?.original_unit_cost} new=${posDoc?.new_carrying_unit_cost} amt=${posDoc?.total_amount} je=${posDoc?.journal_entry_id}`,
    { posDoc },
  );

  const posGl = await pool.query<{ account: string; debit: string; credit: string; source: string | null; ref_type: string }>(
    `SELECT a."AccountCode" AS account,
            COALESCE(le."DebitAmount", 0)::text AS debit,
            COALESCE(le."CreditAmount", 0)::text AS credit,
            lt."PostingSource" AS source,
            lt."ReferenceType" AS ref_type
     FROM ledger_transactions lt
     JOIN ledger_entries le ON le."TransactionId" = lt."Id"
     JOIN accounts a ON a."Id" = le."AccountId"
     WHERE lt."Id" = $1
        OR (lt."ReferenceType" = 'LOT_WRITE_DOWN' AND lt."ReferenceId" = $2)`,
    [posWd.journalEntryId, posWd.documentId],
  );
  const posDr5140 = posGl.rows.filter((r) => r.account === '5140').reduce((s, r) => s + Number(r.debit), 0);
  const posCr1300 = posGl.rows.filter((r) => r.account === '1300').reduce((s, r) => s + Number(r.credit), 0);
  const posForbidden = posGl.rows.filter((r) => ['5110', '5120', '5130'].includes(r.account));
  requireGate(
    'LIVE_POS_SQL_WD_GL',
    near(posDr5140, posMarkdown) &&
      near(posCr1300, posMarkdown) &&
      posForbidden.length === 0 &&
      posGl.rows.every((r) => r.ref_type === 'LOT_WRITE_DOWN' && r.source === 'INVENTORY_MOVE'),
    `DR5140=${posDr5140} CR1300=${posCr1300} forbidden=${posForbidden.map((r) => r.account).join(',') || 'none'}`,
    { posGl: posGl.rows },
  );

  const postedSales = await pool.query<{
    id: string;
    sale_number: string;
    total_amount: string;
    total_cost: string;
    profit: string;
    idempotency_key: string | null;
    unit_price: string;
    unit_cost: string;
    quantity: string;
  }>(
    `SELECT s.id::text, s.sale_number, s.total_amount::text, s.total_cost::text, s.profit::text,
            s.idempotency_key, si.unit_price::text, si.unit_cost::text, si.quantity::text
     FROM sales s
     JOIN sale_items si ON si.sale_id = s.id
     WHERE s.id = ANY($1::uuid[])
     ORDER BY s.created_at`,
    [[saleAtCarry.saleId, saleCatalog.saleId].filter(Boolean)],
  );
  const sqlAt = postedSales.rows.find((r) => r.id === saleAtCarry.saleId);
  const sqlCat = postedSales.rows.find((r) => r.id === saleCatalog.saleId);
  requireGate(
    'LIVE_POS_SQL_SALES',
    postedSales.rows.length === 2 &&
      Boolean(sqlAt) &&
      Boolean(sqlCat) &&
      near(Number(sqlAt?.unit_price), POS_CARRY) &&
      near(Number(sqlAt?.unit_cost), POS_CARRY) &&
      near(Number(sqlAt?.total_amount), POS_CARRY) &&
      near(Number(sqlAt?.total_cost), POS_CARRY) &&
      near(Number(sqlAt?.profit), 0) &&
      near(Number(sqlCat?.unit_price), POS_SELL) &&
      near(Number(sqlCat?.unit_cost), POS_CARRY) &&
      near(Number(sqlCat?.total_amount), POS_SELL) &&
      near(Number(sqlCat?.total_cost), POS_CARRY) &&
      near(Number(sqlCat?.profit), POS_SELL - POS_CARRY),
    `at ${sqlAt?.sale_number} price=${sqlAt?.unit_price} cogs=${sqlAt?.unit_cost}; cat ${sqlCat?.sale_number} price=${sqlCat?.unit_price} cogs=${sqlCat?.unit_cost}`,
    { postedSales: postedSales.rows },
  );

  const belowPosted = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM sales WHERE idempotency_key = $1`,
    [`POS-BELOW-${stamp}`],
  );
  requireGate(
    'LIVE_POS_SQL_NO_BELOW_SALE',
    Number(belowPosted.rows[0]?.n ?? 1) === 0 &&
      saleBelow.ok === false &&
      saleBelow.code === 'BELOW_ALLOCATED_COST',
    `below-cost idempotency POS-BELOW-${stamp} sales=${belowPosted.rows[0]?.n} code=${saleBelow.code}`,
    { belowPosted: belowPosted.rows[0], saleBelow },
  );

  const qtyAfterSales = await pool.query<{ remaining_quantity: string; cost_price: string; original_cost_price: string }>(
    `SELECT remaining_quantity::text, cost_price::text, original_cost_price::text
     FROM inventory_batches WHERE id = $1`,
    [posBatchId],
  );
  requireGate(
    'LIVE_POS_SQL_QTY_AND_FLOOR',
    near(Number(qtyAfterSales.rows[0]?.remaining_quantity), POS_QTY - 2) &&
      near(Number(qtyAfterSales.rows[0]?.cost_price), POS_CARRY) &&
      near(Number(qtyAfterSales.rows[0]?.original_cost_price), POS_CATALOG_COST),
    `remaining=${qtyAfterSales.rows[0]?.remaining_quantity} carrying=${qtyAfterSales.rows[0]?.cost_price} original=${qtyAfterSales.rows[0]?.original_cost_price}`,
    { qtyAfterSales: qtyAfterSales.rows[0] },
  );

  const posSaleGl = await pool.query<{
    ref_type: string;
    source: string | null;
    account: string;
    debit: string;
    credit: string;
    sale_id: string;
  }>(
    `SELECT lt."ReferenceType" AS ref_type, lt."PostingSource" AS source, a."AccountCode" AS account,
            COALESCE(le."DebitAmount", 0)::text AS debit, COALESCE(le."CreditAmount", 0)::text AS credit,
            lt."ReferenceId"::text AS sale_id
     FROM ledger_transactions lt
     JOIN ledger_entries le ON le."TransactionId" = lt."Id"
     JOIN accounts a ON a."Id" = le."AccountId"
     WHERE lt."ReferenceId" = ANY($1::uuid[])`,
    [[saleAtCarry.saleId, saleCatalog.saleId].filter(Boolean)],
  );
  const sumGl = (account: string, side: 'debit' | 'credit', refType?: string) =>
    posSaleGl.rows
      .filter((r) => r.account === account && (!refType || r.ref_type === refType))
      .reduce((s, r) => s + Number(r[side]), 0);
  const glCash = sumGl('1010', 'debit', 'SALE');
  const glRev = sumGl('4000', 'credit', 'SALE');
  const glCogs = sumGl('5000', 'debit', 'SALE_COGS');
  const glInvCogs = sumGl('1300', 'credit', 'SALE_COGS');
  const glForbiddenPnl = posSaleGl.rows.filter((r) => ['5110', '5120', '5130', '5140'].includes(r.account));
  const saleProfitSum = postedSales.rows.reduce((s, r) => s + Number(r.profit), 0);
  const remainingQty = Number(qtyAfterSales.rows[0]?.remaining_quantity);
  const remainingCarry = Number(qtyAfterSales.rows[0]?.cost_price);
  const openingInv = POS_QTY * POS_CATALOG_COST;
  const remainingInv = remainingQty * remainingCarry;
  const identity =
    openingInv - posCr1300 - glInvCogs;
  requireGate(
    'LIVE_POS_SQL_SALE_GL',
    near(glCash, POS_CARRY + POS_SELL) &&
      near(glRev, POS_CARRY + POS_SELL) &&
      near(glCogs, POS_CARRY + POS_CARRY) &&
      near(glInvCogs, POS_CARRY + POS_CARRY) &&
      glForbiddenPnl.length === 0 &&
      posSaleGl.rows.filter((r) => r.ref_type === 'SALE').every((r) => r.source === 'SALES_INVOICE') &&
      posSaleGl.rows.filter((r) => r.ref_type === 'SALE_COGS').every((r) => r.source === 'INVENTORY_MOVE'),
    `cashDR=${glCash} revCR=${glRev} cogsDR=${glCogs} invCR=${glInvCogs} forbidden=${glForbiddenPnl.map((r) => r.account).join(',') || 'none'}`,
    { posSaleGl: posSaleGl.rows },
  );
  requireGate(
    'LIVE_POS_SQL_GROSS_PROFIT',
    near(saleProfitSum, POS_SELL - POS_CARRY) &&
      near(glRev - glCogs, POS_SELL - POS_CARRY) &&
      near(Number(sqlAt?.profit), 0) &&
      near(Number(sqlCat?.profit), POS_SELL - POS_CARRY) &&
      near(Number(sqlAt?.unit_cost), POS_CARRY) &&
      near(Number(sqlCat?.unit_cost), POS_CARRY) &&
      !near(Number(sqlAt?.unit_cost), POS_CATALOG_COST),
    `sale.profit sum=${saleProfitSum} GL 4000-5000=${glRev - glCogs}; COGS uses carrying ${POS_CARRY} not original ${POS_CATALOG_COST}`,
    {
      saleProfitSum,
      glGross: glRev - glCogs,
      sqlAt,
      sqlCat,
    },
  );
  requireGate(
    'LIVE_POS_SQL_VALUATION_IDENTITY',
    near(identity, remainingInv) &&
      near(remainingInv, (POS_QTY - 2) * POS_CARRY) &&
      near(openingInv - posMarkdown - glCogs, remainingInv) &&
      near(glCash + remainingInv - openingInv, glRev - glCogs - posDr5140),
    `open ${openingInv} - WD ${posCr1300} - COGS ${glInvCogs} = ${identity}; subledger ${remainingQty}×${remainingCarry}=${remainingInv}; cash+inv-open=${glCash + remainingInv - openingInv} P&L=${glRev - glCogs - posDr5140}`,
    {
      openingInv,
      markdown1300: posCr1300,
      cogs1300: glInvCogs,
      remainingInv,
      cash: glCash,
      revenue: glRev,
      cogs: glCogs,
      markdown5140: posDr5140,
      netPnl: glRev - glCogs - posDr5140,
    },
  );
  requireGate(
    'LIVE_POS_SQL_NO_DOUBLE_COUNT',
    near(posDr5140, posMarkdown) &&
      near(glCogs, 2 * POS_CARRY) &&
      !near(glCogs, 2 * POS_CATALOG_COST) &&
      posForbidden.length === 0,
    `5140=${posDr5140} is clearance expense; COGS 5000=${glCogs} is remaining carrying not original ${2 * POS_CATALOG_COST}`,
    { markdown5140: posDr5140, cogs5000: glCogs },
  );

  const result = await writeDownNearExpiryLot(pool, {
    inventoryBatchId: criticalId,
    newUnitCost: NEW_COST,
    userId,
    memo: `LIVE write-down ${stamp}`,
  });

  gate(
    'LIVE_DOC',
    result.documentNumber.startsWith('LWD-') && result.expenseAccountCode === '5140',
    `doc=${result.documentNumber} account=${result.expenseAccountCode} amount=${result.totalAmount}`,
    { result: result as unknown as Record<string, unknown> },
  );
  gate('LIVE_QTY_UNCHANGED', near(result.remainingQuantity, QTY), `remaining=${result.remainingQuantity}`);
  gate(
    'LIVE_AMOUNT',
    near(result.totalAmount, MARKDOWN),
    `markdown=${result.totalAmount} expected=${MARKDOWN}`,
  );

  const after = await pool.query<{
    remaining_quantity: string;
    cost_price: string;
    original_cost_price: string;
    status: string;
  }>(
    `SELECT remaining_quantity::text, cost_price::text, original_cost_price::text,
            COALESCE(status::text,'ACTIVE') AS status
     FROM inventory_batches WHERE id = $1`,
    [criticalId],
  );
  const row = after.rows[0];
  gate(
    'LIVE_ORIGINAL_KEPT',
    near(Number(row?.original_cost_price), CARRYING) && near(Number(row?.cost_price), NEW_COST),
    `original=${row?.original_cost_price} carrying=${row?.cost_price} status=${row?.status}`,
    { after: row },
  );
  gate(
    'LIVE_STATUS_ACTIVE',
    row?.status === 'ACTIVE' && near(Number(row?.remaining_quantity), QTY),
    `status=${row?.status} qty=${row?.remaining_quantity}`,
  );

  const doc = await pool.query<{
    reason: string;
    quantity: string;
    expense_account_code: string;
    journal_entry_id: string | null;
  }>(
    `SELECT reason, quantity::text, expense_account_code, journal_entry_id::text
     FROM lot_write_down_documents WHERE id = $1`,
    [result.documentId],
  );
  gate(
    'LIVE_DOC_ROW',
    doc.rows[0]?.reason === 'NEAR_EXPIRY' &&
      doc.rows[0]?.expense_account_code === '5140' &&
      Boolean(doc.rows[0]?.journal_entry_id),
    `reason=${doc.rows[0]?.reason} account=${doc.rows[0]?.expense_account_code} je=${doc.rows[0]?.journal_entry_id}`,
  );

  const gl = await pool.query<{
    txn: string;
    account: string;
    debit: string;
    credit: string;
    ref_type: string;
    source: string | null;
  }>(
    `SELECT lt."TransactionNumber" AS txn,
            a."AccountCode" AS account,
            COALESCE(le."DebitAmount", 0)::text AS debit,
            COALESCE(le."CreditAmount", 0)::text AS credit,
            lt."ReferenceType" AS ref_type,
            lt."PostingSource" AS source
     FROM ledger_transactions lt
     JOIN ledger_entries le ON le."TransactionId" = lt."Id"
     JOIN accounts a ON a."Id" = le."AccountId"
     WHERE lt."Id" = $1
        OR (lt."ReferenceType" = 'LOT_WRITE_DOWN' AND lt."ReferenceId" = $2)
     ORDER BY a."AccountCode", le."LineNumber" NULLS LAST`,
    [result.journalEntryId, result.documentId],
  );

  const debit5140 = gl.rows
    .filter((r) => r.account === '5140')
    .reduce((s, r) => s + Number(r.debit), 0);
  const credit1300 = gl.rows
    .filter((r) => r.account === '1300')
    .reduce((s, r) => s + Number(r.credit), 0);
  const forbidden = gl.rows.filter((r) => ['5110', '5120', '5130'].includes(r.account));
  const sources = [...new Set(gl.rows.map((r) => r.source))];
  const refs = [...new Set(gl.rows.map((r) => r.ref_type))];

  gate(
    'LIVE_GL_SHAPE',
    near(debit5140, MARKDOWN) && near(credit1300, MARKDOWN) && forbidden.length === 0,
    `DR5140=${debit5140} CR1300=${credit1300} forbidden=${forbidden.map((r) => r.account).join(',') || 'none'}`,
    { gl: gl.rows },
  );
  gate(
    'LIVE_GL_SOURCE',
    refs.every((r) => r === 'LOT_WRITE_DOWN') && sources.every((s) => s === 'INVENTORY_MOVE'),
    `ref=${refs.join(',')} source=${sources.join(',')}`,
  );

  assertWriteDownCouplesSubledger({
    quantity: QTY,
    previousCarrying: CARRYING,
    newCarrying: NEW_COST,
    glAmount: debit5140,
  });
  gate('LIVE_COUPLING', true, `qty×delta=${MARKDOWN} matches DR5140=${debit5140}`);

  const moves = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM stock_movements WHERE batch_id = $1`,
    [criticalId],
  );
  gate(
    'LIVE_NO_STOCK_MOVEMENT',
    Number(moves.rows[0]?.n ?? -1) === 0,
    `stock_movements for critical batch=${moves.rows[0]?.n}`,
  );

  const fefo = await pool.query<{ remaining_quantity: string; cost_price: string }>(
    `SELECT remaining_quantity, cost_price
     FROM inventory_batches
     WHERE id = $1 AND remaining_quantity > 0 AND status = 'ACTIVE'
       AND (expiry_date IS NULL OR expiry_date > CURRENT_DATE)`,
    [criticalId],
  );
  const first = fefo.rows[0];
  gate(
    'LIVE_FEFO_CARRYING',
    near(Number(first?.cost_price), NEW_COST),
    `FEFO first cost_price=${first?.cost_price} (expected ${NEW_COST}); layers=${fefo.rows.length}`,
    { fefo: fefo.rows },
  );

  assertSaleLineNotBelowAllocatedCost({
    productId,
    quantity: 1,
    lineRevenue: NEW_COST,
    totalAllocatedCost: NEW_COST,
    costPerSellingUnit: NEW_COST,
    unitPrice: NEW_COST,
  });
  gate('LIVE_POS_AT_NEW_COST', true, `sale at ${NEW_COST} allowed`);

  try {
    assertSaleLineNotBelowAllocatedCost({
      productId,
      quantity: 1,
      lineRevenue: NEW_COST - 1,
      totalAllocatedCost: NEW_COST,
      costPerSellingUnit: NEW_COST,
      unitPrice: NEW_COST - 1,
    });
    gate('LIVE_POS_BELOW_NEW_COST', false, 'below new carrying should throw');
  } catch (e) {
    if (!(e instanceof BusinessError) || e.errorCode !== 'BELOW_ALLOCATED_COST') throw e;
    gate('LIVE_POS_BELOW_NEW_COST', true, e.errorCode);
  }

  await expectPgIntegrity('LIVE_ORIGINAL_IMMUTABLE', /immutable after lot creation/i, () =>
    pool.query(`UPDATE inventory_batches SET original_cost_price = 1 WHERE id = $1`, [criticalId]),
  );
  await expectPgIntegrity('LIVE_COST_NEEDS_DOC', /lot write-down document/i, () =>
    pool.query(`UPDATE inventory_batches SET cost_price = 1 WHERE id = $1`, [criticalId]),
  );

  const REPEAT_COST = 3000;
  const second = await writeDownNearExpiryLot(pool, {
    inventoryBatchId: criticalId,
    newUnitCost: REPEAT_COST,
    userId,
    memo: `LIVE repeat write-down ${stamp}`,
  });
  gate(
    'LIVE_REPEAT_WRITE_DOWN',
    near(second.newCarryingUnitCost, REPEAT_COST) && near(second.totalAmount, QTY * (NEW_COST - REPEAT_COST)),
    `second carrying=${second.newCarryingUnitCost} amount=${second.totalAmount}`,
  );
  const origAfterRepeat = await pool.query<{ original_cost_price: string; cost_price: string }>(
    `SELECT original_cost_price::text, cost_price::text FROM inventory_batches WHERE id = $1`,
    [criticalId],
  );
  gate(
    'LIVE_REPEAT_ORIGINAL_KEPT',
    near(Number(origAfterRepeat.rows[0]?.original_cost_price), CARRYING) &&
      near(Number(origAfterRepeat.rows[0]?.cost_price), REPEAT_COST),
    `original=${origAfterRepeat.rows[0]?.original_cost_price} carrying=${origAfterRepeat.rows[0]?.cost_price}`,
  );

  await expectBusinessCode('LIVE_REJECT_FLOOR', 'LOT_WRITE_DOWN_BELOW_FLOOR', () =>
    writeDownNearExpiryLot(pool, {
      inventoryBatchId: criticalId,
      newUnitCost: 0.001,
      userId,
      memo: `LIVE reject floor ${stamp}`,
    }),
  );

  const { lotService } = await import('../src/modules/inventory-lot/lotService.js');
  const consumeClient = await pool.connect();
  let consumeCost = -1;
  try {
    await consumeClient.query('BEGIN');
    const consumed = await lotService.consumeLot(consumeClient, {
      productId,
      quantity: 1,
      specificLotId: criticalId,
      referenceType: 'LWD_PROOF_FEFO',
      referenceId: criticalId,
      userId,
      recordMovement: false,
      syncProduct: false,
      skipStoreBalanceDeduction: true,
    });
    consumeCost = consumed.layers[0]?.costPrice ?? -1;
    await consumeClient.query('COMMIT');
    gate(
      'LIVE_FEFO_CONSUME_CARRYING',
      near(consumeCost, REPEAT_COST) && consumed.layers.length === 1,
      `consume costPrice=${consumeCost} expected ${REPEAT_COST}`,
      { layers: consumed.layers as unknown as Record<string, unknown>[] },
    );
  } catch (e) {
    await consumeClient.query('ROLLBACK');
    throw e;
  } finally {
    consumeClient.release();
  }

  const { syncService } = await import('../src/modules/platform/syncService.js');
  await syncService.updateEntity(pool, 'inventory_batches', {
    entityType: 'inventory_batch',
    entityId: criticalId,
    action: 'UPDATE',
    data: { cost_price: 1, original_cost_price: 99 },
    version: 1,
    localTimestamp: new Date().toISOString(),
  });
  const afterSync = await pool.query<{ cost_price: string; original_cost_price: string }>(
    `SELECT cost_price::text, original_cost_price::text FROM inventory_batches WHERE id = $1`,
    [criticalId],
  );
  gate(
    'LIVE_OFFLINE_SYNC_COST_SSOT',
    near(Number(afterSync.rows[0]?.cost_price), REPEAT_COST) &&
      near(Number(afterSync.rows[0]?.original_cost_price), CARRYING),
    `after edge cost overwrite attempt carrying=${afterSync.rows[0]?.cost_price} original=${afterSync.rows[0]?.original_cost_price}`,
  );

  try {
    assertSaleLineNotBelowAllocatedCost({
      productId,
      quantity: 1,
      lineRevenue: REPEAT_COST - 1,
      totalAllocatedCost: REPEAT_COST,
      costPerSellingUnit: REPEAT_COST,
      unitPrice: REPEAT_COST - 1,
    });
    gate('LIVE_OFFLINE_STALE_BELOW', false, 'stale offline price below server carrying should throw');
  } catch (e) {
    if (!(e instanceof BusinessError) || e.errorCode !== 'BELOW_ALLOCATED_COST') throw e;
    gate('LIVE_OFFLINE_STALE_BELOW', true, 'server SSOT rejects price below current carrying regardless of client cache');
  }

  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT id FROM inventory_batches WHERE id = $1 FOR UPDATE`, [raceId]);
    await holder.query(
      `UPDATE inventory_batches SET remaining_quantity = remaining_quantity - 1 WHERE id = $1`,
      [raceId],
    );
    const wdRacePromise = writeDownNearExpiryLot(pool, {
      inventoryBatchId: raceId,
      newUnitCost: NEW_COST,
      userId,
      memo: `LIVE race ${stamp}`,
    });
    await new Promise((r) => setTimeout(r, 400));
    await holder.query('COMMIT');
    const wdRace = await wdRacePromise;
    gate(
      'LIVE_CONCURRENT_QTY',
      near(wdRace.quantity, QTY - 1) && near(wdRace.totalAmount, (QTY - 1) * (CARRYING - NEW_COST)),
      `write-down after concurrent consume qty=${wdRace.quantity} amount=${wdRace.totalAmount}`,
    );
    const raceRow = await pool.query<{ remaining_quantity: string; cost_price: string; original_cost_price: string }>(
      `SELECT remaining_quantity::text, cost_price::text, original_cost_price::text FROM inventory_batches WHERE id = $1`,
      [raceId],
    );
    gate(
      'LIVE_CONCURRENT_NO_STALE_COST',
      near(Number(raceRow.rows[0]?.remaining_quantity), QTY - 1) &&
        near(Number(raceRow.rows[0]?.cost_price), NEW_COST) &&
        near(Number(raceRow.rows[0]?.original_cost_price), CARRYING),
      `race remaining=${raceRow.rows[0]?.remaining_quantity} carrying=${raceRow.rows[0]?.cost_price}`,
    );
  } catch (e) {
    try {
      await holder.query('ROLLBACK');
    } catch (rb) {
      console.error('race holder rollback failed:', rb);
    }
    throw e;
  } finally {
    holder.release();
  }

  const wdDispose = await writeDownNearExpiryLot(pool, {
    inventoryBatchId: disposeId,
    newUnitCost: NEW_COST,
    userId,
    memo: `LIVE dispose-after-write-down ${stamp}`,
  });
  gate(
    'LIVE_DISPOSE_PRE_WD',
    near(wdDispose.totalAmount, QTY * (CARRYING - NEW_COST)),
    `dispose-lot markdown=${wdDispose.totalAmount}`,
  );
  await pool.query(`UPDATE inventory_batches SET expiry_date = $2 WHERE id = $1`, [disposeId, biz]);
  const { isMultistoreEnabled } = await import('../src/modules/inventory/warehouse/multistoreSettings.js');
  const { disposeFromQuarantine } = await import('../src/modules/loss-quarantine/lossDisposalService.js');
  const { postgresLotRepository } = await import('../src/modules/inventory-lot/postgresLotRepository.js');
  const { UnitOfWork } = await import('../src/db/unitOfWork.js');
  const multistore = await isMultistoreEnabled(pool);

  let disposeArgs: Parameters<typeof disposeFromQuarantine>[1] = {
    productId: disposeProductId,
    inventoryBatchId: disposeId,
    quantity: QTY,
    reason: 'EXPIRY',
    userId,
    memo: `LIVE dispose carrying ${stamp}`,
  };

  if (!multistore) {
    const { applySoftQuarantine } = await import('../src/modules/loss-quarantine/softQuarantineService.js');
    const q = await applySoftQuarantine(pool, {
      inventoryBatchId: disposeId,
      reason: 'EXPIRED',
      userId,
      memo: `LIVE expire after write-down ${stamp}`,
    });
    gate('LIVE_DISPOSE_QUARANTINE', q.statusApplied === 'EXPIRED', `status=${q.statusApplied}`);
    disposeArgs.quarantineMode = 'SOFT';
  } else {
    const expiredStore = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM store_locations
       WHERE store_type = 'EXPIRED' AND is_active = true LIMIT 1`,
    );
    requireGate(
      'LIVE_DISPOSE_EXPIRED_STORE',
      Boolean(expiredStore.rows[0]?.id),
      expiredStore.rows[0]?.id ? `expiredStore=${expiredStore.rows[0].id}` : 'no EXPIRED store',
    );
    const productLotId = await UnitOfWork.run(pool, async (client) => {
      const bn = await client.query<{ batch_number: string; cost_price: string }>(
        `SELECT batch_number, cost_price::text FROM inventory_batches WHERE id = $1`,
        [disposeId],
      );
      await postgresLotRepository.upsertProjection(client, {
        inventoryBatchId: disposeId,
        productId: disposeProductId,
        lotNumber: bn.rows[0].batch_number,
        expiryDate: biz,
        costPrice: Number(bn.rows[0].cost_price),
        status: 'EXPIRED',
      });
      await lotService.transitionLotStatus(client, {
        lotId: disposeId,
        newStatus: 'EXPIRED',
        userId,
      });
      const lot = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM product_lots WHERE inventory_batch_id = $1 LIMIT 1`,
        [disposeId],
      );
      const lotId = lot.rows[0]?.id;
      if (!lotId) throw new Error('product_lots row missing after upsert');
      await client.query(
        `INSERT INTO inventory_balances (store_location_id, product_id, product_lot_id, quantity_on_hand)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (store_location_id, product_lot_id) DO UPDATE SET
           quantity_on_hand = EXCLUDED.quantity_on_hand,
           product_id = EXCLUDED.product_id,
           updated_at = NOW()`,
        [expiredStore.rows[0].id, disposeProductId, lotId, QTY],
      );
      return lotId;
    });
    gate('LIVE_DISPOSE_QUARANTINE', true, `multistore EXPIRED store + lot ${productLotId}`);
    disposeArgs.quarantineMode = 'HARD';
    disposeArgs.storeLocationId = expiredStore.rows[0].id;
    disposeArgs.productLotId = productLotId;
  }
  try {
    await disposeFromQuarantine(pool, {
      ...disposeArgs,
      unitCost: CARRYING,
      memo: `LIVE reject original-cost dispose ${stamp}`,
    });
    gate('LIVE_DISPOSE_REJECT_ORIGINAL', false, 'dispose at original cost should throw');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/remaining carrying cost/i.test(msg)) throw e;
    gate('LIVE_DISPOSE_REJECT_ORIGINAL', true, msg.slice(0, 180));
  }
  const dispose = await disposeFromQuarantine(pool, disposeArgs);
  gate(
    'LIVE_DISPOSE_ACCOUNT',
    dispose.expenseAccountCode === '5130',
    `dispose account=${dispose.expenseAccountCode}`,
  );
  const glDisp = await pool.query<{ account: string; debit: string; credit: string }>(
    `SELECT a."AccountCode" AS account,
            COALESCE(le."DebitAmount", 0)::text AS debit,
            COALESCE(le."CreditAmount", 0)::text AS credit
     FROM ledger_transactions lt
     JOIN ledger_entries le ON le."TransactionId" = lt."Id"
     JOIN accounts a ON a."Id" = le."AccountId"
     WHERE lt."Id" = $1`,
    [dispose.journalEntryId],
  );
  const debit5130 = glDisp.rows.filter((r) => r.account === '5130').reduce((s, r) => s + Number(r.debit), 0);
  const credit1300d = glDisp.rows.filter((r) => r.account === '1300').reduce((s, r) => s + Number(r.credit), 0);
  const debit5140d = glDisp.rows.filter((r) => r.account === '5140').reduce((s, r) => s + Number(r.debit), 0);
  gate(
    'LIVE_DISPOSE_CARRYING_NOT_ORIGINAL',
    near(debit5130, QTY * NEW_COST) && near(credit1300d, QTY * NEW_COST) && near(debit5140d, 0),
    `DR5130=${debit5130} CR1300=${credit1300d} DR5140=${debit5140d} (must be remaining carrying ${QTY * NEW_COST}, not original ${QTY * CARRYING})`,
    { glDisp: glDisp.rows },
  );

  const failed = gates.filter((g) => !g.ok);
  const evidence = {
    proof: 'LOT_WRITE_DOWN_LIVE',
    contract:
      'Lot carrying-value write-down / inventory clearance markdown: original_cost_price immutable; cost_price decreases only with a posted LWD document; 5140≠5120/5130; disposal uses remaining carrying; concurrent sale/write-down serializes on FOR UPDATE; offline/edge cannot overwrite carrying; POS floor is server FEFO carrying.',
    provenAt: new Date().toISOString(),
    startedAt,
    stamp,
    sku: SKU,
    fixture: {
      productId,
      criticalId,
      sixtyId,
      warningId,
      expiredId,
      noExpiryId,
      quarantinedId,
      raceId,
      disposeId,
      businessDate: biz,
      criticalExpiry,
      sixtyExpiry,
      beyondExpiry,
      carrying: CARRYING,
      newCost: NEW_COST,
      qty: QTY,
    },
    result,
    gates,
    summary: {
      total: gates.length,
      passed: gates.filter((g) => g.ok).length,
      failed: failed.length,
      verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    },
  };

  const jsonPath = path.join(repoRoot, 'PROOF_LOT_WRITE_DOWN_LIVE.json');
  const mdPath = path.join(repoRoot, 'PROOF_LOT_WRITE_DOWN_LIVE.md');
  fs.writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));
  fs.writeFileSync(
    mdPath,
    [
      '# PROOF — Lot carrying-value write-down / inventory clearance markdown (LIVE)',
      '',
      `**Verdict:** ${evidence.summary.verdict}`,
      `**Proven at:** ${evidence.provenAt}`,
      `**Stamp / SKU:** ${stamp} / ${SKU}`,
      '',
      `**Contract:** ${evidence.contract}`,
      '',
      '## Fixture',
      '',
      '```json',
      JSON.stringify(evidence.fixture, null, 2),
      '```',
      '',
      '## Gates (measured)',
      '',
      ...gates.map(
        (g) =>
          `- ${g.ok ? 'PASS' : 'FAIL'} \`${g.id}\`: ${g.detail}` +
          (g.measured ? `\n  - measured: \`${JSON.stringify(g.measured).slice(0, 240)}\`` : ''),
      ),
      '',
      '## Reproduce',
      '',
      '```bash',
      'cd SamplePOS.Server && npx tsx scripts/proof-lot-write-down-live.ts',
      'npm run proof:lot-write-down:live',
      '```',
      '',
      'Requires: `DATABASE_URL`, accounts 1300/5140, migration 611. Exit 2 if DATABASE_URL missing. Unexpected errors are not swallowed.',
      '',
    ].join('\n'),
  );

  console.log('═'.repeat(60));
  console.log(` verdict: ${evidence.summary.verdict}`);
  console.log(` passed: ${evidence.summary.passed}/${evidence.summary.total}`);
  console.log(` wrote: ${path.basename(jsonPath)}`);
  console.log('═'.repeat(60));

  await closePool();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('LIVE proof crashed:', err);
  try {
    await closePool();
  } catch (endErr) {
    console.error('pool.end failed:', endErr);
  }
  process.exit(1);
});
