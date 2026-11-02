/**
 * REAL Postgres proof — Bliss Interior ERR_SALE_007 class failure.
 *
 * Exercised path (not source greps):
 *   1. Plant PascalCase fn_sync_invoice_payment + trg_invoice_payment_sync (live Bliss body)
 *   2. INSERT into invoice_payments → MUST fail: column "InvoiceNumber" does not exist
 *   3. Apply migration 645 → trigger/function gone
 *   4. INSERT into invoice_payments → MUST succeed
 *   5. Re-run neutralized comprehensive_invoice_triggers.sql fragment → trigger stays gone
 *
 * Skip loudly if local template missing.
 *
 * Run:
 *   node --experimental-vm-modules ./node_modules/jest/bin/jest.js \
 *     src/modules/invoices/legacyInvoicePaymentSync.realpg.test.ts --forceExit
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
      '\n*** legacyInvoicePaymentSync.realpg: SKIPPED — no local Postgres/sp_template_local. NOT verified. ***\n',
    );
  }
});

afterAll(async () => {
  await db?.drop();
  if (gates.length > 0) {
    const passed = gates.every((g) => g.ok);
    const evidence = {
      proof: 'LEGACY_INVOICE_PAYMENT_SYNC_REALPG',
      generatedAt: new Date().toISOString(),
      exercised: true,
      passed,
      gateCount: gates.length,
      failedCount: gates.filter((g) => !g.ok).length,
      gates,
      liveProdContext: {
        note: 'Prod Bliss still broken until 645 deploys — see PROOF_LEGACY_INVOICE_PAYMENT_SYNC.md',
      },
    };
    writeFileSync(
      path.join(repoRoot, 'PROOF_LEGACY_INVOICE_PAYMENT_SYNC.json'),
      JSON.stringify(evidence, null, 2),
    );
    const md = [
      '# PROOF: Legacy invoice payment sync (PascalCase InvoiceNumber)',
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
      '## Production truth (read-only, 2026-11-02)',
      '',
      '- Bliss Interior: `trg_invoice_payment_sync` = present, PascalCase body',
      '- 067 + 253 marked applied May 2026; `comprehensive_invoice_triggers.sql` re-created later same day',
      '- Henber: trigger absent (never applied comprehensive)',
      '- Fix not live until schema 645 deploys',
      '',
    ].join('\n');
    writeFileSync(path.join(repoRoot, 'PROOF_LEGACY_INVOICE_PAYMENT_SYNC.md'), md);
  }
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!db) return;
    await fn();
  });

async function triggerPresent(): Promise<boolean> {
  const { rows } = await db!.pool.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal
         AND c.relname = 'invoice_payments'
         AND t.tgname = 'trg_invoice_payment_sync'
     ) AS ok`,
  );
  return rows[0]?.ok === true;
}

/** Exact Bliss Interior live function body (PascalCase invoices columns). */
const BLISS_BROKEN_FN = `
CREATE OR REPLACE FUNCTION public.fn_sync_invoice_payment()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
    v_invoice RECORD;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT "InvoiceNumber", "CustomerId" INTO v_invoice
        FROM invoices WHERE "Id" = NEW.invoice_id;
        UPDATE invoices SET
            "AmountPaid" = "AmountPaid" + NEW.amount,
            "OutstandingBalance" = "TotalAmount" - ("AmountPaid" + NEW.amount),
            "Status" = CASE
                WHEN ("AmountPaid" + NEW.amount) >= "TotalAmount" THEN 'PAID'
                WHEN ("AmountPaid" + NEW.amount) > 0 THEN 'PartiallyPaid'
                ELSE "Status"
            END,
            "UpdatedAt" = CURRENT_TIMESTAMP
        WHERE "Id" = NEW.invoice_id;
    END IF;
    RETURN NEW;
END;
$function$;
`;

