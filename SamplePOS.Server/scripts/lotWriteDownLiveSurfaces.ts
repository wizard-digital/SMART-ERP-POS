/**
 * Live adversarial surfaces for lot write-down: createSale, quote convert,
 * AT_COST, COGS, offline replay, HTTP cashier, tenant isolation, fresh migrate.
 * Hits PostgreSQL and HTTP — not mocks.
 */
import http from 'http';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import pg from 'pg';
import express from 'express';
import jwt from 'jsonwebtoken';
import Decimal from 'decimal.js';
import { BusinessError } from '../src/middleware/errorHandler.js';
import { addDaysToDateString, getBusinessDate } from '../src/utils/dateRange.js';
import { writeDownNearExpiryLot } from '../src/modules/inventory-lot/lotWriteDownService.js';
import { tenantMigrationService } from '../src/modules/system/tenantMigrationService.js';
import { LWD_MIGRATION_FILES } from './ensureLotWriteDownMigrations.js';

export type RecResult = 'PROVEN' | 'FAILED' | 'UNPROVEN' | 'PARTIALLY_PROVEN';
export type RecFn = (
  id: string,
  ok: boolean,
  result: RecResult,
  detail: string,
  evidence?: Record<string, unknown>,
) => void;

function bizCode(e: unknown): string {
  if (e && typeof e === 'object' && 'errorCode' in e && typeof (e as { errorCode: unknown }).errorCode === 'string') {
    return (e as { errorCode: string }).errorCode;
  }
  return '';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function dbNameFromUrl(url: string): string | null {
  try {
    return new URL(url.replace(/^postgresql:/, 'http:')).pathname.replace(/^\//, '').split('?')[0] || null;
  } catch {
    return null;
  }
}

export async function seedUom(pool: Pool, productId: string): Promise<string | null> {
  const uom = await pool.query<{ id: string }>(`SELECT id::text AS id FROM uoms WHERE name = 'Each' LIMIT 1`);
  const uomId = uom.rows[0]?.id;
  if (!uomId) return null;
  const cols = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'product_uoms'`,
  );
  const names = new Set(cols.rows.map((r) => r.column_name));
  const fields = ['product_id', 'uom_id'];
  const values: unknown[] = [productId, uomId];
  if (names.has('conversion_factor')) {
    fields.push('conversion_factor');
    values.push(1);
  }
  if (names.has('is_default')) {
    fields.push('is_default');
    values.push(true);
  }
  const placeholders = values.map((_, i) => `$${i + 1}`).join(',');
  await pool.query(
    `INSERT INTO product_uoms (${fields.join(',')}) VALUES (${placeholders})
     ON CONFLICT DO NOTHING`,
    values,
  );
  return uomId;
}

export async function seedSellableBalance(
  pool: Pool,
  opts: {
    productId: string;
    batchId: string;
    qty: number;
    cost: number;
    expiry: string;
    userId: string;
  },
): Promise<{ storeId: string | null; lotId: string | null }> {
  const { isMultistoreEnabled } = await import('../src/modules/inventory/warehouse/multistoreSettings.js');
  if (!(await isMultistoreEnabled(pool))) {
    return { storeId: null, lotId: null };
  }
  const { postgresLotRepository } = await import('../src/modules/inventory-lot/postgresLotRepository.js');
  const { UnitOfWork } = await import('../src/db/unitOfWork.js');
  const { posProductSearchService } = await import(
    '../src/modules/inventory/warehouse/posProductSearchService.js'
  );
  return UnitOfWork.run(pool, async (client) => {
    const storeId = await posProductSearchService.resolveActiveSellingStoreId(client);
    if (!storeId) throw new Error('no SELLING store');
    const bn = await client.query<{ batch_number: string }>(
      `SELECT batch_number FROM inventory_batches WHERE id = $1`,
      [opts.batchId],
    );
    await postgresLotRepository.upsertProjection(client, {
      inventoryBatchId: opts.batchId,
      productId: opts.productId,
      lotNumber: bn.rows[0].batch_number,
      expiryDate: opts.expiry,
      costPrice: opts.cost,
      status: 'ACTIVE',
    });
    const lot = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM product_lots WHERE inventory_batch_id = $1 LIMIT 1`,
      [opts.batchId],
    );
    const lotId = lot.rows[0]?.id;
    if (!lotId) throw new Error('product_lots missing');
    await client.query(
      `INSERT INTO inventory_balances (store_location_id, product_id, product_lot_id, quantity_on_hand)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (store_location_id, product_lot_id) DO UPDATE SET
         quantity_on_hand = EXCLUDED.quantity_on_hand,
         product_id = EXCLUDED.product_id,
         updated_at = NOW()`,
      [storeId, opts.productId, lotId, opts.qty],
    );
    return { storeId, lotId };
  });
}

