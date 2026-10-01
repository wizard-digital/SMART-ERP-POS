/**
 * End-to-end proof for a credit-sale return.
 * Runs on local DATABASE_URL inside one transaction and always rolls back.
 *
 *   npx tsx scripts/proof-credit-sale-return-e2e.ts
 */
import dotenv from 'dotenv';
import pg from 'pg';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: resolve(serverRoot, '.env') });

const url = process.env.DATABASE_URL || '';
const host = (() => {
  try {
    const u = new URL(url);
    return `${u.hostname}/${u.pathname.replace(/^\//, '')}`;
  } catch {
    return 'unparsed';
  }
})();
if (!host.startsWith('localhost/')) {
  console.error(`Refusing to run against ${host}. This proof is local-only.`);
  process.exit(2);
}

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
function assert(cond: boolean, name: string, detail = '') {
  checks.push({ name, ok: cond, detail: detail || undefined });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const real = new pg.Pool({ connectionString: url, max: 2 });
const holder = await real.connect();
await holder.query('BEGIN');

let sp = 0;
const rawQuery = holder.query.bind(holder);

async function txQuery(sql: unknown, params?: unknown) {
  const text = typeof sql === 'string' ? sql : (sql as { text?: string })?.text ?? '';
  const trimmed = text.trim();
  if (/^BEGIN\b/i.test(trimmed)) {
    sp += 1;
    return rawQuery(`SAVEPOINT proof_sp_${sp}`);
  }
  if (/^COMMIT\b/i.test(trimmed)) {
    const released = await rawQuery(`RELEASE SAVEPOINT proof_sp_${sp}`);
    await rawQuery(`SELECT set_config('app.skip_stock_movement_trigger', 'false', true)`);
    return released;
  }
  if (/^ROLLBACK\b/i.test(trimmed)) {
    return rawQuery(`ROLLBACK TO SAVEPOINT proof_sp_${Math.max(sp, 1)}`);
  }
  return params === undefined ? rawQuery(sql as string) : rawQuery(sql as string, params as never);
}

const pool = real as pg.Pool;
pool.connect = (async () => ({
  query: txQuery,
  release() {},
})) as typeof pool.connect;
pool.query = txQuery as typeof pool.query;

function num(v: unknown) {
  return Number(v ?? 0);
}

async function finish(code: number) {
  try {
    await rawQuery('ROLLBACK');
  } catch (e) {
    console.error('ROLLBACK failed', e);
  }
  const after = await real.query(`SELECT COUNT(*)::int AS n FROM customers WHERE name = 'PROOF RETURN E2E'`);
  const leftover = num(after.rows[0]?.n);
  assert(leftover === 0, 'rollback-left-no-customer', `rows=${leftover}`);
  holder.release();
  await real.end();
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed > 0 || code !== 0 ? 1 : 0);
}

