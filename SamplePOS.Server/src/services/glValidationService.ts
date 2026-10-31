/**
 * GL VALIDATION SERVICE
 *
 * Validates that GL entries are properly created for transactions.
 * Use this to verify accounting integrity at the API level.
 */

import { pool as globalPool } from '../db/pool.js';
import type pg from 'pg';
import Decimal from 'decimal.js';
import logger from '../utils/logger.js';
import * as glEntryService from './glEntryService.js';
import { getBusinessDate } from '../utils/dateRange.js';
import { ACTIVE_GL_REFERENCE_PREDICATE } from '../utils/activeGlReference.js';

interface GLValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

interface ReconciliationResult {
  account: string;
  glBalance: number;
  subledgerBalance: number;
  difference: number;
  isBalanced: boolean;
}

/**
 * Validates that a sale has proper GL entries
 */
export async function validateSaleGLEntries(
  saleId: string,
  dbPool?: pg.Pool
): Promise<GLValidationResult> {
  const pool = dbPool || globalPool;
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // Get the sale
    const saleResult = await pool.query(
      `SELECT id, sale_number, total_amount, payment_method, customer_id, amount_paid, tax_amount 
       FROM sales WHERE id = $1`,
      [saleId]
    );

    if (saleResult.rows.length === 0) {
      return { isValid: false, errors: ['Sale not found'], warnings: [] };
    }

    const sale = saleResult.rows[0];

    const txResult = await pool.query(
      `SELECT "Id" as id
       FROM ledger_transactions
       WHERE "ReferenceType" = 'SALE'
         AND "ReferenceId" = $1
         AND "IsReversed" = FALSE
       LIMIT 1`,
      [saleId]
    );

    if (txResult.rows.length === 0) {
      return {
        isValid: false,
        errors: [`No ledger transaction found for sale ${sale.sale_number}`],
        warnings,
      };
    }

    const transactionId = txResult.rows[0].id as string;
    const totalAmount = new Decimal(sale.total_amount || 0);
    const amountPaid = new Decimal(sale.amount_paid || 0);
    const taxAmount = new Decimal(sale.tax_amount || 0);

    // For CREDIT and DEPOSIT sales, AR should exist on the sale transaction.
    if (sale.payment_method === 'CREDIT' || sale.payment_method === 'DEPOSIT') {
      const arEntry = await pool.query(
        `SELECT COALESCE(SUM(le."DebitAmount"), 0) as debit_total
         FROM ledger_entries le
         JOIN accounts a ON a."Id" = le."AccountId"
         WHERE le."TransactionId" = $1
           AND a."AccountCode" = '1200'`,
        [transactionId]
      );

      const outstandingAmount = totalAmount.minus(amountPaid);
      const expectedAmount = sale.payment_method === 'CREDIT'
        ? (outstandingAmount.greaterThan(0) ? outstandingAmount.toNumber() : 0)
        : totalAmount.toNumber();
      const actualDebit = new Decimal(arEntry.rows[0]?.debit_total || 0).toNumber();

      if (new Decimal(actualDebit).minus(expectedAmount).abs().greaterThan('0.01')) {
        errors.push(
          `AR debit mismatch for ${sale.sale_number}: Expected ${expectedAmount}, Found ${actualDebit}`
        );
      }
    }

    // Check revenue credit exists
    const revenueEntry = await pool.query(
      `SELECT COALESCE(SUM(le."CreditAmount"), 0) as credit_total
       FROM ledger_entries le
       JOIN accounts a ON a."Id" = le."AccountId"
       WHERE le."TransactionId" = $1
         AND a."AccountCode" IN ('4000', '4100')`,
      [transactionId]
    );

    const expectedRevenue = totalAmount.minus(taxAmount).toNumber();
    const actualCredit = new Decimal(revenueEntry.rows[0]?.credit_total || 0).toNumber();

    if (new Decimal(actualCredit).minus(expectedRevenue).abs().greaterThan('0.01')) {
      errors.push(
        `Revenue credit mismatch for ${sale.sale_number}: Expected ${expectedRevenue}, Found ${actualCredit}`
      );
    }

    // Check journal entry is balanced
    const balanceCheck = await pool.query(
      `SELECT 
         COALESCE(SUM(le."DebitAmount"), 0) as total_debits,
         COALESCE(SUM(le."CreditAmount"), 0) as total_credits
       FROM ledger_entries le
       WHERE le."TransactionId" = $1`,
      [transactionId]
    );

    const debits = new Decimal(balanceCheck.rows[0]?.total_debits || 0).toNumber();
    const credits = new Decimal(balanceCheck.rows[0]?.total_credits || 0).toNumber();

    if (new Decimal(debits).minus(credits).abs().greaterThan('0.01')) {
      errors.push(
        `Journal entry not balanced for ${sale.sale_number}: Debits ${debits}, Credits ${credits}`
      );
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  } catch (error) {
    logger.error('GL validation error', { saleId, error });
    return {
      isValid: false,
      errors: [`Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`],
      warnings: [],
    };
  }
}

