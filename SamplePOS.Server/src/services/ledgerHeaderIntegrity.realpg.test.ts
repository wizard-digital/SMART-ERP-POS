/**
 * Option A for TXN-002362: the posted journal is not edited. The integrity check must
 *   H1  match the fingerprint in ops/ledger-known-exceptions.json and nothing else
 *   H2  pass on the local Henber copy (the real exception) and on Blis (no exception)
 *   H3  fail if a second mismatch appears, if the fingerprint changes, or if the listed journal is missing
 *   H4  refuse to treat an economically UNbalanced journal as an exception
 *   H5  a journal written through AccountingCore cannot be this class of defect
 *   H6  the production gate SQL is the same string this module exports (no silent drift)
 *
 * H2 skips loudly when rehearsal_* is absent. Nothing here talks to production.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  HEADER_MISMATCH_SQL,
  KNOWN_EXCEPTIONS_PATH,
  evaluateLedgerHeaderIntegrity,
  loadKnownHeaderExceptions,
  matchHeaderMismatches,
} from './ledgerHeaderIntegrity.js';
import { connectLocalIfExists, createScratchFromTemplate, type TemplateScratch } from '../test/realPgTemplate.js';

const ROOT = resolve(process.cwd(), '..');
const GATE = readFileSync(join(ROOT, 'SamplePOS.Server', 'scripts', 'gates', 'prod-readonly-gates.mjs'), 'utf8');
const EXN = loadKnownHeaderExceptions().find((e) => e.id === 'HENBER-TXN-002362')!;

const row = (over: Record<string, string> = {}) => ({
  txn: EXN.transactionNumber, rt: EXN.referenceType, rn: EXN.referenceNumber,
  hdr_dr: EXN.headerDebit, hdr_cr: EXN.headerCredit, ent_dr: EXN.entriesDebit, ent_cr: EXN.entriesCredit,
  amt_dr: EXN.amountDebit, amt_cr: EXN.amountCredit, ...over,
});

describe('ledger header integrity — Option A known exception', () => {
  it('H1 fingerprint: the documented exception matches; anything else is unknown or stale', () => {
    expect(EXN.decision).toBe('A');
    expect(EXN.economicBalanced).toBe(true);
    const ok = matchHeaderMismatches('henber', [row()]);
    expect(ok.pass).toBe(true);
    expect(ok.matched).toHaveLength(1);
    expect(ok.unknown).toHaveLength(0);
    expect(ok.stale).toHaveLength(0);

    const extra = matchHeaderMismatches('henber', [row(), row({ txn: 'TXN-999999', hdr_dr: '10.00', ent_dr: '9.00', ent_cr: '9.00', hdr_cr: '10.00', amt_dr: '10.00', amt_cr: '10.00' })]);
    expect(extra.pass).toBe(false);
    expect(extra.unknown.map((u) => u.txn)).toEqual(['TXN-999999']);

    const moved = matchHeaderMismatches('henber', [row({ hdr_dr: '13850.00', hdr_cr: '13850.00' })]);
    expect(moved.pass).toBe(false);
    expect(moved.stale.map((s) => s.id)).toEqual(['HENBER-TXN-002362']);
    expect(moved.unknown).toHaveLength(1);

    const missing = matchHeaderMismatches('henber', []);
    expect(missing.pass).toBe(false);
    expect(missing.stale).toHaveLength(1);

    const otherTenant = matchHeaderMismatches('blis', [row()]);
    expect(otherTenant.pass).toBe(false);
    expect(otherTenant.unknown).toHaveLength(1);
    expect(matchHeaderMismatches('blis', []).pass).toBe(true);
  });

  it('H4 an unbalanced "exception" is never accepted even if the numbers are listed', () => {
    const unbalanced = matchHeaderMismatches('henber', [row({ ent_dr: '13850.00', ent_cr: '100.00' })], [{ ...EXN, entriesCredit: '100.00', economicBalanced: true }]);
    expect(unbalanced.pass).toBe(false);
    expect(unbalanced.unknown).toHaveLength(1);
  });

  it('H6 production gate uses the same SQL and the same exceptions file', () => {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    expect(norm(GATE)).toContain(norm(HEADER_MISMATCH_SQL));
    expect(GATE).toContain('ledger-known-exceptions.json');
    expect(GATE).toContain('stale');
    expect(readFileSync(KNOWN_EXCEPTIONS_PATH, 'utf8')).toContain('TXN-002362');
  });
});

describe('ledger header integrity — local copies of production ledgers', () => {
  it('H2 henber copy: exactly TXN-002362, fingerprint matches, economically balanced', async () => {
    const pool = await connectLocalIfExists('rehearsal_henber');
    if (!pool) {
      // eslint-disable-next-line no-console
      console.warn('\n*** H2 SKIPPED — rehearsal_henber missing. NOT verified against the Henber copy. ***\n');
      return;
    }
    try {
      const report = await evaluateLedgerHeaderIntegrity(pool, 'henber');
      expect(report.pass).toBe(true);
      expect(report.matched.map((m) => m.row.txn)).toEqual(['TXN-002362']);
      expect(report.matched[0].row.ent_dr).toBe(report.matched[0].row.ent_cr);
    } finally {
      await pool.end();
    }
  });

  it('H2 blis copy: no header/Amount mismatches', async () => {
    const pool = await connectLocalIfExists('rehearsal_blis');
    if (!pool) {
      // eslint-disable-next-line no-console
      console.warn('\n*** H2 SKIPPED — rehearsal_blis missing. ***\n');
      return;
    }
    try {
      expect((await evaluateLedgerHeaderIntegrity(pool, 'blis')).pass).toBe(true);
    } finally {
      await pool.end();
    }
  });
});

describe('ledger header integrity — planted defects on a scratch template clone', () => {
  let db: TemplateScratch | null = null;
  beforeAllMaybe();
  function beforeAllMaybe() {
    beforeAll(async () => {
      db = await createScratchFromTemplate();
      if (!db) console.warn('\n*** H3–H5 SKIPPED — sp_template_local missing. ***\n');
    }, 60000);
    afterAll(async () => { await db?.drop(); });
  }

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => { if (!db) return; await fn(); });

  async function plant(over: { txn: string; rn: string; hdr: number; ent: number; amt: number }) {
    const cash = (await db!.pool.query(`SELECT "Id" id FROM accounts WHERE "AccountCode"='1010'`)).rows[0].id;
    const rev = (await db!.pool.query(`SELECT "Id" id FROM accounts WHERE "AccountCode"='4000'`)).rows[0].id;
    const id = randomUUID();
    await db!.pool.query(
      `INSERT INTO ledger_transactions ("Id","TransactionNumber","TransactionDate","ReferenceType","ReferenceId","ReferenceNumber","Description","TotalDebitAmount","TotalCreditAmount","Status","IsReversed","IdempotencyKey","CreatedAt","UpdatedAt")
       VALUES ($1,$2,'2026-04-04','SALE',$3,$4,'planted', $5, $5, 'POSTED', false, $6, NOW(), NOW())`,
      [id, over.txn, randomUUID(), over.rn, over.hdr, `planted-${over.txn}`],
    );
    await db!.pool.query(
      `INSERT INTO ledger_entries ("Id","TransactionId","LedgerTransactionId","AccountId","EntryType","Amount","DebitAmount","CreditAmount","Description","LineNumber","EntryDate","CreatedAt")
       VALUES (gen_random_uuid(),$1,$1,$2,'DEBIT',$3,$4,0,'planted dr',1,'2026-04-04',NOW()),
              (gen_random_uuid(),$1,$1,$5,'CREDIT',$3,0,$4,'planted cr',2,'2026-04-04',NOW())`,
      [id, cash, over.amt, over.ent, rev],
    );
  }

  maybe('H3 a second mismatch is unknown (the list cannot hide new defects)', async () => {
    await plant({ txn: 'TXN-002362', rn: 'SALE-2026-0011', hdr: 14850, ent: 13850, amt: 14850 });
    expect((await evaluateLedgerHeaderIntegrity(db!.pool, 'henber')).pass).toBe(true);
    await plant({ txn: 'TXN-009999', rn: 'SALE-9999', hdr: 100, ent: 90, amt: 100 });
    const r = await evaluateLedgerHeaderIntegrity(db!.pool, 'henber');
    expect(r.pass).toBe(false);
    expect(r.unknown.map((u) => u.txn)).toEqual(['TXN-009999']);
    expect(r.matched.map((m) => m.row.txn)).toEqual(['TXN-002362']);
  });

  maybe('H5 AccountingCore posting cannot create a header/Amount mismatch', async () => {
    const { recordSaleToGL } = await import('./glEntryService.js');
    const saleId = randomUUID();
    await recordSaleToGL(
      {
        saleId, saleNumber: `SALE-H5-${saleId.slice(0, 6)}`, saleDate: '2026-10-29',
        totalAmount: 5000, costAmount: 0, paymentMethod: 'CASH', amountPaid: 5000, taxAmount: 0,
        saleItems: [{ productType: 'service', totalPrice: 5000, unitCost: 0, quantity: 1 }],
      } as unknown as Parameters<typeof recordSaleToGL>[0],
      db!.pool,
    );
    const chk = await db!.pool.query(
      `SELECT round(lt."TotalDebitAmount",2)::text hdr, round(sum(le."DebitAmount"),2)::text ent,
              count(*) FILTER (WHERE le."Amount" <> le."DebitAmount"+le."CreditAmount")::int bad
         FROM ledger_transactions lt JOIN ledger_entries le ON le."TransactionId"=lt."Id"
        WHERE lt."ReferenceId"=$1 GROUP BY lt."Id"`,
      [saleId],
    );
    expect(chk.rows[0].hdr).toBe(chk.rows[0].ent);
    expect(chk.rows[0].bad).toBe(0);
  });
});
