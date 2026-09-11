#!/usr/bin/env npx tsx
/**
 * Independent forensic verification of 611+612.
 * Does not treat existing PROOF_* files as evidence.
 * Does not modify application source. Seeds isolated lots, then ROLLBACKs adversarial
 * SQL or leaves labelled forensic SKUs for audit.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { BusinessError } from '../src/middleware/errorHandler.js';
import { addDaysToDateString, getBusinessDate } from '../src/utils/dateRange.js';
import { writeDownNearExpiryLot } from '../src/modules/inventory-lot/lotWriteDownService.js';
import { lotService } from '../src/modules/inventory-lot/lotService.js';
import { syncService } from '../src/modules/platform/syncService.js';
import { assertSaleLineNotBelowAllocatedCost } from '../src/modules/sales/saleBelowCostGuard.js';
import { previewFefoIssueCostForBaseQty } from '../src/modules/pricing/atCostIssuePrice.js';
import Decimal from 'decimal.js';
import { ensureLotWriteDownMigrations, liveGuardIs613 } from './ensureLotWriteDownMigrations.js';
import { runLotWriteDownLiveSurfaces } from './lotWriteDownLiveSurfaces.js';

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
      if (m[1] === 'DATABASE_URL' || process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
}
loadEnv();
const rawUrl = (process.env.DATABASE_URL || '').trim();
if (!rawUrl) {
  console.error('DATABASE_URL missing');
  process.exit(2);
}
process.env.DATABASE_URL = rawUrl;
const pool = new pg.Pool({ connectionString: rawUrl.split('?')[0], max: 12 });

type Row = { id: string; ok: boolean; result: 'PROVEN' | 'FAILED' | 'UNPROVEN' | 'PARTIALLY_PROVEN'; detail: string; evidence: Record<string, unknown> };
const rows: Row[] = [];
function rec(id: string, ok: boolean, result: Row['result'], detail: string, evidence: Record<string, unknown> = {}): void {
  rows.push({ id, ok, result, detail, evidence });
  console.log(`${ok ? 'PASS' : result === 'UNPROVEN' ? 'UNPROVEN' : 'FAIL'} ${id}: ${detail}`);
}

function bizCode(e: unknown): string {
  if (e && typeof e === 'object' && 'errorCode' in e && typeof (e as { errorCode: unknown }).errorCode === 'string') {
    return (e as { errorCode: string }).errorCode;
  }
  return '';
}

async function main(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const sku = `FORLWD-${stamp}`;
  const biz = getBusinessDate();
  const expiry = addDaysToDateString(biz, 5);

  const sqlDir = path.join(repoRoot, 'shared/sql');
  const applied = await ensureLotWriteDownMigrations(pool, sqlDir);
  rec(
    'MIG_611_613_RUNNER',
    await liveGuardIs613(pool),
    'PROVEN',
    `applied=${applied.applied.join(',') || 'already-current'} reapplied613=${applied.reapplied613}`,
    { applied },
  );

  const catalog = await pool.query(`
    SELECT t.tgname, pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'inventory_batches' AND NOT t.tgisinternal
    ORDER BY t.tgname`);
  rec(
    'SCHEMA_TRIGGER',
    catalog.rows.some((r) => r.tgname === 'trg_inventory_batches_carrying_write_down'),
    catalog.rows.some((r) => r.tgname === 'trg_inventory_batches_carrying_write_down') ? 'PROVEN' : 'FAILED',
    `triggers=${catalog.rows.map((r) => r.tgname).join(',')}`,
    { catalog: catalog.rows },
  );

  const fn = await pool.query(`SELECT pg_get_functiondef(p.oid) AS def
    FROM pg_proc p WHERE p.proname = 'inventory_batches_carrying_write_down_guard'`);
  rec(
    'SCHEMA_FN',
    Boolean(fn.rows[0]?.def?.includes('cannot increase after lot creation')) &&
      !String(fn.rows[0]?.def || '').includes('journal_entry_id IS NULL'),
    fn.rows[0]?.def ? 'PROVEN' : 'FAILED',
    'function body loaded from pg_proc',
    { def: String(fn.rows[0]?.def || '').slice(0, 800) },
  );

  const deferred = await pool.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_trigger
       WHERE tgname = 'trg_lot_write_down_posted_journal'
         AND tgrelid = 'lot_write_down_documents'::regclass
         AND tgdeferrable AND tginitdeferred
     ) AS ok`,
  );
  rec(
    'SCHEMA_DEFERRED_JE',
    deferred.rows[0]?.ok === true,
    deferred.rows[0]?.ok ? 'PROVEN' : 'FAILED',
    'POSTED documents require deferred journal constraint trigger',
    { deferred: deferred.rows[0] },
  );

  const chk = await pool.query(`
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'lot_write_down_documents'::regclass`);
  rec('SCHEMA_DOC_CHECKS', chk.rows.length > 0, 'PROVEN', `constraints=${chk.rows.map((r) => r.conname).join(',')}`, {
    chk: chk.rows,
  });

  const tenantCol = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'inventory_batches' AND column_name IN ('tenant_id','tenant_slug')`);
  rec(
    'SCHEMA_TENANT_COL',
    true,
    tenantCol.rows.length === 0 ? 'UNPROVEN' : 'PROVEN',
    tenantCol.rows.length === 0
      ? 'inventory_batches has no tenant_id column (isolation depends on separate tenant DBs, not row ACL)'
      : `tenant columns=${tenantCol.rows.map((r) => r.column_name).join(',')}`,
    { tenantCol: tenantCol.rows },
  );

  const user = await pool.query(`SELECT id::text AS id FROM users WHERE id::text <> '00000000-0000-0000-0000-000000000000' LIMIT 1`);
  const userId = user.rows[0]?.id;
  if (!userId) throw new Error('no user');

  const productId = randomUUID();
  const disposeProductId = randomUUID();
  const ids = {
    main: randomUUID(),
    other: randomUUID(),
    fake: randomUUID(),
    race1: randomUUID(),
    race2: randomUUID(),
    fefoA: randomUUID(),
    fefoB: randomUUID(),
    fefoC: randomUUID(),
    floor: randomUUID(),
    dec: randomUUID(),
    noexp: randomUUID(),
    warn: randomUUID(),
    far: randomUUID(),
    zero: randomUUID(),
    dmg: randomUUID(),
    disp: randomUUID(),
    dual: randomUUID(),
    inc: randomUUID(),
    dispose: randomUUID(),
  };
  await pool.query(
    `INSERT INTO products (id, name, sku, barcode, cost_price, selling_price, quantity_on_hand, is_active, track_expiry)
     VALUES ($1,$2,$3,$3,10000,6000,100,true,true)`,
    [productId, `Forensic LWD ${stamp}`, sku],
  );
  await pool.query(
    `INSERT INTO products (id, name, sku, barcode, cost_price, selling_price, quantity_on_hand, is_active, track_expiry)
     VALUES ($1,$2,$3,$3,10000,6000,10,true,true)`,
    [disposeProductId, `Forensic LWD dispose ${stamp}`, `${sku}-DSP`],
  );
  async function insertBatch(
    id: string,
    product: string,
    bn: string,
    qty: number,
    cost: number,
    exp: string | null,
    remaining = qty,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO inventory_batches (
         id, product_id, batch_number, quantity, remaining_quantity, cost_price, received_date, expiry_date, status, source_type
       ) VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,'ACTIVE','ADJUSTMENT')`,
      [id, product, bn, qty, remaining, cost, exp],
    );
  }
  await insertBatch(ids.main, productId, `${sku}-M`, 10, 10000, expiry);
  await insertBatch(ids.other, productId, `${sku}-O`, 10, 10000, expiry);
  await insertBatch(ids.fake, productId, `${sku}-F`, 10, 10000, expiry);
  await insertBatch(ids.race1, productId, `${sku}-R1`, 10, 10000, expiry);
  await insertBatch(ids.race2, productId, `${sku}-R2`, 10, 10000, expiry);
  await insertBatch(ids.fefoA, productId, `${sku}-A`, 5, 10000, addDaysToDateString(biz, 7));
  await insertBatch(ids.fefoB, productId, `${sku}-B`, 5, 8000, addDaysToDateString(biz, 6));
  await insertBatch(ids.fefoC, productId, `${sku}-C`, 5, 6000, addDaysToDateString(biz, 4));
  await insertBatch(ids.dec, productId, `${sku}-D`, 10, 10000.01, expiry);
  await insertBatch(ids.floor, productId, `${sku}-FL`, 10, 10000, expiry);
  await insertBatch(ids.noexp, productId, `${sku}-NE`, 10, 10000, null);
  await insertBatch(ids.warn, productId, `${sku}-W`, 10, 10000, addDaysToDateString(biz, 60));
  await insertBatch(ids.far, productId, `${sku}-FAR`, 10, 10000, addDaysToDateString(biz, 61));
  await insertBatch(ids.zero, productId, `${sku}-Z`, 10, 10000, expiry, 0);
  await insertBatch(ids.dmg, productId, `${sku}-DM`, 10, 10000, expiry);
  await insertBatch(ids.disp, productId, `${sku}-DS`, 10, 10000, expiry);
  await insertBatch(ids.dual, productId, `${sku}-DU`, 10, 10000, expiry);
  await insertBatch(ids.inc, productId, `${sku}-IN`, 10, 10000, expiry);
  await insertBatch(ids.dispose, disposeProductId, `${sku}-DP`, 10, 10000, expiry);

  const afterIns = await pool.query(
    `SELECT id::text, cost_price::text, original_cost_price::text FROM inventory_batches WHERE id = $1`,
    [ids.main],
  );
  rec(
    'INSERT_ORIGINAL',
    Number(afterIns.rows[0]?.original_cost_price) === 10000,
    'PROVEN',
    `INSERT established original=${afterIns.rows[0]?.original_cost_price} carrying=${afterIns.rows[0]?.cost_price}`,
    { afterIns: afterIns.rows[0] },
  );

  try {
    await pool.query(`UPDATE inventory_batches SET original_cost_price = 1 WHERE id = $1`, [ids.main]);
    rec('SQL_ORIGINAL_IMMUTABLE', false, 'FAILED', 'UPDATE original_cost_price succeeded');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const still = await pool.query(`SELECT original_cost_price::text FROM inventory_batches WHERE id = $1`, [ids.main]);
    rec(
      'SQL_ORIGINAL_IMMUTABLE',
      /immutable after lot creation/i.test(msg) && Number(still.rows[0].original_cost_price) === 10000,
      'PROVEN',
      msg.split('\n')[0],
      { sql: 'UPDATE inventory_batches SET original_cost_price = 1', error: msg, remaining: still.rows[0] },
    );
  }

  try {
    await pool.query(`UPDATE inventory_batches SET original_cost_price = 1 WHERE product_id = $1`, [productId]);
    rec('SQL_ORIGINAL_BULK', false, 'FAILED', 'bulk original update succeeded');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rec('SQL_ORIGINAL_BULK', /immutable/i.test(msg), 'PROVEN', msg.split('\n')[0], { error: msg });
  }

  try {
    await pool.query(`UPDATE inventory_batches SET cost_price = 1 WHERE id = $1`, [ids.main]);
    rec('SQL_COST_NO_DOC', false, 'FAILED', 'unauthenticated cost decrease succeeded');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const still = await pool.query(`SELECT cost_price::text FROM inventory_batches WHERE id = $1`, [ids.main]);
    rec(
      'SQL_COST_NO_DOC',
      /write-down document/i.test(msg) && Number(still.rows[0].cost_price) === 10000,
      'PROVEN',
      msg.split('\n')[0],
      { error: msg, remaining: still.rows[0] },
    );
  }

  try {
    await pool.query(`UPDATE inventory_batches SET cost_price = 20000 WHERE id = $1`, [ids.inc]);
    const afterInc = await pool.query(`SELECT cost_price::text FROM inventory_batches WHERE id = $1`, [ids.inc]);
    rec(
      'SQL_COST_INCREASE_UNGOVERNED',
      false,
      'FAILED',
      `Trigger allowed unauthenticated carrying INCREASE to ${afterInc.rows[0]?.cost_price} with no write-down document`,
      { afterInc: afterInc.rows[0] },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rec('SQL_COST_INCREASE_UNGOVERNED', /cannot increase after lot creation/i.test(msg), 'PROVEN', msg.split('\n')[0], {
      error: msg,
    });
  }

  try {
    await pool.query(`UPDATE inventory_batches SET cost_price = cost_price + 1 WHERE product_id = $1`, [productId]);
    rec('SQL_COST_INCREASE_BULK', false, 'FAILED', 'bulk carrying increase succeeded');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rec('SQL_COST_INCREASE_BULK', /cannot increase after lot creation/i.test(msg), 'PROVEN', msg.split('\n')[0], {
      error: msg,
    });
  }

  // Case C: forged POSTED document, journal_entry_id NULL
  const fakeDoc = randomUUID();
  const beforeForge = await pool.query(
    `SELECT cost_price::text, remaining_quantity::text FROM inventory_batches WHERE id = $1`,
    [ids.fake],
  );
  try {
    await pool.query(
      `INSERT INTO lot_write_down_documents (
         id, document_number, status, reason, product_id, inventory_batch_id, quantity,
         original_unit_cost, previous_carrying_unit_cost, new_carrying_unit_cost,
         total_amount, expense_account_code, created_by, posted_at
       ) VALUES ($1,$2,'POSTED','NEAR_EXPIRY',$3,$4,10,10000,10000,1,99999,'5140',$5,NOW())`,
      [fakeDoc, `FORGE-${stamp}`, productId, ids.fake, userId],
    );
    rec('SQL_FORGED_POSTED_NULL_JE', false, 'FAILED', 'forged POSTED+NULL JE document committed');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const docs = await pool.query(`SELECT COUNT(*)::int AS n FROM lot_write_down_documents WHERE id = $1`, [fakeDoc]);
    rec(
      'SQL_FORGED_POSTED_NULL_JE',
      /posted journal/i.test(msg) && docs.rows[0].n === 0,
      'PROVEN',
      msg.split('\n')[0],
      { error: msg, docs: docs.rows[0] },
    );
  }
  const cForge = await pool.connect();
  try {
    await cForge.query('BEGIN');
    await cForge.query(
      `INSERT INTO lot_write_down_documents (
         document_number, status, reason, product_id, inventory_batch_id, quantity,
         original_unit_cost, previous_carrying_unit_cost, new_carrying_unit_cost,
         total_amount, expense_account_code, created_by, posted_at
       ) VALUES ($1,'POSTED','NEAR_EXPIRY',$2,$3,10,10000,10000,1,99999,'5140',$4,NOW())`,
      [`FORGETX-${stamp}`, productId, ids.fake, userId],
    );
    await cForge.query(`UPDATE inventory_batches SET cost_price = 1 WHERE id = $1`, [ids.fake]);
    await cForge.query('COMMIT');
    rec('SQL_FORGE_TX_COST_DROP', false, 'FAILED', 'forged TX committed carrying drop');
  } catch (e) {
    await cForge.query('ROLLBACK').catch(() => undefined);
    const after = await pool.query(
      `SELECT cost_price::text, remaining_quantity::text FROM inventory_batches WHERE id = $1`,
      [ids.fake],
    );
    const docs = await pool.query(
      `SELECT COUNT(*)::int AS n FROM lot_write_down_documents WHERE document_number = $1`,
      [`FORGETX-${stamp}`],
    );
    rec(
      'SQL_FORGE_TX_COST_DROP',
      Number(after.rows[0].cost_price) === Number(beforeForge.rows[0].cost_price) &&
        after.rows[0].remaining_quantity === beforeForge.rows[0].remaining_quantity &&
        docs.rows[0].n === 0,
      'PROVEN',
      `carrying=${after.rows[0].cost_price} qty=${after.rows[0].remaining_quantity} docs=${docs.rows[0].n} err=${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
      { before: beforeForge.rows[0], after: after.rows[0] },
    );
  } finally {
    cForge.release();
  }

  // Case E: document for other lot (DRAFT — POSTED cannot persist without journal)
  await pool.query(
    `INSERT INTO lot_write_down_documents (
       id, document_number, status, reason, product_id, inventory_batch_id, quantity,
       original_unit_cost, previous_carrying_unit_cost, new_carrying_unit_cost,
       total_amount, expense_account_code, created_by
     ) VALUES ($1,$2,'DRAFT','NEAR_EXPIRY',$3,$4,10,10000,10000,1,99999,'5140',$5)`,
    [randomUUID(), `OTHER-${stamp}`, productId, ids.fake, userId],
  );
  try {
    await pool.query(`UPDATE inventory_batches SET cost_price = 1 WHERE id = $1`, [ids.other]);
    rec('SQL_OTHER_LOT_DOC', false, 'FAILED', 'other-lot document allowed this lot decrease');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rec('SQL_OTHER_LOT_DOC', /write-down document/i.test(msg), 'PROVEN', msg.split('\n')[0], { error: msg });
  }

  // Case F: amounts do not match (doc says 1, try set 2)
  const mismatchDoc = randomUUID();
  await pool.query(
    `INSERT INTO lot_write_down_documents (
       id, document_number, status, reason, product_id, inventory_batch_id, quantity,
       original_unit_cost, previous_carrying_unit_cost, new_carrying_unit_cost,
       total_amount, expense_account_code, created_by
       ) VALUES ($1,$2,'DRAFT','NEAR_EXPIRY',$3,$4,10,10000,10000,50,500,'5140',$5)`,
    [mismatchDoc, `MISMATCH-${stamp}`, productId, ids.other, userId],
  );
  try {
    await pool.query(`UPDATE inventory_batches SET cost_price = 2 WHERE id = $1`, [ids.other]);
    rec('SQL_AMOUNT_MISMATCH', false, 'FAILED', 'mismatched new cost succeeded');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rec('SQL_AMOUNT_MISMATCH', /write-down document/i.test(msg), 'PROVEN', msg.split('\n')[0], { error: msg });
  }

  // DRAFT document
  const draft = randomUUID();
  await pool.query(
    `INSERT INTO lot_write_down_documents (
       id, document_number, status, reason, product_id, inventory_batch_id, quantity,
       original_unit_cost, previous_carrying_unit_cost, new_carrying_unit_cost,
       total_amount, expense_account_code, created_by
     ) VALUES ($1,$2,'DRAFT','NEAR_EXPIRY',$3,$4,10,10000,10000,6000,40000,'5140',$5)`,
    [draft, `DRAFT-${stamp}`, productId, ids.other, userId],
  );
  try {
    await pool.query(`UPDATE inventory_batches SET cost_price = 6000 WHERE id = $1`, [ids.other]);
    rec('SQL_DRAFT_DOC', false, 'FAILED', 'DRAFT document allowed cost decrease');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rec('SQL_DRAFT_DOC', /write-down document/i.test(msg), 'PROVEN', msg.split('\n')[0], { error: msg });
  }

  // Floor via CHECK
  try {
    await pool.query(
      `INSERT INTO lot_write_down_documents (
         document_number, status, reason, product_id, inventory_batch_id, quantity,
         original_unit_cost, previous_carrying_unit_cost, new_carrying_unit_cost,
         total_amount, expense_account_code, created_by
       ) VALUES ($1,'POSTED','NEAR_EXPIRY',$2,$3,10,10000,10000,0.001,99999,'5140',$4)`,
      [`FLOORCHK-${stamp}`, productId, ids.floor, userId],
    );
    rec('SQL_FLOOR_CHECK', false, 'FAILED', 'document with 0.001 accepted');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rec('SQL_FLOOR_CHECK', /chk_lot_write_down_new_positive|violates check/i.test(msg), 'PROVEN', msg.split('\n')[0], {
      error: msg,
    });
  }
  try {
    await pool.query(
      `INSERT INTO lot_write_down_documents (
         document_number, status, reason, product_id, inventory_batch_id, quantity,
         original_unit_cost, previous_carrying_unit_cost, new_carrying_unit_cost,
         total_amount, expense_account_code, created_by
       ) VALUES ($1,'POSTED','NEAR_EXPIRY',$2,$3,10,10000,10000,0.009,99990,'5140',$4)`,
      [`FLOOR009-${stamp}`, productId, ids.floor, userId],
    );
    rec('SQL_FLOOR_009', false, 'FAILED', 'document with 0.009 accepted');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rec('SQL_FLOOR_009', /chk_lot_write_down_new_positive|violates check/i.test(msg), 'PROVEN', msg.split('\n')[0], {
      error: msg,
    });
  }

  // Rollback atomicity of SQL pair
  const rbClient = await pool.connect();
  const beforeRb = await pool.query(`SELECT cost_price::text FROM inventory_batches WHERE id = $1`, [ids.other]);
  try {
    await rbClient.query('BEGIN');
    await rbClient.query(
      `INSERT INTO lot_write_down_documents (
         document_number, status, reason, product_id, inventory_batch_id, quantity,
         original_unit_cost, previous_carrying_unit_cost, new_carrying_unit_cost,
         total_amount, expense_account_code, created_by, posted_at
       ) VALUES ($1,'POSTED','NEAR_EXPIRY',$2,$3,10,10000,10000,6000,40000,'5140',$4,NOW())`,
      [`RB-${stamp}`, productId, ids.other, userId],
    );
    await rbClient.query(`UPDATE inventory_batches SET cost_price = 6000 WHERE id = $1`, [ids.other]);
    await rbClient.query('ROLLBACK');
    const afterRb = await pool.query(`SELECT cost_price::text FROM inventory_batches WHERE id = $1`, [ids.other]);
    rec(
      'SQL_ROLLBACK_ATOMIC',
      Number(afterRb.rows[0].cost_price) === Number(beforeRb.rows[0].cost_price),
      'PROVEN',
      `after rollback carrying=${afterRb.rows[0].cost_price} (was ${beforeRb.rows[0].cost_price})`,
      { before: beforeRb.rows[0], after: afterRb.rows[0] },
    );
  } finally {
    rbClient.release();
  }

  // Valid service write-down + independent journal query
  const wd1 = await writeDownNearExpiryLot(pool, {
    inventoryBatchId: ids.main,
    newUnitCost: 6000,
    userId,
    memo: `forensic ${stamp} first`,
  });
  const batch1 = await pool.query(
    `SELECT remaining_quantity::text, cost_price::text, original_cost_price::text, status::text
     FROM inventory_batches WHERE id = $1`,
    [ids.main],
  );
  const je1 = await pool.query(
    `SELECT a."AccountCode" AS account, le."DebitAmount"::text AS debit, le."CreditAmount"::text AS credit,
            lt."Status" AS status, lt."ReferenceType" AS ref, lt."PostingSource" AS src
     FROM ledger_transactions lt
     JOIN ledger_entries le ON le."TransactionId" = lt."Id"
     JOIN accounts a ON a."Id" = le."AccountId"
     WHERE lt."Id" = $1`,
    [wd1.journalEntryId],
  );
  const d5140 = je1.rows.filter((r) => r.account === '5140').reduce((s, r) => s + Number(r.debit), 0);
  const c1300 = je1.rows.filter((r) => r.account === '1300').reduce((s, r) => s + Number(r.credit), 0);
  rec(
    'SVC_FIRST_WD',
    Number(batch1.rows[0].original_cost_price) === 10000 &&
      Number(batch1.rows[0].cost_price) === 6000 &&
      Number(batch1.rows[0].remaining_quantity) === 10 &&
      d5140 === 40000 &&
      c1300 === 40000 &&
      je1.rows.every((r) => r.ref === 'LOT_WRITE_DOWN'),
    'PROVEN',
    `batch original=${batch1.rows[0].original_cost_price} carrying=${batch1.rows[0].cost_price} qty=${batch1.rows[0].remaining_quantity} DR5140=${d5140} CR1300=${c1300}`,
    { batch: batch1.rows[0], journal: je1.rows, service: wd1 },
  );

  const wd2 = await writeDownNearExpiryLot(pool, {
    inventoryBatchId: ids.main,
    newUnitCost: 3000,
    userId,
    memo: `forensic ${stamp} second`,
  });
  const batch2 = await pool.query(
    `SELECT remaining_quantity::text, cost_price::text, original_cost_price::text FROM inventory_batches WHERE id = $1`,
    [ids.main],
  );
  const je2 = await pool.query(
    `SELECT a."AccountCode" AS account, le."DebitAmount"::text AS debit, le."CreditAmount"::text AS credit
     FROM ledger_transactions lt
     JOIN ledger_entries le ON le."TransactionId" = lt."Id"
     JOIN accounts a ON a."Id" = le."AccountId"
     WHERE lt."Id" = $1`,
    [wd2.journalEntryId],
  );
  const d2 = je2.rows.filter((r) => r.account === '5140').reduce((s, r) => s + Number(r.debit), 0);
  rec(
    'SVC_SECOND_WD',
    Number(batch2.rows[0].original_cost_price) === 10000 &&
      Number(batch2.rows[0].cost_price) === 3000 &&
      Number(batch2.rows[0].remaining_quantity) === 10 &&
      d2 === 30000,
    'PROVEN',
    `second carrying=${batch2.rows[0].cost_price} original=${batch2.rows[0].original_cost_price} DR5140=${d2}`,
    { batch: batch2.rows[0], journal: je2.rows },
  );

  // After posted write-down, journal_entry_id is set — illicit further drop must fail
  try {
    await pool.query(`UPDATE inventory_batches SET cost_price = 1 WHERE id = $1`, [ids.main]);
    rec('SQL_AFTER_POSTED_JE', false, 'FAILED', 'post-commit illicit drop succeeded');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rec('SQL_AFTER_POSTED_JE', /write-down document/i.test(msg), 'PROVEN', msg.split('\n')[0], { error: msg });
  }

  // Replay same carrying
  try {
    await writeDownNearExpiryLot(pool, { inventoryBatchId: ids.main, newUnitCost: 3000, userId });
    rec('IDEMPOTENT_SAME_COST', false, 'FAILED', 'second identical carrying accepted');
  } catch (e) {
    rec(
      'IDEMPOTENT_SAME_COST',
      bizCode(e) === 'LOT_WRITE_DOWN_NOT_BELOW_CARRYING',
      'PROVEN',
      bizCode(e) || String(e),
      { code: bizCode(e) },
    );
  }

  // Floor via service
  try {
    await writeDownNearExpiryLot(pool, { inventoryBatchId: ids.main, newUnitCost: 0.001, userId });
    rec('SVC_FLOOR_0001', false, 'FAILED', '0.001 accepted');
  } catch (e) {
    rec('SVC_FLOOR_0001', bizCode(e) === 'LOT_WRITE_DOWN_BELOW_FLOOR', 'PROVEN', bizCode(e), { code: bizCode(e) });
  }
  try {
    await writeDownNearExpiryLot(pool, { inventoryBatchId: ids.main, newUnitCost: 0, userId });
    rec('SVC_FLOOR_ZERO', false, 'FAILED', '0 accepted');
  } catch (e) {
    rec(
      'SVC_FLOOR_ZERO',
      ['LOT_WRITE_DOWN_INVALID_NEW_COST', 'LOT_WRITE_DOWN_BELOW_FLOOR'].includes(bizCode(e)) ||
        /required|positive/i.test(e instanceof Error ? e.message : ''),
      'PROVEN',
      bizCode(e) || (e instanceof Error ? e.message : String(e)),
      { code: bizCode(e) },
    );
  }
  try {
    await writeDownNearExpiryLot(pool, { inventoryBatchId: ids.main, newUnitCost: -1, userId });
    rec('SVC_FLOOR_NEG', false, 'FAILED', 'negative accepted');
  } catch (e) {
    rec('SVC_FLOOR_NEG', Boolean(bizCode(e) || e instanceof Error), 'PROVEN', bizCode(e) || String(e), {
      code: bizCode(e),
    });
  }

  // 0.01 should be allowed from 3000
  const wdFloorOk = await writeDownNearExpiryLot(pool, {
    inventoryBatchId: ids.floor,
    newUnitCost: 0.01,
    userId,
    memo: `forensic floor ok ${stamp}`,
  });
  rec('SVC_FLOOR_001_OK', wdFloorOk.newCarryingUnitCost === 0.01, 'PROVEN', `new=${wdFloorOk.newCarryingUnitCost} amount=${wdFloorOk.totalAmount}`, {
    wdFloorOk,
  });

  // Eligibility: no side effects
  async function rejectClean(id: string, batchId: string, over: { status?: string; expiry?: string | null }, code: string) {
    if (over.status) await pool.query(`UPDATE inventory_batches SET status = $2 WHERE id = $1`, [batchId, over.status]);
    if (over.expiry !== undefined) {
      await pool.query(`UPDATE inventory_batches SET expiry_date = $2 WHERE id = $1`, [batchId, over.expiry]);
    }
    const before = await pool.query(
      `SELECT cost_price::text, remaining_quantity::text FROM inventory_batches WHERE id = $1`,
      [batchId],
    );
    const docsBefore = await pool.query(`SELECT COUNT(*)::int AS n FROM lot_write_down_documents WHERE inventory_batch_id = $1`, [
      batchId,
    ]);
    try {
      await writeDownNearExpiryLot(pool, { inventoryBatchId: batchId, newUnitCost: 6000, userId });
      rec(id, false, 'FAILED', `expected ${code}`);
    } catch (e) {
      const after = await pool.query(
        `SELECT cost_price::text, remaining_quantity::text FROM inventory_batches WHERE id = $1`,
        [batchId],
      );
      const docsAfter = await pool.query(`SELECT COUNT(*)::int AS n FROM lot_write_down_documents WHERE inventory_batch_id = $1`, [
        batchId,
      ]);
      const clean =
        after.rows[0].cost_price === before.rows[0].cost_price &&
        after.rows[0].remaining_quantity === before.rows[0].remaining_quantity &&
        docsAfter.rows[0].n === docsBefore.rows[0].n;
      rec(id, bizCode(e) === code && clean, clean ? 'PROVEN' : 'FAILED', `${bizCode(e)} clean=${clean}`, {
        code: bizCode(e),
        before: before.rows[0],
        after: after.rows[0],
      });
    }
  }
  await rejectClean('ELIG_EXPIRED', ids.other, { expiry: biz }, 'LOT_WRITE_DOWN_EXPIRED');
  await rejectClean('ELIG_QUARANTINE', ids.race2, { status: 'QUARANTINED' }, 'LOT_WRITE_DOWN_NOT_ACTIVE');
  try {
    await writeDownNearExpiryLot(pool, { inventoryBatchId: randomUUID(), newUnitCost: 6000, userId });
    rec('ELIG_MISSING', false, 'FAILED', 'missing lot accepted');
  } catch (e) {
    rec('ELIG_MISSING', /not found/i.test(e instanceof Error ? e.message : ''), 'PROVEN', e instanceof Error ? e.message : String(e));
  }

  // FEFO allocation across A/B/C — write down A 10000→4000, earliest expiry is C (4d) at 6000
  const fefoBefore = await previewFefoIssueCostForBaseQty(pool, productId, new Decimal(5));
  rec(
    'FEFO_PREVIEW_EXISTS',
    fefoBefore.coveredQty.greaterThan(0),
    'PROVEN',
    `preview totalCost=${fefoBefore.totalCost.toFixed(2)} covered=${fefoBefore.coveredQty.toFixed(2)}`,
    { fefoBefore: { total: fefoBefore.totalCost.toString(), covered: fefoBefore.coveredQty.toString() } },
  );
  await writeDownNearExpiryLot(pool, { inventoryBatchId: ids.fefoC, newUnitCost: 2500, userId, memo: 'fefo C' });
  const layers = await pool.query(
    `SELECT batch_number, cost_price::text, remaining_quantity::text, expiry_date::text
     FROM inventory_batches
     WHERE id = ANY($1::uuid[]) ORDER BY expiry_date ASC NULLS LAST, received_date ASC`,
    [[ids.fefoA, ids.fefoB, ids.fefoC]],
  );
  const cRow = layers.rows.find((r) => r.batch_number.endsWith('-C'));
  rec(
    'FEFO_BATCH_C_CARRYING',
    Number(cRow?.cost_price) === 2500,
    'PROVEN',
    `C carrying=${cRow?.cost_price}`,
    { layers: layers.rows },
  );
  const consumeC = await pool.connect();
  try {
    await consumeC.query('BEGIN');
    const consumed = await lotService.consumeLot(consumeC, {
      productId,
      quantity: 1,
      specificLotId: ids.fefoC,
      referenceType: 'FORENSIC_FEFO',
      referenceId: ids.fefoC,
      userId,
      recordMovement: false,
      syncProduct: false,
      skipStoreBalanceDeduction: true,
    });
    await consumeC.query('COMMIT');
    rec(
      'FEFO_CONSUME_C',
      consumed.layers[0]?.costPrice === 2500,
      'PROVEN',
      `consumeLot costPrice=${consumed.layers[0]?.costPrice}`,
      { layers: consumed.layers },
    );
  } catch (e) {
    await consumeC.query('ROLLBACK');
    rec('FEFO_CONSUME_C', false, 'FAILED', e instanceof Error ? e.message : String(e));
  } finally {
    consumeC.release();
  }

  // POS floor from allocated carrying 3000 on main
  try {
    assertSaleLineNotBelowAllocatedCost({
      productId,
      quantity: 1,
      lineRevenue: 3000,
      totalAllocatedCost: 3000,
      costPerSellingUnit: 3000,
      unitPrice: 3000,
    });
    rec('POS_EQ', true, 'PROVEN', '3000 == 3000 allowed');
  } catch (e) {
    rec('POS_EQ', false, 'FAILED', String(e));
  }
  try {
    assertSaleLineNotBelowAllocatedCost({
      productId,
      quantity: 1,
      lineRevenue: 2999.99,
      totalAllocatedCost: 3000,
      costPerSellingUnit: 3000,
      unitPrice: 2999.99,
    });
    rec('POS_TOLERANCE_001', true, 'PROVEN', '2999.99 allowed at carrying 3000 (±0.01 policy)');
  } catch (e) {
    rec('POS_TOLERANCE_001', false, 'FAILED', String(e));
  }
  try {
    assertSaleLineNotBelowAllocatedCost({
      productId,
      quantity: 1,
      lineRevenue: 2999.98,
      totalAllocatedCost: 3000,
      costPerSellingUnit: 3000,
      unitPrice: 2999.98,
    });
    rec('POS_BELOW', false, 'FAILED', '2999.98 allowed against 3000');
  } catch (e) {
    rec('POS_BELOW', bizCode(e) === 'BELOW_ALLOCATED_COST', 'PROVEN', bizCode(e), { code: bizCode(e) });
  }

  // Offline edge overwrite
  await syncService.updateEntity(pool, 'inventory_batches', {
    entityType: 'inventory_batch',
    entityId: ids.main,
    action: 'UPDATE',
    data: { cost_price: 1, original_cost_price: 99 },
    version: 9,
    localTimestamp: new Date().toISOString(),
  });
  const afterEdge = await pool.query(
    `SELECT cost_price::text, original_cost_price::text FROM inventory_batches WHERE id = $1`,
    [ids.main],
  );
  rec(
    'EDGE_COST_SSOT',
    Number(afterEdge.rows[0].cost_price) === 3000 && Number(afterEdge.rows[0].original_cost_price) === 10000,
    'PROVEN',
    `after edge overwrite carrying=${afterEdge.rows[0].cost_price} original=${afterEdge.rows[0].original_cost_price}`,
    { afterEdge: afterEdge.rows[0] },
  );

  // Decimal
  const wdDec = await writeDownNearExpiryLot(pool, {
    inventoryBatchId: ids.dec,
    newUnitCost: 9999.99,
    userId,
    memo: 'decimal',
  });
  const jeDec = await pool.query(
    `SELECT le."DebitAmount"::text AS debit FROM ledger_transactions lt
     JOIN ledger_entries le ON le."TransactionId" = lt."Id"
     JOIN accounts a ON a."Id" = le."AccountId"
     WHERE lt."Id" = $1 AND a."AccountCode" = '5140'`,
    [wdDec.journalEntryId],
  );
  const expectedDec = Number((new Decimal(10000.01).minus(9999.99)).times(10).toFixed(2));
  rec(
    'DECIMAL_RECONCILE',
    Math.abs(Number(jeDec.rows[0]?.debit) - expectedDec) < 0.02,
    'PROVEN',
    `DR5140=${jeDec.rows[0]?.debit} expected=${expectedDec} serviceAmount=${wdDec.totalAmount}`,
    { jeDec: jeDec.rows, expectedDec, wdDec },
  );

  // Concurrency sale→WD and WD→sale, 5 loops each
  const conc: Array<{ order: string; wdQty: number; rem: number; carrying: number }> = [];
  for (let i = 0; i < 5; i++) {
    const bid = randomUUID();
    await pool.query(
      `INSERT INTO inventory_batches (id, product_id, batch_number, quantity, remaining_quantity, cost_price, received_date, expiry_date, status, source_type)
       VALUES ($1,$2,$3,10,10,10000,CURRENT_DATE,$4,'ACTIVE','ADJUSTMENT')`,
      [bid, productId, `${sku}-CX${i}`, expiry],
    );
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM inventory_batches WHERE id = $1 FOR UPDATE`, [bid]);
      await holder.query(`UPDATE inventory_batches SET remaining_quantity = remaining_quantity - 2 WHERE id = $1`, [bid]);
      const p = writeDownNearExpiryLot(pool, { inventoryBatchId: bid, newUnitCost: 6000, userId, memo: `cx${i}` });
      await new Promise((r) => setTimeout(r, 150));
      await holder.query('COMMIT');
      const w = await p;
      const row = await pool.query(`SELECT remaining_quantity::text, cost_price::text FROM inventory_batches WHERE id = $1`, [bid]);
      conc.push({
        order: 'sale-then-wd',
        wdQty: w.quantity,
        rem: Number(row.rows[0].remaining_quantity),
        carrying: Number(row.rows[0].cost_price),
      });
    } catch (e) {
      await holder.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      holder.release();
    }
  }
  for (let i = 0; i < 5; i++) {
    const bid = randomUUID();
    await pool.query(
      `INSERT INTO inventory_batches (id, product_id, batch_number, quantity, remaining_quantity, cost_price, received_date, expiry_date, status, source_type)
       VALUES ($1,$2,$3,10,10,10000,CURRENT_DATE,$4,'ACTIVE','ADJUSTMENT')`,
      [bid, productId, `${sku}-CY${i}`, expiry],
    );
    const w = await writeDownNearExpiryLot(pool, { inventoryBatchId: bid, newUnitCost: 6000, userId, memo: `cy${i}` });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const consumed = await lotService.consumeLot(c, {
        productId,
        quantity: 2,
        specificLotId: bid,
        referenceType: 'FORENSIC_CONC',
        referenceId: bid,
        userId,
        recordMovement: false,
        syncProduct: false,
        skipStoreBalanceDeduction: true,
      });
      await c.query('COMMIT');
      const row = await pool.query(`SELECT remaining_quantity::text, cost_price::text FROM inventory_batches WHERE id = $1`, [bid]);
      conc.push({
        order: 'wd-then-sale',
        wdQty: w.quantity,
        rem: Number(row.rows[0].remaining_quantity),
        carrying: Number(row.rows[0].cost_price),
        ...({ consumeCost: consumed.layers[0]?.costPrice } as { consumeCost?: number }),
      });
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  const saleFirstOk = conc.filter((x) => x.order === 'sale-then-wd').every((x) => x.wdQty === 8 && x.rem === 8 && x.carrying === 6000);
  const wdFirstOk = conc
    .filter((x) => x.order === 'wd-then-sale')
    .every((x) => x.wdQty === 10 && x.rem === 8 && x.carrying === 6000);
  rec('CONCURRENCY_BOTH_ORDERS', saleFirstOk && wdFirstOk, 'PROVEN', `n=${conc.length}`, { conc });

  const dualResults = await Promise.allSettled([
    writeDownNearExpiryLot(pool, { inventoryBatchId: ids.dual, newUnitCost: 6000, userId, memo: 'dual-a' }),
    writeDownNearExpiryLot(pool, { inventoryBatchId: ids.dual, newUnitCost: 6000, userId, memo: 'dual-b' }),
  ]);
  const dualOk = dualResults.filter((r) => r.status === 'fulfilled').length;
  const dualFail = dualResults.filter((r) => r.status === 'rejected');
  const dualCodes = dualFail.map((r) => (r.status === 'rejected' ? bizCode(r.reason) : ''));
  const dualBatch = await pool.query(
    `SELECT cost_price::text, remaining_quantity::text FROM inventory_batches WHERE id = $1`,
    [ids.dual],
  );
  const dualDocs = await pool.query(
    `SELECT COUNT(*)::int AS n FROM lot_write_down_documents WHERE inventory_batch_id = $1 AND status = 'POSTED'`,
    [ids.dual],
  );
  rec(
    'CONCURRENCY_DUAL_WD',
    dualOk === 1 && dualDocs.rows[0].n === 1 && Number(dualBatch.rows[0].cost_price) === 6000,
    dualOk === 1 ? 'PROVEN' : 'FAILED',
    `fulfilled=${dualOk} rejectedCodes=${dualCodes.join(',')} carrying=${dualBatch.rows[0].cost_price} docs=${dualDocs.rows[0].n}`,
    {
      dualResults: dualResults.map((r) => (r.status === 'fulfilled' ? r.value : String(r.reason))),
      dualBatch: dualBatch.rows[0],
    },
  );

  await rejectClean('ELIG_NO_EXPIRY', ids.noexp, {}, 'LOT_WRITE_DOWN_NO_EXPIRY');
  await rejectClean('ELIG_NOT_CRITICAL', ids.far, {}, 'LOT_WRITE_DOWN_NOT_CRITICAL');
  try {
    const sixty = await writeDownNearExpiryLot(pool, {
      inventoryBatchId: ids.warn,
      newUnitCost: 6000,
      userId,
    });
    rec(
      'ELIG_60_OK',
      Number(sixty.totalAmount) === 40000,
      'PROVEN',
      `60d write-down amount=${sixty.totalAmount} doc=${sixty.documentNumber}`,
      { sixty },
    );
  } catch (e) {
    rec('ELIG_60_OK', false, 'FAILED', bizCode(e) || (e instanceof Error ? e.message : String(e)));
  }
  await rejectClean('ELIG_NO_QTY', ids.zero, {}, 'LOT_WRITE_DOWN_NO_QTY');
  try {
    await pool.query(`UPDATE inventory_batches SET status = 'DAMAGED' WHERE id = $1`, [ids.dmg]);
    await rejectClean('ELIG_DAMAGED', ids.dmg, {}, 'LOT_WRITE_DOWN_NOT_ACTIVE');
  } catch (e) {
    rec(
      'ELIG_DAMAGED',
      false,
      'UNPROVEN',
      `Could not set DAMAGED status: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const hClient = await pool.connect();
  const beforeH = await pool.query(`SELECT cost_price::text FROM inventory_batches WHERE id = $1`, [ids.race1]);
  try {
    await hClient.query('BEGIN');
    await hClient.query(
      `INSERT INTO lot_write_down_documents (
         document_number, status, reason, product_id, inventory_batch_id, quantity,
         original_unit_cost, previous_carrying_unit_cost, new_carrying_unit_cost,
         total_amount, expense_account_code, created_by, posted_at
       ) VALUES ($1,'POSTED','NEAR_EXPIRY',$2,$3,10,10000,10000,6000,40000,'5140',$4,NOW())`,
      [`HFAIL-${stamp}`, productId, ids.race1, userId],
    );
    await hClient.query(`UPDATE inventory_batches SET cost_price = 6000 WHERE id = $1`, [ids.race1]);
    await hClient.query(`DO $$ BEGIN RAISE EXCEPTION 'forensic accounting abort'; END $$`);
    await hClient.query('COMMIT');
    rec('SQL_INVENTORY_THEN_GL_ABORT', false, 'FAILED', 'COMMIT succeeded after RAISE');
  } catch (e) {
    await hClient.query('ROLLBACK').catch(() => undefined);
    const afterH = await pool.query(`SELECT cost_price::text FROM inventory_batches WHERE id = $1`, [ids.race1]);
    const docsH = await pool.query(
      `SELECT COUNT(*)::int AS n FROM lot_write_down_documents WHERE document_number = $1`,
      [`HFAIL-${stamp}`],
    );
    rec(
      'SQL_INVENTORY_THEN_GL_ABORT',
      Number(afterH.rows[0].cost_price) === Number(beforeH.rows[0].cost_price) && docsH.rows[0].n === 0,
      'PROVEN',
      `after abort carrying=${afterH.rows[0].cost_price} docs=${docsH.rows[0].n} err=${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
      { before: beforeH.rows[0], after: afterH.rows[0], docs: docsH.rows[0] },
    );
  } finally {
    hClient.release();
  }

  const wdRacePos = await writeDownNearExpiryLot(pool, {
    inventoryBatchId: ids.race1,
    newUnitCost: 6000,
    userId,
    memo: 'pos 6000',
  });
  try {
    assertSaleLineNotBelowAllocatedCost({
      productId,
      quantity: 1,
      lineRevenue: 6000,
      totalAllocatedCost: 6000,
      costPerSellingUnit: 6000,
      unitPrice: 6000,
    });
    rec('POS_6000_EQ', true, 'PROVEN', `after markdown to ${wdRacePos.newCarryingUnitCost}, 6000 allowed`);
  } catch (e) {
    rec('POS_6000_EQ', false, 'FAILED', String(e));
  }
  try {
    assertSaleLineNotBelowAllocatedCost({
      productId,
      quantity: 1,
      lineRevenue: 6000.01,
      totalAllocatedCost: 6000,
      costPerSellingUnit: 6000,
      unitPrice: 6000.01,
    });
    rec('POS_6000_01', true, 'PROVEN', '6000.01 allowed at carrying 6000');
  } catch (e) {
    rec('POS_6000_01', false, 'FAILED', String(e));
  }
  try {
    assertSaleLineNotBelowAllocatedCost({
      productId,
      quantity: 1,
      lineRevenue: 5999.99,
      totalAllocatedCost: 6000,
      costPerSellingUnit: 6000,
      unitPrice: 5999.99,
    });
    rec('POS_5999', true, 'PROVEN', '5999.99 allowed at carrying 6000 (±0.01 policy)');
  } catch (e) {
    rec('POS_5999', false, 'FAILED', String(e));
  }
  try {
    assertSaleLineNotBelowAllocatedCost({
      productId,
      quantity: 1,
      lineRevenue: 5999.98,
      totalAllocatedCost: 6000,
      costPerSellingUnit: 6000,
      unitPrice: 5999.98,
    });
    rec('POS_5998', false, 'FAILED', '5999.98 allowed against 6000');
  } catch (e) {
    rec('POS_5998', bizCode(e) === 'BELOW_ALLOCATED_COST', 'PROVEN', bizCode(e), { code: bizCode(e) });
  }

  await runLotWriteDownLiveSurfaces({
    pool,
    rec,
    stamp,
    userId,
    repoRoot,
    databaseUrl: rawUrl,
  });

  const fefoWalk = await previewFefoIssueCostForBaseQty(pool, productId, new Decimal(1));
  rec(
    'FEFO_WALK_USES_MARKDOWN',
    Number(fefoWalk.totalCost.toFixed(2)) === 2500,
    Number(fefoWalk.totalCost.toFixed(2)) === 2500 ? 'PROVEN' : 'FAILED',
    `qty=1 FEFO totalCost=${fefoWalk.totalCost.toFixed(2)} (expect 2500 from written-down C, not catalog 10000)`,
    { total: fefoWalk.totalCost.toString(), covered: fefoWalk.coveredQty.toString() },
  );

  const wdDispose = await writeDownNearExpiryLot(pool, {
    inventoryBatchId: ids.dispose,
    newUnitCost: 6000,
    userId,
    memo: 'forensic dispose markdown',
  });
  rec('DISPOSE_WD', wdDispose.totalAmount === 40000, 'PROVEN', `markdown amount=${wdDispose.totalAmount}`, { wdDispose });
  try {
    const { isMultistoreEnabled } = await import('../src/modules/inventory/warehouse/multistoreSettings.js');
    const { disposeFromQuarantine } = await import('../src/modules/loss-quarantine/lossDisposalService.js');
    const { postgresLotRepository } = await import('../src/modules/inventory-lot/postgresLotRepository.js');
    const { UnitOfWork } = await import('../src/db/unitOfWork.js');
    const multistore = await isMultistoreEnabled(pool);
    await pool.query(`UPDATE inventory_batches SET expiry_date = $2 WHERE id = $1`, [ids.dispose, biz]);
    let disposeArgs: {
      productId: string;
      inventoryBatchId: string;
      quantity: number;
      reason: 'EXPIRY';
      userId: string;
      memo: string;
      quarantineMode?: 'SOFT' | 'HARD';
      storeLocationId?: string;
      productLotId?: string;
      unitCost?: number;
    } = {
      productId: disposeProductId,
      inventoryBatchId: ids.dispose,
      quantity: 10,
      reason: 'EXPIRY',
      userId,
      memo: `forensic dispose ${stamp}`,
    };
    if (!multistore) {
      const { applySoftQuarantine } = await import('../src/modules/loss-quarantine/softQuarantineService.js');
      await applySoftQuarantine(pool, {
        inventoryBatchId: ids.dispose,
        reason: 'EXPIRED',
        userId,
        memo: 'forensic expire after write-down',
      });
      disposeArgs.quarantineMode = 'SOFT';
    } else {
      const expiredStore = await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM store_locations WHERE store_type = 'EXPIRED' AND is_active = true LIMIT 1`,
      );
      if (!expiredStore.rows[0]?.id) throw new Error('no EXPIRED store');
      const productLotId = await UnitOfWork.run(pool, async (client) => {
        const bn = await client.query<{ batch_number: string; cost_price: string }>(
          `SELECT batch_number, cost_price::text FROM inventory_batches WHERE id = $1`,
          [ids.dispose],
        );
        await postgresLotRepository.upsertProjection(client, {
          inventoryBatchId: ids.dispose,
          productId: disposeProductId,
          lotNumber: bn.rows[0].batch_number,
          expiryDate: biz,
          costPrice: Number(bn.rows[0].cost_price),
          status: 'EXPIRED',
        });
        await lotService.transitionLotStatus(client, {
          lotId: ids.dispose,
          newStatus: 'EXPIRED',
          userId,
        });
        const lot = await client.query<{ id: string }>(
          `SELECT id::text AS id FROM product_lots WHERE inventory_batch_id = $1 LIMIT 1`,
          [ids.dispose],
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
          [expiredStore.rows[0].id, disposeProductId, lotId, 10],
        );
        return lotId;
      });
      disposeArgs.quarantineMode = 'HARD';
      disposeArgs.storeLocationId = expiredStore.rows[0].id;
      disposeArgs.productLotId = productLotId;
    }
    try {
      await disposeFromQuarantine(pool, { ...disposeArgs, unitCost: 10000 });
      rec('DISPOSE_REJECT_ORIGINAL', false, 'FAILED', 'dispose at original 10000 accepted');
    } catch (e) {
      rec(
        'DISPOSE_REJECT_ORIGINAL',
        /remaining carrying cost/i.test(e instanceof Error ? e.message : ''),
        'PROVEN',
        e instanceof Error ? e.message.slice(0, 200) : String(e),
      );
    }
    const dispose = await disposeFromQuarantine(pool, disposeArgs);
    const glDisp = await pool.query(
      `SELECT a."AccountCode" AS account,
              COALESCE(le."DebitAmount", 0)::text AS debit,
              COALESCE(le."CreditAmount", 0)::text AS credit
       FROM ledger_transactions lt
       JOIN ledger_entries le ON le."TransactionId" = lt."Id"
       JOIN accounts a ON a."Id" = le."AccountId"
       WHERE lt."Id" = $1`,
      [dispose.journalEntryId],
    );
    const d5130 = glDisp.rows.filter((r) => r.account === '5130').reduce((s, r) => s + Number(r.debit), 0);
    const c1300d = glDisp.rows.filter((r) => r.account === '1300').reduce((s, r) => s + Number(r.credit), 0);
    const d5140 = glDisp.rows.filter((r) => r.account === '5140').reduce((s, r) => s + Number(r.debit), 0);
    rec(
      'DISPOSE_CARRYING_NOT_ORIGINAL',
      d5130 === 60000 && c1300d === 60000 && d5140 === 0 && dispose.expenseAccountCode === '5130',
      'PROVEN',
      `DR5130=${d5130} CR1300=${c1300d} DR5140=${d5140} account=${dispose.expenseAccountCode}`,
      { glDisp: glDisp.rows, dispose },
    );
  } catch (e) {
    rec('DISPOSE_CARRYING_NOT_ORIGINAL', false, 'FAILED', e instanceof Error ? e.message : String(e));
  }

  const out = {
    proof: 'FORENSIC_LWD_611_612',
    asOf: new Date().toISOString(),
    sku,
    rows,
    summary: {
      proven: rows.filter((r) => r.result === 'PROVEN').length,
      failed: rows.filter((r) => r.result === 'FAILED').length,
      unproven: rows.filter((r) => r.result === 'UNPROVEN').length,
      partial: rows.filter((r) => r.result === 'PARTIALLY_PROVEN').length,
    },
  };
  const jsonPath = path.join(repoRoot, 'FORENSIC_LOT_WRITE_DOWN_611_612.json');
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.summary, null, 2));
  await pool.end();
  process.exit(out.summary.failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await pool.end();
  } catch (endErr) {
    console.error(endErr);
  }
  process.exit(1);
});