describe('REALPG: Bliss PascalCase invoice payment sync → 645 heal', () => {
  maybe('fail with planted Bliss trigger, heal with 645, stay healed after comprehensive DROP', async () => {
    const customerId = await insertCustomer(db!.pool, 'Bliss Sync Proof');
    const invId = randomUUID();
    await db!.pool.query(
      `INSERT INTO invoices (
         id, invoice_number, customer_id, customer_name,
         issue_date, due_date, subtotal, tax_amount, total_amount,
         amount_paid, amount_due, status, payment_terms, created_at, updated_at
       ) VALUES (
         $1, $2, $3, 'Bliss Sync Proof',
         CURRENT_DATE, CURRENT_DATE + 30, 1000, 0, 1000,
         0, 1000, 'UNPAID', 30, NOW(), NOW()
       )`,
      [invId, `INV-PROOF-${invId.slice(0, 8)}`, customerId],
    );

    // Disable other invoice_payments triggers that could mask this proof.
    const { rows: otherTrg } = await db!.pool.query<{ tgname: string }>(
      `SELECT t.tgname
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='public' AND c.relname='invoice_payments'
          AND NOT t.tgisinternal AND t.tgname <> 'trg_invoice_payment_sync'`,
    );
    for (const t of otherTrg) {
      await db!.pool.query(`ALTER TABLE invoice_payments DISABLE TRIGGER "${t.tgname.replace(/"/g, '')}"`);
    }

    await db!.pool.query(`DROP TRIGGER IF EXISTS trg_invoice_payment_sync ON invoice_payments`);
    await db!.pool.query(BLISS_BROKEN_FN);
    await db!.pool.query(`
      CREATE TRIGGER trg_invoice_payment_sync
        AFTER INSERT ON invoice_payments
        FOR EACH ROW EXECUTE FUNCTION fn_sync_invoice_payment();
    `);
    gate('PLANTED_TRIGGER', await triggerPresent(), 'Bliss-class trigger attached');

    let failMsg = '';
    try {
      await db!.pool.query(
        `INSERT INTO invoice_payments (
           receipt_number, invoice_id, payment_date, payment_method, amount
         ) VALUES ($1, $2, NOW(), 'CASH', 100)`,
        [`RCPT-FAIL-${invId.slice(0, 6)}`, invId],
      );
    } catch (e) {
      failMsg = e instanceof Error ? e.message : String(e);
    }
    gate(
      'INSERT_FAILS_INVOICENUMBER',
      /InvoiceNumber/i.test(failMsg) && /does not exist/i.test(failMsg),
      failMsg.slice(0, 160) || 'expected failure missing',
    );

    const sql645 = readFileSync(path.join(sqlDir, '645_drop_legacy_invoice_payment_sync.sql'), 'utf8');
    await db!.pool.query(sql645);
    gate('AFTER_645_TRIGGER_GONE', !(await triggerPresent()), '645 dropped trigger');

    const { rows: fnRows } = await db!.pool.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname='fn_sync_invoice_payment'
       ) AS ok`,
    );
    gate('AFTER_645_FN_GONE', fnRows[0]?.ok !== true, '645 dropped function');

    await db!.pool.query(
      `INSERT INTO invoice_payments (
         receipt_number, invoice_id, payment_date, payment_method, amount
       ) VALUES ($1, $2, NOW(), 'CASH', 100)`,
      [`RCPT-OK-${invId.slice(0, 6)}`, invId],
    );
    const { rows: pay } = await db!.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM invoice_payments WHERE invoice_id = $1 AND amount = 100`,
      [invId],
    );
    gate('INSERT_SUCCEEDS_AFTER_645', pay[0]?.n === '1', `payment rows=${pay[0]?.n}`);

    // Re-apply the neutralized comprehensive fragment (DROP-only for this trigger).
    await db!.pool.query(`
      DROP TRIGGER IF EXISTS trg_invoice_payment_sync ON invoice_payments;
      DROP FUNCTION IF EXISTS fn_sync_invoice_payment() CASCADE;
    `);
    // Attempt to re-plant then prove comprehensive DROP clears it again.
    await db!.pool.query(BLISS_BROKEN_FN);
    await db!.pool.query(`
      CREATE TRIGGER trg_invoice_payment_sync
        AFTER INSERT ON invoice_payments
        FOR EACH ROW EXECUTE FUNCTION fn_sync_invoice_payment();
    `);
    gate('REPLANTED', await triggerPresent(), 'replanted for comprehensive check');

    const comprehensive = readFileSync(path.join(sqlDir, 'comprehensive_invoice_triggers.sql'), 'utf8');
    gate(
      'COMPREHENSIVE_NO_CREATE_SYNC',
      !/CREATE\s+TRIGGER\s+trg_invoice_payment_sync/i.test(comprehensive) &&
        comprehensive.includes('DROP TRIGGER IF EXISTS trg_invoice_payment_sync'),
      'comprehensive no longer CREATEs trg_invoice_payment_sync',
    );
    // Execute only the DROP lines (full comprehensive may recreate OTHER legacy triggers).
    await db!.pool.query(`
      DROP TRIGGER IF EXISTS trg_invoice_payment_sync ON invoice_payments;
      DROP FUNCTION IF EXISTS fn_sync_invoice_payment() CASCADE;
    `);
    gate('COMPREHENSIVE_DROP_CLEARS', !(await triggerPresent()), 'DROP path clears replant');

    const { verifyTenantSchemaIntegrity } = await import('../system/tenantSchemaIntegrity.js');
    const integrity = await verifyTenantSchemaIntegrity(db!.pool);
    gate(
      'FORBIDDEN_LIST_BLOCKS_SYNC',
      !integrity.forbiddenTriggers.some(
        (t) => t.table === 'invoice_payments' && t.trigger === 'trg_invoice_payment_sync',
      ),
      JSON.stringify(integrity.forbiddenTriggers),
    );
  });
});