/**
 * Validates that a customer payment has proper GL entries
 */
export async function validatePaymentGLEntries(
  paymentId: string,
  dbPool?: pg.Pool
): Promise<GLValidationResult> {
  const pool = dbPool || globalPool;
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const paymentResult = await pool.query(
      `SELECT "Id", "PaymentNumber", "Amount", "PaymentMethod"
       FROM customer_payments WHERE "Id" = $1`,
      [paymentId]
    );

    if (paymentResult.rows.length === 0) {
      return { isValid: false, errors: ['Payment not found'], warnings: [] };
    }

    const payment = paymentResult.rows[0];

    const txResult = await pool.query(
      `SELECT "Id" as id
       FROM ledger_transactions
       WHERE "ReferenceType" = 'CUSTOMER_PAYMENT'
         AND "ReferenceId" = $1
         AND "IsReversed" = FALSE
       LIMIT 1`,
      [paymentId]
    );

    if (txResult.rows.length === 0) {
      return {
        isValid: false,
        errors: [`No ledger transaction found for payment ${payment.PaymentNumber}`],
        warnings,
      };
    }

    const transactionId = txResult.rows[0].id as string;

    const balanceCheck = await pool.query(
      `SELECT 
         COALESCE(SUM(le."DebitAmount"), 0) as total_debits,
         COALESCE(SUM(le."CreditAmount"), 0) as total_credits
       FROM ledger_entries le
       WHERE le."TransactionId" = $1`,
      [transactionId]
    );

    const debits = new Decimal(balanceCheck.rows[0]?.total_debits || 0).toNumber();
    const credits = new Decimal(balanceCheck.rows[0]?.total_credits || 0).toNumber();

    if (new Decimal(debits).minus(credits).abs().greaterThan('0.01')) {
      errors.push(
        `Journal entry not balanced for ${payment.PaymentNumber}: Debits ${debits}, Credits ${credits}`
      );
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  } catch (error) {
    logger.error('GL validation error', { paymentId, error });
    return {
      isValid: false,
      errors: [`Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`],
      warnings: [],
    };
  }
}

/**
 * Check AR reconciliation (GL vs Customer Subledger)
 */
export async function checkARReconciliation(dbPool?: pg.Pool): Promise<ReconciliationResult> {
  const pool = dbPool || globalPool;
  const result = await pool.query(`
    SELECT 
      COALESCE(
        (SELECT SUM("DebitAmount") - SUM("CreditAmount")
         FROM ledger_entries le
         JOIN accounts a ON a."Id" = le."AccountId"
         WHERE a."AccountCode" = '1200'), 0
      ) as gl_balance,
      COALESCE(
        (SELECT SUM(balance) FROM customers), 0
      ) as subledger_balance
  `);

  const glBalance = new Decimal(result.rows[0]?.gl_balance || 0).toNumber();
  const subledgerBalance = new Decimal(result.rows[0]?.subledger_balance || 0).toNumber();
  const difference = new Decimal(glBalance).minus(subledgerBalance).toNumber();

  return {
    account: 'AR (1200)',
    glBalance,
    subledgerBalance,
    difference,
    isBalanced: new Decimal(difference).abs().lessThan('0.01'),
  };
}

/**
 * Check AP reconciliation (GL vs Supplier Subledger)
 */