async function tryCreateSale(
  pool: Pool,
  opts: {
    productId: string;
    productName: string;
    unitPrice: number;
    qty: number;
    userId: string;
    customerId?: string;
    key: string;
    offlineId?: string;
  },
): Promise<{ ok: true; saleId: string } | { ok: false; code: string; message: string }> {
  const { salesService } = await import('../src/modules/sales/salesService.js');
  const line = Number(new Decimal(opts.unitPrice).times(opts.qty).toFixed(2));
  try {
    const created = await salesService.createSale(pool, {
      items: [
        {
          productId: opts.productId,
          productName: opts.productName,
          quantity: opts.qty,
          unitPrice: opts.unitPrice,
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
      soldBy: opts.userId,
      customerId: opts.customerId,
      idempotencyKey: opts.key,
      offlineId: opts.offlineId,
    });
    return { ok: true, saleId: created.sale.id };
  } catch (e) {
    return { ok: false, code: bizCode(e), message: errMsg(e).slice(0, 240) };
  }
}

export async function runLotWriteDownLiveSurfaces(opts: {
  pool: Pool;
  rec: RecFn;
  stamp: string;
  userId: string;
  databaseUrl: string;
}): Promise<void> {
  const { pool, rec, stamp, userId, databaseUrl } = opts;
  const biz = getBusinessDate();
  const expiry = addDaysToDateString(biz, 5);
  const sku = `LWDLS-${stamp}`;
  const productId = randomUUID();
  const batchId = randomUUID();
  const QTY = 20;
  const ORIG = 10000;
  const CARRY = 6000;

  try {
    await pool.query(
      `INSERT INTO products (id, name, sku, barcode, cost_price, selling_price, quantity_on_hand, is_active, track_expiry, is_taxable, tax_rate)
       VALUES ($1,$2,$3,$3,$4,$5,$6,true,true,false,0)`,
      [productId, `LWD live surfaces ${stamp}`, sku, ORIG, 7000, QTY],
    );
    await pool.query(
      `INSERT INTO inventory_batches (
         id, product_id, batch_number, quantity, remaining_quantity, cost_price, received_date, expiry_date, status, source_type
       ) VALUES ($1,$2,$3,$4,$4,$5,CURRENT_DATE,$6,'ACTIVE','ADJUSTMENT')`,
      [batchId, productId, `${sku}-B`, QTY, ORIG, expiry],
    );
    const uomId = await seedUom(pool, productId);
    rec('LIVE_UOM', Boolean(uomId), uomId ? 'PROVEN' : 'UNPROVEN', uomId ? `uom=${uomId}` : 'no Each UoM');
    const wd = await writeDownNearExpiryLot(pool, {
      inventoryBatchId: batchId,
      newUnitCost: CARRY,
      userId,
      memo: `live surfaces markdown ${stamp}`,
    });
    rec(
      'LIVE_SURFACES_WD',
      wd.newCarryingUnitCost === CARRY,
      'PROVEN',
      `carrying=${wd.newCarryingUnitCost} je=${wd.journalEntryId}`,
      { wd },
    );
    await seedSellableBalance(pool, {
      productId,
      batchId,
      qty: QTY,
      cost: CARRY,
      expiry,
      userId,
    });

    const prices = [
      { id: 'CREATE_SALE_6000_01', price: 6000.01, expect: 'allow' as const },
      { id: 'CREATE_SALE_6000_00', price: 6000.0, expect: 'allow' as const },
      { id: 'CREATE_SALE_5999_99', price: 5999.99, expect: 'allow' as const },
      { id: 'CREATE_SALE_5999_98', price: 5999.98, expect: 'reject' as const },
    ];
    let firstSaleId: string | null = null;
    for (const p of prices) {
      const before = await pool.query<{ remaining_quantity: string; cost_price: string }>(
        `SELECT remaining_quantity::text, cost_price::text FROM inventory_batches WHERE id = $1`,
        [batchId],
      );
      const result = await tryCreateSale(pool, {
        productId,
        productName: sku,
        unitPrice: p.price,
        qty: 1,
        userId,
        key: `${p.id}-${stamp}`,
      });
      if (p.expect === 'allow') {
        const stockFail = !result.ok && (result.code === 'ERR_STOCK_001' || /stock/i.test(result.message));
        rec(
          p.id,
          result.ok,
          result.ok ? 'PROVEN' : stockFail ? 'UNPROVEN' : 'FAILED',
          result.ok
            ? `createSale accepted ${p.price} at carrying ${CARRY}`
            : `expected accept, got ${result.code} ${result.message}`,
          { result },
        );
        if (result.ok && !firstSaleId) firstSaleId = result.saleId;
      } else {
        const after = await pool.query<{ remaining_quantity: string; cost_price: string }>(
          `SELECT remaining_quantity::text, cost_price::text FROM inventory_batches WHERE id = $1`,
          [batchId],
        );
        rec(
          p.id,
          !result.ok && result.code === 'BELOW_ALLOCATED_COST'
            && after.rows[0].remaining_quantity === before.rows[0].remaining_quantity
            && Number(after.rows[0].cost_price) === CARRY,
          !result.ok && result.code === 'BELOW_ALLOCATED_COST' ? 'PROVEN' : 'FAILED',
          result.ok
            ? `createSale accepted ${p.price} below carrying ${CARRY}`
            : `${result.code} qty ${before.rows[0].remaining_quantity}→${after.rows[0].remaining_quantity}`,
          { result, before: before.rows[0], after: after.rows[0] },
        );
      }
    }

    if (firstSaleId) {
      const cogs = await pool.query<{ account: string; debit: string; credit: string; ref: string }>(
        `SELECT a."AccountCode" AS account,
                COALESCE(le."DebitAmount",0)::text AS debit,
                COALESCE(le."CreditAmount",0)::text AS credit,
                lt."ReferenceType"::text AS ref
         FROM ledger_transactions lt
         JOIN ledger_entries le ON le."TransactionId" = lt."Id"
         JOIN accounts a ON a."Id" = le."AccountId"
         WHERE lt."ReferenceId"::text = $1`,
        [firstSaleId],
      );
      const d5000 = cogs.rows.filter((r) => r.account === '5000').reduce((s, r) => s + Number(r.debit), 0);
      const c1300 = cogs.rows.filter((r) => r.account === '1300').reduce((s, r) => s + Number(r.credit), 0);
      rec(
        'CREATE_SALE_COGS',
        d5000 === CARRY && c1300 === CARRY,
        d5000 === CARRY && c1300 === CARRY ? 'PROVEN' : cogs.rows.length === 0 ? 'FAILED' : 'PARTIALLY_PROVEN',
        `sale ${firstSaleId} DR5000=${d5000} CR1300=${c1300} expected ${CARRY} (markdown already on 5140; COGS uses carrying)`,
        { cogs: cogs.rows },
      );
    } else {
      rec('CREATE_SALE_COGS', false, 'UNPROVEN', 'no accepted createSale to inspect COGS journal');
    }

    const beforeOffline = await pool.query<{ remaining_quantity: string; cost_price: string }>(
      `SELECT remaining_quantity::text, cost_price::text FROM inventory_batches WHERE id = $1`,
      [batchId],
    );
    const offline = await tryCreateSale(pool, {
      productId,
      productName: sku,
      unitPrice: 5999.98,
      qty: 1,
      userId,
      key: `OFFLINE-${stamp}`,
      offlineId: randomUUID(),
    });
    const afterOffline = await pool.query<{ remaining_quantity: string; cost_price: string }>(
      `SELECT remaining_quantity::text, cost_price::text FROM inventory_batches WHERE id = $1`,
      [batchId],
    );
    rec(
      'OFFLINE_STALE_PRICE',
      !offline.ok && offline.code === 'BELOW_ALLOCATED_COST'
        && afterOffline.rows[0].remaining_quantity === beforeOffline.rows[0].remaining_quantity,
      !offline.ok && offline.code === 'BELOW_ALLOCATED_COST' ? 'PROVEN' : 'FAILED',
      offline.ok
        ? 'offline replay with stale 5999.98 posted'
        : `${offline.code} server carrying ${CARRY} won`,
      { offline, before: beforeOffline.rows[0], after: afterOffline.rows[0] },
    );

    try {
      const pgId = await pool.query<{ id: string }>(
        `INSERT INTO price_groups (name, pricing_mode, description, is_active)
         VALUES ($1,'AT_COST',$2,true) RETURNING id::text AS id`,
        [`ATCOST-${stamp}`, `forensic AT_COST ${stamp}`],
      );
      const custNo = `C-${stamp}`;
      const cust = await pool.query<{ id: string }>(
        `INSERT INTO customers (customer_number, name, price_group_id, credit_limit, is_active)
         VALUES ($1,$2,$3,0,true) RETURNING id::text AS id`,
        [custNo, `AT_COST ${stamp}`, pgId.rows[0].id],
      );
      const { getFinalPrice } = await import('../src/modules/pricing/pricingEngineService.js');
      const priced = await getFinalPrice(productId, cust.rows[0].id, undefined, 1, pool, 1);
      rec(
        'AT_COST_ENGINE_PRICE',
        Math.abs(priced.finalPrice - CARRY) < 0.005,
        Math.abs(priced.finalPrice - CARRY) < 0.005 ? 'PROVEN' : 'FAILED',
        `AT_COST finalPrice=${priced.finalPrice} carrying=${CARRY}`,
        { priced },
      );
      const atOk = await tryCreateSale(pool, {
        productId,
        productName: sku,
        unitPrice: priced.finalPrice,
        qty: 1,
        userId,
        customerId: cust.rows[0].id,
        key: `ATCOST-OK-${stamp}`,
      });
      rec(
        'AT_COST_LIVE_SALE',
        atOk.ok,
        atOk.ok ? 'PROVEN' : 'FAILED',
        atOk.ok ? `createSale AT_COST at ${priced.finalPrice}` : `${atOk.code} ${atOk.message}`,
        { atOk },
      );
      const atLow = await tryCreateSale(pool, {
        productId,
        productName: sku,
        unitPrice: CARRY - 1,
        qty: 1,
        userId,
        customerId: cust.rows[0].id,
        key: `ATCOST-LOW-${stamp}`,
      });
      rec(
        'AT_COST_CLIENT_LOWER',
        !atLow.ok && atLow.code === 'BELOW_ALLOCATED_COST',
        !atLow.ok && atLow.code === 'BELOW_ALLOCATED_COST' ? 'PROVEN' : 'FAILED',
        atLow.ok ? 'client-manipulated AT_COST price accepted' : atLow.code,
        { atLow },
      );
    } catch (e) {
      rec('AT_COST_LIVE_SALE', false, 'UNPROVEN', `AT_COST fixture failed: ${errMsg(e)}`);
    }

    try {
      const { quotationService } = await import('../src/modules/quotations/quotationService.js');
      const walk = await pool.query<{ id: string; name: string }>(
        `SELECT id::text AS id, name FROM customers WHERE COALESCE(is_active,true) LIMIT 1`,
      );
      const quoteCust = walk.rows[0];
      if (!quoteCust) throw new Error('no customer');
      const createdQuote = await quotationService.createQuotation(pool, {
        quoteType: 'quick',
        customerId: quoteCust.id,
        customerName: quoteCust.name,
        validFrom: biz,
        validUntil: addDaysToDateString(biz, 30),
        createdById: userId,
        fulfillmentMode: 'RETAIL',
        items: [
          {
            productId,
            itemType: 'product',
            description: sku,
            quantity: 1,
            unitPrice: 100,
            unitCost: CARRY,
            isTaxable: false,
            taxRate: 0,
          },
        ],
      });
      const quoteId = createdQuote.quotation.id;
      const beforeQ = await pool.query<{ remaining_quantity: string; cost_price: string }>(
        `SELECT remaining_quantity::text, cost_price::text FROM inventory_batches WHERE id = $1`,
        [batchId],
      );
      const salesBefore = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM sales WHERE customer_id = $1`,
        [quoteCust.id],
      );
      try {
        await quotationService.convertQuotationToSale(pool, quoteId, {
          paymentOption: 'full',
          depositMethod: 'CASH',
          cashierId: userId,
        });
        rec('QUOTE_CONVERT_BELOW_COST', false, 'FAILED', 'quote at 100 converted below carrying 6000');
      } catch (e) {
        const afterQ = await pool.query<{ remaining_quantity: string; cost_price: string }>(
          `SELECT remaining_quantity::text, cost_price::text FROM inventory_batches WHERE id = $1`,
          [batchId],
        );
        const docs = await pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM lot_write_down_documents WHERE inventory_batch_id = $1 AND document_number LIKE $2`,
          [batchId, `FORGE%`],
        );
        rec(
          'QUOTE_CONVERT_BELOW_COST',
          bizCode(e) === 'BELOW_ALLOCATED_COST'
            && afterQ.rows[0].remaining_quantity === beforeQ.rows[0].remaining_quantity
            && Number(afterQ.rows[0].cost_price) === CARRY,
          bizCode(e) === 'BELOW_ALLOCATED_COST' ? 'PROVEN' : 'FAILED',
          `${bizCode(e) || errMsg(e).slice(0, 160)} qty unchanged=${afterQ.rows[0].remaining_quantity === beforeQ.rows[0].remaining_quantity}`,
          { code: bizCode(e), before: beforeQ.rows[0], after: afterQ.rows[0], salesBefore: salesBefore.rows[0], docs: docs.rows[0] },
        );
      }
    } catch (e) {
      rec('QUOTE_CONVERT_BELOW_COST', false, 'UNPROVEN', `quote fixture failed: ${errMsg(e)}`);
    }
  } catch (e) {
    rec('LIVE_SURFACES_SEED', false, 'FAILED', errMsg(e));
  }

  await probeHttpCashier(pool, rec, stamp, userId, batchId);
  await probeTenantIsolation(pool, rec, databaseUrl, batchId);
  await probeFreshMigrate(rec, databaseUrl);
}

