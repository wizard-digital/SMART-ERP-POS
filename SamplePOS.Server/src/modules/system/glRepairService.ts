/**
 * GL REPAIR SERVICE
 *
 * Expanded idempotent repair engine that scans all historical documents for
 * missing GL entries and reposts them using the canonical glEntryService functions.
 *
 * Covered document types:
 *   1. Goods Receipts         (COMPLETED, DR Inventory / CR GRIR Clearing)
 *   2. Return GRNs            (POSTED, DR GRIR Clearing / CR Inventory)
 *   3. Supplier Invoices      (POSTED / Paid / PartiallyPaid, DR GRIR / CR AP)
 *   4. Supplier Payments      (COMPLETED, DR AP / CR Cash)
 *   5. Stock Movements        (ADJUSTMENT_IN/OUT, DAMAGE, EXPIRY)
 *   6. Opening Stock          (OPENING_BALANCE movements)
 *   7. Sales                  (COMPLETED, DR Cash / CR Revenue + COGS)
 *
 * ALL calls are fully idempotent — AccountingCore.createJournalEntry enforces a
 * UNIQUE constraint on IdempotencyKey, so re-running is always safe.
 */

import { pool as globalPool } from '../../db/pool.js';
import type pg from 'pg';
import Decimal from 'decimal.js';
import logger from '../../utils/logger.js';
import * as glEntryService from '../../services/glEntryService.js';
import { getBusinessDate } from '../../utils/dateRange.js';
import { Money } from '../../utils/money.js';
import { AccountingCore } from '../../services/accountingCore.js';
import { LEDGER_NET_ACTIVE_SQL } from '../../utils/ledgerNetActive.js';
import { ACTIVE_GL_REFERENCE_PREDICATE } from '../../utils/activeGlReference.js';
import {
  computeApReconciliationSnapshot,
  apMaterialityThreshold,
  isApDriftExplainedByExpenses,
  syncSupplierBalanceFromOpenItems,
} from '../supplier-payments/apReconciliationEngine.js';
import { syncCustomerBalanceFromOpenItems } from '../ar-payments/openItemAllocationEngine.js';
import {
  captureApReconciliationMetrics,
  verifyApReconciliationMetrics,
  type ApReconciliationMetrics,
} from '../supplier-payments/apReconciliationMetrics.js';

export interface RepairTypeResult {
    found: number;
    reposted: number;
    skipped: number;
    errors: string[];
}

export interface GLRepairResult {
    goodsReceipts: RepairTypeResult;
    returnGrns: RepairTypeResult;
    supplierInvoices: RepairTypeResult;
    supplierPayments: RepairTypeResult;
    stockMovements: RepairTypeResult;
    openingStock: RepairTypeResult;
    sales: RepairTypeResult;
    summary: string;
    totalFound: number;
    totalReposted: number;
    totalErrors: number;
}

export interface GLIntegrityStatus {
    systemStatus: 'GREEN' | 'YELLOW' | 'RED';
    checkedAt: string;
    checks: {
        apReconciliation: {
            glBalance: number;
            subledgerBalance: number;
            difference: number;
            isBalanced: boolean;
            legacyGrInAp: number;
        };
        inventoryReconciliation: {
            glBalance: number;
            subledgerBalance: number;
            difference: number;
            isBalanced: boolean;
        };
        arReconciliation: {
            glBalance: number;
            subledgerBalance: number;
            difference: number;
            isBalanced: boolean;
        };
        missingGL: {
            goodsReceiptsWithoutGL: number;
            returnGrnsWithoutGL: number;
            supplierInvoicesWithoutGL: number;
            supplierPaymentsWithoutGL: number;
            stockMovementsWithoutGL: number;
            salesWithoutGL: number;
        };
        unbalancedJournals: number;
        suspiciousMovements: Array<{
            movementNumber: string;
            movementType: string;
            totalValue: number;
            notes: string | null;
        }>;
    };
    alerts: string[];
}

// ============================================================================
// REPAIR ENGINE
// ============================================================================

/**
 * Scan all historical documents for missing GL entries and repost them.
 * Fully idempotent — safe to call multiple times.
 */
export async function repostAllMissingGL(dbPool?: pg.Pool): Promise<GLRepairResult> {
    const pool = dbPool || globalPool;

    const grResult = await repairGoodsReceipts(pool);
    const rgrResult = await repairReturnGrns(pool);
    const siResult = await repairSupplierInvoices(pool);
    const spResult = await repairSupplierPayments(pool);
    const smResult = await repairStockMovements(pool);
    const osResult = await repairOpeningStock(pool);
    const saleResult = await repairSales(pool);

    const totalFound =
        grResult.found + rgrResult.found + siResult.found + spResult.found +
        smResult.found + osResult.found + saleResult.found;
    const totalReposted =
        grResult.reposted + rgrResult.reposted + siResult.reposted + spResult.reposted +
        smResult.reposted + osResult.reposted + saleResult.reposted;
    const totalErrors =
        grResult.errors.length + rgrResult.errors.length + siResult.errors.length +
        spResult.errors.length + smResult.errors.length + osResult.errors.length +
        saleResult.errors.length;

    const summary =
        `GRs: ${grResult.reposted}/${grResult.found} | ` +
        `Returns: ${rgrResult.reposted}/${rgrResult.found} | ` +
        `Invoices: ${siResult.reposted}/${siResult.found} | ` +
        `Payments: ${spResult.reposted}/${spResult.found} | ` +
        `StockMvts: ${smResult.reposted}/${smResult.found} | ` +
        `OpeningStock: ${osResult.reposted}/${osResult.found} | ` +
        `Sales: ${saleResult.reposted}/${saleResult.found}` +
        (totalErrors > 0 ? ` | Errors: ${totalErrors}` : '');

    logger.info('GL repair engine completed', { summary, totalFound, totalReposted, totalErrors });

    return {
        goodsReceipts: grResult,
        returnGrns: rgrResult,
        supplierInvoices: siResult,
        supplierPayments: spResult,
        stockMovements: smResult,
        openingStock: osResult,
        sales: saleResult,
        summary,
        totalFound,
        totalReposted,
        totalErrors,
    };
}

// ============================================================================
// 1. GOODS RECEIPTS
// ============================================================================
async function repairGoodsReceipts(pool: pg.Pool): Promise<RepairTypeResult> {
    const result: RepairTypeResult = { found: 0, reposted: 0, skipped: 0, errors: [] };

    const rows = await pool.query(`
    SELECT
      gr.id,
      gr.receipt_number,
      gr.received_date,
      po.supplier_id,
      s."CompanyName" AS supplier_name,
      COALESCE(gr.total_value, 0) AS total_value
    FROM goods_receipts gr
    LEFT JOIN purchase_orders po ON po.id = gr.purchase_order_id
    LEFT JOIN suppliers s ON s."Id" = po.supplier_id
    WHERE gr.status = 'COMPLETED'
      AND COALESCE(gr.total_value, 0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM ledger_transactions lt
        WHERE lt."ReferenceType" = 'GOODS_RECEIPT'
          AND lt."ReferenceId" = gr.id
          AND ${ACTIVE_GL_REFERENCE_PREDICATE}
      )
  `);

    result.found = rows.rows.length;

    for (const gr of rows.rows) {
        try {
            await glEntryService.recordGoodsReceiptToGL({
                grId: gr.id,
                grNumber: gr.receipt_number || gr.id,
                grDate: toDateString(gr.received_date),
                totalAmount: new Decimal(gr.total_value).toNumber(),
                supplierId: gr.supplier_id || '',
                supplierName: gr.supplier_name || 'Unknown Supplier',
            }, pool);
            result.reposted++;
            logger.info('Repaired missing GR GL entry', { grId: gr.id, grNumber: gr.receipt_number });
        } catch (err) {
            const msg = `GR ${gr.receipt_number}: ${err instanceof Error ? err.message : String(err)}`;
            result.errors.push(msg);
            logger.error('Failed to repair GR GL entry', { grId: gr.id, error: msg });
        }
    }

    return result;
}