export async function checkAPReconciliation(dbPool?: pg.Pool): Promise<ReconciliationResult> {
  const pool = dbPool || globalPool;
  const result = await pool.query(`
    SELECT 
      COALESCE(
        (SELECT SUM(le."CreditAmount") - SUM(le."DebitAmount")
         FROM ledger_entries le
         JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
         JOIN accounts a ON a."Id" = le."AccountId"
         WHERE a."AccountCode" = '2100'
           AND lt."ReferenceType" NOT IN ('EXPENSE', 'EXPENSE_PAYMENT')
           AND lt."Status" = 'POSTED'
           AND COALESCE(lt."IsReversed", false) = false), 0
      ) as gl_balance,
      COALESCE((
        SELECT SUM(
          CASE
            WHEN si.document_type = 'SUPPLIER_CREDIT_NOTE'
              THEN -COALESCE(si."OutstandingBalance", 0)
            ELSE COALESCE(si."OutstandingBalance", 0)
          END
        )
        FROM supplier_invoices si
        WHERE si.deleted_at IS NULL
          AND UPPER(si."Status") NOT IN ('PAID', 'CANCELLED', 'DELETED')
      ), 0) as subledger_balance
  `);

  const glBalance = new Decimal(result.rows[0]?.gl_balance || 0).toNumber();
  const subledgerBalance = new Decimal(result.rows[0]?.subledger_balance || 0).toNumber();
  const difference = new Decimal(glBalance).minus(subledgerBalance).toNumber();

  return {
    account: 'AP (2100)',
    glBalance,
    subledgerBalance,
    difference,
    isBalanced: new Decimal(difference).abs().lessThan('0.01'),
  };
}

/**
 * Check Inventory reconciliation (GL vs Batch Subledger)
 *
 * Compares GL Inventory account (1300) against the batch subledger:
 *   SUM(inventory_batches.remaining_quantity × cost_price)
 *
 * This is the authoritative subledger because:
 * - GL COGS is posted using FEFO batch.cost_price (from salesService FEFO preview)
 * - inventory_batches is the physical stock ledger used for all deductions
 * - fn_reconcile_inventory() also uses this source
 *
 * NOTE: cost_layers is no longer the correct subledger because GL COGS is now
 * derived from FEFO batch costs, not FIFO cost-layer averaging. Using cost_layers
 * would produce false positives whenever FIFO and FEFO costs diverge.
 *
 * Discrepancies can occur when:
 * - Goods receipts fail to post to GL (missing DR Inventory 1300)
 * - Stock adjustments bypass GL
 * - Return GRNs use wrong cost (now fixed — batch.cost_price used for GL)
 */
export async function checkInventoryReconciliation(
  dbPool?: pg.Pool
): Promise<ReconciliationResult> {
  const pool = dbPool || globalPool;
  const result = await pool.query(`
    SELECT 
      COALESCE(
        (SELECT SUM(CASE WHEN le."EntryType" = 'DEBIT' THEN le."Amount" ELSE -le."Amount" END)
         FROM ledger_entries le
         JOIN accounts a ON a."Id" = le."AccountId"
         WHERE a."AccountCode" = '1300'), 0
      ) as gl_balance,
      COALESCE(
        (SELECT SUM(remaining_quantity * cost_price)
         FROM inventory_batches
         WHERE remaining_quantity > 0), 0
      ) as subledger_balance
  `);

  const glBalance = new Decimal(result.rows[0]?.gl_balance || 0).toNumber();
  const subledgerBalance = new Decimal(result.rows[0]?.subledger_balance || 0).toNumber();
  const difference = new Decimal(glBalance).minus(subledgerBalance).toNumber();

  return {
    account: 'Inventory (1300)',
    glBalance,
    subledgerBalance,
    difference,
    isBalanced: new Decimal(difference).abs().lessThan('0.01'),
  };
}

/**
 * Full accounting integrity check
 */