try {
  const { salesService } = await import('../src/modules/sales/salesService.js');
  const { customerInvoiceAdjustmentService } = await import(
    '../src/modules/customer-invoice-adjustments/customerInvoiceAdjustmentService.js'
  );
  const { invoiceRepository } = await import('../src/modules/invoices/invoiceRepository.js');

  const openSession = await pool.query(
    `SELECT s.id::text, s.user_id::text AS user_id, u.role
     FROM cash_register_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.status = 'OPEN'
     ORDER BY s.opened_at DESC
     LIMIT 1`,
  );
  const session = openSession.rows[0] as { id: string; user_id: string; role: string } | undefined;
  const soldBy = session?.user_id;
  assert(!!session, 'fixture-session', session ? `${session.id} ${session.role}` : 'no open register session');
  if (!soldBy || !session) await finish(1);

  const product = await pool.query(
    `SELECT p.id::text, p.name, COALESCE(p.selling_price, 1000)::float8 AS price,
            COALESCE(p.quantity_on_hand, 0)::float8 AS qty
     FROM products p
     WHERE COALESCE(p.is_active, true) AND COALESCE(p.quantity_on_hand, 0) >= 5
     ORDER BY p.quantity_on_hand DESC
     LIMIT 1`,
  );
  assert(product.rows.length === 1, 'fixture-product', product.rows[0]?.name || 'none');
  if (!product.rows.length) await finish(1);
  const prod = product.rows[0] as { id: string; name: string; price: number; qty: number };
  const unitPrice = Math.max(Number(prod.price) || 1000, 1000);
  const qty = 2;
  const onHandBefore = num(prod.qty);

  const customer = await pool.query(
    `INSERT INTO customers (name, is_active, unlimited_credit, credit_limit, balance)
     VALUES ('PROOF RETURN E2E', true, true, 0, 0)
     RETURNING id::text`,
  );
  const customerId = customer.rows[0].id as string;

  const sale = await salesService.createSale(pool, {
    customerId,
    items: [{ productId: prod.id, productName: prod.name, quantity: qty, unitPrice }],
    subtotal: unitPrice * qty,
    discountAmount: 0,
    taxAmount: 0,
    totalAmount: unitPrice * qty,
    paymentMethod: 'CREDIT',
    paymentReceived: 0,
    paymentLines: [{ paymentMethod: 'CREDIT', amount: unitPrice * qty }],
    soldBy,
    cashRegisterSessionId: session.id,
    idempotencyKey: `proof-return-e2e-${Date.now()}`,
  });
  const saleId = sale.sale.id as string;
  assert(!!saleId, 'credit-sale-created', sale.sale.saleNumber);

  const inv = await pool.query(
    `SELECT id::text, invoice_number, total_amount::float8 AS total, amount_due::float8 AS due,
            tax_amount::float8 AS tax, status
     FROM invoices
     WHERE sale_id = $1 AND COALESCE(document_type, 'INVOICE') = 'INVOICE'`,
    [saleId],
  );
  assert(inv.rows.length === 1, 'invoice-created', inv.rows[0]?.invoice_number);
  if (!inv.rows.length) await finish(1);
  const invoiceId = inv.rows[0].id as string;
  const invoiceTotal = num(inv.rows[0].total);
  const dueBefore = num(inv.rows[0].due);
  const saleTax = num(inv.rows[0].tax);
  assert(Math.abs(dueBefore - invoiceTotal) < 0.02, 'invoice-opens-at-full-due', `due=${dueBefore} total=${invoiceTotal}`);

  const onHandAfterSale = num(
    (await pool.query(`SELECT quantity_on_hand::float8 AS qty FROM products WHERE id = $1`, [prod.id])).rows[0]?.qty,
  );
  assert(
    Math.abs(onHandAfterSale - (onHandBefore - qty)) < 0.02,
    'stock-reduced-on-sale',
    `before=${onHandBefore} after=${onHandAfterSale}`,
  );

  const saleItem = await pool.query(
    `SELECT id::text, quantity::float8 AS qty, unit_price::float8 AS price,
            COALESCE(tax_rate, 0)::float8 AS tax_rate, COALESCE(tax_amount, 0)::float8 AS tax_amount
     FROM sale_items WHERE sale_id = $1 LIMIT 1`,
    [saleId],
  );
  const saleItemId = saleItem.rows[0].id as string;
  const lineTaxRate = num(saleItem.rows[0].tax_rate);

  const returned = await customerInvoiceAdjustmentService.adjust(
    pool,
    {
      intent: 'RETURN_GOODS',
      invoiceId,
      reason: 'Customer returned one unit from the credit sale',
      lines: [{ saleItemId, quantity: 1 }],
    },
    soldBy,
  );
  assert(returned.totalCredit > 0.01, 'credit-note-posted', `${returned.creditNoteNumber} credit=${returned.totalCredit}`);

  const dueAfterCn = num(
    (await pool.query(`SELECT amount_due::float8 AS due FROM invoices WHERE id = $1`, [invoiceId])).rows[0]?.due,
  );
  assert(
    Math.abs(dueAfterCn - (dueBefore - returned.totalCredit)) < 0.05,
    'invoice-due-reduced-by-credit-note',
    `before=${dueBefore} credit=${returned.totalCredit} after=${dueAfterCn}`,
  );

  if (saleTax > 0.01 || lineTaxRate > 0) {
    const exTax = unitPrice;
    assert(
      returned.totalCredit > exTax + 0.01,
      'return-credit-includes-tax',
      `credit=${returned.totalCredit} exTax=${exTax} rate=${lineTaxRate} saleTax=${saleTax}`,
    );
  } else {
    assert(Math.abs(returned.totalCredit - unitPrice) < 0.05, 'return-credit-matches-untaxed-price', `${returned.totalCredit}`);
  }

  const gl = await pool.query(
    `SELECT a."AccountCode" AS code,
            ROUND(SUM(le."DebitAmount")::numeric, 2)::float8 AS dr,
            ROUND(SUM(le."CreditAmount")::numeric, 2)::float8 AS cr
     FROM ledger_transactions lt
     JOIN ledger_entries le ON le."TransactionId" = lt."Id"
     JOIN accounts a ON a."Id" = le."AccountId"
     WHERE lt."ReferenceType" = 'CREDIT_NOTE' AND lt."ReferenceId"::text = $1
       AND COALESCE(lt."IsReversed", false) = false
     GROUP BY a."AccountCode"`,
    [returned.creditNoteId],
  );
  const arCr = gl.rows.filter((r) => r.code === '1200').reduce((s, r) => s + num(r.cr), 0);
  const glDr = gl.rows.reduce((s, r) => s + num(r.dr), 0);
  const glCr = gl.rows.reduce((s, r) => s + num(r.cr), 0);
  assert(Math.abs(arCr - returned.totalCredit) < 0.05, 'gl-credits-ar', `ar=${arCr} note=${returned.totalCredit}`);
  assert(Math.abs(glDr - glCr) < 0.05, 'gl-credit-note-balanced', `dr=${glDr} cr=${glCr}`);

  const onHandAfterReturn = num(
    (await pool.query(`SELECT quantity_on_hand::float8 AS qty FROM products WHERE id = $1`, [prod.id])).rows[0]?.qty,
  );
  assert(
    Math.abs(onHandAfterReturn - (onHandAfterSale + 1)) < 0.02,
    'stock-restored-for-returned-unit',
    `afterSale=${onHandAfterSale} afterReturn=${onHandAfterReturn}`,
  );

  const refundedQty = num(
    (await pool.query(`SELECT COALESCE(refunded_qty, 0)::float8 AS q FROM sale_items WHERE id = $1`, [saleItemId])).rows[0]?.q,
  );
  assert(Math.abs(refundedQty - 1) < 0.001, 'refunded-qty-recorded', `${refundedQty}`);

  await invoiceRepository.recalcInvoice(pool, invoiceId);
  const dueAfterRecalc = num(
    (await pool.query(`SELECT amount_due::float8 AS due FROM invoices WHERE id = $1`, [invoiceId])).rows[0]?.due,
  );
  assert(
    Math.abs(dueAfterRecalc - dueAfterCn) < 0.05,
    'recalc-keeps-reduced-due',
    `afterNote=${dueAfterCn} afterRecalc=${dueAfterRecalc}`,
  );

  const custBal = num(
    (await pool.query(`SELECT balance::float8 AS b FROM customers WHERE id = $1`, [customerId])).rows[0]?.b,
  );
  assert(
    Math.abs(custBal - dueAfterRecalc) < 0.05,
    'customer-balance-matches-invoice-due',
    `balance=${custBal} due=${dueAfterRecalc}`,
  );

  let secondReturnBlocked = false;
  try {
    await customerInvoiceAdjustmentService.adjust(
      pool,
      {
        intent: 'RETURN_GOODS',
        invoiceId,
        reason: 'Duplicate return of the same unit',
        lines: [{ saleItemId, quantity: 2 }],
      },
      soldBy,
    );
  } catch {
    secondReturnBlocked = true;
  }
  assert(secondReturnBlocked, 'cannot-return-more-than-remaining');

  const refund = await salesService.refundSale(pool, saleId, soldBy, {
    reason: 'Return the remaining credit-sale unit from the sale screen',
    items: [{ saleItemId, quantity: 1 }],
  });
  assert(!!refund.refund.refundNumber, 'sale-return-posted', refund.refund.refundNumber);

  const dueAfterRefund = num(
    (await pool.query(`SELECT amount_due::float8 AS due FROM invoices WHERE id = $1`, [invoiceId])).rows[0]?.due,
  );
  assert(dueAfterRefund < dueAfterRecalc - 0.01, 'sale-return-reduces-invoice', `before=${dueAfterRecalc} after=${dueAfterRefund}`);

  await invoiceRepository.recalcInvoice(pool, invoiceId);
  const dueFinal = num(
    (await pool.query(`SELECT amount_due::float8 AS due FROM invoices WHERE id = $1`, [invoiceId])).rows[0]?.due,
  );
  assert(
    Math.abs(dueFinal - dueAfterRefund) < 0.05,
    'recalc-keeps-sale-return-reduction',
    `afterRefund=${dueAfterRefund} afterRecalc=${dueFinal}`,
  );

  const fullBill = invoiceTotal;
  const stillOwed = dueFinal;
  assert(stillOwed >= -0.02, 'due-not-negative', `${stillOwed}`);
  if (saleTax <= 0.01) {
    assert(stillOwed < 0.05, 'untaxed-full-return-clears-invoice', `due=${stillOwed} billed=${fullBill}`);
  }

  await finish(0);
} catch (e) {
  console.error(e instanceof Error ? e.stack || e.message : e);
  checks.push({ name: 'unhandled', ok: false, detail: e instanceof Error ? e.message : String(e) });
  await finish(1);
}
