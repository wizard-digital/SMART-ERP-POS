/**
 * PROOF — scripts/reconcile-period-balances.mjs (dry-run default, confirm-gated apply, ledger untouched).
 * Real Postgres scratch DB; the script is executed as a child process exactly as an operator would.
 */
import { afterAll, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScratchDb } from './periodBalanceWorker.testDb.js';

const DDL = `
CREATE TABLE accounts ("Id" UUID PRIMARY KEY, "AccountCode" TEXT NOT NULL);
CREATE TABLE financial_periods (period_year INT NOT NULL, period_month INT NOT NULL, "Status" TEXT NOT NULL);
CREATE TABLE ledger_transactions ("Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "TransactionDate" TIMESTAMPTZ NOT NULL,
  "Status" TEXT NOT NULL DEFAULT 'POSTED', "IsReversed" BOOLEAN NOT NULL DEFAULT FALSE, "ReversedByTransactionId" UUID);
CREATE TABLE ledger_entries ("Id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "TransactionId" UUID NOT NULL REFERENCES ledger_transactions("Id"),
  "AccountId" UUID NOT NULL, "DebitAmount" NUMERIC(18,2) NOT NULL DEFAULT 0, "CreditAmount" NUMERIC(18,2) NOT NULL DEFAULT 0);
CREATE TABLE gl_period_balances (account_id UUID NOT NULL, fiscal_year INT NOT NULL, fiscal_period INT NOT NULL,
  debit_total NUMERIC(18,2) NOT NULL DEFAULT 0, credit_total NUMERIC(18,2) NOT NULL DEFAULT 0, running_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT NOW(), UNIQUE (account_id, fiscal_year, fiscal_period));`;

const A = { ok: '00000000-0000-0000-0000-00000000000a', drift: '00000000-0000-0000-0000-00000000000b', missing: '00000000-0000-0000-0000-00000000000c',
  orphan: '00000000-0000-0000-0000-00000000000d', lockedOrphan: '00000000-0000-0000-0000-00000000000e' };

const db = await createScratchDb(DDL);
if (!db) console.error('[SKIPPED] local Postgres unreachable — reconcile script proofs NOT executed');
const suite = db ? describe : describe.skip;
const outDir = mkdtempSync(join(tmpdir(), 'recon-'));

function run(extra: string[]) {
  const out = join(outDir, `ev-${Math.random().toString(16).slice(2)}.json`);
  const r = spawnSync(process.execPath, ['scripts/reconcile-period-balances.mjs', '--db', db!.name, '--out', out, ...extra], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, PGHOST: process.env.PGHOST || 'localhost', PGPORT: process.env.PGPORT || '5432', PGUSER: process.env.PGUSER || 'postgres', PGPASSWORD: process.env.PGPASSWORD || 'password' },
  });
  return { ...r, evidence: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null };
}
const q = async (sql: string, p: unknown[] = []) => (await db!.pool.query(sql, p)).rows;
const balances = async () => q(`SELECT account_id::text a, fiscal_year y, fiscal_period m, debit_total::float d, credit_total::float c FROM gl_period_balances ORDER BY 1,2,3`);
const ledgerFp = async () => (await q(`SELECT count(*)::int n, sum("DebitAmount")::float d, sum("CreditAmount")::float c FROM ledger_entries`))[0];

async function post(acct: string, d: number, c: number, date: string) {
  const t = await q(`INSERT INTO ledger_transactions ("TransactionDate") VALUES ($1) RETURNING "Id"::text id`, [date]);
  await q(`INSERT INTO ledger_entries ("TransactionId","AccountId","DebitAmount","CreditAmount") VALUES ($1,$2,$3,$4)`, [t[0].id, acct, d, c]);
}