export async function runFullIntegrityCheck(dbPool?: pg.Pool): Promise<{
  passed: boolean;
  results: {
    arReconciliation: ReconciliationResult;
    apReconciliation: ReconciliationResult;
    inventoryReconciliation: ReconciliationResult;
    unbalancedJournalEntries: number;
    creditSalesWithoutGL: number;
    paymentsWithoutGL: number;
  };
}> {
  const pool = dbPool || globalPool;
  const [ar, ap, inventory] = await Promise.all([
    checkARReconciliation(pool),
    checkAPReconciliation(pool),
    checkInventoryReconciliation(pool),
  ]);

  // Check for unbalanced journal entries
  const unbalanced = await pool.query(`
    SELECT COUNT(*) as count
    FROM (
      SELECT lt."Id"
      FROM ledger_transactions lt
      JOIN ledger_entries le ON le."TransactionId" = lt."Id"
      WHERE lt."IsReversed" = FALSE
      GROUP BY lt."Id"
      HAVING ABS(SUM(le."DebitAmount") - SUM(le."CreditAmount")) > 0.01
    ) sub
  `);

  // Check credit sales without GL
  const salesNoGL = await pool.query(`
    SELECT COUNT(*) as count
    FROM sales s
    WHERE s.payment_method = 'CREDIT'
      AND NOT EXISTS (
        SELECT 1 FROM ledger_transactions lt
        WHERE lt."ReferenceType" = 'SALE'
          AND lt."ReferenceId" = s.id
          AND ${ACTIVE_GL_REFERENCE_PREDICATE}
      )
  `);

  // Check payments without GL
  const paymentsNoGL = await pool.query(`
    SELECT COUNT(*) as count
    FROM customer_payments cp
    WHERE NOT EXISTS (
      SELECT 1 FROM ledger_transactions lt
        WHERE lt."ReferenceType" = 'CUSTOMER_PAYMENT'
        AND lt."ReferenceId" = cp."Id"
        AND ${ACTIVE_GL_REFERENCE_PREDICATE}
    )
  `);

  const results = {
    arReconciliation: ar,
    apReconciliation: ap,
    inventoryReconciliation: inventory,
    unbalancedJournalEntries: parseInt(unbalanced.rows[0]?.count || '0'),
    creditSalesWithoutGL: parseInt(salesNoGL.rows[0]?.count || '0'),
    paymentsWithoutGL: parseInt(paymentsNoGL.rows[0]?.count || '0'),
  };

  const passed =
    ar.isBalanced &&
    ap.isBalanced &&
    inventory.isBalanced &&
    results.unbalancedJournalEntries === 0 &&
    results.creditSalesWithoutGL === 0 &&
    results.paymentsWithoutGL === 0;

  return { passed, results };
}

/**
 * Find and repost missing GL entries for completed transactions.
 * Only reposts transactions that have NO existing GL entry (safe idempotency).
 */
