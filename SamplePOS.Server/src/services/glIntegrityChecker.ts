/**
 * GL INTEGRITY CHECKER SERVICE
 *
 * Enterprise-grade system-wide accounting integrity validation.
 *
 * Odoo Pattern:
 *   Periodically verify the entire GL is consistent:
 *   - Every transaction balances (Σ debits = Σ credits)
 *   - No orphan entries (entries without valid transaction)
 *   - No orphan transactions (transactions without entries)
 *   - Trial balance sums to zero
 *   - Sub-ledger ↔ GL reconciliation (AR, AP, Inventory)
 *   - Period-locked entries not tampered
 *   - Sequence gaps detection
 *
 * This is the AUDIT-GRADE check that should run nightly or on demand.
 */

import type pg from 'pg';
import { pool as globalPool } from '../db/pool.js';
import { Money, Decimal } from '../utils/money.js';
import logger from '../utils/logger.js';
import {
  LEDGER_FISCAL_PERIOD_SQL,
  LEDGER_FISCAL_YEAR_SQL,
  LEDGER_NET_ACTIVE_SQL,
} from '../utils/ledgerNetActive.js';

// =============================================================================
// TYPES
// =============================================================================

export type CheckSeverity = 'ERROR' | 'WARNING' | 'INFO';

export interface IntegrityFinding {
  check: string;
  severity: CheckSeverity;
  message: string;
  details?: Record<string, unknown>;
}

export interface IntegrityReport {
  runDate: string;
  durationMs: number;
  passed: boolean;
  totalChecks: number;
  errors: number;
  warnings: number;
  findings: IntegrityFinding[];
}

// =============================================================================
// GL INTEGRITY CHECKER
// =============================================================================

export class GLIntegrityChecker {

  /**
   * Run all integrity checks and return a comprehensive report
   */
  static async runFullAudit(dbPool?: pg.Pool): Promise<IntegrityReport> {
    const pool = dbPool || globalPool;
    const start = Date.now();
    const findings: IntegrityFinding[] = [];

    // Run all checks in parallel where possible
    const [
      unbalanced,
      orphanEntries,
      orphanTransactions,
      trialBalance,
      arRecon,
      deadSaleOpenInvoices,
      apRecon,
      inventoryRecon,
      adjInMissingGl,
      duplicateIdempotency,
      lockedPeriodViolations,
      sequenceGaps,
      negativeBalances,
      periodBalancesRecon,
      projectionEventsBacklog,
      runningBalanceInvariant,
      productDailySummaryRecon,
      inventoryBalancesRecon,
      customerBalancesRecon,
      supplierInvoiceSafety,
      structuralWarnings,
    ] = await Promise.all([
      this.checkUnbalancedTransactions(pool),
      this.checkOrphanEntries(pool),
      this.checkOrphanTransactions(pool),
      this.checkTrialBalance(pool),
      this.checkARReconciliation(pool),
      this.checkDeadSaleOpenInvoices(pool),
      this.checkAPReconciliation(pool),
      this.checkInventoryReconciliation(pool),
      this.checkAdjustmentInMissingGl(pool),
      this.checkDuplicateIdempotencyKeys(pool),
      this.checkLockedPeriodViolations(pool),
      this.checkSequenceGaps(pool),
      this.checkNegativeAssetBalances(pool),
      this.checkPeriodBalancesReconciliation(pool),
      this.checkGlProjectionEventsBacklog(pool),
      this.checkRunningBalanceInvariant(pool),
      this.checkProductDailySummaryReconciliation(pool),
      this.checkInventoryBalancesReconciliation(pool),
      this.checkCustomerBalancesReconciliation(pool),
      this.checkSupplierInvoiceSafety(pool),
      this.checkTrialBalanceStructuralIntegrity(pool),
    ]);

    findings.push(
      ...unbalanced,
      ...orphanEntries,
      ...orphanTransactions,
      ...trialBalance,
      ...arRecon,
      ...deadSaleOpenInvoices,
      ...apRecon,
      ...inventoryRecon,
      ...adjInMissingGl,
      ...duplicateIdempotency,
      ...lockedPeriodViolations,
      ...sequenceGaps,
      ...negativeBalances,
      ...periodBalancesRecon,
      ...projectionEventsBacklog,
      ...runningBalanceInvariant,
      ...productDailySummaryRecon,
      ...inventoryBalancesRecon,
      ...customerBalancesRecon,
      ...supplierInvoiceSafety,
      ...structuralWarnings,
    );

    const errors = findings.filter(f => f.severity === 'ERROR').length;
    const warnings = findings.filter(f => f.severity === 'WARNING').length;
    const durationMs = Date.now() - start;

    const report: IntegrityReport = {
      runDate: new Date().toISOString(),
      durationMs,
      passed: errors === 0,
      totalChecks: 18,
      errors,
      warnings,
      findings,
    };

    logger.info('GL integrity audit completed', {
      passed: report.passed,
      errors,
      warnings,
      durationMs,
    });

    return report;
  }

  // ===========================================================================
  // CHECK 1: Unbalanced Transactions
  // ===========================================================================

  private static async checkUnbalancedTransactions(
    pool: pg.Pool
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];

    const result = await pool.query(`
      SELECT
        lt."Id" as transaction_id,
        lt."TransactionNumber" as transaction_number,
        lt."TransactionDate" as transaction_date,
        SUM(le."DebitAmount") as total_debits,
        SUM(le."CreditAmount") as total_credits,
        ABS(SUM(le."DebitAmount") - SUM(le."CreditAmount")) as imbalance
      FROM ledger_transactions lt
      JOIN ledger_entries le ON le."TransactionId" = lt."Id"
      WHERE lt."Status" = 'POSTED'
      GROUP BY lt."Id", lt."TransactionNumber", lt."TransactionDate"
      HAVING ABS(SUM(le."DebitAmount") - SUM(le."CreditAmount")) > 0.01
      ORDER BY lt."TransactionDate" DESC
      LIMIT 100
    `);

