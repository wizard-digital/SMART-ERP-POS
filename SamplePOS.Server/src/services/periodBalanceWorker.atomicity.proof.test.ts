/**
 * PROOF — GL outbox worker with the REAL rebuild SQL (glPeriodRebuildService) on real Postgres:
 *  - balance upsert and DONE mark commit together (a failure of either leaves neither)
 *  - duplicate delivery / replay is idempotent (absolute recompute, one row)
 *  - concurrent workers on shared tuples neither deadlock nor corrupt totals
 *  - CLOSED periods are never touched
 *  - the ledger (journals) is never modified by recovery
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createScratchDb, histogram, insertEvents } from './periodBalanceWorker.testDb.js';

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const LEDGER_DDL = `
CREATE TABLE financial_periods (period_year INT NOT NULL, period_month INT NOT NULL, "Status" TEXT NOT NULL);
CREATE TABLE ledger_transactions (
  "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "TransactionDate" TIMESTAMPTZ NOT NULL,
  "Status" TEXT NOT NULL DEFAULT 'POSTED',
  "IsReversed" BOOLEAN NOT NULL DEFAULT FALSE,
  "ReversedByTransactionId" UUID
);
CREATE TABLE ledger_entries (
  "Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "TransactionId" UUID NOT NULL REFERENCES ledger_transactions("Id"),
  "AccountId" UUID NOT NULL,
  "DebitAmount" NUMERIC(18,2) NOT NULL DEFAULT 0,
  "CreditAmount" NUMERIC(18,2) NOT NULL DEFAULT 0
);
CREATE TABLE gl_period_balances (
  account_id UUID NOT NULL, fiscal_year INT NOT NULL, fiscal_period INT NOT NULL,
  debit_total NUMERIC(18,2) NOT NULL DEFAULT 0, credit_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  running_balance NUMERIC(18,2) NOT NULL DEFAULT 0, last_updated TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (account_id, fiscal_year, fiscal_period)
);`;

const { pollAndProcessPendingEvents } = await import('./periodBalanceWorker.js');

const db = await createScratchDb(LEDGER_DDL);
if (!db) console.error('[SKIPPED] local Postgres unreachable — outbox atomicity proofs NOT executed');
const suite = db ? describe : describe.skip;

async function post(accountId: string, debit: number, credit: number, date = '2026-05-15T10:00:00Z') {
  const t = await db!.pool.query<{ Id: string }>(
    `INSERT INTO ledger_transactions ("TransactionDate") VALUES ($1) RETURNING "Id"`, [date]);
  await db!.pool.query(
    `INSERT INTO ledger_entries ("TransactionId","AccountId","DebitAmount","CreditAmount") VALUES ($1,$2,$3,$4)`,
    [t.rows[0].Id, accountId, debit, credit]);
}
async function balance(accountId: string, period = 5) {
  const r = await db!.pool.query(
    `SELECT debit_total::float d, credit_total::float c, running_balance::float rb
       FROM gl_period_balances WHERE account_id=$1 AND fiscal_year=2026 AND fiscal_period=$2`, [accountId, period]);
  return r.rows;
}
const ledgerFingerprint = async () =>
  (await db!.pool.query(`SELECT count(*)::int n, COALESCE(sum("DebitAmount"+"CreditAmount"),0)::float s FROM ledger_entries`)).rows[0];

suite('GL outbox worker — atomicity & idempotency with the real rebuild (real Postgres)', () => {
  afterAll(async () => { await db?.drop(); });
  beforeEach(async () => { await db!.pool.query('TRUNCATE gl_projection_events'); });

  it('rebuilds absolute totals and marks DONE; replaying the same event is a no-op (idempotent)', async () => {
    const a = 'aaaaaaaa-1111-0000-0000-000000000001';
    await post(a, 1000, 0); await post(a, 0, 250); await post(a, 500, 0);
    const [ev] = await insertEvents(db!.pool, [{ accountId: a, period: 5 }]);

    const r1 = await pollAndProcessPendingEvents(db!.pool);
    expect(r1).toMatchObject({ claimed: 1, rebuilt: 1, failed: 0 });
    expect(await balance(a)).toEqual([{ d: 1500, c: 250, rb: 1250 }]);

    // duplicate delivery of the already-applied event (forced back to PENDING)
    await db!.pool.query(`UPDATE gl_projection_events SET status='PENDING', processed_at=NULL WHERE id=$1`, [ev]);
    for (let i = 0; i < 3; i++) {
      await pollAndProcessPendingEvents(db!.pool);
      await db!.pool.query(`UPDATE gl_projection_events SET status='PENDING', processed_at=NULL WHERE id=$1`, [ev]);
    }
    expect(await balance(a)).toEqual([{ d: 1500, c: 250, rb: 1250 }]); // still exactly one row, same numbers
  });

  it('ATOMIC: if marking DONE fails, the balance upsert rolls back with it and the event stays PENDING', async () => {
    const a = 'aaaaaaaa-2222-0000-0000-000000000002';
    await post(a, 700, 0);
    const [ev] = await insertEvents(db!.pool, [{ accountId: a, period: 5 }]);
    await db!.pool.query(`
      CREATE OR REPLACE FUNCTION trg_block_done() RETURNS trigger AS $$
      BEGIN IF NEW.status = 'DONE' THEN RAISE EXCEPTION 'simulated failure while marking DONE'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER block_done BEFORE UPDATE ON gl_projection_events FOR EACH ROW EXECUTE FUNCTION trg_block_done();`);

    const r = await pollAndProcessPendingEvents(db!.pool);
    expect(r.rebuilt).toBe(0);
    expect(await balance(a)).toEqual([]); // the upsert did NOT survive
    const st = await db!.pool.query(`SELECT status FROM gl_projection_events WHERE id=$1`, [ev]);
    expect(st.rows[0].status).toBe('PENDING'); // not stranded

    await db!.pool.query(`DROP TRIGGER block_done ON gl_projection_events`);
    const ok = await pollAndProcessPendingEvents(db!.pool);
    expect(ok).toMatchObject({ rebuilt: 1, failed: 0 });
    expect(await balance(a)).toEqual([{ d: 700, c: 0, rb: 700 }]);
  });

  it('stranded legacy PROCESSING events are recovered with correct balances and ZERO ledger change', async () => {
    const a = 'aaaaaaaa-3333-0000-0000-000000000003';
    await post(a, 120, 0, '2026-04-10T10:00:00Z'); await post(a, 0, 20, '2026-04-11T10:00:00Z');
    await insertEvents(db!.pool, [
      { accountId: a, period: 4, status: 'PROCESSING', ageSeconds: 86400 * 90 },
      { accountId: a, period: 4, status: 'PROCESSING', ageSeconds: 86400 * 90 },
    ]);
    const before = await ledgerFingerprint();
    const r = await pollAndProcessPendingEvents(db!.pool);
    expect(r).toMatchObject({ claimed: 2, rebuilt: 1 });
    expect(await balance(a, 4)).toEqual([{ d: 120, c: 20, rb: 100 }]);
    expect(await ledgerFingerprint()).toEqual(before); // posted journals untouched
  });

  it('CLOSED period: event completes but gl_period_balances is not touched', async () => {
    const a = 'aaaaaaaa-4444-0000-0000-000000000004';
    await db!.pool.query(`INSERT INTO financial_periods VALUES (2026, 3, 'CLOSED')`);
    await post(a, 999, 0, '2026-03-10T10:00:00Z');
    await insertEvents(db!.pool, [{ accountId: a, period: 3 }]);
    const r = await pollAndProcessPendingEvents(db!.pool);
    expect(r).toMatchObject({ rebuilt: 1, failed: 0 });
    expect(await balance(a, 3)).toEqual([]);
  });

  it('CONCURRENT workers on shared tuples: no deadlock, no lost event, totals equal ledger truth', async () => {
    const accts = [1, 2, 3, 4].map((n) => `bbbbbbbb-0000-0000-0000-00000000000${n}`);
    for (const a of accts) { await post(a, 100, 0, '2026-06-05T10:00:00Z'); await post(a, 0, 40, '2026-06-06T10:00:00Z'); }
    await insertEvents(db!.pool, Array.from({ length: 400 }, (_, i) => ({ accountId: accts[i % 4], period: 6 })));
    const pending0 = (await histogram(db!.pool)).PENDING;
    expect(pending0).toBe(400);

    const before = await ledgerFingerprint();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => pollAndProcessPendingEvents(db!.pool)));
    expect(results.reduce((s, r) => s + r.claimed, 0)).toBe(400);
    expect(results.every((r) => r.failed === 0)).toBe(true);
    expect((await histogram(db!.pool)).DONE).toBe(400);
    for (const a of accts) expect(await balance(a, 6)).toEqual([{ d: 100, c: 40, rb: 60 }]);
    expect(await ledgerFingerprint()).toEqual(before);
  });
});