export async function repostMissingGL(dbPool?: pg.Pool): Promise<{
  goodsReceipts: { found: number; reposted: number; errors: string[] };
  supplierPayments: { found: number; reposted: number; errors: string[] };
  sales: { found: number; reposted: number; errors: string[] };
  summary: string;
}> {
  const pool = dbPool || globalPool;

  const grResult = { found: 0, reposted: 0, errors: [] as string[] };
  const spResult = { found: 0, reposted: 0, errors: [] as string[] };
  const saleResult = { found: 0, reposted: 0, errors: [] as string[] };

  // 1. Repost missing Goods Receipt GL entries
  const missingGRs = await pool.query(`
    SELECT gr.id, gr.receipt_number, gr.received_date,
           po.supplier_id,
           s."CompanyName" AS supplier_name,
           COALESCE(SUM(
             CASE WHEN gri.is_bonus THEN 0
                  ELSE COALESCE(gri.received_quantity, 0) * COALESCE(gri.cost_price, 0)
             END
           ), 0) AS total_value
    FROM goods_receipts gr
    LEFT JOIN goods_receipt_items gri ON gri.goods_receipt_id = gr.id
    LEFT JOIN purchase_orders po ON po.id = gr.purchase_order_id
    LEFT JOIN suppliers s ON s."Id" = po.supplier_id
    WHERE gr.status = 'COMPLETED'
      AND NOT EXISTS (
        SELECT 1 FROM ledger_transactions lt
        WHERE lt."ReferenceType" = 'GOODS_RECEIPT'
          AND lt."ReferenceId" = gr.id
          AND ${ACTIVE_GL_REFERENCE_PREDICATE}
      )
    GROUP BY gr.id, gr.receipt_number, gr.received_date, po.supplier_id, s."CompanyName"
    HAVING COALESCE(SUM(
      CASE WHEN gri.is_bonus THEN 0
           ELSE COALESCE(gri.received_quantity, 0) * COALESCE(gri.cost_price, 0)
      END
    ), 0) > 0
  `);

  grResult.found = missingGRs.rows.length;

  for (const gr of missingGRs.rows) {
    try {
      await glEntryService.recordGoodsReceiptToGL({
        grId: gr.id,
        grNumber: gr.receipt_number || gr.id,
        grDate: gr.received_date || getBusinessDate(),
        totalAmount: parseFloat(gr.total_value),
        supplierId: gr.supplier_id || '',
        supplierName: gr.supplier_name || 'Unknown Supplier',
      }, pool);
      grResult.reposted++;
      logger.info('Reposted missing GR GL entry', { grId: gr.id, grNumber: gr.receipt_number });
    } catch (err) {
      const msg = `GR ${gr.receipt_number}: ${err instanceof Error ? err.message : String(err)}`;
      grResult.errors.push(msg);
      logger.error('Failed to repost GR GL entry', { grId: gr.id, error: msg });
    }
  }

  // 2. Repost missing Supplier Payment GL entries
  const missingSPs = await pool.query(`
    SELECT sp."Id", sp."PaymentNumber", sp."PaymentDate", sp."Amount",
           sp."PaymentMethod", sp."SupplierId",
           s."CompanyName" AS supplier_name
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

  spResult.found = missingSPs.rows.length;

  for (const sp of missingSPs.rows) {
    try {
      await glEntryService.recordSupplierPaymentToGL({
        paymentId: sp.Id,
        paymentNumber: sp.PaymentNumber || sp.Id,
        paymentDate: sp.PaymentDate || getBusinessDate(),
        amount: parseFloat(sp.Amount),
        paymentMethod: (sp.PaymentMethod as 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'CHECK') || 'CASH',
        supplierId: sp.SupplierId || '',
        supplierName: sp.supplier_name || 'Unknown Supplier',
      }, pool);
      spResult.reposted++;
      logger.info('Reposted missing SP GL entry', { spId: sp.Id, spNumber: sp.PaymentNumber });
    } catch (err) {
      const msg = `SP ${sp.PaymentNumber}: ${err instanceof Error ? err.message : String(err)}`;
      spResult.errors.push(msg);
      logger.error('Failed to repost SP GL entry', { spId: sp.Id, error: msg });
    }
  }

  // 3. Repost missing Sale GL entries
  const missingSales = await pool.query(`
    SELECT s.id, s.sale_number, s.sale_date, s.total_amount, s.total_cost,
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

  saleResult.found = missingSales.rows.length;

  for (const sale of missingSales.rows) {
    try {
      // Fetch sale items for proper revenue/cost classification
      const itemsResult = await pool.query(`
        SELECT product_type, (product_type = 'service') AS is_service, total_price, unit_cost, quantity
        FROM sale_items WHERE sale_id = $1
      `, [sale.id]);

      const saleItems = itemsResult.rows.map((item: { product_type: string; is_service: boolean; total_price: string; unit_cost: string; quantity: string }) => ({
        productType: (item.is_service ? 'service' : 'inventory') as 'inventory' | 'service',
        totalPrice: parseFloat(item.total_price) || 0,
        unitCost: parseFloat(item.unit_cost) || 0,
        quantity: parseFloat(item.quantity) || 0,
      }));

      await glEntryService.recordSaleToGL({
        saleId: sale.id,
        saleNumber: sale.sale_number,
        saleDate: sale.sale_date || getBusinessDate(),
        totalAmount: parseFloat(sale.total_amount) || 0,
        costAmount: parseFloat(sale.total_cost) || 0,
        paymentMethod: (sale.payment_method as 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'AIRTEL_MONEY' | 'CREDIT' | 'DEPOSIT' | 'GIFT') || 'CASH',
        amountPaid: sale.amount_paid != null ? parseFloat(sale.amount_paid) : undefined,
        taxAmount: sale.tax_amount != null ? parseFloat(sale.tax_amount) : undefined,
        customerId: sale.customer_id || undefined,
        saleItems,
      }, pool);
      saleResult.reposted++;
      logger.info('Reposted missing Sale GL entry', { saleId: sale.id, saleNumber: sale.sale_number });
    } catch (err) {
      const msg = `Sale ${sale.sale_number}: ${err instanceof Error ? err.message : String(err)}`;
      saleResult.errors.push(msg);
      logger.error('Failed to repost Sale GL entry', { saleId: sale.id, error: msg });
    }
  }

  const totalErrors = grResult.errors.length + spResult.errors.length + saleResult.errors.length;
  const summary = `Goods Receipts: ${grResult.reposted}/${grResult.found} reposted. ` +
    `Supplier Payments: ${spResult.reposted}/${spResult.found} reposted. ` +
    `Sales: ${saleResult.reposted}/${saleResult.found} reposted.` +
    (totalErrors > 0 ? ` Errors: ${totalErrors}` : '');

  logger.info('Repost missing GL completed', { summary, grResult, spResult, saleResult });

  return { goodsReceipts: grResult, supplierPayments: spResult, sales: saleResult, summary };
}

export const glValidationService = {
  validateSaleGLEntries,
  validatePaymentGLEntries,
  checkARReconciliation,
  checkAPReconciliation,
  checkInventoryReconciliation,
  runFullIntegrityCheck,
  repostMissingGL,
};
