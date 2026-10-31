/**
 * REAL Postgres: post store issue (GI 201) then reverse (GI 202).
 *
 * Exercises storeIssueService.postNow + reverse + generateStoreIssueAudit against
 * a scratch clone of sp_template_local. AccountingCore, FEFO lots, and 5150/1300
 * are live. Skip is not proof — missing template fails the suite.
 *
 * Run: node --experimental-vm-modules ./node_modules/jest/bin/jest.js src/modules/kitchen-production/storeIssueReverse.realpg.test.ts --no-coverage --testTimeout=120000 --forceExit
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { createScratchFromTemplate, type TemplateScratch } from '../../test/realPgTemplate.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ISSUE_QTY = 4;
const UNIT_COST = 250;
const REASON = 'Posted to the wrong kitchen';

let db: TemplateScratch | null = null;
let storeIssueService: typeof import('./storeIssueService.js').storeIssueService;
let generateStoreIssueAudit: typeof import('../reports/inventory/storeIssueAuditService.js').generateStoreIssueAudit;
let lotService: typeof import('../inventory-lot/lotService.js').lotService;
let isMultistoreEnabled: typeof import('../inventory/warehouse/multistoreSettings.js').isMultistoreEnabled;

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

async function batchRemaining(pool: Pool, productId: string): Promise<number> {
  const r = await pool.query<{ q: string }>(
    `SELECT COALESCE(SUM(remaining_quantity), 0)::text AS q
     FROM inventory_batches
     WHERE product_id = $1 AND COALESCE(status, 'ACTIVE') <> 'DEPLETED'`,
    [productId],
  );
  return Number(r.rows[0]?.q ?? 0);
}

async function movementsByType(
  pool: Pool,
  documentId: string,
): Promise<Record<string, { count: number; qty: number }>> {
  const r = await pool.query<{ mt: string; c: string; q: string }>(
    `SELECT movement_type::text AS mt, COUNT(*)::text AS c, COALESCE(SUM(quantity), 0)::text AS q
     FROM stock_movements
     WHERE reference_id = $1::uuid
     GROUP BY movement_type`,
    [documentId],
  );
  return Object.fromEntries(
    r.rows.map((row) => [row.mt, { count: Number(row.c), qty: Number(row.q) }]),
  );
}

async function journalsForDoc(
  pool: Pool,
  documentId: string,
): Promise<Array<{ ref: string; status: string; code: string; debit: number; credit: number }>> {
  const r = await pool.query(
    `SELECT lt."ReferenceType" AS ref, lt."Status" AS status, a."AccountCode" AS code,
            COALESCE(SUM(le."DebitAmount"), 0)::float8 AS debit,
            COALESCE(SUM(le."CreditAmount"), 0)::float8 AS credit
       FROM ledger_transactions lt
       JOIN ledger_entries le ON le."TransactionId" = lt."Id"
       JOIN accounts a ON a."Id" = le."AccountId"
      WHERE lt."ReferenceId"::text = $1
      GROUP BY lt."ReferenceType", lt."Status", a."AccountCode"
      ORDER BY lt."ReferenceType", a."AccountCode"`,
    [documentId],
  );
  return r.rows;
}

beforeAll(async () => {
  db = await createScratchFromTemplate();
  if (!db) {
    throw new Error(
      'storeIssueReverse.realpg: sp_template_local required. Run node scripts/ops/clone-template-local.mjs',
    );
  }
  ({ storeIssueService } = await import('./storeIssueService.js'));
  ({ generateStoreIssueAudit } = await import('../reports/inventory/storeIssueAuditService.js'));
  ({ lotService } = await import('../inventory-lot/lotService.js'));
  ({ isMultistoreEnabled } = await import('../inventory/warehouse/multistoreSettings.js'));

  const pool = db.pool;
  if (!(await hasTable(pool, 'store_issue_documents'))) {
    await applySql(pool, '639_store_issue_to_expense.sql');
  }
  if (!(await hasColumn(pool, 'store_issue_lines', 'uom_id'))) {
    await applySql(pool, '640_store_issue_uom.sql');
  }
  if (!(await hasColumn(pool, 'store_issue_documents', 'reversed_by'))) {
    await applySql(pool, '641_store_issue_reversal.sql');
  }
  if (!(await hasColumn(pool, 'store_issue_documents', 'reversal_reason'))) {
    await applySql(pool, '642_store_issue_reverse_governance.sql');
  }

  const settingsCount = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM system_settings`,
  );
  if (Number(settingsCount.rows[0]?.n ?? 0) === 0) {
    await pool.query(
      `INSERT INTO system_settings (restaurant_mode_enabled, is_multistore_enabled)
       VALUES (TRUE, FALSE)`,
    );
  } else {
    await pool.query(
      `UPDATE system_settings SET restaurant_mode_enabled = TRUE, is_multistore_enabled = FALSE`,
    );
  }

  const today = new Date();
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
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
    `UPDATE accounting_periods SET status = 'OPEN'
     WHERE $1::date BETWEEN period_start AND period_end`,
    [`${year}-${String(month).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`],
  );
}, 120000);

afterAll(async () => {
  await db?.drop();
});

describe('store issue post + reverse on real Postgres', () => {
  it('posts GI 201, blocks self-reverse, reverses GI 202, and the audit lists both', async () => {
    expect(db).not.toBeNull();
    const pool = db!.pool;

    const acc5150 = await pool.query(`SELECT 1 FROM accounts WHERE "AccountCode" = '5150'`);
    expect(acc5150.rows.length).toBe(1);
    prove('account-5150-present', { rows: acc5150.rows.length });

    const stampUsers = Date.now().toString(36);
    const insertedUsers = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role, is_active, user_number)
       VALUES
         ($1, 'x', 'Store Issue Poster', 'ADMIN', true, $2),
         ($3, 'x', 'Store Issue Reverser', 'MANAGER', true, $4)
       RETURNING id::text AS id`,
      [
        `si-poster-${stampUsers}@proof.local`,
        `USR-SIP-${stampUsers.slice(-8)}`,
        `si-reverser-${stampUsers}@proof.local`,
        `USR-SIR-${stampUsers.slice(-8)}`,
      ],
    );
    const poster = insertedUsers.rows[0].id;
    const reverser = insertedUsers.rows[1].id;
    expect(reverser).not.toBe(poster);
    prove('two-users', { poster: poster.slice(0, 8), reverser: reverser.slice(0, 8) });

    const stamp = Date.now().toString(36).toUpperCase();
    let categoryId: string | null = null;
    try {
      const cat = await pool.query<{ id: string }>(`SELECT id::text AS id FROM categories LIMIT 1`);
      categoryId = cat.rows[0]?.id ?? null;
    } catch {
      categoryId = null;
    }
    const pn = `SI${stamp}`.slice(0, 20);
    const productCols = ['sku', 'name', 'product_type', 'is_active'];
    const productVals: unknown[] = [`SI-SKU-${stamp}`, `Store issue flour ${stamp}`, 'inventory', true];
    const optionalProduct: Array<[string, unknown]> = [
      ['product_number', pn],
      ['category_id', categoryId],
      ['cost_price', UNIT_COST],
      ['selling_price', UNIT_COST * 2],
      ['is_taxable', false],
      ['tax_rate', 0],
      ['available_in_restaurant', true],
      ['conversion_factor', 1],
    ];
    for (const [col, val] of optionalProduct) {
      if (await hasColumn(pool, 'products', col)) {
        productCols.push(col);
        productVals.push(val);
      }
    }
    const placeholders = productVals.map((_, i) => `$${i + 1}`).join(', ');
    const product = await pool.query<{ id: string }>(
      `INSERT INTO products (${productCols.join(', ')})
       VALUES (${placeholders})
       RETURNING id::text AS id`,
      productVals,
    );
    const productId = product.rows[0].id;
    await pool
      .query(
        `INSERT INTO product_inventory (product_id, quantity_on_hand, reorder_level, reorder_quantity)
         VALUES ($1, 0, 0, 0) ON CONFLICT (product_id) DO NOTHING`,
        [productId],
      )
      .catch(() => undefined);

    const multi = await isMultistoreEnabled(pool);
    let storeLocationId: string | null = null;
    if (multi) {
      const st = await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM store_locations
         WHERE COALESCE(is_active, true)
           AND store_type::text NOT IN ('DAMAGE', 'EXPIRED', 'RETURN')
         ORDER BY CASE WHEN store_type::text = 'MAIN' THEN 0 ELSE 1 END, name
         LIMIT 1`,
      );
      storeLocationId = st.rows[0]?.id ?? null;
      expect(storeLocationId).toBeTruthy();
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lotService.receiveLot(client, {
        productId,
        lotNumber: `SI-LOT-${stamp}`,
        quantity: ISSUE_QTY + 6,
        costPrice: UNIT_COST,
        attributes: { receivedDate: new Date().toISOString().slice(0, 10) },
        sourceType: 'ADJUSTMENT',
        targetStoreLocationId: storeLocationId,
        userId: poster,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const remainingBefore = await batchRemaining(pool, productId);
    expect(remainingBefore).toBeGreaterThanOrEqual(ISSUE_QTY);
    prove('lot-received', { remainingBefore, storeLocationId, multistore: multi });

    const posted = await storeIssueService.postNow(
      pool,
      {
        issuedTo: 'KITCHEN',
        requestedByName: 'Chef',
        notes: 'realpg GI 201',
        storeLocationId,
        lines: [
          {
            productId,
            requestedQtyBase: ISSUE_QTY,
            issuedQtyBase: ISSUE_QTY,
            uomName: 'PCS',
            conversionFactor: 1,
          },
        ],
      },
      poster,
    );
    expect(posted.status).toBe('POSTED');
    expect(posted.expenseAccountCode).toBe('5150');
    expect(posted.totalCost).toBe(ISSUE_QTY * UNIT_COST);
    expect(posted.journalEntryId).toBeTruthy();
    const remainingAfterPost = await batchRemaining(pool, productId);
    expect(Math.abs(remainingBefore - remainingAfterPost - ISSUE_QTY)).toBeLessThan(0.001);
    const postMoves = await movementsByType(pool, posted.id);
    expect(postMoves.GOODS_ISSUE?.qty).toBe(ISSUE_QTY);
    expect(postMoves.GOODS_ISSUE_REVERSAL).toBeUndefined();
    const postJournals = await journalsForDoc(pool, posted.id);
    const posted5150 = postJournals.find((j) => j.ref === 'STORE_ISSUE' && j.code === '5150');
    const posted1300 = postJournals.find((j) => j.ref === 'STORE_ISSUE' && j.code === '1300');
    expect(posted5150?.debit).toBe(ISSUE_QTY * UNIT_COST);
    expect(posted5150?.credit).toBe(0);
    expect(posted1300?.credit).toBe(ISSUE_QTY * UNIT_COST);
    expect(posted1300?.debit).toBe(0);
    prove('posted-gi-201', {
      documentNumber: posted.documentNumber,
      status: posted.status,
      totalCost: posted.totalCost,
      remainingAfterPost,
      movements: postMoves,
      journals: postJournals,
    });

    await expect(
      storeIssueService.reverse(pool, posted.id, poster, {
        reason: REASON,
        canOverrideFourEyes: false,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/cannot reverse a goods issue you posted/i),
    });
    const stillPosted = await storeIssueService.getById(pool, posted.id);
    expect(stillPosted.status).toBe('POSTED');
    prove('self-reverse-forbidden', { status: stillPosted.status });

    const reversed = await storeIssueService.reverse(pool, posted.id, reverser, {
      reason: REASON,
      canOverrideFourEyes: false,
    });
    expect(reversed.status).toBe('REVERSED');
    expect(reversed.reversedBy).toBe(reverser);
    expect(reversed.reversalReason).toBe(REASON);
    expect(reversed.reversalJournalId).toBeTruthy();
    const remainingAfterReverse = await batchRemaining(pool, productId);
    expect(Math.abs(remainingAfterReverse - remainingBefore)).toBeLessThan(0.001);
    const revMoves = await movementsByType(pool, posted.id);
    expect(revMoves.GOODS_ISSUE?.qty).toBe(ISSUE_QTY);
    expect(revMoves.GOODS_ISSUE_REVERSAL?.qty).toBe(ISSUE_QTY);
    const revJournals = await journalsForDoc(pool, posted.id);
    const reversal5150 = revJournals.find((j) => j.ref === 'REVERSAL' && j.code === '5150');
    const reversal1300 = revJournals.find((j) => j.ref === 'REVERSAL' && j.code === '1300');
    expect(reversal5150?.credit).toBe(ISSUE_QTY * UNIT_COST);
    expect(reversal1300?.debit).toBe(ISSUE_QTY * UNIT_COST);
    prove('reversed-gi-202', {
      status: reversed.status,
      reversalReason: reversed.reversalReason,
      remainingAfterReverse,
      movements: revMoves,
      journals: revJournals,
    });

    const audit = await generateStoreIssueAudit(pool, {
      startDate: posted.issueDate,
      endDate: posted.issueDate,
      search: posted.documentNumber,
    });
    expect(audit.rows.length).toBe(2);
    const types = audit.rows.map((row) => row.movementType).sort();
    expect(types).toEqual(['GOODS_ISSUE', 'GOODS_ISSUE_REVERSAL']);
    expect(audit.totals.issuedAmount).toBe(ISSUE_QTY * UNIT_COST);
    expect(audit.totals.reversedAmount).toBe(ISSUE_QTY * UNIT_COST);
    expect(audit.totals.reverseRate).toBe(1);
    expect(audit.rows.some((row) => row.reversalReason === REASON)).toBe(true);
    expect(audit.rows.every((row) => row.uomName)).toBe(true);
    prove('audit-union-both-rows', {
      rows: audit.rows.length,
      types,
      issuedAmount: audit.totals.issuedAmount,
      reversedAmount: audit.totals.reversedAmount,
      reverseRate: audit.totals.reverseRate,
      search: audit.search,
    });

    const payload = {
      title: 'PROOF_STORE_ISSUE_REVERSE_REALPG',
      runAt: new Date().toISOString(),
      verdict: 'PASS',
      exercised: 'storeIssueService.postNow + reverse + generateStoreIssueAudit',
      database: db!.name,
      checks: evidence,
    };
    const json = JSON.stringify(payload, null, 2);
    writeFileSync(path.join(repoRoot, 'PROOF_STORE_ISSUE_REVERSE_REALPG.json'), json);
    writeFileSync(path.join(repoRoot, 'SamplePOS.Server/PROOF_STORE_ISSUE_REVERSE_REALPG.json'), json);
  }, 120000);
});