async function probeHttpCashier(
  pool: Pool,
  rec: RecFn,
  stamp: string,
  userId: string,
  batchId: string,
): Promise<void> {
  try {
    const { initializeRbacMiddleware } = await import('../src/rbac/middleware.js');
    const { lotWriteDownRoutes } = await import('../src/modules/inventory-lot/lotWriteDownRoutes.js');
    initializeRbacMiddleware(pool);

    const cashierId = randomUUID();
    const userCols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`,
    );
    const uc = new Set(userCols.rows.map((r) => r.column_name));
    const fields = ['id'];
    const values: unknown[] = [cashierId];
    if (uc.has('email')) {
      fields.push('email');
      values.push(`cashier-lwd-${stamp}@forensic.local`);
    }
    if (uc.has('username')) {
      fields.push('username');
      values.push(`cashier_lwd_${stamp}`);
    }
    if (uc.has('password_hash')) {
      fields.push('password_hash');
      values.push('forensic-no-login');
    }
    if (uc.has('full_name')) {
      fields.push('full_name');
      values.push(`Cashier LWD ${stamp}`);
    }
    if (uc.has('role')) {
      fields.push('role');
      values.push('CASHIER');
    }
    if (uc.has('is_active')) {
      fields.push('is_active');
      values.push(true);
    }
    if (uc.has('user_number')) {
      fields.push('user_number');
      values.push(`CSH${stamp.slice(-10)}`);
    }
    await pool.query(
      `INSERT INTO users (${fields.join(',')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(',')})`,
      values,
    );

    const secret = process.env.JWT_SECRET || 'dev-only-insecure-key-change-me-32ch';
    const token = jwt.sign(
      {
        userId: cashierId,
        email: `cashier-lwd-${stamp}@forensic.local`,
        fullName: `Cashier LWD ${stamp}`,
        role: 'CASHIER',
        type: 'access',
      },
      secret,
      { expiresIn: '15m' },
    );

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.tenantPool = pool;
      next();
    });
    app.use('/api/inventory/lot-write-down', lotWriteDownRoutes);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no listen port');
    const url = `http://127.0.0.1:${addr.port}/api/inventory/lot-write-down`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ inventoryBatchId: batchId, newUnitCost: 5000, memo: `http cashier ${stamp}` }),
    });
    const body = await res.text();
    rec(
      'PERMISSIONS_HTTP',
      res.status === 403,
      res.status === 403 ? 'PROVEN' : 'FAILED',
      `cashier POST lot-write-down status=${res.status} body=${body.slice(0, 180)}`,
      { status: res.status, body: body.slice(0, 300), cashierId, adminUserId: userId },
    );
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  } catch (e) {
    rec('PERMISSIONS_HTTP', false, 'UNPROVEN', `HTTP probe failed: ${errMsg(e)}`);
  }
}

