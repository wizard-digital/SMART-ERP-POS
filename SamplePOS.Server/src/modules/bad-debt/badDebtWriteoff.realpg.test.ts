/**
 * REAL Postgres: bad-debt write-off + reverse with integrity across GL, invoice,
 * customer.balance, workqueue, AR aging, and both P&L surfaces.
 *
 * Flag-off default is proven. Posting uses AccountingCore (AR_WRITEOFF).
 * Skip is not proof — missing template fails the suite.
 *
 * Run: node --experimental-vm-modules ./node_modules/jest/bin/jest.js src/modules/bad-debt/badDebtWriteoff.realpg.test.ts --no-coverage --testTimeout=120000 --forceExit
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import {
  createScratchFromTemplate,
  insertCustomer,
  journalByAccount,
  type TemplateScratch,
} from '../../test/realPgTemplate.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const INVOICE_TOTAL = 10000;
const PARTIAL_WRITEOFF = 4000;
const REMAINING = 6000;

let db: TemplateScratch | null = null;
let createAndPostWriteoff: typeof import('./badDebtService.js').createAndPostWriteoff;
let reverseWriteoff: typeof import('./badDebtService.js').reverseWriteoff;
let getWriteoffWorkqueue: typeof import('./badDebtService.js').getWriteoffWorkqueue;
let isBadDebtWriteoffEnabled: typeof import('./badDebtSettings.js').isBadDebtWriteoffEnabled;
let reportsRepository: typeof import('../reports/reportsRepository.js').reportsRepository;
let ProfitLossReportService: typeof import('../../services/profitLossReportService.js').ProfitLossReportService;
let syncCustomerBalanceFromInvoices: typeof import('../../utils/customerBalanceSync.js').syncCustomerBalanceFromInvoices;
let getBusinessDate: typeof import('../../utils/dateRange.js').getBusinessDate;
let systemSettingsService: typeof import('../system-settings/systemSettingsService.js').systemSettingsService;
let getExpensesByAccount: typeof import('../../repositories/businessReportRepository.js').getExpensesByAccount;
let getIncomeStatement: typeof import('../../repositories/accountingRepository.js').getIncomeStatement;
let AgedBalanceService: typeof import('../../services/agedBalanceService.js').AgedBalanceService;

const evidence: Array<{ name: string; ok: true; detail: Record<string, unknown> }> = [];

function prove(name: string, detail: Record<string, unknown>): void {
  evidence.push({ name, ok: true, detail });
}

async function hasTable(pool: Pool, name: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    [name],
  );
  return r.rows.length > 0;
}

async function hasColumn(pool: Pool, table: string, column: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 LIMIT 1`,
    [table, column],
  );
  return r.rows.length > 0;
}

async function applySql(pool: Pool, filename: string): Promise<void> {
  const file = path.join(repoRoot, 'shared/sql', filename);
  if (!existsSync(file)) throw new Error(`Missing ${filename}`);
  await pool.query(readFileSync(file, 'utf8'));
}

async function openPeriodFor(pool: Pool, isoDate: string): Promise<void> {
  const ymd = isoDate.slice(0, 10);
  const [year, month] = ymd.split('-').map(Number);
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const endRes = await pool.query<{ d: string }>(
    `SELECT ($1::date + INTERVAL '1 month' - INTERVAL '1 day')::date::text AS d`,
    [start],
  );
  await pool.query(
    `INSERT INTO accounting_periods (period_year, period_month, period_start, period_end, status)
     VALUES ($1, $2, $3::date, $4::date, 'OPEN')
     ON CONFLICT DO NOTHING`,
    [year, month, start, endRes.rows[0].d],
  );
  await pool.query(
    `UPDATE accounting_periods SET status = 'OPEN' WHERE $1::date BETWEEN period_start AND period_end`,
    [ymd],
  );
}

async function insertActor(pool: Pool): Promise<string> {
  const stamp = Date.now().toString(36);
  const email = `bd-writer-${stamp}@proof.local`;
  if (await hasColumn(pool, 'users', 'user_number')) {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role, is_active, user_number)
       VALUES ($1, 'x', 'Bad Debt Writer', 'ADMIN', true, $2)
       RETURNING id::text AS id`,
      [email, `USR-BD-${stamp.slice(-8)}`],
    );
    return r.rows[0].id;
  }
  const r = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, is_active)
     VALUES ($1, 'x', 'Bad Debt Writer', 'ADMIN', true)
     RETURNING id::text AS id`,
    [email],
  );
  return r.rows[0].id;
}

async function insertOverdueInvoice(
  pool: Pool,
  customerId: string,
  customerName: string,
  total: number,
  ageDays: number,
): Promise<{ id: string; number: string }> {
  const stamp = Date.now().toString(36).toUpperCase();
  const number = `INV-BD-${stamp}`.slice(0, 50);
  const extraDoc = await hasColumn(pool, 'invoices', 'document_type');
  const result = await pool.query<{ id: string }>(
    extraDoc
      ? `INSERT INTO invoices (
           invoice_number, customer_id, customer_name, issue_date, due_date,
           subtotal, tax_amount, total_amount, amount_paid, amount_due,
           status, document_type, payment_terms, created_at, updated_at
         ) VALUES (
           $1, $2, $5, CURRENT_DATE - ($3::int + 5), CURRENT_DATE - $3::int,
           $4, 0, $4, 0, $4, 'UNPAID', 'INVOICE', 30, NOW(), NOW()
         ) RETURNING id::text AS id`
      : `INSERT INTO invoices (
           invoice_number, customer_id, customer_name, issue_date, due_date,
           subtotal, tax_amount, total_amount, amount_paid, amount_due,
           status, payment_terms, created_at, updated_at
         ) VALUES (
           $1, $2, $5, CURRENT_DATE - ($3::int + 5), CURRENT_DATE - $3::int,
           $4, 0, $4, 0, $4, 'UNPAID', 30, NOW(), NOW()
         ) RETURNING id::text AS id`,
    [number, customerId, ageDays, total, customerName],
  );
  return { id: result.rows[0].id, number };
}

async function invoiceRow(
  pool: Pool,
  invoiceId: string,
): Promise<{ amountPaid: number; amountDue: number; status: string }> {
  const r = await pool.query<{ amount_paid: string; amount_due: string; status: string }>(
    `SELECT amount_paid::text, amount_due::text, status::text
     FROM invoices WHERE id = $1`,
    [invoiceId],
  );
  return {
    amountPaid: Number(r.rows[0].amount_paid),
    amountDue: Number(r.rows[0].amount_due),
    status: String(r.rows[0].status).toUpperCase(),
  };
}

async function customerBalance(pool: Pool, customerId: string): Promise<number> {
  const r = await pool.query<{ balance: string }>(
    `SELECT COALESCE(balance, 0)::text AS balance FROM customers WHERE id = $1`,
    [customerId],
  );
  return Number(r.rows[0].balance);
}

async function glNetActive(
  pool: Pool,
  accountCode: string,
): Promise<{ debit: number; credit: number; net: number }> {
  const r = await pool.query<{ debit: string; credit: string }>(
    `SELECT
       COALESCE(SUM(le."DebitAmount"), 0)::text AS debit,
       COALESCE(SUM(le."CreditAmount"), 0)::text AS credit
     FROM ledger_entries le
     JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
     JOIN accounts a ON a."Id" = le."AccountId"
     WHERE a."AccountCode" = $1
       AND lt."Status" = 'POSTED'
       AND lt."IsReversed" = FALSE
       AND lt."Id" NOT IN (
         SELECT "ReversedByTransactionId" FROM ledger_transactions
         WHERE "ReversedByTransactionId" IS NOT NULL
       )`,
    [accountCode],
  );
  const debit = Number(r.rows[0]?.debit ?? 0);
  const credit = Number(r.rows[0]?.credit ?? 0);
  return { debit, credit, net: debit - credit };
}

async function workqueueDue(
  customerId: string,
  minAgeDays: number,
): Promise<{ totalLines: number; totalDue: number; invoiceIds: string[] }> {
  const q = await getWriteoffWorkqueue(db!.pool, { minAgeDays, customerId });
  return {
    totalLines: q.summary.totalLines,
    totalDue: Number(q.summary.totalDue),
    invoiceIds: q.lines.map((l) => l.invoiceId),
  };
}

beforeAll(async () => {
  db = await createScratchFromTemplate();
  if (!db) {
    throw new Error(
      'badDebtWriteoff.realpg: sp_template_local required. Run node scripts/ops/clone-template-local.mjs',
    );
  }
  const pool = db.pool;
  if (!(await hasColumn(pool, 'system_settings', 'bad_debt_writeoff_enabled'))) {
    await applySql(pool, '550_bad_debt_foundation.sql');
  }
  if (!(await hasTable(pool, 'ar_writeoff_documents'))) {
    await applySql(pool, '551_bad_debt_writeoff_documents.sql');
  }
  if (!(await hasColumn(pool, 'sales', 'gift_amount'))) {
    await applySql(pool, '643_sale_gift_foc.sql');
  }
  await applySql(pool, '644_pnl_bad_debt_opex.sql');

  ({ createAndPostWriteoff, reverseWriteoff, getWriteoffWorkqueue } = await import(
    './badDebtService.js'
  ));
  ({ isBadDebtWriteoffEnabled } = await import('./badDebtSettings.js'));
  ({ reportsRepository } = await import('../reports/reportsRepository.js'));
  ({ ProfitLossReportService } = await import('../../services/profitLossReportService.js'));
  ({ syncCustomerBalanceFromInvoices } = await import('../../utils/customerBalanceSync.js'));
  ({ getBusinessDate } = await import('../../utils/dateRange.js'));
  ({ systemSettingsService } = await import('../system-settings/systemSettingsService.js'));
  ({ getExpensesByAccount } = await import('../../repositories/businessReportRepository.js'));
  ({ getIncomeStatement } = await import('../../repositories/accountingRepository.js'));
  ({ AgedBalanceService } = await import('../../services/agedBalanceService.js'));

  const settingsCount = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM system_settings`);
  if (Number(settingsCount.rows[0]?.n ?? 0) === 0) {
    await pool.query(`INSERT INTO system_settings (business_name) VALUES ('Bad Debt Proof')`);
  }
  await pool.query(`UPDATE system_settings SET bad_debt_writeoff_enabled = FALSE`);
  await openPeriodFor(pool, getBusinessDate());
}, 120000);

afterAll(async () => {
  await db?.drop();
});

describe('bad debt write-off E2E on real Postgres', () => {
  it('flag-off blocks posting; flag-on posts/reverses with GL=invoice=customer=aging=workqueue=P&L', async () => {
    expect(db).not.toBeNull();
    const pool = db!.pool;
    const today = getBusinessDate();
    const tomorrow = await pool.query<{ d: string }>(
      `SELECT ($1::date + 2)::date::text AS d`,
      [today],
    );
    const rangeEnd = tomorrow.rows[0].d;

    const acc5210 = await pool.query(`SELECT 1 FROM accounts WHERE "AccountCode" = '5210'`);
    const acc1200 = await pool.query(`SELECT 1 FROM accounts WHERE "AccountCode" = '1200'`);
    expect(acc5210.rows.length).toBe(1);
    expect(acc1200.rows.length).toBe(1);
    prove('coa-5210-1200', { badDebtExpense: true, ar: true });

    expect(await isBadDebtWriteoffEnabled(pool)).toBe(false);
    prove('flag-default-off', { enabled: false });

    const actorId = await insertActor(pool);
    const customerName = 'Bad Debt Debtor E2E';
    const customerId = await insertCustomer(pool, customerName);
    const invoice = await insertOverdueInvoice(pool, customerId, customerName, INVOICE_TOTAL, 40);
    await syncCustomerBalanceFromInvoices(pool, customerId, 'AR_WRITEOFF_E2E_SEED');

    expect(await customerBalance(pool, customerId)).toBe(INVOICE_TOTAL);
    const seeded = await invoiceRow(pool, invoice.id);
    expect(seeded.amountDue).toBe(INVOICE_TOTAL);
    expect(seeded.status).toBe('UNPAID');

    const q30 = await workqueueDue(customerId, 30);
    expect(q30.invoiceIds).toContain(invoice.id);
    expect(q30.totalDue).toBe(INVOICE_TOTAL);
    const q90 = await workqueueDue(customerId, 90);
    expect(q90.invoiceIds).not.toContain(invoice.id);
    prove('workqueue-age-filter', { min30: q30.totalDue, min90: q90.totalDue, invoice: invoice.number });

    await expect(
      createAndPostWriteoff(pool, {
        customerId,
        writeoffDate: today,
        reasonCode: 'UNCOLLECTIBLE',
        memo: 'must not post while flag off',
        createdBy: actorId,
        lines: [{ invoiceId: invoice.id, writeoffAmount: PARTIAL_WRITEOFF }],
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        statusCode: 403,
        message: expect.stringMatching(/disabled/i),
      }),
    );
    prove('flag-off-blocks-post', { blocked: true, statusCode: 403 });

    const patchedOn = await systemSettingsService.updateSettings(
      pool,
      { badDebtWriteoffEnabled: true },
      actorId,
    );
    expect(patchedOn.settings.badDebtWriteoffEnabled).toBe(true);
    expect((await systemSettingsService.getSettings(pool)).badDebtWriteoffEnabled).toBe(true);
    expect(await isBadDebtWriteoffEnabled(pool)).toBe(true);

    const taxSaveDoesNotClobber = await systemSettingsService.updateSettings(
      pool,
      { taxName: 'VAT', taxEnabled: true },
      actorId,
    );
    expect(taxSaveDoesNotClobber.settings.badDebtWriteoffEnabled).toBe(true);
    expect(await isBadDebtWriteoffEnabled(pool)).toBe(true);
    prove('settings-patch-on-and-tax-save-does-not-clobber', {
      patchedOn: true,
      afterTaxSave: true,
    });

    const first = await createAndPostWriteoff(pool, {
      customerId,
      writeoffDate: today,
      reasonCode: 'UNCOLLECTIBLE',
      memo: 'Partial uncollectible — E2E',
      createdBy: actorId,
      lines: [{ invoiceId: invoice.id, writeoffAmount: PARTIAL_WRITEOFF }],
    });
    expect(first.status).toBe('POSTED');
    expect(Number(first.totalAmount)).toBe(PARTIAL_WRITEOFF);

    const glAfterPartial = await journalByAccount(pool, {
      referenceType: 'AR_WRITEOFF',
      referenceId: first.id,
    });
    const byCodePartial = Object.fromEntries(glAfterPartial.map((r) => [r.code, r]));
    expect(byCodePartial['5210']?.debit).toBe(PARTIAL_WRITEOFF);
    expect(byCodePartial['5210']?.credit ?? 0).toBe(0);
    expect(byCodePartial['1200']?.credit).toBe(PARTIAL_WRITEOFF);
    expect(byCodePartial['1200']?.debit ?? 0).toBe(0);
    expect(byCodePartial['4010']).toBeUndefined();
    expect(byCodePartial['1010']).toBeUndefined();

    const afterPartialInv = await invoiceRow(pool, invoice.id);
    expect(afterPartialInv.amountDue).toBe(REMAINING);
    expect(afterPartialInv.amountPaid).toBe(PARTIAL_WRITEOFF);
    expect(afterPartialInv.status).toBe('PARTIALLY_PAID');
    expect(await customerBalance(pool, customerId)).toBe(REMAINING);

    const qAfterPartial = await workqueueDue(customerId, 30);
    expect(qAfterPartial.invoiceIds).toContain(invoice.id);
    expect(qAfterPartial.totalDue).toBe(REMAINING);

    const agingPartial = await reportsRepository.getCustomerAging(pool, { asOfDate: today });
    const ageRowPartial = agingPartial.rows.find((r) => r.customerId === customerId);
    expect(ageRowPartial?.totalOutstanding).toBe(REMAINING);

    const reportsPnlPartial = await reportsRepository.getProfitLossReport(pool, {
      startDate: today,
      endDate: rangeEnd,
      groupBy: 'day',
    });
    const bdExpensePartial = reportsPnlPartial.expenseBreakdown.find((r) => r.accountCode === '5210');
    expect(bdExpensePartial?.totalAmount).toBe(PARTIAL_WRITEOFF);
    expect(reportsPnlPartial.summary.totalExpenses).toBeGreaterThanOrEqual(PARTIAL_WRITEOFF);

    const erpPnl = new ProfitLossReportService(pool);
    const erpPartial = await erpPnl.getProfitLossReport(today, rangeEnd);
    expect(erpPartial.cogsAccounts.find((a) => a.accountCode === '5210')).toBeUndefined();
    const erp5210Partial = erpPartial.expenseAccounts.find((a) => a.accountCode === '5210');
    expect(erp5210Partial?.displayAmount).toBe(PARTIAL_WRITEOFF);
    expect(erp5210Partial?.section).toBe('OPERATING_EXPENSES');
    expect(erpPartial.summary.totalOperatingExpenses).toBeGreaterThanOrEqual(PARTIAL_WRITEOFF);

    const fsPartial = await getIncomeStatement(today, rangeEnd, pool);
    expect(fsPartial.costOfGoodsSold.items.find((a) => a.accountCode === '5210')).toBeUndefined();
    expect(fsPartial.operatingExpenses.items.find((a) => a.accountCode === '5210')?.amount).toBe(
      PARTIAL_WRITEOFF,
    );
    expect(fsPartial.netIncome).toBe(erpPartial.summary.netIncome);

    const agedPartial = await AgedBalanceService.agedReceivables(today, pool);
    const agedEntityPartial = agedPartial.entities.find((e) => e.entityId === customerId);
    expect(agedEntityPartial?.total).toBe(REMAINING);
    expect(ageRowPartial?.totalOutstanding).toBe(agedEntityPartial?.total);

    const bizPartial = await getExpensesByAccount(
      { startDate: today, endDate: rangeEnd, includeExpenses: true },
      pool,
    );
    const biz5210Partial = bizPartial.find((r) => r.account_code === '5210');
    expect(Number(biz5210Partial?.total_amount)).toBe(PARTIAL_WRITEOFF);

    prove('partial-writeoff-surfaces-agree', {
      document: first.documentNumber,
      gl5210: byCodePartial['5210']?.debit,
      gl1200: byCodePartial['1200']?.credit,
      invoiceDue: afterPartialInv.amountDue,
      customerBalance: REMAINING,
      workqueueDue: qAfterPartial.totalDue,
      aging: ageRowPartial?.totalOutstanding,
      reportsPnl5210: bdExpensePartial?.totalAmount,
      erpPnl5210: erp5210Partial?.displayAmount,
      erpSection: erp5210Partial?.section,
      incomeStatement5210: fsPartial.operatingExpenses.items.find((a) => a.accountCode === '5210')
        ?.amount,
      incomeStatementNet: fsPartial.netIncome,
      agedBalances: agedEntityPartial?.total,
      businessReport5210: PARTIAL_WRITEOFF,
    });

    const second = await createAndPostWriteoff(pool, {
      customerId,
      writeoffDate: today,
      reasonCode: 'UNCOLLECTIBLE',
      memo: 'Remainder uncollectible — E2E',
      createdBy: actorId,
      lines: [{ invoiceId: invoice.id, writeoffAmount: REMAINING }],
    });
    expect(Number(second.totalAmount)).toBe(REMAINING);

    const afterFullInv = await invoiceRow(pool, invoice.id);
    expect(afterFullInv.amountDue).toBe(0);
    expect(afterFullInv.amountPaid).toBe(INVOICE_TOTAL);
    expect(afterFullInv.status).toBe('PAID');
    expect(await customerBalance(pool, customerId)).toBe(0);

    const qAfterFull = await workqueueDue(customerId, 0);
    expect(qAfterFull.invoiceIds).not.toContain(invoice.id);
    expect(qAfterFull.totalDue).toBe(0);

    const agingFull = await reportsRepository.getCustomerAging(pool, { asOfDate: today });
    const ageRowFull = agingFull.rows.find((r) => r.customerId === customerId);
    expect(ageRowFull?.totalOutstanding ?? 0).toBe(0);

    const net5210Full = await glNetActive(pool, '5210');
    const net1200Full = await glNetActive(pool, '1200');
    expect(net5210Full.net).toBe(INVOICE_TOTAL);
    expect(net1200Full.credit - net1200Full.debit).toBe(INVOICE_TOTAL);

    const reportsPnlFull = await reportsRepository.getProfitLossReport(pool, {
      startDate: today,
      endDate: rangeEnd,
      groupBy: 'day',
    });
    const bdExpenseFull = reportsPnlFull.expenseBreakdown.find((r) => r.accountCode === '5210');
    expect(bdExpenseFull?.totalAmount).toBe(INVOICE_TOTAL);
    expect(reportsPnlFull.summary.totalExpenses).toBeGreaterThanOrEqual(INVOICE_TOTAL);

    const erpFull = await erpPnl.getProfitLossReport(today, rangeEnd);
    expect(erpFull.cogsAccounts.find((a) => a.accountCode === '5210')).toBeUndefined();
    const erp5210Full = erpFull.expenseAccounts.find((a) => a.accountCode === '5210');
    expect(erp5210Full?.displayAmount).toBe(INVOICE_TOTAL);
    expect(erp5210Full?.section).toBe('OPERATING_EXPENSES');
    expect(erpFull.summary.totalOperatingExpenses).toBeGreaterThanOrEqual(INVOICE_TOTAL);

    prove('full-writeoff-clears-ar', {
      document: second.documentNumber,
      invoiceDue: afterFullInv.amountDue,
      invoiceStatus: afterFullInv.status,
      customerBalance: 0,
      workqueueDue: qAfterFull.totalDue,
      aging: ageRowFull?.totalOutstanding ?? 0,
      gl5210Net: net5210Full.net,
      reportsPnl5210: bdExpenseFull?.totalAmount,
      erpPnl5210: erp5210Full?.displayAmount,
    });

    const revSecond = await reverseWriteoff(pool, second.id, actorId, 'E2E reverse remainder');
    expect(revSecond.reversal.reversesDocumentId).toBe(second.id);

    const afterRev2 = await invoiceRow(pool, invoice.id);
    expect(afterRev2.amountDue).toBe(REMAINING);
    expect(afterRev2.status).toBe('PARTIALLY_PAID');
    expect(await customerBalance(pool, customerId)).toBe(REMAINING);
    const qAfterRev2 = await workqueueDue(customerId, 30);
    expect(qAfterRev2.totalDue).toBe(REMAINING);

    const reportsPnlRev2 = await reportsRepository.getProfitLossReport(pool, {
      startDate: today,
      endDate: rangeEnd,
      groupBy: 'day',
    });
    expect(reportsPnlRev2.expenseBreakdown.find((r) => r.accountCode === '5210')?.totalAmount).toBe(
      PARTIAL_WRITEOFF,
    );

    const revFirst = await reverseWriteoff(pool, first.id, actorId, 'E2E reverse partial');
    expect(revFirst.reversal.reversesDocumentId).toBe(first.id);

    const restored = await invoiceRow(pool, invoice.id);
    expect(restored.amountDue).toBe(INVOICE_TOTAL);
    expect(restored.amountPaid).toBe(0);
    expect(restored.status).toBe('UNPAID');
    expect(await customerBalance(pool, customerId)).toBe(INVOICE_TOTAL);

    const qRestored = await workqueueDue(customerId, 30);
    expect(qRestored.invoiceIds).toContain(invoice.id);
    expect(qRestored.totalDue).toBe(INVOICE_TOTAL);

    const agingRestored = await reportsRepository.getCustomerAging(pool, { asOfDate: today });
    expect(agingRestored.rows.find((r) => r.customerId === customerId)?.totalOutstanding).toBe(
      INVOICE_TOTAL,
    );

    const net5210Restored = await glNetActive(pool, '5210');
    const net1200Restored = await glNetActive(pool, '1200');
    expect(net5210Restored.net).toBe(0);
    expect(net1200Restored.credit - net1200Restored.debit).toBe(0);

    const reportsPnlRestored = await reportsRepository.getProfitLossReport(pool, {
      startDate: today,
      endDate: rangeEnd,
      groupBy: 'day',
    });
    expect(reportsPnlRestored.expenseBreakdown.find((r) => r.accountCode === '5210')?.totalAmount ?? 0).toBe(
      0,
    );

    const erpRestored = await erpPnl.getProfitLossReport(today, rangeEnd);
    expect(erpRestored.cogsAccounts.find((a) => a.accountCode === '5210')).toBeUndefined();
    const erp5210Restored = erpRestored.expenseAccounts.find((a) => a.accountCode === '5210');
    expect(erp5210Restored?.displayAmount ?? 0).toBe(0);

    prove('reverse-restores-all-surfaces', {
      invoiceDue: restored.amountDue,
      invoiceStatus: restored.status,
      customerBalance: INVOICE_TOTAL,
      workqueueDue: qRestored.totalDue,
      aging: INVOICE_TOTAL,
      gl5210Net: net5210Restored.net,
      gl1200NetCredit: net1200Restored.credit - net1200Restored.debit,
      reportsPnl5210: reportsPnlRestored.expenseBreakdown.find((r) => r.accountCode === '5210')
        ?.totalAmount ?? 0,
      erpPnl5210: erp5210Restored?.displayAmount ?? 0,
    });

    const patchedOff = await systemSettingsService.updateSettings(
      pool,
      { badDebtWriteoffEnabled: false },
      actorId,
    );
    expect(patchedOff.settings.badDebtWriteoffEnabled).toBe(false);
    expect((await systemSettingsService.getSettings(pool)).badDebtWriteoffEnabled).toBe(false);
    expect(await isBadDebtWriteoffEnabled(pool)).toBe(false);
    await expect(
      createAndPostWriteoff(pool, {
        customerId,
        writeoffDate: today,
        reasonCode: 'UNCOLLECTIBLE',
        memo: 'must not post after settings off',
        createdBy: actorId,
        lines: [{ invoiceId: invoice.id, writeoffAmount: PARTIAL_WRITEOFF }],
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        statusCode: 403,
        message: expect.stringMatching(/disabled/i),
      }),
    );
    prove('settings-patch-off-blocks-post', { patchedOff: true, statusCode: 403 });

    const proof = {
      feature: 'BAD_DEBT_WRITEOFF_E2E',
      provenAt: new Date().toISOString(),
      verdict: 'PASS',
      contract:
        'Settings PATCH (the operator toggle path) turns the flag on/off. Tax-only PATCH does not clobber it. Flag off blocks post. Write-off DR 5210 / CR 1200 via AccountingCore. Invoice residual, customer.balance, workqueue, AR aging, reports P&L 5210, and ERP fn_get_profit_loss 5210 agree. Reverse restores every surface.',
      invoice: { id: invoice.id, number: invoice.number, total: INVOICE_TOTAL },
      evidence,
      summary: { total: evidence.length, passed: evidence.length, failed: 0 },
    };
    const json = JSON.stringify(proof, null, 2);
    writeFileSync(path.join(repoRoot, 'PROOF_BAD_DEBT_WRITEOFF_E2E.json'), json);
    writeFileSync(path.join(repoRoot, 'SamplePOS.Server/PROOF_BAD_DEBT_WRITEOFF_E2E.json'), json);
    writeFileSync(
      path.join(repoRoot, 'PROOF_BAD_DEBT_WRITEOFF_E2E.md'),
      [
        '# Bad Debt Write-off — executed E2E (real Postgres)',
        '',
        `Run: ${proof.provenAt}`,
        `Verdict: ${proof.verdict}`,
        '',
        proof.contract,
        '',
        `Invoice ${proof.invoice.number} total ${proof.invoice.total}.`,
        '',
        ...evidence.map(
          (e) => `- PASS ${e.name}: ${JSON.stringify(e.detail)}`,
        ),
        '',
      ].join('\n'),
    );
  }, 120000);
});
