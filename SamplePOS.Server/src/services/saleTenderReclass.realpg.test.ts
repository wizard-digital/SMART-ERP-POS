/**
 * Historical split-tender correction — REAL Postgres (production template clone), REAL AccountingCore.
 * Proves: dry run is read-only; correction is balanced and liquidity<->liquidity only; revenue/tax/AR/total
 * liquidity/trial balance unchanged; posted journals never edited; per-account balances equal the tender
 * lines afterwards; replay is a no-op; stale/unapproved plans are refused; review-only populations untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { createScratchFromTemplate, insertCustomer, type TemplateScratch } from '../test/realPgTemplate.js';

let db: TemplateScratch | null = null;
let recordSaleToGL: typeof import('./glEntryService.js').recordSaleToGL;
let svc: typeof import('./saleTenderReclassService.js');

beforeAll(async () => {
  db = await createScratchFromTemplate();
  if (!db) {
    // eslint-disable-next-line no-console
    console.warn('\n*** saleTenderReclass.realpg: SKIPPED — local Postgres or sp_template_local missing. NOT verified. ***\n');
    return;
  }
  ({ recordSaleToGL } = await import('./glEntryService.js'));
  svc = await import('./saleTenderReclassService.js');
});
afterAll(async () => {
  await db?.drop();
});

type Line = { paymentMethod: string; amount: number };
const created: Record<string, string> = {};

/** Insert sale + payment_lines rows and post its GL. `legacy` = the pre-fix shape (no lines passed to GL). */
async function seedSale(tag: string, o: { header: string; total: number; paid?: number; lines: Line[]; legacy: boolean; customer?: boolean }) {
  const id = randomUUID();
  const customerId = o.customer ? await insertCustomer(db!.pool, `Cust ${tag}`) : null;
  const saleNumber = `SALE-R-${tag}-${id.slice(0, 4)}`;
  await db!.pool.query(
    `INSERT INTO sales (id, sale_number, subtotal, total_amount, payment_method, amount_paid, status, sale_date, customer_id)
     VALUES ($1,$2,$3,$3,$4::payment_method,$5,'COMPLETED','2026-10-20',$6)`,
    [id, saleNumber, o.total, o.header, o.paid ?? o.total, customerId],
  );
  for (const l of o.lines) {
    await db!.pool.query(`INSERT INTO payment_lines (sale_id, payment_method, amount) VALUES ($1,$2,$3)`, [id, l.paymentMethod, l.amount]);
  }
  await recordSaleToGL(
    {
      saleId: id, saleNumber, saleDate: '2026-10-20', totalAmount: o.total, costAmount: 0,
      paymentMethod: o.header, amountPaid: o.paid ?? o.total, taxAmount: 0,
      customerId: customerId ?? undefined,
      ...(o.legacy ? {} : { paymentLines: o.lines }),
      saleItems: [{ productType: 'service', totalPrice: o.total, unitCost: 0, quantity: 1 }],
    } as unknown as Parameters<typeof recordSaleToGL>[0],
    db!.pool,
  );
  created[tag] = id;
  return { id, saleNumber };
}

const balances = async () => {
  const r = await db!.pool.query(
    `SELECT a."AccountCode" code, round(COALESCE(sum(le."DebitAmount"-le."CreditAmount"),0),2)::float8 bal
       FROM accounts a LEFT JOIN ledger_entries le ON le."AccountId"=a."Id"
       LEFT JOIN ledger_transactions lt ON lt."Id"=le."TransactionId" AND lt."Status"='POSTED'
      WHERE a."AccountCode" IN ('1010','1020','1030','1040','1200','2300','4000','4100') GROUP BY 1 ORDER BY 1`,
  );
  return Object.fromEntries(r.rows.map((x) => [x.code, x.bal])) as Record<string, number>;
};
const tb = async () =>
  (await db!.pool.query(`SELECT round(sum("DebitAmount"),2)::float8 dr, round(sum("CreditAmount"),2)::float8 cr, count(*)::int n FROM ledger_entries`)).rows[0];