// ============================================================================
// 2. RETURN GRNs
// ============================================================================
async function repairReturnGrns(pool: pg.Pool): Promise<RepairTypeResult> {
    const result: RepairTypeResult = { found: 0, reposted: 0, skipped: 0, errors: [] };

    const rows = await pool.query(`
    SELECT
      r.id,
      r.return_grn_number,
      r.return_date,
      r.supplier_id,
      s."CompanyName" AS supplier_name,
      COALESCE(SUM(rl.line_total), 0) AS total_amount,
      gr.receipt_number AS original_gr_number
    FROM return_grn r
    LEFT JOIN return_grn_lines rl ON rl.rgrn_id = r.id
    LEFT JOIN suppliers s ON s."Id" = r.supplier_id
    LEFT JOIN goods_receipts gr ON gr.id = r.grn_id
    WHERE r.status = 'POSTED'
      AND NOT EXISTS (
        SELECT 1 FROM ledger_transactions lt
        WHERE lt."ReferenceType" = 'RETURN_GRN'
          AND lt."ReferenceId" = r.id
          AND ${ACTIVE_GL_REFERENCE_PREDICATE}
      )
    GROUP BY r.id, r.return_grn_number, r.return_date, r.supplier_id, s."CompanyName", gr.receipt_number
    HAVING COALESCE(SUM(rl.line_total), 0) > 0
  `);

    result.found = rows.rows.length;

    for (const rgrn of rows.rows) {
        try {
            await glEntryService.recordReturnGrnToGL({
                returnGrnId: rgrn.id,
                returnGrnNumber: rgrn.return_grn_number || rgrn.id,
                returnDate: toDateString(rgrn.return_date),
                totalAmount: new Decimal(rgrn.total_amount).toNumber(),
                supplierId: rgrn.supplier_id || '',
                supplierName: rgrn.supplier_name || 'Unknown Supplier',
                originalGrNumber: rgrn.original_gr_number || undefined,
            }, pool);
            result.reposted++;
            logger.info('Repaired missing Return GRN GL entry', { id: rgrn.id, number: rgrn.return_grn_number });
        } catch (err) {
            const msg = `Return GRN ${rgrn.return_grn_number}: ${err instanceof Error ? err.message : String(err)}`;
            result.errors.push(msg);
            logger.error('Failed to repair Return GRN GL entry', { id: rgrn.id, error: msg });
        }
    }

    return result;
}

// ============================================================================
// 3. SUPPLIER INVOICES
// ============================================================================
async function repairSupplierInvoices(pool: pg.Pool): Promise<RepairTypeResult> {
    const result: RepairTypeResult = { found: 0, reposted: 0, skipped: 0, errors: [] };

    // Posted / Paid / PartiallyPaid invoices that have no SUPPLIER_INVOICE GL entry
    const rows = await pool.query(`
    SELECT
      si."Id"                       AS id,
      si."SupplierInvoiceNumber"    AS invoice_number,
      si."InvoiceDate"              AS invoice_date,
      si."TotalAmount"              AS total_amount,
      si."SupplierId"               AS supplier_id,
      si."InternalReferenceNumber"  AS internal_reference_number,
      s."CompanyName"               AS supplier_name
    FROM supplier_invoices si
    LEFT JOIN suppliers s ON s."Id" = si."SupplierId"
    WHERE si."Status" IN ('POSTED', 'Paid', 'PartiallyPaid', 'PAID', 'PARTIALLY_PAID')
      AND COALESCE(si."TotalAmount", 0) > 0
      AND si.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM ledger_transactions lt
        WHERE lt."ReferenceType" = 'SUPPLIER_INVOICE'
          AND lt."ReferenceId" = si."Id"
          AND ${ACTIVE_GL_REFERENCE_PREDICATE}
      )
  `);

    result.found = rows.rows.length;

    for (const inv of rows.rows) {
        try {
            // Determine routing: GR-linked → GR/IR Clearing; standalone → General Expense
            const grRef = (inv.internal_reference_number || '').trim();
            let hasGrReference = false;
            if (grRef.startsWith('GR-')) {
                const grCheck = await pool.query(
                    `SELECT 1 FROM goods_receipts WHERE receipt_number = $1 AND status = 'COMPLETED' LIMIT 1`,
                    [grRef],
                );
                hasGrReference = grCheck.rows.length > 0;
            }

            await glEntryService.recordSupplierInvoiceToGL({
                invoiceId: inv.id,
                invoiceNumber: inv.invoice_number || inv.id,
                invoiceDate: toDateString(inv.invoice_date),
                totalAmount: new Decimal(inv.total_amount).toNumber(),
                supplierId: inv.supplier_id || '',
                supplierName: inv.supplier_name || 'Unknown Supplier',
                hasGrReference,
            }, pool);
            result.reposted++;
            logger.info('Repaired missing Supplier Invoice GL entry', { id: inv.id, number: inv.invoice_number });
        } catch (err) {
            const msg = `Invoice ${inv.invoice_number}: ${err instanceof Error ? err.message : String(err)}`;
            result.errors.push(msg);
            logger.error('Failed to repair Supplier Invoice GL entry', { id: inv.id, error: msg });
        }
    }

    return result;
}

// ============================================================================
// 4. SUPPLIER PAYMENTS
// ============================================================================
async function repairSupplierPayments(pool: pg.Pool): Promise<RepairTypeResult> {
    const result: RepairTypeResult = { found: 0, reposted: 0, skipped: 0, errors: [] };

    const rows = await pool.query(`
    SELECT
      sp."Id"            AS id,
      sp."PaymentNumber" AS payment_number,
      sp."PaymentDate"   AS payment_date,
      sp."Amount"        AS amount,
      sp."PaymentMethod" AS payment_method,
      sp."SupplierId"    AS supplier_id,
      s."CompanyName"    AS supplier_name
    FROM supplier_payments sp
    LEFT JOIN suppliers s ON s."Id" = sp."SupplierId"
    WHERE sp."Status" = 'COMPLETED'
      AND sp.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM ledger_transactions lt
        WHERE lt."ReferenceType" = 'SUPPLIER_PAYMENT'
          AND lt."ReferenceId" = sp."Id"
          AND ${ACTIVE_GL_REFERENCE_PREDICATE}
      )
  `);

    result.found = rows.rows.length;

    for (const sp of rows.rows) {
        try {
            await glEntryService.recordSupplierPaymentToGL({
                paymentId: sp.id,
                paymentNumber: sp.payment_number || sp.id,
                paymentDate: toDateString(sp.payment_date),
                amount: new Decimal(sp.amount).toNumber(),
                paymentMethod: (sp.payment_method as 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'CHECK' | 'MOBILE_MONEY') || 'CASH',
                supplierId: sp.supplier_id || '',
                supplierName: sp.supplier_name || 'Unknown Supplier',
            }, pool);
            result.reposted++;
            logger.info('Repaired missing Supplier Payment GL entry', { id: sp.id, number: sp.payment_number });
        } catch (err) {
            const msg = `Payment ${sp.payment_number}: ${err instanceof Error ? err.message : String(err)}`;
            result.errors.push(msg);
            logger.error('Failed to repair Supplier Payment GL entry', { id: sp.id, error: msg });
        }
    }

    return result;
}

// ============================================================================
// 5. STOCK MOVEMENTS (ADJUSTMENT_IN/OUT, DAMAGE, EXPIRY)
// ============================================================================
async function repairStockMovements(pool: pg.Pool): Promise<RepairTypeResult> {
    const result: RepairTypeResult = { found: 0, reposted: 0, skipped: 0, errors: [] };

    // LQ-INV-8: never invent GL for quarantine-only audits (posts_gl=false / QUARANTINE_TRANSFER)
    const rows = await pool.query(`
    SELECT
      sm.id,
      sm.movement_number,
      sm.movement_type,
      sm.product_id,
      sm.quantity,
      sm.unit_cost,
      sm.created_at,
      sm.reference_type,
      sm.notes,
      sm.economic_event,
      sm.posts_gl,
      p.name AS product_name
    FROM stock_movements sm
    LEFT JOIN products p ON p.id = sm.product_id
    WHERE sm.movement_type IN ('ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'DAMAGE', 'EXPIRY')
      AND sm.unit_cost > 0
      AND NOT (
        sm.posts_gl IS FALSE
        OR sm.economic_event = 'QUARANTINE_TRANSFER'
        OR UPPER(COALESCE(sm.reference_type, '')) = 'EXPIRY_AUTOMATION'
        OR UPPER(COALESCE(sm.reference_type, '')) = 'SOFT_QUARANTINE'
        OR UPPER(COALESCE(sm.reference_type, '')) = 'LOT_SPLIT'
        OR LOWER(COALESCE(sm.notes, '')) LIKE '%internal quarantine transfer%'
      )
      AND NOT EXISTS (
        SELECT 1 FROM ledger_transactions lt
        WHERE lt."ReferenceType" = 'STOCK_MOVEMENT'
          AND lt."ReferenceId" = sm.id
          AND ${ACTIVE_GL_REFERENCE_PREDICATE}
      )
    ORDER BY sm.created_at
  `);

    result.found = rows.rows.length;

    for (const sm of rows.rows) {
        const { shouldSkipGlRepairForMovement } = await import(
            '@shared/loss-quarantine/index.js'
        );
        if (
            shouldSkipGlRepairForMovement({
                movementType: sm.movement_type,
                referenceType: sm.reference_type,
                notes: sm.notes,
                economicEvent: sm.economic_event,
                postsGl: sm.posts_gl,
            })
        ) {
            result.skipped++;
            continue;
        }

        const movementValue = new Decimal(sm.quantity).abs().times(new Decimal(sm.unit_cost)).toNumber();
        if (movementValue <= 0) {
            result.skipped++;
            continue;
        }

        try {
            await glEntryService.recordStockMovementToGL({
                movementId: sm.id,
                movementNumber: sm.movement_number || sm.id,
                movementDate: toDateString(sm.created_at),
                movementType: sm.movement_type as 'ADJUSTMENT_IN' | 'ADJUSTMENT_OUT' | 'DAMAGE' | 'EXPIRY',
                movementValue,
                productName: sm.product_name || undefined,
            }, pool);
            result.reposted++;
            logger.info('Repaired missing Stock Movement GL entry', { id: sm.id, type: sm.movement_type });
        } catch (err) {
            const msg = `StockMovement ${sm.movement_number} (${sm.movement_type}): ${err instanceof Error ? err.message : String(err)}`;
            result.errors.push(msg);
            logger.error('Failed to repair Stock Movement GL entry', { id: sm.id, error: msg });
        }
    }

    return result;
}

