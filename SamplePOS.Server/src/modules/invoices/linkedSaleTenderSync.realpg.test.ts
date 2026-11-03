/**
 * REAL Postgres — Blis-class chk_sales_credit_has_debt on linked CREDIT sales.
 *
 * Exercised (not greps):
 *   A) Full DEPOSIT tender on CREDIT sale+invoice → sync succeeds; sale leaves CREDIT → DEPOSIT
 *   B) Regression: amount_paid-only UPDATE to total under CREDIT → MUST fail constraint
 *   C) Write-off-style: invoice settlement paid=total with tender=0 → sync keeps CREDIT, amount_paid=0
 *
 * Skip loudly if sp_template_local missing.
 *
 * Run:
 *   node --experimental-vm-modules ./node_modules/jest/bin/jest.js \
 *     src/modules/invoices/linkedSaleTenderSync.realpg.test.ts --forceExit
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScratchFromTemplate, insertCustomer, type TemplateScratch } from '../../test/realPgTemplate.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const sqlDir = path.join(repoRoot, 'shared', 'sql');

let db: TemplateScratch | null = null;
let invoiceRepository: typeof import('./invoiceRepository.js').invoiceRepository;
const gates: Array<{ id: string; ok: boolean; detail: string }> = [];

function gate(id: string, ok: boolean, detail: string) {
  gates.push({ id, ok, detail });
  expect(ok).toBe(true);
}

beforeAll(async () => {
  db = await createScratchFromTemplate();
  if (!db) {
    // eslint-disable-next-line no-console
    console.warn(
      '\n*** linkedSaleTenderSync.realpg: SKIPPED — no local Postgres/sp_template_local. NOT verified. ***\n',
    );
    return;
  }
  // Template may still carry legacy invoice_payments → sales triggers.
  // 645: PascalCase InvoiceNumber sync. 646: amount_paid-only under CREDIT.
  await db.pool.query(
    readFileSync(path.join(sqlDir, '645_drop_legacy_invoice_payment_sync.sql'), 'utf8'),
  );
  await db.pool.query(
    readFileSync(path.join(sqlDir, '646_drop_invoice_payment_sales_sync_trigger.sql'), 'utf8'),
  );
  ({ invoiceRepository } = await import('./invoiceRepository.js'));
});

afterAll(async () => {
  await db?.drop();
  if (gates.length > 0) {
    const passed = gates.every((g) => g.ok);
    const evidence = {
      proof: 'LINKED_SALE_TENDER_SYNC_REALPG',
      generatedAt: new Date().toISOString(),
      exercised: true,
      passed,
      gateCount: gates.length,
      failedCount: gates.filter((g) => !g.ok).length,
      gates,
      constraint:
        "CHECK (payment_method <> 'CREDIT' OR (payment_method = 'CREDIT' AND amount_paid < total_amount))",
    };
    writeFileSync(
      path.join(repoRoot, 'PROOF_LINKED_SALE_TENDER_SYNC.json'),
      JSON.stringify(evidence, null, 2),
    );
    writeFileSync(
      path.join(repoRoot, 'PROOF_LINKED_SALE_TENDER_SYNC.md'),
      [
        '# PROOF: Linked sale tender sync (chk_sales_credit_has_debt)',
        '',
        `**${passed ? 'PASS' : 'FAIL'}** — exercised on real Postgres scratch`,
        '',
        `- Gates: ${gates.length}`,
        `- Failed: ${gates.filter((g) => !g.ok).length}`,
        '',
        '| Gate | OK | Detail |',
        '|------|----|--------|',
        ...gates.map((g) => `| ${g.id} | ${g.ok ? 'yes' : 'NO'} | ${g.detail.replace(/\|/g, '/')} |`),
        '',
        '## Rule',
        '',
        '- sales.amount_paid = liquidity tender only',
        '- CREDIT + full tender → leave CREDIT to clearing method in one UPDATE',
        '- Write-off / CN must not set sales.amount_paid = total under CREDIT',
        '',
      ].join('\n'),
    );
  }
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!db) return;
    await fn();
  });

async function constraintPresent(): Promise<boolean> {
  const { rows } = await db!.pool.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'chk_sales_credit_has_debt'
     ) AS ok`,
  );
  return rows[0]?.ok === true;
}

async function seedCreditSaleInvoice(tag: string, total: number): Promise<{
  saleId: string;
  invoiceId: string;
  customerId: string;
}> {
  const customerId = await insertCustomer(db!.pool, `Linked Tender ${tag}`);
  const saleId = randomUUID();
  const invoiceId = randomUUID();
  const saleNumber = `SALE-LT-${tag}-${saleId.slice(0, 6)}`;
  const invoiceNumber = `INV-LT-${tag}-${invoiceId.slice(0, 6)}`;

  await db!.pool.query(
    `INSERT INTO sales (
       id, sale_number, subtotal, total_amount, payment_method, amount_paid,
       status, sale_date, customer_id
     ) VALUES (
       $1, $2, $3, $3, 'CREDIT'::payment_method, 0,
       'COMPLETED', CURRENT_DATE, $4
     )`,
    [saleId, saleNumber, total, customerId],
  );

  await db!.pool.query(
    `INSERT INTO invoices (
       id, invoice_number, customer_id, customer_name, sale_id,
       issue_date, due_date, subtotal, tax_amount, total_amount,
       amount_paid, amount_due, status, payment_terms, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $5, $4,
       CURRENT_DATE, CURRENT_DATE + 30, $6, 0, $6,
       0, $6, 'UNPAID', 30, NOW(), NOW()
     )`,
    [invoiceId, invoiceNumber, customerId, saleId, `Linked Tender ${tag}`, total],
  );

  return { saleId, invoiceId, customerId };
}

async function saleRow(saleId: string): Promise<{ method: string; paid: number; total: number }> {
  const { rows } = await db!.pool.query<{
    payment_method: string;
    amount_paid: string;
    total_amount: string;
  }>(
    `SELECT payment_method::text, amount_paid::text, total_amount::text
     FROM sales WHERE id = $1`,
    [saleId],
  );
  return {
    method: String(rows[0].payment_method).toUpperCase(),
    paid: Number(rows[0].amount_paid),
    total: Number(rows[0].total_amount),
  };
}

async function salesSyncTriggerPresent(): Promise<boolean> {
  const { rows } = await db!.pool.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal
         AND c.relname = 'invoice_payments'
         AND t.tgname = 'trg_sync_invoice_payment'
     ) AS ok`,
  );
  return rows[0]?.ok === true;
}

describe('REALPG: linked sale tender sync vs chk_sales_credit_has_debt', () => {
  maybe('constraint present on template; full DEPOSIT leaves CREDIT; WO does not fake pay', async () => {
    gate(
      'CONSTRAINT_PRESENT',
      await constraintPresent(),
      'chk_sales_credit_has_debt on scratch',
    );
    gate(
      'TRIGGER_646_GONE',
      !(await salesSyncTriggerPresent()),
      'trg_sync_invoice_payment dropped by 646',
    );

    const TOTAL = 50_000;

    // --- A0) Plant amount_paid-only trigger → full DEPOSIT INSERT must fail ---
    const plant = await seedCreditSaleInvoice('PLANT', TOTAL);
    await db!.pool.query(`
      CREATE OR REPLACE FUNCTION sync_invoice_payment_to_sales_and_customer()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE v_sale_id uuid; v_total numeric(15,2);
      BEGIN
        SELECT sale_id INTO v_sale_id FROM invoices WHERE id = NEW.invoice_id;
        IF v_sale_id IS NULL THEN RETURN NEW; END IF;
        SELECT COALESCE(SUM(amount),0) INTO v_total FROM invoice_payments WHERE invoice_id = NEW.invoice_id;
        UPDATE sales SET amount_paid = v_total WHERE id = v_sale_id;
        RETURN NEW;
      END;
      $$;
      DROP TRIGGER IF EXISTS trg_sync_invoice_payment ON invoice_payments;
      CREATE TRIGGER trg_sync_invoice_payment
        AFTER INSERT ON invoice_payments
        FOR EACH ROW EXECUTE FUNCTION sync_invoice_payment_to_sales_and_customer();
    `);
    let plantMsg = '';
    try {
      await db!.pool.query(
        `INSERT INTO invoice_payments (
           receipt_number, invoice_id, payment_date, payment_method, amount
         ) VALUES ($1, $2, NOW(), 'DEPOSIT', $3)`,
        [`RCPT-PLANT-${plant.invoiceId.slice(0, 6)}`, plant.invoiceId, TOTAL],
      );
    } catch (e) {
      plantMsg = e instanceof Error ? e.message : String(e);
    }
    gate(
      'PLANTED_TRIGGER_FULL_DEPOSIT_FAILS',
      /chk_sales_credit_has_debt/i.test(plantMsg),
      plantMsg.slice(0, 200) || 'expected planted-trigger failure missing',
    );
    await db!.pool.query(
      readFileSync(path.join(sqlDir, '646_drop_invoice_payment_sales_sync_trigger.sql'), 'utf8'),
    );
    gate('REHEAL_646', !(await salesSyncTriggerPresent()), '646 drops planted trigger');

    // --- A) Full DEPOSIT tender ---
    const full = await seedCreditSaleInvoice('FULL', TOTAL);
    await db!.pool.query(
      `INSERT INTO invoice_payments (
         receipt_number, invoice_id, payment_date, payment_method, amount
       ) VALUES ($1, $2, NOW(), 'DEPOSIT', $3)`,
      [`RCPT-DEP-${full.invoiceId.slice(0, 6)}`, full.invoiceId, TOTAL],
    );

    const fresh = await invoiceRepository.recalcInvoice(db!.pool, full.invoiceId);
    gate(
      'RECALC_OK',
      !!fresh && Number(fresh.balance) === 0 && Number(fresh.amount_paid) === TOTAL,
      `balance=${fresh?.balance} paid=${fresh?.amount_paid}`,
    );

    const afterFull = await saleRow(full.saleId);
    gate(
      'FULL_DEPOSIT_LEAVES_CREDIT',
      afterFull.method === 'DEPOSIT' && afterFull.paid === TOTAL,
      JSON.stringify(afterFull),
    );

    // --- B) Regression: amount_paid-only under CREDIT must fail ---
    const regress = await seedCreditSaleInvoice('REGRESS', TOTAL);
    let regressMsg = '';
    try {
      await db!.pool.query(
        `UPDATE sales SET amount_paid = $1::numeric WHERE id = $2`,
        [TOTAL, regress.saleId],
      );
    } catch (e) {
      regressMsg = e instanceof Error ? e.message : String(e);
    }
    gate(
      'AMOUNT_PAID_ONLY_UNDER_CREDIT_FAILS',
      /chk_sales_credit_has_debt/i.test(regressMsg),
      regressMsg.slice(0, 200) || 'expected constraint failure missing',
    );

    // --- C) Write-off style: invoice paid via settlement, tender=0 ---
    const wo = await seedCreditSaleInvoice('WO', TOTAL);
    // Simulate invoice fully settled by write-off/CN without liquidity rows.
    await db!.pool.query(
      `UPDATE invoices
       SET amount_paid = $1::numeric, amount_due = 0, status = 'PAID'::invoice_status
       WHERE id = $2`,
      [TOTAL, wo.invoiceId],
    );
    await invoiceRepository.syncLinkedSaleFromInvoice(db!.pool, wo.invoiceId);
    const afterWo = await saleRow(wo.saleId);
    gate(
      'WRITEOFF_KEEPS_CREDIT_ZERO_TENDER',
      afterWo.method === 'CREDIT' && afterWo.paid === 0,
      JSON.stringify(afterWo),
    );

    // Partial tender stays CREDIT
    const partial = await seedCreditSaleInvoice('PARTIAL', TOTAL);
    await db!.pool.query(
      `INSERT INTO invoice_payments (
         receipt_number, invoice_id, payment_date, payment_method, amount
       ) VALUES ($1, $2, NOW(), 'CASH', $3)`,
      [`RCPT-PART-${partial.invoiceId.slice(0, 6)}`, partial.invoiceId, 10_000],
    );
    await invoiceRepository.recalcInvoice(db!.pool, partial.invoiceId);
    const afterPart = await saleRow(partial.saleId);
    gate(
      'PARTIAL_STAYS_CREDIT',
      afterPart.method === 'CREDIT' && afterPart.paid === 10_000,
      JSON.stringify(afterPart),
    );
  });
});
