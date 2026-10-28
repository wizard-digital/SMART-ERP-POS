/**
 * Historical bank-mirror reconciliation — REAL Postgres (production template clone), REAL BankingService / AccountingCore.
 * Proves: classification by era and by GL support, idempotent apply (replay + concurrent runs), no journal is posted by the
 * mirror, reclassed sales link to the SALE_TENDER_RECLASS journal, and review-only populations are never auto-created.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { createScratchFromTemplate, type TemplateScratch } from '../test/realPgTemplate.js';

let db: TemplateScratch | null = null;
let recordSaleToGL: typeof import('./glEntryService.js').recordSaleToGL;
let BankingService: typeof import('./bankingService.js').BankingService;
let rec: typeof import('./bankMirrorReconcileService.js');
let reclass: typeof import('./saleTenderReclassService.js');

type Line = { paymentMethod: string; amount: number };
const S: Record<string, { id: string; no: string }> = {};

beforeAll(async () => {
  db = await createScratchFromTemplate();
  if (!db) {
    // eslint-disable-next-line no-console
    console.warn('\n*** bankMirrorReconcile.realpg: SKIPPED — local Postgres or sp_template_local missing. NOT verified. ***\n');
    return;
  }
  ({ recordSaleToGL } = await import('./glEntryService.js'));
  ({ BankingService } = await import('./bankingService.js'));
  rec = await import('./bankMirrorReconcileService.js');
  reclass = await import('./saleTenderReclassService.js');
  const { ensureDepositLiquidityBook } = await import('../modules/treasury/ensureDepositLiquidityBook.js');
  await ensureDepositLiquidityBook(db.pool, 'MOBILE_MONEY');
});
afterAll(async () => {
  await db?.drop();
});
const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!db) return;
    await fn();
  });

async function seed(tag: string, lines: Line[], o: { header?: string; legacy?: boolean; createdAt: string; total?: number }) {
  const id = randomUUID();
  const no = `SALE-M-${tag}-${id.slice(0, 4)}`;
  const total = o.total ?? lines.reduce((s, l) => s + l.amount, 0);
  await db!.pool.query(
    `INSERT INTO sales (id, sale_number, subtotal, total_amount, payment_method, amount_paid, status, sale_date, created_at)
     VALUES ($1,$2,$3,$3,$4::payment_method,$3,'COMPLETED',$5::date,$5::timestamptz)`,
    [id, no, total, o.header ?? lines[0].paymentMethod, o.createdAt],
  );
  for (const l of lines) await db!.pool.query(`INSERT INTO payment_lines (sale_id, payment_method, amount) VALUES ($1,$2,$3)`, [id, l.paymentMethod, l.amount]);
  await recordSaleToGL(
    {
      saleId: id, saleNumber: no, saleDate: o.createdAt.slice(0, 10), totalAmount: total, costAmount: 0,
      paymentMethod: o.header ?? lines[0].paymentMethod, amountPaid: total, taxAmount: 0,
      ...(o.legacy ? {} : { paymentLines: lines }),
      saleItems: [{ productType: 'service', totalPrice: total, unitCost: 0, quantity: 1 }],
    } as unknown as Parameters<typeof recordSaleToGL>[0],
    db!.pool,
  );
  S[tag] = { id, no };
}
const bankRows = async (id: string) =>
  (await db!.pool.query(`SELECT description, amount::float8 amount, gl_transaction_id FROM bank_transactions WHERE source_type='SALE' AND source_id=$1 ORDER BY description`, [id])).rows;
const journals = async () => (await db!.pool.query(`SELECT count(*)::int n FROM ledger_transactions`)).rows[0].n as number;

describe('historical bank-mirror reconciliation on real Postgres', () => {
  maybe('seed populations', async () => {
    // go-live anchor: first mirrored sale, 2026-09-25
    await seed('ANCHOR', [{ paymentMethod: 'MOBILE_MONEY', amount: 1000 }], { createdAt: '2026-09-25T10:00:00Z' });
    await BankingService.createFromSale(S.ANCHOR.id, S.ANCHOR.no, 1000, 'MOBILE_MONEY', '2026-09-25', db!.pool);
    await db!.pool.query(`UPDATE bank_transactions SET created_at='2026-09-25T10:00:01Z' WHERE source_id=$1`, [S.ANCHOR.id]);
    // PRE go-live, never in the register (policy decision, not a defect)
    await seed('PRE', [{ paymentMethod: 'MOBILE_MONEY', amount: 5000 }], { createdAt: '2026-08-10T10:00:00Z' });
    // POST go-live, posted with the fixed code but mirror was missed (e.g. Redis outage)
    await seed('MISS', [{ paymentMethod: 'CASH', amount: 10000 }, { paymentMethod: 'MOBILE_MONEY', amount: 30000 }], { createdAt: '2026-10-05T10:00:00Z' });
    // POST go-live, same-method split mirrored only in part
    await seed('UNDER', [{ paymentMethod: 'AIRTEL_MONEY', amount: 10000 }, { paymentMethod: 'AIRTEL_MONEY', amount: 20000 }], { createdAt: '2026-10-06T10:00:00Z' });
    await BankingService.createFromSale(S.UNDER.id, S.UNDER.no, 10000, 'AIRTEL_MONEY', '2026-10-06', db!.pool);
    // POST go-live, legacy GL (header CASH) -> GL does not support the MoMo amount until reclassed
    await seed('LEG', [{ paymentMethod: 'CASH', amount: 20000 }, { paymentMethod: 'MOBILE_MONEY', amount: 15000 }], { createdAt: '2026-10-07T10:00:00Z', header: 'CASH', legacy: true });
    // over-mirrored
    await seed('OVER', [{ paymentMethod: 'MOBILE_MONEY', amount: 4000 }], { createdAt: '2026-10-08T10:00:00Z' });
    await db!.pool.query(
      `INSERT INTO bank_transactions (id, transaction_number, bank_account_id, transaction_date, type, description, reference, amount, gl_transaction_id, source_type, source_id, is_reconciled, is_reversed, created_by)
       SELECT gen_random_uuid(), 'BTX-TEST-OVER', (SELECT id FROM bank_accounts WHERE gl_account_id=(SELECT "Id" FROM accounts WHERE "AccountCode"='1040') LIMIT 1), '2026-10-08', 'DEPOSIT',
              $2, $2, 9000, (SELECT "Id" FROM ledger_transactions WHERE "ReferenceId"=$1 AND "ReferenceType"='SALE'), 'SALE', $1, false, false, '00000000-0000-0000-0000-000000000000'`,
      [S.OVER.id, `Sale ${S.OVER.no} [MOBILE_MONEY]`],
    );
    // CARD: never mirrored by policy
    await seed('CARD', [{ paymentMethod: 'CARD', amount: 7000 }], { createdAt: '2026-10-09T10:00:00Z' });
  });

  maybe('PLAN is read-only and classifies by era / GL support / policy', async () => {
    const before = await journals();
    const plan = await rec.planBankMirrorReconcile(db!.pool);
    expect(await journals()).toBe(before);
    const st = (tag: string) => plan.eligible.concat(plan.review).find((r) => r.saleId === S[tag].id);
    expect(st('MISS')).toMatchObject({ status: 'MISSING_ELIGIBLE', era: 'POST_GOLIVE', createCents: 3_000_000 });
    expect(st('UNDER')).toMatchObject({ status: 'UNDER_ELIGIBLE', createCents: 2_000_000 });
    expect(st('LEG')).toMatchObject({ status: 'REVIEW_GL_DOES_NOT_SUPPORT' });
    expect(st('OVER')).toMatchObject({ status: 'REVIEW_OVER_MIRRORED' });
    expect(st('PRE')).toMatchObject({ status: 'MISSING_ELIGIBLE', era: 'PRE_GOLIVE' }); // exists, but approved separately by era
    expect(st('CARD')).toBeUndefined(); // CARD excluded by policy
    const post = await rec.planBankMirrorReconcile(db!.pool, { era: 'POST_GOLIVE' });
    expect(post.eligible.map((r) => r.saleId).sort()).toEqual([S.MISS.id, S.UNDER.id].sort());
    expect(post.eligible.some((r) => r.era === 'PRE_GOLIVE')).toBe(false);
  });

  maybe('APPLY refuses without approval or with a stale fingerprint', async () => {
    const plan = await rec.planBankMirrorReconcile(db!.pool, { era: 'POST_GOLIVE' });
    await expect(rec.applyBankMirrorReconcile(db!.pool, { approvalRef: '', approvedFingerprint: plan.fingerprint, era: 'POST_GOLIVE' })).rejects.toThrow(/approvalRef/);
    await expect(rec.applyBankMirrorReconcile(db!.pool, { approvalRef: 'APPR-2', approvedFingerprint: 'beef', era: 'POST_GOLIVE' })).rejects.toThrow(/Plan changed/);
  });

  maybe('APPLY (POST_GOLIVE): creates exactly the planned rows, posts no journal; two concurrent runs create no duplicates', async () => {
    const plan = await rec.planBankMirrorReconcile(db!.pool, { era: 'POST_GOLIVE' });
    const j0 = await journals();
    const runs = await Promise.allSettled([
      rec.applyBankMirrorReconcile(db!.pool, { approvalRef: 'APPR-2', approvedFingerprint: plan.fingerprint, era: 'POST_GOLIVE' }),
      rec.applyBankMirrorReconcile(db!.pool, { approvalRef: 'APPR-2', approvedFingerprint: plan.fingerprint, era: 'POST_GOLIVE' }),
    ]);
    // a run that re-plans after the other finished is REFUSED as stale (safe); one that overlapped is absorbed by the unique index
    let created = 0;
    for (const r of runs) {
      if (r.status === 'fulfilled') {
        expect(r.value.failed).toEqual([]);
        created += r.value.created;
      } else {
        expect(String(r.reason)).toMatch(/Plan changed/);
      }
    }
    expect(created).toBe(2); // exactly the two planned rows across both runs, whichever interleaving occurred
    expect(await journals()).toBe(j0);
    expect(await bankRows(S.MISS.id)).toMatchObject([{ description: `Sale ${S.MISS.no} [MOBILE_MONEY]`, amount: 30000 }]);
    const under = await bankRows(S.UNDER.id);
    expect(under.map((r) => [r.description, r.amount])).toEqual([
      [`Sale ${S.UNDER.no} [AIRTEL_MONEY]`, 10000],
      [`Sale ${S.UNDER.no} [AIRTEL_MONEY] (supplement)`, 20000],
    ]);
  });

  maybe('POST-OP RECONCILIATION: re-plan has no eligible POST_GOLIVE rows; replay is a no-op', async () => {
    const plan = await rec.planBankMirrorReconcile(db!.pool, { era: 'POST_GOLIVE' });
    expect(plan.eligible).toEqual([]);
    const again = await rec.applyBankMirrorReconcile(db!.pool, { approvalRef: 'APPR-2', approvedFingerprint: plan.fingerprint, era: 'POST_GOLIVE' });
    expect(again).toEqual({ created: 0, alreadyMirrored: 0, failed: [] });
  });

  maybe('legacy-GL sale: after the audited tender reclass, the mirror links to the SALE_TENDER_RECLASS journal (no second journal)', async () => {
    const tp = await reclass.planSaleTenderReclass(db!.pool);
    const mine = tp.eligible.filter((r) => r.saleId === S.LEG.id);
    expect(mine).toHaveLength(1);
    await reclass.applySaleTenderReclass(db!.pool, { approvalRef: 'APPR-3', approvedFingerprint: tp.fingerprint, entryDate: '2026-10-28' });
    const plan = await rec.planBankMirrorReconcile(db!.pool, { era: 'POST_GOLIVE' });
    expect(plan.eligible.map((r) => r.saleId)).toContain(S.LEG.id);
    const j0 = await journals();
    const res = await rec.applyBankMirrorReconcile(db!.pool, { approvalRef: 'APPR-4', approvedFingerprint: plan.fingerprint, era: 'POST_GOLIVE' });
    expect(res.failed).toEqual([]);
    expect(await journals()).toBe(j0);
    const rows = await bankRows(S.LEG.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(15000);
    const link = await db!.pool.query(`SELECT "ReferenceType" FROM ledger_transactions WHERE "Id"=$1`, [rows[0].gl_transaction_id]);
    expect(link.rows[0].ReferenceType).toBe('SALE_TENDER_RECLASS');
  });

  maybe('PRE_GOLIVE and review populations were never touched by the POST_GOLIVE approvals', async () => {
    expect(await bankRows(S.PRE.id)).toEqual([]);
    expect(await bankRows(S.CARD.id)).toEqual([]);
    expect((await bankRows(S.OVER.id)).map((r) => r.amount)).toEqual([9000]);
  });
});