// ============================================================================
// 6. OPENING STOCK (movement_type = 'OPENING_BALANCE')
// ============================================================================
async function repairOpeningStock(pool: pg.Pool): Promise<RepairTypeResult> {
    const result: RepairTypeResult = { found: 0, reposted: 0, skipped: 0, errors: [] };

    const rows = await pool.query(`
    SELECT
      sm.id,
      sm.movement_number,
      sm.product_id,
      sm.quantity,
      sm.unit_cost,
      sm.created_at,
      ib.batch_number,
      p.name AS product_name
    FROM stock_movements sm
    LEFT JOIN products p ON p.id = sm.product_id
    LEFT JOIN inventory_batches ib ON ib.id = sm.batch_id
    WHERE sm.movement_type = 'OPENING_BALANCE'
      AND sm.unit_cost > 0
      AND NOT EXISTS (
        SELECT 1 FROM ledger_transactions lt
        WHERE lt."ReferenceType" = 'OPENING_STOCK'
          AND lt."ReferenceId" = sm.id
          AND ${ACTIVE_GL_REFERENCE_PREDICATE}
      )
    ORDER BY sm.created_at
  `);

    result.found = rows.rows.length;

    for (const sm of rows.rows) {
        const movementValue = new Decimal(sm.quantity).abs().times(new Decimal(sm.unit_cost)).toNumber();
        if (movementValue <= 0) {
            result.skipped++;
            continue;
        }

        try {
            await glEntryService.recordOpeningStockToGL({
                movementId: sm.id,
                movementNumber: sm.movement_number || sm.id,
                movementDate: toDateString(sm.created_at),
                movementValue,
                productId: sm.product_id,
                batchNumber: sm.batch_number || sm.id,
                productName: sm.product_name || undefined,
            }, pool);
            result.reposted++;
            logger.info('Repaired missing Opening Stock GL entry', { id: sm.id, productId: sm.product_id });
        } catch (err) {
            const msg = `OpeningStock ${sm.movement_number}: ${err instanceof Error ? err.message : String(err)}`;
            result.errors.push(msg);
            logger.error('Failed to repair Opening Stock GL entry', { id: sm.id, error: msg });
        }
    }

    return result;
}

// ============================================================================
// 7. SALES
// ============================================================================
async function repairSales(pool: pg.Pool): Promise<RepairTypeResult> {
    const result: RepairTypeResult = { found: 0, reposted: 0, skipped: 0, errors: [] };

    const rows = await pool.query(`
    SELECT
      s.id, s.sale_number, s.sale_date, s.total_amount, s.total_cost,
      s.payment_method, s.amount_paid, s.tax_amount, s.customer_id
    FROM sales s
    WHERE s.status = 'COMPLETED'
      AND COALESCE(s.total_amount, 0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM ledger_transactions lt
        WHERE lt."ReferenceType" = 'SALE'
          AND lt."ReferenceId" = s.id
          AND ${ACTIVE_GL_REFERENCE_PREDICATE}
      )
    ORDER BY s.sale_date
  `);

    result.found = rows.rows.length;

    for (const sale of rows.rows) {
        try {
            const itemsResult = await pool.query(`
        SELECT product_type, total_price, unit_cost, quantity
        FROM sale_items WHERE sale_id = $1
      `, [sale.id]);

            const saleItems = itemsResult.rows.map((item: { product_type: string; total_price: string; unit_cost: string; quantity: string }) => ({
                productType: (item.product_type === 'service' ? 'service' : 'inventory') as 'inventory' | 'service',
                totalPrice: new Decimal(item.total_price || 0).toNumber(),
                unitCost: new Decimal(item.unit_cost || 0).toNumber(),
                quantity: new Decimal(item.quantity || 0).toNumber(),
            }));

            await glEntryService.recordSaleToGL({
                saleId: sale.id,
                saleNumber: sale.sale_number,
                saleDate: toDateString(sale.sale_date),
                totalAmount: new Decimal(sale.total_amount || 0).toNumber(),
                costAmount: new Decimal(sale.total_cost || 0).toNumber(),
                paymentMethod: (sale.payment_method as 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'CREDIT' | 'DEPOSIT' | 'GIFT') || 'CASH',
                amountPaid: sale.amount_paid != null ? new Decimal(sale.amount_paid).toNumber() : undefined,
                taxAmount: sale.tax_amount != null ? new Decimal(sale.tax_amount).toNumber() : undefined,
                customerId: sale.customer_id || undefined,
                saleItems,
            }, pool);
            result.reposted++;
            logger.info('Repaired missing Sale GL entry', { saleId: sale.id, saleNumber: sale.sale_number });
        } catch (err) {
            const msg = `Sale ${sale.sale_number}: ${err instanceof Error ? err.message : String(err)}`;
            result.errors.push(msg);
            logger.error('Failed to repair Sale GL entry', { id: sale.id, error: msg });
        }
    }

    return result;
}

// ============================================================================
// INTEGRITY CHECK
// ============================================================================

/**
 * Full GL integrity check — compares GL balances against subledgers and counts
 * documents with missing GL entries. Returns GREEN / YELLOW / RED status.
 *
 * GREEN  = fully balanced, no missing GL entries
 * YELLOW = small differences (< 1.00) or low count of missing entries (< 5)
 * RED    = balance differences ≥ 1.00 or ≥ 5 missing GL entries
 */