const ledgerChecksum = async () =>
  (await db!.pool.query(
    `SELECT md5(string_agg(le."Id"::text||le."AccountId"::text||le."DebitAmount"::text||le."CreditAmount"::text, ',' ORDER BY le."Id")) h, count(*)::int n
       FROM ledger_entries le JOIN ledger_transactions lt ON lt."Id"=le."TransactionId" WHERE lt."ReferenceType" <> 'SALE_TENDER_RECLASS'`,
  )).rows[0];

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!db) return;
    await fn();
  });

describe('historical split-tender reclassification on real Postgres', () => {
  maybe('seed: legacy-posted split sales + controls', async () => {
    await seedSale('A', { header: 'CASH', total: 40000, lines: [{ paymentMethod: 'CASH', amount: 20000 }, { paymentMethod: 'MOBILE_MONEY', amount: 15000 }, { paymentMethod: 'CARD', amount: 5000 }], legacy: true });
    await seedSale('B', { header: 'CASH', total: 25000, lines: [{ paymentMethod: 'BANK_TRANSFER', amount: 10000 }, { paymentMethod: 'CASH', amount: 30000 }], legacy: true }); // change given
    await seedSale('C', { header: 'CREDIT', total: 30000, paid: 12000, customer: true, lines: [{ paymentMethod: 'MOBILE_MONEY', amount: 12000 }, { paymentMethod: 'CREDIT', amount: 18000 }], legacy: true });
    await seedSale('D', { header: 'CASH', total: 10000, lines: [{ paymentMethod: 'CASH', amount: 10000 }], legacy: true }); // control: already right
    await seedSale('E', { header: 'CASH', total: 50000, lines: [{ paymentMethod: 'CASH', amount: 30000 }, { paymentMethod: 'AIRTEL_MONEY', amount: 20000 }], legacy: false }); // posted with the FIXED code
    await seedSale('F', { header: 'DEPOSIT', total: 40000, customer: true, lines: [{ paymentMethod: 'DEPOSIT', amount: 30000 }, { paymentMethod: 'CASH', amount: 10000 }], legacy: true }); // review only
    await seedSale('G', { header: 'CASH', total: 9000, lines: [{ paymentMethod: 'CASH', amount: 4000 }, { paymentMethod: 'CUSTOMER_CREDIT', amount: 5000 }], legacy: true }); // unmapped tender → review
  });

  maybe('DRY RUN is read-only and classifies every population explicitly', async () => {
    const before = await ledgerChecksum();
    const plan = await svc.planSaleTenderReclass(db!.pool);
    expect(await ledgerChecksum()).toEqual(before);
    expect(plan.population.ELIGIBLE).toBe(3); // A, B, C
    expect(plan.population.ALREADY_CORRECT).toBe(2); // D (cash only), E (fixed posting)
    expect(plan.population.REVIEW_DEPOSIT_TENDER).toBe(1); // F
    expect(plan.population.REVIEW_UNMAPPED_TENDER).toBe(1); // G (CUSTOMER_CREDIT)
    expect(plan.netMovementCents).toBe(0);
    const A = plan.eligible.find((r) => r.saleId === created.A)!;
    expect(A.deltaCents).toEqual({ '1010': -2000000, '1020': 500000, '1030': 0, '1040': 1500000 });
    const B = plan.eligible.find((r) => r.saleId === created.B)!; // 25,000 due: bank 10,000 + cash 15,000 (change clipped)
    expect(B.deltaCents).toEqual({ '1010': -1000000, '1020': 0, '1030': 1000000, '1040': 0 });
    const C = plan.eligible.find((r) => r.saleId === created.C)!; // part-paid credit: 12,000 MM, was all cash
    expect(C.deltaCents).toEqual({ '1010': -1200000, '1020': 0, '1030': 0, '1040': 1200000 });
  });

  maybe('APPLY refuses without approval, with a wrong fingerprint, or with a bad date', async () => {
    const plan = await svc.planSaleTenderReclass(db!.pool);
    await expect(svc.applySaleTenderReclass(db!.pool, { approvalRef: '', approvedFingerprint: plan.fingerprint, entryDate: '2026-10-28' })).rejects.toThrow(/approvalRef/);
    await expect(svc.applySaleTenderReclass(db!.pool, { approvalRef: 'APPR-1', approvedFingerprint: 'deadbeef', entryDate: '2026-10-28' })).rejects.toThrow(/Plan changed/);
    await expect(svc.applySaleTenderReclass(db!.pool, { approvalRef: 'APPR-1', approvedFingerprint: plan.fingerprint, entryDate: '28/10/2026' })).rejects.toThrow(/entryDate/);
  });

  maybe('APPLY: balanced liquidity-only journals; totals, revenue, tax, AR and TB unchanged; posted rows untouched', async () => {
    const plan = await svc.planSaleTenderReclass(db!.pool);
    const balBefore = await balances();
    const tbBefore = await tb();
    const checksumBefore = await ledgerChecksum();

    const res = await svc.applySaleTenderReclass(db!.pool, { approvalRef: 'APPR-TEST-1', approvedFingerprint: plan.fingerprint, entryDate: '2026-10-28' });
    expect(res).toMatchObject({ posted: 3, replayed: 0, failed: [] });

    const balAfter = await balances();
    // exact per-account movement == the plan
    for (const c of ['1010', '1020', '1030', '1040']) expect(Math.round((balAfter[c] - balBefore[c]) * 100)).toBe(plan.accountMovementCents[c]);
    // everything that is not tender is untouched
    for (const c of ['1200', '2300', '4000', '4100']) expect(balAfter[c]).toBe(balBefore[c]);
    const liq = (b: Record<string, number>) => Math.round((b['1010'] + b['1020'] + b['1030'] + b['1040']) * 100);
    expect(liq(balAfter)).toBe(liq(balBefore));
    // trial balance still balanced; only reclass entries were added; nothing pre-existing changed
    const tbAfter = await tb();
    expect(tbAfter.dr).toBe(tbAfter.cr);
    expect(tbAfter.n).toBeGreaterThan(tbBefore.n);
    expect(await ledgerChecksum()).toEqual(checksumBefore);
    // audit shape
    const j = await db!.pool.query(
      `SELECT "ReferenceType","PostingSource","IdempotencyKey","Description","TotalDebitAmount"::float8 d,"TotalCreditAmount"::float8 c
         FROM ledger_transactions WHERE "ReferenceType"='SALE_TENDER_RECLASS' ORDER BY "ReferenceNumber"`,
    );
    expect(j.rows).toHaveLength(3);
    for (const r of j.rows) {
      expect(r.PostingSource).toBe('SYSTEM_CORRECTION');
      expect(r.Description).toContain('APPR-TEST-1');
      expect(r.d).toBe(r.c);
      expect(r.IdempotencyKey).toMatch(/^SALE-TENDER-RECLASS-SALE-R-/);
    }
  });

  maybe('POST-OP RECONCILIATION: re-plan shows zero eligible; review populations unchanged; replay is a no-op', async () => {
    const plan = await svc.planSaleTenderReclass(db!.pool);
    expect(plan.population.ELIGIBLE).toBe(0);
    expect(plan.population.ALREADY_CORRECT).toBe(5); // A,B,C now correct + D,E
    expect(plan.population.REVIEW_DEPOSIT_TENDER).toBe(1);
    expect(plan.population.REVIEW_UNMAPPED_TENDER).toBe(1);
    const n1 = (await db!.pool.query(`SELECT count(*)::int n FROM ledger_transactions WHERE "ReferenceType"='SALE_TENDER_RECLASS'`)).rows[0].n;
    const res = await svc.applySaleTenderReclass(db!.pool, { approvalRef: 'APPR-TEST-1', approvedFingerprint: plan.fingerprint, entryDate: '2026-10-28' });
    expect(res.posted).toBe(0);
    const n2 = (await db!.pool.query(`SELECT count(*)::int n FROM ledger_transactions WHERE "ReferenceType"='SALE_TENDER_RECLASS'`)).rows[0].n;
    expect(n2).toBe(n1);
  });

  maybe('REVERSAL of a reclass journal restores that sale\'s liquidity and a re-apply is a new journal (not an edit)', async () => {
    const { AccountingCore } = await import('./accountingCore.js');
    const before = await balances();
    const reclass = await db!.pool.query(
      `SELECT "Id" id, "ReferenceId" sale FROM ledger_transactions WHERE "ReferenceType"='SALE_TENDER_RECLASS' AND "ReferenceId"=$1 AND COALESCE("IsReversed",false)=false`,
      [created.A],
    );
    expect(reclass.rowCount).toBe(1);
    await AccountingCore.reverseTransaction(
      { originalTransactionId: reclass.rows[0].id, reversalDate: '2026-10-28', reason: 'rollback rehearsal of split-tender reclass', userId: '00000000-0000-0000-0000-000000000000', idempotencyKey: `REV-RECLASS-A-${reclass.rows[0].id}` },
      db!.pool,
    );
    const orig = await db!.pool.query(`SELECT "Status", "IsReversed" FROM ledger_transactions WHERE "Id"=$1`, [reclass.rows[0].id]);
    expect(orig.rows[0]).toMatchObject({ Status: 'REVERSED', IsReversed: true });
    const plan = await svc.planSaleTenderReclass(db!.pool, { scope: 'SPLIT_TENDER' });
    expect(plan.eligible.map((r) => r.saleId)).toEqual([created.A]);
    expect(plan.eligible[0].deltaCents).toEqual({ '1010': -2000000, '1020': 500000, '1030': 0, '1040': 1500000 });
    const res = await svc.applySaleTenderReclass(db!.pool, { approvalRef: 'APPR-REAPPLY-A', approvedFingerprint: plan.fingerprint, entryDate: '2026-10-28', scope: 'SPLIT_TENDER' });
    expect(res.failed).toEqual([]);
    expect(res.posted).toBe(1);
    const n = (await db!.pool.query(`SELECT count(*)::int n FROM ledger_transactions WHERE "ReferenceType"='SALE_TENDER_RECLASS' AND "ReferenceId"=$1`, [created.A])).rows[0].n;
    expect(n).toBe(2); // reversed original + new (never edited the first)
    const after = await balances();
    for (const c of ['1010', '1020', '1030', '1040', '1200', '2300', '4000', '4100']) expect(after[c]).toBe(before[c]);
    const tbAfter = await tb();
    expect(tbAfter.dr).toBe(tbAfter.cr);
  });

  maybe('after reclass, per-account liquidity of the seeded sales equals the tender lines (A+B+C+D+E)', async () => {
    const r = await db!.pool.query(
      `SELECT a."AccountCode" code, round(sum(le."DebitAmount"-le."CreditAmount"),2)::float8 bal
         FROM ledger_entries le JOIN accounts a ON a."Id"=le."AccountId" JOIN ledger_transactions lt ON lt."Id"=le."TransactionId"
        WHERE lt."ReferenceId" = ANY($1::uuid[]) AND lt."ReferenceType" IN ('SALE','SALE_TENDER_RECLASS')
          AND COALESCE(lt."IsReversed",false)=false
          AND a."AccountCode" IN ('1010','1020','1030','1040') GROUP BY 1 ORDER BY 1`,
      [[created.A, created.B, created.C, created.D, created.E]],
    );
    // CASH: A 20,000 + B 15,000 (25,000 due − 10,000 bank) + D 10,000 + E 30,000 = 75,000 ; CARD 5,000 ;
    // BANK 10,000 ; MM/Airtel: A 15,000 + C 12,000 + E 20,000 = 47,000
    expect(Object.fromEntries(r.rows.map((x) => [x.code, x.bal]))).toEqual({ '1010': 75000, '1020': 5000, '1030': 10000, '1040': 47000 });
  });


});