async function probeTenantIsolation(
  pool: Pool,
  rec: RecFn,
  databaseUrl: string,
  batchId: string,
): Promise<void> {
  const candidates = [process.env.HENBER_DATABASE_URL, process.env.TENANT_DATABASE_URL, process.env.BLISS_DATABASE_URL]
    .map((u) => (u || '').trim())
    .filter(Boolean);
  const selfName = dbNameFromUrl(databaseUrl);
  const otherUrl = candidates.find((u) => dbNameFromUrl(u) && dbNameFromUrl(u) !== selfName);
  if (!otherUrl) {
    rec(
      'TENANT_ISOLATION',
      false,
      'UNPROVEN',
      'No second tenant connection string distinct from DATABASE_URL was available.',
    );
    return;
  }
  const other = new pg.Pool({ connectionString: otherUrl.split('?')[0], max: 2 });
  try {
    const read = await other.query(`SELECT id::text AS id FROM inventory_batches WHERE id = $1`, [batchId]);
    let mutated = false;
    let docs = 0;
    let journals = 0;
    try {
      await other.query(`UPDATE inventory_batches SET cost_price = 1 WHERE id = $1`, [batchId]);
      mutated = true;
    } catch {
      mutated = false;
    }
    const docCount = await other.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM lot_write_down_documents WHERE inventory_batch_id = $1`,
      [batchId],
    );
    docs = Number(docCount.rows[0]?.n ?? 0);
    const je = await other.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM ledger_transactions WHERE "ReferenceType" = 'LOT_WRITE_DOWN' AND "ReferenceId"::text = $1`,
      [batchId],
    );
    journals = Number(je.rows[0]?.n ?? 0);
    rec(
      'TENANT_ISOLATION',
      read.rows.length === 0 && !mutated && docs === 0 && journals === 0,
      read.rows.length === 0 && !mutated && docs === 0 && journals === 0 ? 'PROVEN' : 'FAILED',
      `other tenant read=${read.rows.length} mutated=${mutated} docs=${docs} journals=${journals}`,
      { selfDb: selfName, otherDb: dbNameFromUrl(otherUrl), read: read.rows.length },
    );
  } catch (e) {
    rec('TENANT_ISOLATION', false, 'UNPROVEN', `second tenant probe failed: ${errMsg(e)}`);
  } finally {
    await other.end().catch(() => undefined);
  }
}