export async function runGLIntegrityCheck(dbPool?: pg.Pool): Promise<GLIntegrityStatus> {
    const pool = dbPool || globalPool;
    const checkedAt = new Date().toISOString();
    const alerts: string[] = [];

    // ── AP reconciliation (2100 supplier scope vs open-item subledger) ────────
    const apSnapshot = await computeApReconciliationSnapshot(pool);
    const apGL = apSnapshot.glBalance;
    const apSub = apSnapshot.subledgerBalance;
    const legacyGrInAp = apSnapshot.legacyGrInAp;
    const apDiff = apSnapshot.drift;
    const apThreshold = apMaterialityThreshold(apGL);
    const apExplained = isApDriftExplainedByExpenses(apSnapshot, apThreshold);
    const apBalanced = Math.abs(apDiff) < 0.01 || apExplained;
    if (legacyGrInAp > 0.01) {
        alerts.push(
            `AP contains ${legacyGrInAp.toFixed(2)} of legacy GR credits that belong in GRIR Clearing (2150). ` +
            `Post a correcting entry: DR AP 2100 / CR GRIR 2150 for ${legacyGrInAp.toFixed(2)}.`,
        );
    }
    if (!apBalanced) {
        alerts.push(
            `AP drift: GL=${apGL.toFixed(2)}, Open-item subledger=${apSub.toFixed(2)}, `
            + `Diff=${apDiff.toFixed(2)}`
            + (apSnapshot.unallocatedPayments > 0
              ? `, Unallocated payments=${apSnapshot.unallocatedPayments.toFixed(2)}`
              : ''),
        );
    }

    // ── Inventory reconciliation (1300 vs batch subledger) ────────────────────
    const invResult = await pool.query(`
    SELECT
      COALESCE(
        (SELECT SUM(le."DebitAmount") - SUM(le."CreditAmount")
         FROM ledger_entries le
         JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
         JOIN accounts a ON a."Id" = le."AccountId"
         WHERE a."AccountCode" = '1300'
           AND lt."Status" = 'POSTED' AND lt."IsReversed" = FALSE
           AND lt."Id" NOT IN (
             SELECT "ReversedByTransactionId" FROM ledger_transactions
             WHERE "ReversedByTransactionId" IS NOT NULL
           )), 0
      ) AS gl_balance,
      COALESCE(
        (SELECT SUM(remaining_quantity * cost_price)
         FROM inventory_batches
         WHERE remaining_quantity > 0), 0
      ) AS subledger_balance
  `);
    const invGL = new Decimal(invResult.rows[0]?.gl_balance ?? 0).toNumber();
    const invSub = new Decimal(invResult.rows[0]?.subledger_balance ?? 0).toNumber();
    const invDiff = new Decimal(invGL).minus(invSub).toNumber();
    const invBalanced = new Decimal(invDiff).abs().lessThan('0.01');
    if (!invBalanced) {
        alerts.push(`Inventory drift: GL=${invGL.toFixed(2)}, Subledger=${invSub.toFixed(2)}, Diff=${invDiff.toFixed(2)}`);
    }

    // ── AR reconciliation (1200 vs customers.balance) ─────────────────────────
    const arResult = await pool.query(`
    SELECT
      COALESCE(
        (SELECT SUM(
           CASE
             WHEN le."EntryType" IS NOT NULL AND le."Amount" IS NOT NULL
             THEN CASE WHEN le."EntryType"='DEBIT' THEN le."Amount" ELSE -le."Amount" END
             ELSE COALESCE(le."DebitAmount",0) - COALESCE(le."CreditAmount",0)
           END)
         FROM ledger_entries le
         JOIN accounts a ON a."Id" = le."AccountId"
         WHERE a."AccountCode" = '1200'), 0
      ) AS gl_balance,
      COALESCE((SELECT SUM(balance) FROM customers), 0) AS subledger_balance
  `);
    const arGL = new Decimal(arResult.rows[0]?.gl_balance ?? 0).toNumber();
    const arSub = new Decimal(arResult.rows[0]?.subledger_balance ?? 0).toNumber();
    const arDiff = new Decimal(arGL).minus(arSub).toNumber();
    const arBalanced = new Decimal(arDiff).abs().lessThan('0.01');
    if (!arBalanced) {
        alerts.push(`AR drift: GL=${arGL.toFixed(2)}, Subledger=${arSub.toFixed(2)}, Diff=${arDiff.toFixed(2)}`);
    }

    // ── Missing GL counts ──────────────────────────────────────────────────────
    const missingResult = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM goods_receipts gr
       WHERE gr.status = 'COMPLETED'
         AND NOT EXISTS (
           SELECT 1 FROM ledger_transactions lt
           WHERE lt."ReferenceType" = 'GOODS_RECEIPT' AND lt."ReferenceId" = gr.id
             AND ${ACTIVE_GL_REFERENCE_PREDICATE}
         )
      ) AS grs_without_gl,

      (SELECT COUNT(*) FROM return_grn r
       WHERE r.status = 'POSTED'
         AND NOT EXISTS (
           SELECT 1 FROM ledger_transactions lt
           WHERE lt."ReferenceType" = 'RETURN_GRN' AND lt."ReferenceId" = r.id
             AND ${ACTIVE_GL_REFERENCE_PREDICATE}
         )
      ) AS returns_without_gl,

      (SELECT COUNT(*) FROM supplier_invoices si
       WHERE si."Status" IN ('POSTED','Paid','PartiallyPaid','PAID','PARTIALLY_PAID')
         AND si.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM ledger_transactions lt
           WHERE lt."ReferenceType" = 'SUPPLIER_INVOICE' AND lt."ReferenceId" = si."Id"
             AND ${ACTIVE_GL_REFERENCE_PREDICATE}
         )
      ) AS invoices_without_gl,

      (SELECT COUNT(*) FROM supplier_payments sp
       WHERE sp."Status" = 'COMPLETED'
         AND sp.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM ledger_transactions lt
           WHERE lt."ReferenceType" = 'SUPPLIER_PAYMENT' AND lt."ReferenceId" = sp."Id"
             AND ${ACTIVE_GL_REFERENCE_PREDICATE}
         )
      ) AS payments_without_gl,

      (SELECT COUNT(*) FROM stock_movements sm
       WHERE sm.movement_type IN ('ADJUSTMENT_IN','ADJUSTMENT_OUT','DAMAGE','EXPIRY')
         AND sm.unit_cost > 0
         AND NOT (
           sm.posts_gl IS FALSE
           OR sm.economic_event = 'QUARANTINE_TRANSFER'
           OR UPPER(COALESCE(sm.reference_type, '')) = 'EXPIRY_AUTOMATION'
           OR UPPER(COALESCE(sm.reference_type, '')) = 'SOFT_QUARANTINE'
           OR UPPER(COALESCE(sm.reference_type, '')) = 'LOT_SPLIT'
           OR LOWER(COALESCE(sm.notes, '')) LIKE '%internal quarantine transfer%'
         )
         AND NOT EXISTS (
           SELECT 1 FROM ledger_transactions lt
           WHERE lt."ReferenceType" = 'STOCK_MOVEMENT' AND lt."ReferenceId" = sm.id
             AND ${ACTIVE_GL_REFERENCE_PREDICATE}
         )
      ) AS stock_movements_without_gl,

      (SELECT COUNT(*) FROM sales s
       WHERE s.status = 'COMPLETED'
         AND COALESCE(s.total_amount, 0) > 0
         AND NOT EXISTS (
           SELECT 1 FROM ledger_transactions lt
           WHERE lt."ReferenceType" = 'SALE' AND lt."ReferenceId" = s.id
             AND ${ACTIVE_GL_REFERENCE_PREDICATE}
         )
      ) AS sales_without_gl
  `);

    const m = missingResult.rows[0];
    const missingGL = {
        goodsReceiptsWithoutGL: parseInt(m?.grs_without_gl ?? '0'),
        returnGrnsWithoutGL: parseInt(m?.returns_without_gl ?? '0'),
        supplierInvoicesWithoutGL: parseInt(m?.invoices_without_gl ?? '0'),
        supplierPaymentsWithoutGL: parseInt(m?.payments_without_gl ?? '0'),
        stockMovementsWithoutGL: parseInt(m?.stock_movements_without_gl ?? '0'),
        salesWithoutGL: parseInt(m?.sales_without_gl ?? '0'),
    };
    const totalMissing = Object.values(missingGL).reduce((a, b) => a + b, 0);
    if (totalMissing > 0) {
        alerts.push(`${totalMissing} document(s) have missing GL entries (run repair to fix)`);
    }

    // ── Unbalanced journal entries (dual-format) ──────────────────────────────
    const unbalancedResult = await pool.query(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT lt."Id"
      FROM ledger_transactions lt
      JOIN ledger_entries le ON le."TransactionId" = lt."Id"
      WHERE lt."IsReversed" = FALSE
      GROUP BY lt."Id"
      HAVING ABS(SUM(
        CASE
          WHEN le."EntryType" = 'DEBIT'  AND le."Amount" IS NOT NULL THEN  le."Amount"
          WHEN le."EntryType" = 'CREDIT' AND le."Amount" IS NOT NULL THEN -le."Amount"
          ELSE COALESCE(le."DebitAmount",0) - COALESCE(le."CreditAmount",0)
        END
      )) > 0.01
    ) sub
  `);
    const unbalancedJournals = parseInt(unbalancedResult.rows[0]?.count ?? '0');
    if (unbalancedJournals > 0) {
        alerts.push(`${unbalancedJournals} unbalanced journal entr${unbalancedJournals === 1 ? 'y' : 'ies'} detected`);
    }

    // ── Suspicious high-value stock adjustments ───────────────────────────────
    const suspiciousResult = await pool.query(`
    SELECT sm.movement_number, sm.movement_type,
           sm.quantity, sm.unit_cost,
           (sm.quantity * sm.unit_cost) AS total_value,
           sm.notes
    FROM stock_movements sm
    WHERE sm.movement_type IN ('ADJUSTMENT_IN','ADJUSTMENT_OUT')
      AND (sm.quantity * sm.unit_cost) > 10000000
    ORDER BY (sm.quantity * sm.unit_cost) DESC
  `);
    const suspiciousMovements: Array<{ movementNumber: string; movementType: string; totalValue: number; notes: string | null }> =
        suspiciousResult.rows.map((r: { movement_number: string; movement_type: string; quantity: string; unit_cost: string; notes: string | null }) => ({
            movementNumber: r.movement_number,
            movementType: r.movement_type,
            totalValue: parseFloat(r.quantity) * parseFloat(r.unit_cost),
            notes: r.notes ?? null,
        }));
    if (suspiciousMovements.length > 0) {
        const total = suspiciousMovements.reduce((a, b) => a + b.totalValue, 0);
        alerts.push(
            `${suspiciousMovements.length} high-value stock adjustment(s) totalling ${total.toFixed(2)} may inflate GL 1300 ` +
            `(e.g. ${suspiciousMovements[0].movementNumber}: ${suspiciousMovements[0].totalValue.toFixed(0)} — "${suspiciousMovements[0].notes ?? ''}")`,
        );
    }

    // ── Determine system status ────────────────────────────────────────────────
    const maxAbsDiff = Math.max(
        Math.abs(apDiff),
        Math.abs(invDiff),
        Math.abs(arDiff),
    );

    let systemStatus: 'GREEN' | 'YELLOW' | 'RED';
    if (alerts.length === 0) {
        systemStatus = 'GREEN';
    } else if (maxAbsDiff < 1.0 && totalMissing < 5 && unbalancedJournals === 0) {
        systemStatus = 'YELLOW';
    } else {
        systemStatus = 'RED';
    }

    logger.info('GL integrity check completed', { systemStatus, alertCount: alerts.length, totalMissing });

    return {
        systemStatus,
        checkedAt,
        checks: {
            apReconciliation: { glBalance: apGL, subledgerBalance: apSub, difference: apDiff, isBalanced: apBalanced, legacyGrInAp },
            inventoryReconciliation: { glBalance: invGL, subledgerBalance: invSub, difference: invDiff, isBalanced: invBalanced },
            arReconciliation: { glBalance: arGL, subledgerBalance: arSub, difference: arDiff, isBalanced: arBalanced },
            missingGL,
            unbalancedJournals,
            suspiciousMovements,
        },
        alerts,
    };
}