suite('reconcile-period-balances.mjs', () => {
  afterAll(async () => { await db?.drop(); });

  it('seeds: ok / drift / missing / orphan / orphan in a CLOSED period', async () => {
    for (const [k, v] of Object.entries(A)) await q(`INSERT INTO accounts VALUES ($1,$2)`, [v, `9${k.length}00`]);
    await q(`INSERT INTO financial_periods VALUES (2026, 3, 'CLOSED')`);
    await post(A.ok, 100, 0, '2026-05-10T10:00:00Z');       await q(`INSERT INTO gl_period_balances VALUES ($1,2026,5,100,0,100)`, [A.ok]);
    await post(A.drift, 300, 50, '2026-05-11T10:00:00Z');   await q(`INSERT INTO gl_period_balances VALUES ($1,2026,5,999,50,949)`, [A.drift]);
    await post(A.missing, 70, 0, '2026-06-12T10:00:00Z');   // no stored row
    await q(`INSERT INTO gl_period_balances VALUES ($1,2027,7,0,4000,-4000)`, [A.orphan]);
    await q(`INSERT INTO gl_period_balances VALUES ($1,2026,3,5,0,5)`, [A.lockedOrphan]);
    expect((await balances()).length).toBe(4);
  });

  it('DRY-RUN reports all 4 differences and writes NOTHING (read-only transaction)', async () => {
    const before = await balances();
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/DRY-RUN only: nothing was written/);
    expect(r.stdout).toMatch(/4 difference/);
    expect(r.evidence.differences.map((d: { kind: string }) => d.kind).sort()).toEqual(['DRIFT', 'MISSING', 'ORPHAN', 'ORPHAN']);
    expect(await balances()).toEqual(before);
  });

  it('--apply WITHOUT --confirm-db is refused and changes nothing', async () => {
    const before = await balances();
    const r = run(['--apply']);
    expect(r.status).toBe(2);
    expect(await balances()).toEqual(before);
  });

  it('--apply with a WRONG --confirm-db is refused', async () => {
    const r = run(['--apply', '--confirm-db', 'some_other_db']);
    expect(r.status).toBe(2);
  });

  it('--apply --confirm-db: fixes drift/missing/orphan, SKIPS the CLOSED period, ledger untouched, evidence recorded', async () => {
    const ledgerBefore = await ledgerFp();
    const r = run(['--apply', '--confirm-db', db!.name]);
    expect(r.status).toBe(0);
    expect(r.evidence.postCheck).toMatchObject({ remainingDifferences: 0, ledgerUntouched: true, result: 'COMMITTED' });
    const acts = Object.fromEntries(r.evidence.actions.map((a: { account_id: string; action: string }) => [a.account_id, a.action]));
    expect(acts[A.drift]).toBe('CORRECTED');
    expect(acts[A.missing]).toBe('INSERTED');
    expect(acts[A.orphan]).toBe('DELETED_ORPHAN');
    expect(acts[A.lockedOrphan]).toBe('SKIPPED_LOCKED_PERIOD');
    // before-values are preserved in the evidence
    const orphanEv = r.evidence.differences.find((d: { account_id: string }) => d.account_id === A.orphan);
    expect(orphanEv).toMatchObject({ stored_credit: '4000.00', kind: 'ORPHAN' });

    const after = await balances();
    expect(after.find((b) => b.a === A.ok)).toMatchObject({ d: 100, c: 0 });             // untouched
    expect(after.find((b) => b.a === A.drift)).toMatchObject({ d: 300, c: 50 });          // corrected
    expect(after.find((b) => b.a === A.missing)).toMatchObject({ d: 70, c: 0 });          // inserted
    expect(after.find((b) => b.a === A.orphan)).toBeUndefined();                          // orphan removed
    expect(after.find((b) => b.a === A.lockedOrphan)).toMatchObject({ d: 5 });            // closed period preserved
    expect(await ledgerFp()).toEqual(ledgerBefore);
  });

  it('is idempotent: a second DRY-RUN shows only the (skipped) closed-period row, a second APPLY changes nothing', async () => {
    const before = await balances();
    const r = run(['--apply', '--confirm-db', db!.name]);
    expect(r.status).toBe(0);
    expect(r.evidence.actions.filter((a: { action: string }) => a.action !== 'SKIPPED_LOCKED_PERIOD')).toHaveLength(0);
    expect(await balances()).toEqual(before);
  });
});