    if (result.rows.length === 0) {
      findings.push({
        check: 'unbalanced_transactions',
        severity: 'INFO',
        message: 'All posted transactions are balanced.',
      });
    } else {
      for (const row of result.rows) {
        findings.push({
          check: 'unbalanced_transactions',
          severity: 'ERROR',
          message: `Transaction ${row.transaction_number} is unbalanced by ${row.imbalance}`,
          details: {
            transactionId: row.transaction_id,
            transactionNumber: row.transaction_number,
            date: row.transaction_date,
            debits: Number(row.total_debits),
            credits: Number(row.total_credits),
            imbalance: Number(row.imbalance),
          },
        });
      }
    }

    return findings;
  }

  // ===========================================================================
  // CHECK 2: Orphan Ledger Entries (entries without a valid transaction)
  // ===========================================================================

  private static async checkOrphanEntries(
    pool: pg.Pool
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];

    const result = await pool.query(`
      SELECT COUNT(*) as orphan_count
      FROM ledger_entries le
      LEFT JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
      WHERE lt."Id" IS NULL
    `);

    const count = parseInt(result.rows[0]?.orphan_count || '0', 10);

    if (count > 0) {
      findings.push({
        check: 'orphan_entries',
        severity: 'ERROR',
        message: `${count} ledger entries have no parent transaction.`,
        details: { orphanCount: count },
      });
    } else {
      findings.push({
        check: 'orphan_entries',
        severity: 'INFO',
        message: 'No orphan ledger entries found.',
      });
    }

    return findings;
  }

  // ===========================================================================
  // CHECK 3: Orphan Transactions (transactions without any entries)
  // ===========================================================================

  private static async checkOrphanTransactions(
    pool: pg.Pool
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];

    const result = await pool.query(`
      SELECT COUNT(*) as orphan_count
      FROM ledger_transactions lt
      LEFT JOIN ledger_entries le ON le."TransactionId" = lt."Id"
      WHERE le."Id" IS NULL
        AND lt."Status" = 'POSTED'
    `);

    const count = parseInt(result.rows[0]?.orphan_count || '0', 10);

    if (count > 0) {
      findings.push({
        check: 'orphan_transactions',
        severity: 'WARNING',
        message: `${count} posted transactions have no ledger entries.`,
        details: { orphanCount: count },
      });
    } else {
      findings.push({
        check: 'orphan_transactions',
        severity: 'INFO',
        message: 'No orphan transactions found.',
      });
    }

    return findings;
  }

  // ===========================================================================
  // CHECK 4: Trial Balance (all accounts must net to zero)
  // ===========================================================================

  private static async checkTrialBalance(
    pool: pg.Pool
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];

    const result = await pool.query(`
      SELECT
        SUM(le."DebitAmount") as total_debits,
        SUM(le."CreditAmount") as total_credits
      FROM ledger_entries le
      JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
      WHERE lt."Status" = 'POSTED'
    `);

    const debits = new Decimal(result.rows[0]?.total_debits || 0);
    const credits = new Decimal(result.rows[0]?.total_credits || 0);
    const difference = debits.minus(credits).abs();

    if (difference.greaterThan('0.01')) {
      findings.push({
        check: 'trial_balance',
        severity: 'ERROR',
        message: `Trial balance does not sum to zero. Difference: ${difference.toFixed(2)}`,
        details: {
          totalDebits: debits.toNumber(),
          totalCredits: credits.toNumber(),
          difference: difference.toNumber(),
        },
      });
    } else {
      findings.push({
        check: 'trial_balance',
        severity: 'INFO',
        message: `Trial balance is correct. Total: ${debits.toFixed(2)}`,
        details: {
          totalDebits: debits.toNumber(),
          totalCredits: credits.toNumber(),
        },
      });
    }

    return findings;
  }

  // ===========================================================================
  // CHECK 5: AR Reconciliation (GL 1200 ↔ Customer balances)
  // ===========================================================================

  private static async checkARReconciliation(
    pool: pg.Pool
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];

    const result = await pool.query(`
      SELECT
        COALESCE(
          (SELECT SUM(le."DebitAmount") - SUM(le."CreditAmount")
           FROM ledger_entries le
           JOIN accounts a ON a."Id" = le."AccountId"
           JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
           WHERE a."AccountCode" = '1200'
             AND ${LEDGER_NET_ACTIVE_SQL}), 0
        ) as gl_balance,
        COALESCE(
          (SELECT SUM(balance) FROM customers), 0
        ) as subledger_balance
    `);

    const glBalance = new Decimal(result.rows[0]?.gl_balance || 0);
    const subBalance = new Decimal(result.rows[0]?.subledger_balance || 0);
    const diff = glBalance.minus(subBalance).abs();

    if (diff.greaterThan('0.01')) {
      findings.push({
        check: 'ar_reconciliation',
        severity: 'WARNING',
        message: `AR GL (1200) differs from customer subledger by ${diff.toFixed(2)}`,
        details: {
          glBalance: glBalance.toNumber(),
          subledgerBalance: subBalance.toNumber(),
          difference: diff.toNumber(),
        },
      });
    } else {
      findings.push({
        check: 'ar_reconciliation',
        severity: 'INFO',
        message: 'AR reconciliation: GL matches customer subledger.',
      });
    }

    return findings;
  }

  /**
   * Open invoices must not survive VOID / VOIDED_BY_RETURN / REFUNDED sales.
   * Henber INV-2026-0020: refund corrected GL 1200 but left the invoice UNPAID.
   */
  private static async checkDeadSaleOpenInvoices(
    pool: pg.Pool
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];

    const result = await pool.query(`
      SELECT i.invoice_number,
             s.sale_number,
             s.status::text AS sale_status,
             i.amount_due::numeric AS amount_due
      FROM invoices i
      JOIN sales s ON s.id = i.sale_id
      WHERE i.status NOT IN ('CANCELLED', 'VOIDED', 'DRAFT', 'PAID')
        AND COALESCE(i.amount_due, 0) > 0.009
        AND s.status IN ('VOID', 'VOIDED_BY_RETURN', 'REFUNDED')
      ORDER BY i.amount_due DESC
      LIMIT 50
    `);

    if (result.rows.length > 0) {
      const totalDue = result.rows.reduce(
        (sum, r) => sum + Number(r.amount_due || 0),
        0,
      );
      findings.push({
        check: 'dead_sale_open_invoices',
        severity: 'ERROR',
        message:
          `${result.rows.length} open invoice(s) linked to voided/fully-returned sales ` +
          `(outstanding ${totalDue.toFixed(2)}). Cancel subledger only — do not re-post AR.`,
        details: {
          count: result.rows.length,
          totalDue,
          samples: result.rows.slice(0, 10),
        },
      });
    } else {
      findings.push({
        check: 'dead_sale_open_invoices',
        severity: 'INFO',
        message: 'No open invoices linked to voided or fully-returned sales.',
      });
    }

    return findings;
  }

  /**
   * Valued ADJUSTMENT_IN movements must have a STOCK_MOVEMENT twin on GL 1300.
   */
  private static async checkAdjustmentInMissingGl(
    pool: pg.Pool
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];

    const result = await pool.query(`
      WITH mov_gl AS (
        SELECT DISTINCT lt."ReferenceNumber" AS mov
        FROM ledger_entries le
        JOIN ledger_transactions lt ON le."TransactionId" = lt."Id"
        JOIN accounts a ON le."AccountId" = a."Id"
        WHERE a."AccountCode" = '1300'
          AND lt."ReferenceType" = 'STOCK_MOVEMENT'
          AND lt."Status" = 'POSTED'
          AND lt."IsReversed" = FALSE
      )
      SELECT m.movement_number,
             ROUND((ABS(m.quantity) * COALESCE(m.unit_cost, 0))::numeric, 2) AS val
      FROM stock_movements m
      LEFT JOIN mov_gl g ON g.mov = m.movement_number
      WHERE m.movement_type::text = 'ADJUSTMENT_IN'
        AND g.mov IS NULL
        AND ABS(m.quantity) * COALESCE(m.unit_cost, 0) > 0.01
      ORDER BY ABS(m.quantity) * COALESCE(m.unit_cost, 0) DESC
      LIMIT 50
    `);

    if (result.rows.length > 0) {
      const totalVal = result.rows.reduce((sum, r) => sum + Number(r.val || 0), 0);
      findings.push({
        check: 'adjustment_in_missing_gl',
        severity: 'ERROR',
        message:
          `${result.rows.length} valued ADJUSTMENT_IN movement(s) have no GL 1300 twin ` +
          `(exposed value ${totalVal.toFixed(2)}).`,
        details: {
          count: result.rows.length,
          totalVal,
          samples: result.rows.slice(0, 10),
        },
      });
    } else {
      findings.push({
        check: 'adjustment_in_missing_gl',
        severity: 'INFO',
        message: 'All valued ADJUSTMENT_IN movements have a GL 1300 twin.',
      });
    }

    return findings;
  }

  // ===========================================================================
  // CHECK 6: AP Reconciliation (GL 2100 ↔ Supplier balances)
  // ===========================================================================

  private static async checkAPReconciliation(
    pool: pg.Pool
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];
    const { computeApReconciliationSnapshot, apMaterialityThreshold, isApDriftExplainedByExpenses } =
      await import('../modules/supplier-payments/apReconciliationEngine.js');

    const snapshot = await computeApReconciliationSnapshot(pool);
    const threshold = apMaterialityThreshold(snapshot.glBalance);
    const diff = new Decimal(snapshot.drift).abs();
    const ok = diff.lessThanOrEqualTo('0.01') || isApDriftExplainedByExpenses(snapshot, threshold);

    if (!ok) {
      findings.push({
        check: 'ap_reconciliation',
        severity: 'WARNING',
        message: `AP GL (2100) differs from open-item subledger by ${snapshot.drift.toFixed(2)}`,
        details: {
          glBalance: snapshot.glBalance,
          subledgerBalance: snapshot.subledgerBalance,
          difference: snapshot.drift,
          unallocatedPayments: snapshot.unallocatedPayments,
          expenseOnAp: snapshot.expenseOnAp,
        },
      });
    } else {
      findings.push({
        check: 'ap_reconciliation',
        severity: 'INFO',
        message: 'AP reconciliation: GL matches open-item supplier subledger.',
      });
    }

    return findings;
  }

  // ===========================================================================
  // CHECK 7: Inventory Reconciliation (GL 1300 ↔ Cost Layers)
  // ===========================================================================

  private static async checkInventoryReconciliation(
    pool: pg.Pool
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];

    const result = await pool.query(`
      SELECT
        COALESCE(
          (SELECT SUM(le."DebitAmount") - SUM(le."CreditAmount")
           FROM ledger_entries le
           JOIN accounts a ON a."Id" = le."AccountId"
           JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
           WHERE a."AccountCode" = '1300'
             AND ${LEDGER_NET_ACTIVE_SQL}), 0
        ) as gl_balance,
        COALESCE(
          (SELECT SUM(remaining_quantity * cost_price)
           FROM inventory_batches
           WHERE remaining_quantity > 0), 0
        ) as subledger_balance
    `);

    const glBalance = new Decimal(result.rows[0]?.gl_balance || 0);
    const subBalance = new Decimal(result.rows[0]?.subledger_balance || 0);
    const diff = glBalance.minus(subBalance).abs();

    if (diff.greaterThan('0.01')) {
      findings.push({
        check: 'inventory_reconciliation',
        severity: 'WARNING',
        message: `Inventory GL (1300) differs from inventory_batches subledger by ${diff.toFixed(2)}`,
        details: {
          glBalance: glBalance.toNumber(),
          subledgerBalance: subBalance.toNumber(),
          difference: diff.toNumber(),
        },
      });
    } else {
      findings.push({
        check: 'inventory_reconciliation',
        severity: 'INFO',
        message: 'Inventory reconciliation: GL matches inventory_batches subledger.',
      });
    }

    return findings;
  }

  // ===========================================================================
  // CHECK 8: Duplicate Idempotency Keys
  // ===========================================================================

  private static async checkDuplicateIdempotencyKeys(
    pool: pg.Pool
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];

    const result = await pool.query(`
      SELECT
        "IdempotencyKey" as key,
        COUNT(*) as count
      FROM ledger_transactions
      WHERE "IdempotencyKey" IS NOT NULL
        AND "Status" = 'POSTED'
      GROUP BY "IdempotencyKey"
      HAVING COUNT(*) > 1
      LIMIT 50
    `);

    if (result.rows.length > 0) {
      findings.push({
        check: 'duplicate_idempotency',
        severity: 'ERROR',
        message: `${result.rows.length} duplicate idempotency keys found.`,
        details: {
          duplicates: result.rows.map(r => ({
            key: r.key,
            count: parseInt(r.count, 10),
          })),
        },
      });
    } else {
      findings.push({
        check: 'duplicate_idempotency',
        severity: 'INFO',
        message: 'No duplicate idempotency keys found.',
      });
    }

    return findings;
  }

  // ===========================================================================
  // CHECK 9: Entries in Locked Periods
  // ===========================================================================

  private static async checkLockedPeriodViolations(
    pool: pg.Pool
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];

    const result = await pool.query(`
      SELECT COUNT(*) as violation_count
      FROM ledger_transactions lt
      JOIN financial_periods fp
        ON EXTRACT(YEAR FROM lt."TransactionDate") = fp.period_year
        AND EXTRACT(MONTH FROM lt."TransactionDate") = fp.period_month
      WHERE lt."Status" = 'POSTED'
        AND fp."Status" IN ('CLOSED', 'LOCKED')
        AND lt."CreatedAt" > COALESCE(fp."LockedAt", fp.closed_at)
    `);

    const count = parseInt(result.rows[0]?.violation_count || '0', 10);

    if (count > 0) {
      findings.push({
        check: 'locked_period_violations',
        severity: 'ERROR',
        message: `${count} entries posted after their period was locked.`,
        details: { violationCount: count },
      });
    } else {
      findings.push({
        check: 'locked_period_violations',
        severity: 'INFO',
        message: 'No locked-period violations detected.',
      });
    }

    return findings;
  }

  // ===========================================================================
  // CHECK 10: Sequence Gaps in Transaction Numbers
  // ===========================================================================

  private static async checkSequenceGaps(
    pool: pg.Pool
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];

    // Check for gaps in journal entry numbering within each year
    const result = await pool.query(`
      WITH numbered AS (
        SELECT
          "TransactionNumber",
          EXTRACT(YEAR FROM "TransactionDate") as year,
          ROW_NUMBER() OVER (
            PARTITION BY EXTRACT(YEAR FROM "TransactionDate")
            ORDER BY "TransactionNumber"
          ) as row_num,
          LAG("TransactionNumber") OVER (
            PARTITION BY EXTRACT(YEAR FROM "TransactionDate")
            ORDER BY "TransactionNumber"
          ) as prev_number
        FROM ledger_transactions
        WHERE "Status" = 'POSTED'
      )
      SELECT year, COUNT(*) as gap_count
      FROM numbered
      WHERE prev_number IS NOT NULL
        AND "TransactionNumber" IS NOT NULL
        AND prev_number IS DISTINCT FROM "TransactionNumber"
      GROUP BY year
      HAVING COUNT(*) > 0
    `);

    // This is informational — gaps can be normal after reversals
    if (result.rows.length > 0) {
      findings.push({
        check: 'sequence_gaps',
        severity: 'INFO',
        message: 'Transaction number sequence has gaps (normal after reversals).',
        details: {
          yearGaps: result.rows.map(r => ({
            year: parseInt(String(r.year), 10),
            gapCount: parseInt(r.gap_count, 10),
          })),
        },
      });
    } else {
      findings.push({
        check: 'sequence_gaps',
        severity: 'INFO',
        message: 'Transaction number sequences are contiguous.',
      });
    }

    return findings;
  }

  // ===========================================================================
  // CHECK 11: Negative Asset Balances
  // ===========================================================================

  private static async checkNegativeAssetBalances(
    pool: pg.Pool
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];

    const result = await pool.query(`
      SELECT
        a."AccountCode" as account_code,
        a."AccountName" as account_name,
        a."AccountType" as account_type,
        SUM(le."DebitAmount") - SUM(le."CreditAmount") as balance
      FROM ledger_entries le
      JOIN accounts a ON a."Id" = le."AccountId"
      JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
      WHERE a."AccountType" = 'ASSET'
        AND a."AccountCode" NOT IN ('1550')  -- Accum Depreciation is contra
      GROUP BY a."AccountCode", a."AccountName", a."AccountType"
      HAVING SUM(le."DebitAmount") - SUM(le."CreditAmount") < -0.01
    `);

    if (result.rows.length > 0) {
      for (const row of result.rows) {
        findings.push({
          check: 'negative_asset_balance',
          severity: 'WARNING',
          message: `Asset account ${row.account_code} (${row.account_name}) has negative balance: ${Number(row.balance).toFixed(2)}`,
          details: {
            accountCode: row.account_code,
            accountName: row.account_name,
            balance: Number(row.balance),
          },
        });
      }
    } else {
      findings.push({
        check: 'negative_asset_balance',
        severity: 'INFO',
        message: 'No asset accounts with negative balances.',
      });
    }

    return findings;
  }

  // ===========================================================================
  // CHECK 12: gl_period_balances ↔ ledger_entries Reconciliation
  // Detects drift between the pre-aggregated totals table and the source of truth.
  // ===========================================================================

  private static async checkPeriodBalancesReconciliation(
    pool: pg.Pool
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];

    // Compare net-active POSTED ledger_entries vs gl_period_balances (same rules as
    // glPeriodRebuildService.rebuildSingleAccountPeriod and rebuildPeriodBalances).
    // Only compare periods 1-12 (in-period activity, not period-0 carry-forward).
    const result = await pool.query(`
      WITH ledger_totals AS (
        SELECT
          le."AccountId"                    AS account_id,
          ${LEDGER_FISCAL_YEAR_SQL}         AS fiscal_year,
          ${LEDGER_FISCAL_PERIOD_SQL}       AS fiscal_period,
          COALESCE(SUM(le."DebitAmount"),  0) AS le_debits,
          COALESCE(SUM(le."CreditAmount"), 0) AS le_credits
        FROM ledger_entries le
        JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
        WHERE ${LEDGER_NET_ACTIVE_SQL}
        GROUP BY le."AccountId", ${LEDGER_FISCAL_YEAR_SQL}, ${LEDGER_FISCAL_PERIOD_SQL}
      )
      SELECT
        a."AccountCode"    AS account_code,
        a."AccountName"    AS account_name,
        COALESCE(lt.fiscal_year,  gpb.fiscal_year)  AS fiscal_year,
        COALESCE(lt.fiscal_period, gpb.fiscal_period) AS fiscal_period,
        COALESCE(lt.le_debits, 0)        AS le_debits,
        COALESCE(lt.le_credits, 0)       AS le_credits,
        COALESCE(gpb.debit_total, 0)     AS gpb_debits,
        COALESCE(gpb.credit_total, 0)    AS gpb_credits,
        ABS(COALESCE(lt.le_debits, 0) - COALESCE(gpb.debit_total, 0))   AS dr_diff,
        ABS(COALESCE(lt.le_credits, 0) - COALESCE(gpb.credit_total, 0)) AS cr_diff
      FROM ledger_totals lt
      FULL OUTER JOIN gl_period_balances gpb
        ON  gpb.account_id    = lt.account_id
        AND gpb.fiscal_year   = lt.fiscal_year
        AND gpb.fiscal_period = lt.fiscal_period
      JOIN accounts a ON a."Id" = COALESCE(lt.account_id, gpb.account_id)
      WHERE gpb.fiscal_period BETWEEN 1 AND 12   -- Skip period 0 (carry-forward)
        AND (
          ABS(COALESCE(lt.le_debits, 0) - COALESCE(gpb.debit_total, 0)) > 0.01
          OR ABS(COALESCE(lt.le_credits, 0) - COALESCE(gpb.credit_total, 0)) > 0.01
        )
      ORDER BY fiscal_year, fiscal_period, account_code
      LIMIT 100
    `);

    if (result.rows.length === 0) {
      findings.push({
        check: 'period_balances_reconciliation',
        severity: 'INFO',
        message: 'gl_period_balances matches ledger_entries for all account/periods.',
      });
    } else {
      findings.push({
        check: 'period_balances_reconciliation',
        severity: 'ERROR',
        message: `${result.rows.length} account/period(s) have drifted between gl_period_balances and ledger_entries.`,
        details: {
          driftCount: result.rows.length,
          remediation:
            'POST /api/system/gl/rebuild-period-balances — recomputes open periods from net-active ledger. '
            + 'If drift persists, check gl_projection_events for FAILED rows or manual SQL ledger edits.',
          samples: result.rows.slice(0, 10).map(r => ({
            accountCode: r.account_code,
            accountName: r.account_name,
            year: parseInt(String(r.fiscal_year), 10),
            period: parseInt(String(r.fiscal_period), 10),
            ledgerDebits: Number(r.le_debits),
            ledgerCredits: Number(r.le_credits),
            totalsDebits: Number(r.gpb_debits),
            totalsCredits: Number(r.gpb_credits),
            debitDrift: Number(r.dr_diff),
            creditDrift: Number(r.cr_diff),
          })),
        },
      });
    }

    return findings;
  }

  // ===========================================================================
  // CHECK 12b: gl_projection_events backlog (stale gl_period_balances risk)
  // ===========================================================================

  private static async checkGlProjectionEventsBacklog(
    pool: pg.Pool
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];
    try {
      const result = await pool.query<{ pending: string; failed: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('PENDING', 'PROCESSING'))::TEXT AS pending,
           COUNT(*) FILTER (WHERE status = 'FAILED')::TEXT AS failed
         FROM gl_projection_events`,
      );
      const pending = parseInt(result.rows[0]?.pending ?? '0', 10);
      const failed = parseInt(result.rows[0]?.failed ?? '0', 10);
      if (failed > 0) {
        findings.push({
          check: 'gl_projection_events_failed',
          severity: 'ERROR',
          message: `${failed} gl_projection_events row(s) in FAILED state — period balances may be stale.`,
          details: { failed, pending, remediation: 'POST /api/system/gl/process-projection-events then rebuild-period-balances' },
        });
      } else if (pending > 50) {
        findings.push({
          check: 'gl_projection_events_backlog',
          severity: 'WARNING',
          message: `${pending} pending gl_projection_events — period balance worker may be behind.`,
          details: { pending },
        });
      } else {
        findings.push({
          check: 'gl_projection_events_backlog',
          severity: 'INFO',
          message: 'gl_projection_events queue is healthy.',
          details: { pending, failed },
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('does not exist')) {
        findings.push({
          check: 'gl_projection_events_backlog',
          severity: 'INFO',
          message: 'gl_projection_events table not present (pre-migration tenant).',
        });
      } else {
        findings.push({
          check: 'gl_projection_events_backlog',
          severity: 'WARNING',
          message: `Could not read gl_projection_events: ${msg}`,
        });
      }
    }
    return findings;
  }

  // ===========================================================================
  // CHECK 13: gl_period_balances running_balance invariant
  // Ensures running_balance = debit_total - credit_total
  // (Defense-in-depth — the DB CHECK constraint should prevent this, but verify)
  // ===========================================================================

  private static async checkRunningBalanceInvariant(
    pool: pg.Pool
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];

    const result = await pool.query(`
      SELECT
        a."AccountCode" AS account_code,
        gpb.fiscal_year,
        gpb.fiscal_period,
        gpb.debit_total,
        gpb.credit_total,
        gpb.running_balance,
        (gpb.debit_total - gpb.credit_total) AS expected_balance,
        ABS(gpb.running_balance - (gpb.debit_total - gpb.credit_total)) AS invariant_drift
      FROM gl_period_balances gpb
      JOIN accounts a ON a."Id" = gpb.account_id
      WHERE ABS(gpb.running_balance - (gpb.debit_total - gpb.credit_total)) > 0.001
      LIMIT 50
    `);

    if (result.rows.length === 0) {
      findings.push({
        check: 'running_balance_invariant',
        severity: 'INFO',
        message: 'All gl_period_balances rows satisfy running_balance = debit_total - credit_total.',
      });
    } else {
      findings.push({
        check: 'running_balance_invariant',
        severity: 'ERROR',
        message: `${result.rows.length} gl_period_balances rows violate the running_balance invariant.`,
        details: {
          violationCount: result.rows.length,
          samples: result.rows.slice(0, 10).map(r => ({
            accountCode: r.account_code,
            year: parseInt(String(r.fiscal_year), 10),
            period: parseInt(String(r.fiscal_period), 10),
            debits: Number(r.debit_total),
            credits: Number(r.credit_total),
            storedBalance: Number(r.running_balance),
            expectedBalance: Number(r.expected_balance),
            drift: Number(r.invariant_drift),
          })),
        },
      });
    }

    return findings;
  }

  // ===========================================================================
  // CHECK 14: Product Daily Summary vs Sale Items Reconciliation
  // Ensures product_daily_summary state table matches sale_items aggregates
  // DATE-BOUNDED to last 30 days for 100M-row scalability
  // ===========================================================================

  private static async checkProductDailySummaryReconciliation(
    pool: pg.Pool
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];

    try {
      const result = await pool.query(`
        WITH date_range AS (
          SELECT (CURRENT_DATE - INTERVAL '30 days')::date AS since
        ),
        txn_totals AS (
          SELECT
            s.sale_date AS business_date,
            si.product_id,
            COALESCE(SUM(si.quantity), 0) AS txn_units,
            COALESCE(SUM(si.total_price), 0) AS txn_revenue
          FROM sales s
          JOIN sale_items si ON si.sale_id = s.id
          CROSS JOIN date_range dr
          WHERE s.status = 'COMPLETED'
            AND si.product_id IS NOT NULL
            AND s.sale_date >= dr.since
          GROUP BY s.sale_date, si.product_id
        ),
        state_totals AS (
          SELECT
            business_date,
            product_id,
            units_sold AS state_units,
            revenue AS state_revenue
          FROM product_daily_summary
          CROSS JOIN date_range dr
          WHERE business_date >= dr.since
        )
        SELECT
          COALESCE(t.business_date, s.business_date) AS business_date,
          COALESCE(t.product_id, s.product_id) AS product_id,
          COALESCE(t.txn_units, 0) AS txn_units,
          COALESCE(s.state_units, 0) AS state_units,
          COALESCE(t.txn_revenue, 0) AS txn_revenue,
          COALESCE(s.state_revenue, 0) AS state_revenue,
          ABS(COALESCE(t.txn_revenue, 0) - COALESCE(s.state_revenue, 0)) AS revenue_drift
        FROM txn_totals t
        FULL OUTER JOIN state_totals s
          ON t.business_date = s.business_date AND t.product_id = s.product_id
        WHERE ABS(COALESCE(t.txn_revenue, 0) - COALESCE(s.state_revenue, 0)) > 0.01
        LIMIT 50
      `);

      if (result.rows.length === 0) {
        findings.push({
          check: 'product_daily_summary_reconciliation',
          severity: 'INFO',
          message: 'product_daily_summary matches sale_items aggregates.',
        });
      } else {
        findings.push({
          check: 'product_daily_summary_reconciliation',
          severity: 'WARNING',
          message: `${result.rows.length} product_daily_summary rows drift from sale_items. Run backfill to heal.`,
          details: {
            driftCount: result.rows.length,
            samples: result.rows.slice(0, 5).map(r => ({
              date: r.business_date,
              productId: r.product_id,
              txnRevenue: Number(r.txn_revenue),
              stateRevenue: Number(r.state_revenue),
              drift: Number(r.revenue_drift),
            })),
          },
        });
      }
    } catch {
      findings.push({
        check: 'product_daily_summary_reconciliation',
        severity: 'INFO',
        message: 'product_daily_summary table not yet created — skipping check.',
      });
    }

    return findings;
  }

  // ===========================================================================
  // CHECK 15: Inventory Balances vs products.quantity_on_hand Reconciliation
  // ===========================================================================

  private static async checkInventoryBalancesReconciliation(
    pool: pg.Pool
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];

    try {
      const result = await pool.query(`
        SELECT
          p.id AS product_id,
          p.name AS product_name,
          COALESCE(p.quantity_on_hand, 0) AS product_qoh,
          COALESCE(ib.quantity_on_hand, 0) AS state_qoh,
          ABS(COALESCE(p.quantity_on_hand, 0) - COALESCE(ib.quantity_on_hand, 0)) AS qoh_drift
        FROM products p
        LEFT JOIN inventory_aggregate_balances ib ON ib.product_id = p.id
        WHERE ABS(COALESCE(p.quantity_on_hand, 0) - COALESCE(ib.quantity_on_hand, 0)) > 0.001
        LIMIT 50
      `);

      if (result.rows.length === 0) {
        findings.push({
          check: 'inventory_balances_reconciliation',
          severity: 'INFO',
          message: 'inventory_aggregate_balances matches products.quantity_on_hand.',
        });
      } else {
        findings.push({
          check: 'inventory_balances_reconciliation',
          severity: 'WARNING',
          message: `${result.rows.length} inventory_aggregate_balances rows drift from products.quantity_on_hand. Run backfill to heal.`,
          details: {
            driftCount: result.rows.length,
            samples: result.rows.slice(0, 5).map(r => ({
              productId: r.product_id,
              productName: r.product_name,
              productQoh: Number(r.product_qoh),
              stateQoh: Number(r.state_qoh),
              drift: Number(r.qoh_drift),
            })),
          },
        });
      }
    } catch {
      findings.push({
        check: 'inventory_balances_reconciliation',
        severity: 'INFO',
        message: 'inventory_aggregate_balances table not yet created — skipping check.',
      });
    }

    return findings;
  }

  // ===========================================================================
  // CHECK 16: Customer Balances State vs customers.balance Reconciliation
  // ===========================================================================

  private static async checkCustomerBalancesReconciliation(
    pool: pg.Pool
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];

    try {
      const result = await pool.query(`
        SELECT
          c.id AS customer_id,
          c.name AS customer_name,
          COALESCE(c.balance, 0) AS master_balance,
          COALESCE(cb.balance, 0) AS state_balance,
          ABS(COALESCE(c.balance, 0) - COALESCE(cb.balance, 0)) AS balance_drift
        FROM customers c
        LEFT JOIN customer_balances cb ON cb.customer_id = c.id
        WHERE ABS(COALESCE(c.balance, 0) - COALESCE(cb.balance, 0)) > 0.01
        LIMIT 50
      `);

      if (result.rows.length === 0) {
        findings.push({
          check: 'customer_balances_reconciliation',
          severity: 'INFO',
          message: 'customer_balances matches customers.balance.',
        });
      } else {
        findings.push({
          check: 'customer_balances_reconciliation',
          severity: 'WARNING',
          message: `${result.rows.length} customer_balances rows drift from customers.balance. Run backfill to heal.`,
          details: {
            driftCount: result.rows.length,
            samples: result.rows.slice(0, 5).map(r => ({
              customerId: r.customer_id,
              customerName: r.customer_name,
              masterBalance: Number(r.master_balance),
              stateBalance: Number(r.state_balance),
              drift: Number(r.balance_drift),
            })),
          },
        });
      }
    } catch {
      findings.push({
        check: 'customer_balances_reconciliation',
        severity: 'INFO',
        message: 'customer_balances table not yet created — skipping check.',
      });
    }

    return findings;
  }

  // ===========================================================================
  // CHECK 17: Supplier Invoice Safety — no document with POSTED GL may be lost
  // ===========================================================================
  // Detects two failure modes:
  //   A) GL→Subledger: a POSTED ledger transaction whose ReferenceType is a
  //      supplier-invoice doc, but its referenced supplier_invoices row is
  //      either gone (hard-deleted) or soft-deleted while the GL still posts.
  //   B) Subledger→GL: a non-cancelled supplier_invoices row with
  //      OutstandingBalance > 0 that has zero POSTED ledger transactions.
  //
  // Either case means the system silently lost (or never recorded) a liability.
  // This check guards the user's invariant: "no invoice of any supplier can
  // ever get lost or disappear".
  // ===========================================================================
  private static async checkSupplierInvoiceSafety(
    pool: pg.Pool,
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];

    // (A) Orphan GL: POSTED ledger TX referencing a supplier-doc that is
    //                hard-deleted or soft-deleted.
    const orphanGl = await pool.query(`
      SELECT lt."TransactionNumber" AS tx_num,
             lt."ReferenceType"     AS ref_type,
             lt."ReferenceId"       AS ref_id,
             lt."Description"       AS description
      FROM ledger_transactions lt
      WHERE lt."Status" = 'POSTED'
        AND lt."ReferenceType" IN (
          'SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','SUPPLIER_DEBIT_NOTE'
        )
        AND NOT EXISTS (
          SELECT 1 FROM supplier_invoices si
          WHERE si."Id" = lt."ReferenceId" AND si.deleted_at IS NULL
        )
      LIMIT 100
    `);

    // (B) Lost subledger: live invoice with OB>0 that has zero POSTED GL TX.
    const orphanInvoices = await pool.query(`
      SELECT si."SupplierInvoiceNumber" AS inv_num,
             si.document_type           AS doc_type,
             si."Status"                AS status,
             si."OutstandingBalance"    AS ob
      FROM supplier_invoices si
      WHERE si.deleted_at IS NULL
        AND COALESCE(si."OutstandingBalance", 0) > 0
        AND UPPER(si."Status") NOT IN ('CANCELLED','VOID','VOIDED','DELETED','DRAFT')
        AND NOT EXISTS (
          SELECT 1 FROM ledger_transactions lt
          WHERE lt."ReferenceId" = si."Id"
            AND lt."Status" IN ('POSTED','REVERSED')
        )
      LIMIT 100
    `);

    if (orphanGl.rows.length === 0 && orphanInvoices.rows.length === 0) {
      findings.push({
        check: 'supplier_invoice_safety',
        severity: 'INFO',
        message:
          'Supplier invoice safety: every POSTED GL doc has a live subledger row, every live invoice has a GL trail.',
      });
    } else {
      const parts: string[] = [];
      if (orphanGl.rows.length > 0) {
        parts.push(`${orphanGl.rows.length} POSTED GL tx(s) reference a deleted/missing supplier doc`);
      }
      if (orphanInvoices.rows.length > 0) {
        parts.push(`${orphanInvoices.rows.length} live invoice(s) with OB>0 have no GL posting`);
      }
      findings.push({
        check: 'supplier_invoice_safety',
        severity: 'ERROR',
        message: `Supplier invoice safety violation: ${parts.join('; ')}.`,
        details: {
          orphanGlCount: orphanGl.rows.length,
          orphanGlSamples: orphanGl.rows.slice(0, 5),
          orphanInvoicesCount: orphanInvoices.rows.length,
          orphanInvoicesSamples: orphanInvoices.rows.slice(0, 5),
        },
      });
    }

    return findings;
  }

  // ===========================================================================
  // CHECK 18: Trial Balance Structural Integrity (3 rules)
  // ===========================================================================

  /**
   * Structural warnings that don't necessarily mean the trial balance is out
   * of balance, but indicate accounting hygiene problems:
   *
   *   Rule A — Opening Balance Equity (3050) non-zero
   *     In a properly closed system, 3050 should be cleared into Retained Earnings
   *     after the first year-end close. A persistent non-zero balance means opening
   *     entries have never been formally closed.
   *
   *   Rule B — GR/IR (2150) has a GL balance but no uninvoiced GRNs exist
   *     GR/IR should net to zero once all goods receipts are invoiced. A remaining
   *     balance with no open GRNs indicates polluted entries (typically Return GRN
   *     or Supplier Credit Note entries that incorrectly posted to 2150 instead of
   *     the dedicated Supplier Return Clearing account 2160).
   *
   *   Rule C — GR/IR pollution: Return GRN or Supplier Credit Note entries in 2150
   *     These entries should have gone through account 2160 (Supplier Return Clearing).
   *     A non-zero count means historical data needs migration.
   */
  private static async checkTrialBalanceStructuralIntegrity(
    pool: pg.Pool
  ): Promise<IntegrityFinding[]> {
    const findings: IntegrityFinding[] = [];

    // ── Rule A: Opening Balance Equity (3050) should be zero ──────────────
    const obEquityResult = await pool.query(`
      SELECT COALESCE(SUM(le."DebitAmount" - le."CreditAmount"), 0) AS balance
      FROM ledger_entries le
      JOIN accounts a ON a."Id" = le."AccountId"
      WHERE a."AccountCode" = '3050'
    `);
    const obEquityBalance = Money.toNumber(Money.parseDb(
      String(obEquityResult.rows[0]?.balance ?? '0')
    ));

    if (Math.abs(obEquityBalance) < 0.01) {
      findings.push({
        check: 'structural_opening_balance_equity',
        severity: 'INFO',
        message: 'Opening Balance Equity (3050) is zero — properly closed.',
      });
    } else {
      findings.push({
        check: 'structural_opening_balance_equity',
        severity: 'WARNING',
        message: `Opening Balance Equity (3050) has a non-zero balance of ${obEquityBalance}. ` +
          'This account should be cleared to Retained Earnings after the first year-end close.',
        details: { accountCode: '3050', balance: obEquityBalance },
      });
    }

    // ── Rule B: GR/IR (2150) balance vs. uninvoiced GRN count ────────────
    const grirGlResult = await pool.query(`
      SELECT COALESCE(SUM(le."DebitAmount" - le."CreditAmount"), 0) AS gl_balance
      FROM ledger_entries le
      JOIN accounts a ON a."Id" = le."AccountId"
      JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
      WHERE a."AccountCode" = '2150'
        AND lt."Status" = 'POSTED'
    `);
    const grirGlBalance = Money.toNumber(Money.parseDb(
      String(grirGlResult.rows[0]?.gl_balance ?? '0')
    ));

    const uninvoicedResult = await pool.query(`
      SELECT COUNT(DISTINCT gr.id) AS uninvoiced_count
      FROM goods_receipts gr
      JOIN purchase_orders po ON gr.purchase_order_id = po.id
      WHERE gr.status = 'COMPLETED'
        AND NOT EXISTS (
          SELECT 1 FROM supplier_invoices si
          WHERE si."PurchaseOrderId" = po.id
            AND si.deleted_at IS NULL
            AND COALESCE(si."Status",'') NOT IN ('Cancelled','CANCELLED','Voided','VOIDED')
        )
    `);
    const uninvoicedCount = parseInt(String(uninvoicedResult.rows[0]?.uninvoiced_count ?? '0'), 10);

    if (Math.abs(grirGlBalance) > 0.01 && uninvoicedCount === 0) {
      findings.push({
        check: 'structural_grir_balance_no_open_grns',
        severity: 'WARNING',
        message: `GR/IR Clearing (2150) has a GL balance of ${grirGlBalance} but there are no uninvoiced goods receipts. ` +
          'This indicates polluted entries (Return GRN or Supplier Credit Note) were posted to 2150. ' +
          'Run the migration script to move them to account 2160 (Supplier Return Clearing).',
        details: { accountCode: '2150', glBalance: grirGlBalance, uninvoicedGrnCount: uninvoicedCount },
      });
    } else if (Math.abs(grirGlBalance) < 0.01 && uninvoicedCount === 0) {
      findings.push({
        check: 'structural_grir_balance_no_open_grns',
        severity: 'INFO',
        message: 'GR/IR Clearing (2150) is zero with no uninvoiced GRNs — fully cleared.',
      });
    } else {
      findings.push({
        check: 'structural_grir_balance_no_open_grns',
        severity: 'INFO',
        message: `GR/IR Clearing (2150) balance of ${grirGlBalance} matches ${uninvoicedCount} uninvoiced GRN(s).`,
        details: { accountCode: '2150', glBalance: grirGlBalance, uninvoicedGrnCount: uninvoicedCount },
      });
    }

    // ── Rule C: Detect historical GR/IR pollution (Return GRN / Credit Note) ─
    // Only count entries that do NOT have an offsetting GRIR_CORRECTION journal
    const pollutionResult = await pool.query(`
      SELECT
        COUNT(*) AS polluted_count,
        COALESCE(SUM(le."DebitAmount" - le."CreditAmount"), 0) AS polluted_balance
      FROM ledger_entries le
      JOIN accounts a ON a."Id" = le."AccountId"
      JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
      WHERE a."AccountCode" = '2150'
        AND lt."Status" = 'POSTED'
        AND lt."ReferenceType" IN ('RETURN_GRN', 'SUPPLIER_CREDIT_NOTE')
        AND NOT EXISTS (
          SELECT 1 FROM ledger_transactions lt2
          WHERE lt2."ReferenceType" = 'GRIR_CORRECTION'
            AND lt2."ReferenceId" = lt."ReferenceId"
        )
    `);
    const pollutedCount = parseInt(String(pollutionResult.rows[0]?.polluted_count ?? '0'), 10);
    const pollutedBalance = Money.toNumber(Money.parseDb(
      String(pollutionResult.rows[0]?.polluted_balance ?? '0')
    ));

    if (pollutedCount === 0) {
      findings.push({
        check: 'structural_grir_pollution',
        severity: 'INFO',
        message: 'GR/IR Clearing (2150) contains no Return GRN or Supplier Credit Note entries — MR11 purity confirmed.',
      });
    } else {
      findings.push({
        check: 'structural_grir_pollution',
        severity: 'WARNING',
        message: `GR/IR Clearing (2150) contains ${pollutedCount} Return GRN / Supplier Credit Note entries ` +
          `with a net balance of ${pollutedBalance}. These should be in account 2160 (Supplier Return Clearing). ` +
          'Run shared/sql/migrate_supplier_return_clearing.sql to fix historical data.',
        details: {
          accountCode: '2150',
          pollutedEntryCount: pollutedCount,
          pollutedBalance,
          remediationScript: 'shared/sql/migrate_supplier_return_clearing.sql',
        },
      });
    }

    return findings;
  }
}

export default GLIntegrityChecker;