export const glRepairService = {
    repostAllMissingGL,
    runGLIntegrityCheck,
    rebuildPeriodBalances,
    recalcAllSupplierBalances,
    recalcAllCustomerBalances,
    rebaseAccountBalances,
    healApReconciliationCaches,
    rebuildInventoryBalances,
    rebuildProductDailySummary,
    healAPDrift,
    healInventoryGlDrift,
};

// ============================================================================
// HEAL: REBUILD gl_period_balances FROM ledger_entries
// ----------------------------------------------------------------------------
// Heals two ERROR-level audit findings simultaneously:
//   1. period_balances_reconciliation — totals drift between gpb and le.
//   2. running_balance_invariant      — running_balance != debits - credits.
//
// Strategy:
//   - Aggregate POSTED ledger_entries by (account, year, month).
//   - UPSERT into gl_period_balances with absolute (replace) totals.
//   - DELETE any gpb rows that no longer have backing ledger entries
//     (orphans from reversed/deleted transactions).
//   - Skip period 0 (carry-forward) and any LOCKED/CLOSED financial periods.
//
// Idempotent: re-running is safe and yields the same result.
// Locked periods are NEVER touched — preserves audit trail integrity.
// ============================================================================

export interface RebuildPeriodBalancesResult {
    rowsRecomputed: number;
    rowsInserted: number;
    rowsUpdated: number;
    orphansDeleted: number;
    skippedLockedPeriods: number;
    durationMs: number;
}