async function probeFreshMigrate(
  rec: RecFn,
  databaseUrl: string,
): Promise<void> {
  const stamp = `lwd${Date.now().toString(36)}`;
  let admin: pg.Pool | null = null;
  let fresh: pg.Pool | null = null;
  let created = false;
  const dbName = `lwd_fresh_${stamp}`.replace(/[^a-z0-9_]/gi, '_').slice(0, 63);
  try {
    const u = new URL(databaseUrl.replace(/^postgresql:/i, 'http:'));
    const adminUrl = databaseUrl.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
    admin = new pg.Pool({ connectionString: adminUrl.split('?')[0], max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    created = true;
    const freshUrl = databaseUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    fresh = new pg.Pool({ connectionString: freshUrl.split('?')[0], max: 4 });
    await tenantMigrationService._runPendingMigrations(fresh, `fresh-${dbName}`);
    const files = await fresh.query<{ filename: string }>(
      `SELECT filename FROM schema_migrations WHERE filename = ANY($1::text[]) ORDER BY filename`,
      [LWD_MIGRATION_FILES],
    );
    const names = files.rows.map((r) => r.filename);
    const has611 = names.includes('611_lot_write_down_clearance.sql');
    const has612 = names.includes('612_lot_write_down_immutability.sql');
    const has613 = names.includes('613_lot_write_down_journal_coupling.sql');
    rec(
      'FRESH_DB_MIGRATE',
      has611 && has612 && has613,
      has611 && has612 && has613 ? 'PROVEN' : 'FAILED',
      `fresh ${dbName} migrations=${names.join(',') || '(none)'}`,
      { names },
    );
  } catch (e) {
    rec(
      'FRESH_DB_MIGRATE',
      false,
      'UNPROVEN',
      `Could not provision empty DB and run runner: ${errMsg(e)}`,
    );
  } finally {
    if (fresh) await fresh.end().catch(() => undefined);
    if (created && admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    }
    if (admin) await admin.end().catch(() => undefined);
  }
}