export async function rebuildPeriodBalances(
    dbPool?: pg.Pool,
): Promise<RebuildPeriodBalancesResult> {
    const pool = dbPool || globalPool;
    const startedAt = Date.now();
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Pin the session to UTC so EXTRACT(YEAR/MONTH FROM TransactionDate)
        // produces the same result regardless of the PostgreSQL server's default
        // timezone or the calling session (e.g. psql in EAT/UTC+3).
        await client.query("SET LOCAL timezone = 'UTC'");

        // 1. Snapshot how many rows currently exist (open periods only) so we
        //    can compute inserts vs updates after the upsert.
        const beforeCount = await client.query(
            `SELECT COUNT(*)::INT AS n FROM gl_period_balances gpb
             WHERE gpb.fiscal_period BETWEEN 1 AND 12
               AND NOT EXISTS (
                 SELECT 1 FROM financial_periods fp
                 WHERE fp.period_year = gpb.fiscal_year
                   AND fp.period_month = gpb.fiscal_period
                   AND fp."Status" IN ('CLOSED', 'LOCKED')
               )`,
        );
        const beforeOpen: number = beforeCount.rows[0]?.n ?? 0;

        // 2. Recompute totals from net-active POSTED ledger_entries and UPSERT.
        //    Uses the same reversal-pair exclusion as balance sheet / integrity checks.
        //    Locked/closed periods are filtered out via NOT EXISTS clause.
        const upsertRes = await client.query(
            `WITH fresh AS (
               SELECT
                 le."AccountId"                                                              AS account_id,
                 EXTRACT(YEAR  FROM lt."TransactionDate" AT TIME ZONE 'UTC')::INT            AS fiscal_year,
                 EXTRACT(MONTH FROM lt."TransactionDate" AT TIME ZONE 'UTC')::INT            AS fiscal_period,
                 COALESCE(SUM(le."DebitAmount"),  0)                                        AS debits,
                 COALESCE(SUM(le."CreditAmount"), 0)                                        AS credits
               FROM ledger_entries le
               JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
               WHERE ${LEDGER_NET_ACTIVE_SQL}
               GROUP BY le."AccountId",
                        EXTRACT(YEAR  FROM lt."TransactionDate" AT TIME ZONE 'UTC')::INT,
                        EXTRACT(MONTH FROM lt."TransactionDate" AT TIME ZONE 'UTC')::INT
             )
             INSERT INTO gl_period_balances
                 (account_id, fiscal_year, fiscal_period,
                  debit_total, credit_total, running_balance, last_updated)
             SELECT
                 fresh.account_id, fresh.fiscal_year, fresh.fiscal_period,
                 fresh.debits, fresh.credits,
                 fresh.debits - fresh.credits,
                 NOW()
             FROM fresh
             WHERE fresh.fiscal_period BETWEEN 1 AND 12
               AND NOT EXISTS (
                 SELECT 1 FROM financial_periods fp
                 WHERE fp.period_year  = fresh.fiscal_year
                   AND fp.period_month = fresh.fiscal_period
                   AND fp."Status" IN ('CLOSED', 'LOCKED')
               )
             ON CONFLICT (account_id, fiscal_year, fiscal_period) DO UPDATE SET
                 debit_total     = EXCLUDED.debit_total,
                 credit_total    = EXCLUDED.credit_total,
                 running_balance = EXCLUDED.running_balance,
                 last_updated    = NOW()`,
        );
        const rowsRecomputed = upsertRes.rowCount ?? 0;

        // 3. Delete orphan gpb rows: open periods where no ledger_entries exist.
        //    These linger after transactions are reversed/deleted.
        const orphanRes = await client.query(
            `DELETE FROM gl_period_balances gpb
             WHERE gpb.fiscal_period BETWEEN 1 AND 12
               AND NOT EXISTS (
                 SELECT 1 FROM financial_periods fp
                 WHERE fp.period_year  = gpb.fiscal_year
                   AND fp.period_month = gpb.fiscal_period
                   AND fp."Status" IN ('CLOSED', 'LOCKED')
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM ledger_entries le
                 JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
                 WHERE le."AccountId" = gpb.account_id
                   AND ${LEDGER_NET_ACTIVE_SQL}
                   AND EXTRACT(YEAR  FROM lt."TransactionDate" AT TIME ZONE 'UTC')::INT = gpb.fiscal_year
                   AND EXTRACT(MONTH FROM lt."TransactionDate" AT TIME ZONE 'UTC')::INT = gpb.fiscal_period
               )`,
        );
        const orphansDeleted = orphanRes.rowCount ?? 0;

        // 4. Count how many LOCKED/CLOSED periods we skipped (informational).
        const skippedRes = await client.query(
            `SELECT COUNT(DISTINCT (gpb.fiscal_year, gpb.fiscal_period))::INT AS n
             FROM gl_period_balances gpb
             WHERE EXISTS (
               SELECT 1 FROM financial_periods fp
               WHERE fp.period_year  = gpb.fiscal_year
                 AND fp.period_month = gpb.fiscal_period
                 AND fp."Status" IN ('CLOSED', 'LOCKED')
             )`,
        );
        const skippedLockedPeriods: number = skippedRes.rows[0]?.n ?? 0;

        await client.query('COMMIT');

        const afterCount = await pool.query(
            `SELECT COUNT(*)::INT AS n FROM gl_period_balances gpb
             WHERE gpb.fiscal_period BETWEEN 1 AND 12
               AND NOT EXISTS (
                 SELECT 1 FROM financial_periods fp
                 WHERE fp.period_year = gpb.fiscal_year
                   AND fp.period_month = gpb.fiscal_period
                   AND fp."Status" IN ('CLOSED', 'LOCKED')
               )`,
        );
        const afterOpen: number = afterCount.rows[0]?.n ?? 0;
        const rowsInserted = Math.max(afterOpen - (beforeOpen - orphansDeleted), 0);
        const rowsUpdated = Math.max(rowsRecomputed - rowsInserted, 0);

        const durationMs = Date.now() - startedAt;
        logger.info('gl_period_balances rebuilt from ledger_entries', {
            rowsRecomputed, rowsInserted, rowsUpdated, orphansDeleted,
            skippedLockedPeriods, durationMs,
        });

        return {
            rowsRecomputed, rowsInserted, rowsUpdated, orphansDeleted,
            skippedLockedPeriods, durationMs,
        };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// ============================================================================
// HEAL: RECALC suppliers."OutstandingBalance" FROM supplier_invoices
// ----------------------------------------------------------------------------
// Heals ap_reconciliation drift between the GL (account 2100) and the supplier
// subledger when the cached suppliers.OutstandingBalance has fallen out of sync.
// Uses the same formula as recalculateOutstandingBalance() in supplierRepository.
// ============================================================================

export interface RecalcSupplierBalancesResult {
    suppliersScanned: number;
    suppliersUpdated: number;
    durationMs: number;
}

export async function recalcAllSupplierBalances(
    dbPool?: pg.Pool,
): Promise<RecalcSupplierBalancesResult> {
    const pool = dbPool || globalPool;
    const startedAt = Date.now();

    const scanRes = await pool.query(`SELECT COUNT(*)::INT AS n FROM suppliers`);
    const suppliersScanned: number = scanRes.rows[0]?.n ?? 0;

    const client = await pool.connect();
    let suppliersUpdated = 0;
    try {
        await client.query('BEGIN');
        const suppliers = await client.query<{ Id: string }>(`SELECT "Id" FROM suppliers`);
        for (const row of suppliers.rows) {
            const { oldBalance, newBalance } = await syncSupplierBalanceFromOpenItems(
                client,
                row.Id,
                'RECALC_ALL_SUPPLIER_BALANCES',
            );
            if (Math.abs(oldBalance - newBalance) > 0.01) {
                suppliersUpdated++;
            }
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    return {
        suppliersScanned,
        suppliersUpdated,
        durationMs: Date.now() - startedAt,
    };
}

export interface RecalcCustomerBalancesResult {
    customersScanned: number;
    customersUpdated: number;
    durationMs: number;
}

/**
 * Recalc all customer.balance caches from open-item SSOT (includes posted AR write-offs).
 *
 * ADR-006 / BD-INV-3/6: never invents AR_WRITEOFF journals; never reopens invoices that
 * were written off — settlement already counts ar_writeoff_lines as paid.
 */
export async function recalcAllCustomerBalances(
    dbPool?: pg.Pool,
): Promise<RecalcCustomerBalancesResult> {
    const pool = dbPool || globalPool;
    const startedAt = Date.now();

    const scanRes = await pool.query(`SELECT COUNT(*)::INT AS n FROM customers WHERE is_active = true`);
    const customersScanned: number = scanRes.rows[0]?.n ?? 0;

    const client = await pool.connect();
    let customersUpdated = 0;
    try {
        await client.query('BEGIN');
        const customers = await client.query<{ id: string }>(
            `SELECT id FROM customers WHERE is_active = true`,
        );
        for (const row of customers.rows) {
            const { oldBalance, newBalance } = await syncCustomerBalanceFromOpenItems(
                client,
                row.id,
                'RECALC_ALL_CUSTOMER_BALANCES',
            );
            if (Math.abs(oldBalance - newBalance) > 0.01) {
                customersUpdated++;
            }
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    return {
        customersScanned,
        customersUpdated,
        durationMs: Date.now() - startedAt,
    };
}

// ============================================================================
// HEAL: REBASE accounts.CurrentBalance FROM net-active ledger_entries
// ----------------------------------------------------------------------------
// Fixes STORED_BALANCE drift (e.g. Henber 2100 cache −20M vs GL +17M).
// Uses LEDGER_NET_ACTIVE_SQL (exclude both reverse-pair legs) — same SSOT as
// Banking / funds guard. Bare Status=POSTED orphans reverse credits (Henber 1015).
// Respects NormalBalance (DEBIT vs CREDIT). Idempotent.
// ============================================================================

export interface RebaseAccountBalancesResult {
    accountsScanned: number;
    accountsUpdated: number;
    durationMs: number;
    updates: Array<{ accountCode: string; oldBalance: number; newBalance: number }>;
}

export async function rebaseAccountBalances(
    dbPool?: pg.Pool,
    options?: { accountCodes?: string[] },
): Promise<RebaseAccountBalancesResult> {
    const pool = dbPool || globalPool;
    const startedAt = Date.now();
    const codes = options?.accountCodes;

    const params: unknown[] = [];
    const codeFilter = codes?.length
        ? (params.push(codes), `AND a."AccountCode" = ANY($1::text[])`)
        : '';

    const updateRes = await pool.query<{
        account_code: string;
        old_balance: string;
        new_balance: string;
    }>(
        `
        WITH posted AS (
          SELECT le."AccountId",
            SUM(le."DebitAmount") - SUM(le."CreditAmount") AS net_debit,
            SUM(le."CreditAmount") - SUM(le."DebitAmount") AS net_credit
          FROM ledger_entries le
          JOIN ledger_transactions lt ON le."TransactionId" = lt."Id"
          WHERE ${LEDGER_NET_ACTIVE_SQL}
          GROUP BY le."AccountId"
        ),
        targets AS (
          SELECT a."Id", a."AccountCode", a."CurrentBalance" AS old_balance,
            CASE
              WHEN a."NormalBalance" = 'DEBIT' THEN COALESCE(p.net_debit, 0)
              ELSE COALESCE(p.net_credit, 0)
            END AS new_balance
          FROM accounts a
          LEFT JOIN posted p ON p."AccountId" = a."Id"
          WHERE a."IsActive" = true
          ${codeFilter}
        )
        UPDATE accounts a
        SET "CurrentBalance" = t.new_balance,
            "UpdatedAt" = NOW()
        FROM targets t
        WHERE a."Id" = t."Id"
          AND ABS(a."CurrentBalance" - t.new_balance) > 0.01
        RETURNING a."AccountCode" AS account_code,
                  t.old_balance::text,
                  t.new_balance::text
        `,
        params,
    );

    const scanRes = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::INT AS n FROM accounts a WHERE a."IsActive" = true ${codeFilter}`,
        params,
    );

    const updates = updateRes.rows.map((r) => ({
        accountCode: r.account_code,
        oldBalance: parseFloat(r.old_balance || '0'),
        newBalance: parseFloat(r.new_balance || '0'),
    }));

    return {
        accountsScanned: scanRes.rows[0]?.n ?? 0,
        accountsUpdated: updates.length,
        durationMs: Date.now() - startedAt,
        updates,
    };
}

export interface HealApReconciliationCachesResult {
    before: ApReconciliationMetrics;
    after: ApReconciliationMetrics;
    recalc: RecalcSupplierBalancesResult;
    rebase: RebaseAccountBalancesResult;
    verification: ReturnType<typeof verifyApReconciliationMetrics>;
    durationMs: number;
}

/**
 * Phase-1 AP heal: sync supplier cache + rebase 2100 CurrentBalance.
 * Does NOT post GL correction JEs — use healAPDrift for true GL vs open-item gap.
 */
export async function healApReconciliationCaches(
    dbPool?: pg.Pool,
    tenantSlug?: string,
): Promise<HealApReconciliationCachesResult> {
    const pool = dbPool || globalPool;
    const startedAt = Date.now();
    const before = await captureApReconciliationMetrics(pool);

    const { ensureTenantApCachesAligned } = await import(
        '../supplier-payments/apBalanceGovernance.js'
    );
    const heal = await ensureTenantApCachesAligned(
        pool,
        tenantSlug ?? 'manual-heal',
        { force: true },
    );

    const after = await captureApReconciliationMetrics(pool);
    const verification = verifyApReconciliationMetrics(after);

    return {
        before,
        after,
        recalc: {
            suppliersScanned: 0,
            suppliersUpdated: heal.suppliersUpdated,
            durationMs: Date.now() - startedAt,
        },
        rebase: {
            accountsScanned: 1,
            accountsUpdated: heal.accountsRebased,
            durationMs: 0,
            updates: [],
        },
        verification,
        durationMs: Date.now() - startedAt,
    };
}

// ============================================================================
// HEAL: REBUILD inventory_balances FROM products.quantity_on_hand
// ----------------------------------------------------------------------------
// products.quantity_on_hand is the source of truth (updated atomically by every
// stock movement under withTransaction). inventory_balances is a denormalised
// state-table maintained by stateTablesRepository's UPSERTs at write time. If
// it falls out of sync (e.g. failed savepoint, manual SQL, restored backup),
// this rebuild snaps every row back to products.quantity_on_hand. Idempotent.
// ============================================================================

export interface RebuildInventoryBalancesResult {
    rowsScanned: number;
    rowsUpdated: number;
    rowsInserted: number;
    durationMs: number;
}

export async function rebuildInventoryBalances(
    dbPool?: pg.Pool,
): Promise<RebuildInventoryBalancesResult> {
    const pool = dbPool || globalPool;
    const startedAt = Date.now();

    const beforeRes = await pool.query(
        `SELECT COUNT(*)::INT AS n FROM inventory_aggregate_balances`,
    );
    const before: number = beforeRes.rows[0]?.n ?? 0;

    // UPSERT: snap inventory_aggregate_balances.quantity_on_hand to products.quantity_on_hand
    // for every product, leaving cumulative tallies (total_received/sold/adjusted)
    // alone — those are write-time movement counters that the rebuild has no way
    // to recompute without scanning stock_movements (separate concern).
    const upsertRes = await pool.query(
        `WITH src AS (
           SELECT p.id, COALESCE(p.quantity_on_hand, 0) AS qoh
           FROM products p
         )
         INSERT INTO inventory_aggregate_balances (product_id, quantity_on_hand, updated_at)
         SELECT id, qoh, NOW() FROM src
         ON CONFLICT (product_id) DO UPDATE
            SET quantity_on_hand = EXCLUDED.quantity_on_hand,
                updated_at       = NOW()
          WHERE ABS(inventory_aggregate_balances.quantity_on_hand - EXCLUDED.quantity_on_hand) > 0.001`,
    );

    const afterRes = await pool.query(
        `SELECT COUNT(*)::INT AS n FROM inventory_aggregate_balances`,
    );
    const after: number = afterRes.rows[0]?.n ?? 0;

    const rowsInserted = Math.max(after - before, 0);
    const rowsUpdated = Math.max((upsertRes.rowCount ?? 0) - rowsInserted, 0);

    return {
        rowsScanned: after,
        rowsUpdated,
        rowsInserted,
        durationMs: Date.now() - startedAt,
    };
}

// ============================================================================
// HEAL: REBUILD product_daily_summary FROM sale_items
// ----------------------------------------------------------------------------
// product_daily_summary is a per-(business_date, product_id) state table
// maintained at write-time by stateTablesRepository when sales are completed.
// If it drifts from sale_items (e.g. partial savepoint failure, restored
// backup, missed UPSERT), this rebuild snaps every row back to the source of
// truth: COMPLETED sales × sale_items aggregates. Cost lookup uses
// si.unit_cost (already captured at sale time) so cost_layers are not needed.
// ============================================================================

export interface RebuildProductDailySummaryResult {
    rowsAffected: number;
    rowsDeleted: number;
    durationMs: number;
}

export async function rebuildProductDailySummary(
    dbPool?: pg.Pool,
): Promise<RebuildProductDailySummaryResult> {
    const pool = dbPool || globalPool;
    const startedAt = Date.now();

    const result = await pool.query(`
      WITH agg AS (
        SELECT
          s.sale_date                                  AS business_date,
          si.product_id                                AS product_id,
          COALESCE(MAX(p.category), 'Uncategorized')   AS category,
          SUM(si.quantity)::numeric(15,4)              AS units_sold,
          SUM(si.total_price)::numeric(15,2)           AS revenue,
          SUM(COALESCE(si.unit_cost, 0) * si.quantity)::numeric(15,2) AS cost_of_goods,
          SUM(si.total_price - COALESCE(si.unit_cost,0) * si.quantity)::numeric(15,2) AS gross_profit,
          SUM(COALESCE(si.discount_amount, 0))::numeric(15,2) AS discount_given,
          COUNT(DISTINCT s.id)::int                    AS transaction_count
        FROM sales s
        JOIN sale_items si ON si.sale_id = s.id
        LEFT JOIN products p ON p.id = si.product_id
        WHERE s.status = 'COMPLETED'
          AND si.product_id IS NOT NULL
        GROUP BY s.sale_date, si.product_id
      )
      INSERT INTO product_daily_summary (
        business_date, product_id, category,
        units_sold, revenue, cost_of_goods, gross_profit,
        discount_given, transaction_count, updated_at
      )
      SELECT
        business_date, product_id, category,
        units_sold, revenue, cost_of_goods, gross_profit,
        discount_given, transaction_count, NOW()
      FROM agg
      ON CONFLICT (business_date, product_id) DO UPDATE SET
        category          = EXCLUDED.category,
        units_sold        = EXCLUDED.units_sold,
        revenue           = EXCLUDED.revenue,
        cost_of_goods     = EXCLUDED.cost_of_goods,
        gross_profit      = EXCLUDED.gross_profit,
        discount_given    = EXCLUDED.discount_given,
        transaction_count = EXCLUDED.transaction_count,
        updated_at        = NOW()
    `);

    // Remove orphan PDS rows that no longer have any matching COMPLETED sale_items.
    // These typically arise from voided/refunded sales where the original PDS
    // upsert ran but the void path didn't roll the counter back.
    const deleteRes = await pool.query(`
      DELETE FROM product_daily_summary pds
      WHERE NOT EXISTS (
        SELECT 1
        FROM sales s
        JOIN sale_items si ON si.sale_id = s.id
        WHERE s.status = 'COMPLETED'
          AND si.product_id = pds.product_id
          AND s.sale_date   = pds.business_date
      )
    `);

    return {
        rowsAffected: result.rowCount ?? 0,
        rowsDeleted: deleteRes.rowCount ?? 0,
        durationMs: Date.now() - startedAt,
    };
}

// ============================================================================
// HEAL: AP DRIFT — post a CORRECTION JE to align GL 2100 with subledger
// ----------------------------------------------------------------------------
// When the GL 2100 (Accounts Payable) balance drifts from the supplier
// subledger (sum of supplier_invoices.OutstandingBalance with SCN sign-flip),
// the safest, audit-trail-preserving fix is to post a single CORRECTION
// journal entry that closes the gap, NOT to adjust historical entries.
//
// Rules:
//   • Drift = GL 2100 (POSTED only) − subledger sum.
//   • If |drift| < 0.01 → no-op.
//   • If drift > 0  (GL > subledger): GL is overstating AP. We DEBIT 2100
//                                     and CREDIT a "GL Adjustments" expense
//                                     (account 5900) to reduce AP liability.
//   • If drift < 0  (GL < subledger): GL is understating AP. We CREDIT 2100
//                                     and DEBIT 5900.
//
// The supplier subledger is NEVER touched — the GL is brought to it. Idempotent
// via an audit-tagged idempotency key (one heal per UTC date).
// ============================================================================

export interface HealAPDriftResult {
    drift: number;
    subledgerBalance: number;
    glBalance: number;
    action: 'no-op' | 'debit-ap' | 'credit-ap';
    transactionNumber?: string;
    transactionId?: string;
    durationMs: number;
    /** True when global CORRECTION heal is blocked — use document-level fixes */
    blocked?: boolean;
    assessment?: import('../supplier-payments/apDriftHealPolicy.js').ApDriftHealAssessment;
}

export async function healAPDrift(
    dbPool?: pg.Pool,
    userId?: string,
): Promise<HealAPDriftResult> {
    const pool = dbPool || globalPool;
    const startedAt = Date.now();

    const snapshot = await computeApReconciliationSnapshot(pool);
    const glBalance = snapshot.glBalance;
    const subBalance = snapshot.subledgerBalance;
    const threshold = apMaterialityThreshold(glBalance);

    if (isApDriftExplainedByExpenses(snapshot, threshold)) {
        return {
            drift: snapshot.drift,
            subledgerBalance: subBalance,
            glBalance,
            action: 'no-op',
            durationMs: Date.now() - startedAt,
        };
    }

    const { isApDriftExplainedByUnpostedInvoices } = await import(
        '../supplier-payments/apReconciliationEngine.js'
    );
    if (isApDriftExplainedByUnpostedInvoices(snapshot, threshold)) {
        logger.warn('heal-ap-drift skipped: drift matches unposted open invoices (post bills to GL instead)', {
            drift: snapshot.drift,
            unpostedOpenInvoiceBalance: snapshot.unpostedOpenInvoiceBalance,
        });
        return {
            drift: snapshot.drift,
            subledgerBalance: subBalance,
            glBalance,
            action: 'no-op',
            durationMs: Date.now() - startedAt,
        };
    }

    const drift = snapshot.drift;

    if (Math.abs(drift) < threshold) {
        return {
            drift: snapshot.drift,
            subledgerBalance: subBalance,
            glBalance,
            action: 'no-op',
            durationMs: Date.now() - startedAt,
        };
    }

    const { assessApDriftHealEligibility } = await import(
        '../supplier-payments/apDriftHealPolicy.js'
    );
    const assessment = await assessApDriftHealEligibility(pool);
    logger.warn('heal-ap-drift blocked: global AP CORRECTION disabled; use document-level fixes', {
        drift: assessment.drift,
        reasons: assessment.reasons,
        recommendations: assessment.recommendations,
    });
    return {
        drift: assessment.drift,
        subledgerBalance: subBalance,
        glBalance,
        action: 'no-op',
        blocked: true,
        assessment,
        durationMs: Date.now() - startedAt,
    };
}

// ============================================================================
// HEAL: Inventory GL 1300 ↔ inventory_batches subledger
// ----------------------------------------------------------------------------
// Brings net-active GL 1300 in line with SUM(batch remaining × cost_price).
// Drift > 0 (GL overstated): DR 5110 shrinkage / CR 1300.
// Drift < 0 (GL understated): DR 1300 / CR 4110 stock overage.
// Idempotent per business date (one correction per day).
// ============================================================================

export interface HealInventoryGlDriftResult {
    drift: number;
    glBalance: number;
    subledgerBalance: number;
    materialityThreshold: number;
    action: 'no-op' | 'credit-inventory' | 'debit-inventory';
    transactionNumber?: string;
    transactionId?: string;
    durationMs: number;
}

export async function healInventoryGlDrift(
    dbPool?: pg.Pool,
    userId?: string,
): Promise<HealInventoryGlDriftResult> {
    const pool = dbPool || globalPool;
    const startedAt = Date.now();

    const balRes = await pool.query(`
      SELECT
        COALESCE(
          (SELECT SUM(le."DebitAmount") - SUM(le."CreditAmount")
           FROM ledger_entries le
           JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
           JOIN accounts a ON a."Id" = le."AccountId"
           WHERE a."AccountCode" = '1300'
             AND lt."Status" = 'POSTED' AND lt."IsReversed" = FALSE
             AND lt."Id" NOT IN (
               SELECT "ReversedByTransactionId" FROM ledger_transactions
               WHERE "ReversedByTransactionId" IS NOT NULL
             )), 0
        ) AS gl_balance,
        COALESCE(
          (SELECT SUM(remaining_quantity * cost_price)
           FROM inventory_batches WHERE remaining_quantity > 0), 0
        ) AS sub_balance
    `);
    const glBalance = Money.toNumber(Money.parseDb(balRes.rows[0].gl_balance));
    const subBalance = Money.toNumber(Money.parseDb(balRes.rows[0].sub_balance));
    const drift = Money.toNumber(Money.subtract(Money.parseDb(glBalance), Money.parseDb(subBalance)));
    const materialityThreshold = Math.max(5000, Math.abs(glBalance) * 0.0001);

    if (Math.abs(drift) <= materialityThreshold) {
        return {
            drift,
            glBalance,
            subledgerBalance: subBalance,
            materialityThreshold,
            action: 'no-op',
            durationMs: Date.now() - startedAt,
        };
    }

    const shrinkageCode = '5110';
    const overageCode = '4110';
    const accRes = await pool.query(
        `SELECT "AccountCode" FROM accounts WHERE "AccountCode" = ANY($1::text[])`,
        [[shrinkageCode, overageCode, '1300']],
    );
    const found = new Set(accRes.rows.map((r: { AccountCode: string }) => r.AccountCode));
    if (!found.has('1300')) {
        throw new Error('Account 1300 (Inventory) not found');
    }
    let expenseCode = shrinkageCode;
    if (!found.has(shrinkageCode)) {
        const fallback = await pool.query(
            `SELECT "AccountCode" FROM accounts WHERE "AccountType" = 'EXPENSE' ORDER BY "AccountCode" LIMIT 1`,
        );
        if ((fallback.rowCount ?? 0) === 0) {
            throw new Error('No expense account for inventory drift correction');
        }
        expenseCode = fallback.rows[0].AccountCode;
    }
    let overageAccount = overageCode;
    if (!found.has(overageCode)) {
        const rev = await pool.query(
            `SELECT "AccountCode" FROM accounts WHERE "AccountType" = 'REVENUE' ORDER BY "AccountCode" LIMIT 1`,
        );
        overageAccount = rev.rows[0]?.AccountCode ?? expenseCode;
    }

    const absDrift = Math.abs(drift);
    const today = getBusinessDate();
    const idempotencyKey = `INV-GL-DRIFT-HEAL-${today}`;
    const action: HealInventoryGlDriftResult['action'] =
        drift > 0 ? 'credit-inventory' : 'debit-inventory';

    const description =
        `Inventory subledger alignment: GL 1300 (${glBalance.toFixed(2)}) `
        + `vs batches (${subBalance.toFixed(2)}); drift=${drift.toFixed(2)}`;

    const lines =
        drift > 0
            ? [
                  {
                      accountCode: expenseCode,
                      debitAmount: absDrift,
                      creditAmount: 0,
                      description: 'Inventory shrinkage — GL 1300 overstated vs FEFO batches',
                  },
                  {
                      accountCode: '1300',
                      debitAmount: 0,
                      creditAmount: absDrift,
                      description: 'Inventory subledger alignment (credit overstated GL)',
                  },
              ]
            : [
                  {
                      accountCode: '1300',
                      debitAmount: absDrift,
                      creditAmount: 0,
                      description: 'Inventory subledger alignment (debit understated GL)',
                  },
                  {
                      accountCode: overageAccount,
                      debitAmount: 0,
                      creditAmount: absDrift,
                      description: 'Stock overage — GL 1300 understated vs FEFO batches',
                  },
              ];

    const tx = await AccountingCore.createJournalEntry(
        {
            entryDate: today,
            description,
            referenceType: 'CORRECTION',
            referenceId: '00000000-0000-0000-0000-000000000000',
            referenceNumber: idempotencyKey,
            idempotencyKey,
            userId: userId ?? '00000000-0000-0000-0000-000000000001',
            lines,
            source: 'SYSTEM_CORRECTION',
        },
        pool,
    );

    logger.info('Inventory GL drift heal posted', {
        drift,
        glBalance,
        subBalance,
        transactionNumber: tx.transactionNumber,
    });

    return {
        drift,
        glBalance,
        subledgerBalance: subBalance,
        materialityThreshold,
        action,
        transactionNumber: tx.transactionNumber,
        transactionId: tx.transactionId,
        durationMs: Date.now() - startedAt,
    };
}

// ─── internal helpers ─────────────────────────────────────────────────────────

/** Normalise any date value (Date object, ISO string, or date-only string) to YYYY-MM-DD. */
function toDateString(value: Date | string | null | undefined): string {
    if (!value) return getBusinessDate();
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    // Already a date string or ISO string
    return String(value).slice(0, 10);
}
