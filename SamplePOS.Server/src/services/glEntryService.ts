/**
 * General Ledger Entry Service
 * 
 * Provides business logic for creating GL entries from business transactions.
 * Implements proper double-entry bookkeeping for all transaction types.
 * 
 * ARCHITECTURE:
 * - Uses AccountingCore for all ledger operations (single source of truth)
 * - Translates business events to journal entries
 * - Handles idempotency via deterministic keys
 * 
 * ACCOUNTING PRINCIPLES IMPLEMENTED:
 * - Double-entry: Every transaction creates balanced debit/credit entries
 * - Idempotency: Prevents duplicate entries for the same transaction
 * - Audit trail: All entries are immutable with full reference tracking
 * - Immutability: Posted entries cannot be modified
 * - Period locking: Respects closed accounting periods
 * 
 * STANDARD ACCOUNT CODES (as per chart of accounts):
 * - 1010: Cash
 * - 1020: Credit Card Receipts
 * - 1200: Accounts Receivable
 * - 1300: Inventory
 * - 2100: Accounts Payable
 * - 4000: Sales Revenue
 * - 5000: Cost of Goods Sold
 */

import type pg from 'pg';
import { AccountingCore, JournalLine, AccountingError } from './accountingCore.js';
import { BusinessRuleException } from '../errors/BusinessRuleException.js';
import { AppError, ValidationError } from '../middleware/errorHandler.js';
import { pool as globalPool } from '../db/pool.js';
import { Money } from '../utils/money.js';
import logger from '../utils/logger.js';
import { SYSTEM_USER_ID } from '../utils/constants.js';
import { customerArLine, requireCustomerIdForAr } from '../modules/accounting-governance/arPostingHelpers.js';
import { splitSupplierPaymentCredits, splitCustomerPaymentDebits } from '../modules/supplier-payments/supplierPaymentWht.js';

// =============================================================================
// ACCOUNT CODE CONSTANTS
// =============================================================================

export const AccountCodes = {
  // Assets
  CASH: '1010',
  CREDIT_CARD_RECEIPTS: '1020',
  CHECKING_ACCOUNT: '1030',
  MOBILE_MONEY: '1040',
  UNDEPOSITED_FUNDS: '1015',
  ACCOUNTS_RECEIVABLE: '1200',
  INVENTORY: '1300',

  // Liabilities
  ACCOUNTS_PAYABLE: '2100',
  CUSTOMER_DEPOSITS: '2200',
  /** Return/exchange store-credit liability (not cash advances — those stay on 2200) */
  STORE_CREDIT: '2210',
  TAX_PAYABLE: '2300',

  // Equity
  OWNERS_EQUITY: '3000',
  OPENING_BALANCE_EQUITY: '3050',

  // Revenue - These may need to be added to chart of accounts
  SALES_REVENUE: '4000',
  SERVICE_REVENUE: '4100',
  OTHER_INCOME: '4200',

  // Cost of Goods Sold
  COGS: '5000',

  // Revenue - Delivery
  DELIVERY_REVENUE: '4500',

  // Revenue - Stock Overages
  STOCK_OVERAGE_INCOME: '4110',

  // Operating Expenses
  SALARIES: '6000',
  RENT: '6100',
  UTILITIES: '6200',
  MARKETING: '6300',
  OFFICE_SUPPLIES: '6400',
  DEPRECIATION: '6500',
  INSURANCE: '6600',
  DELIVERY_EXPENSE: '6750',
  GENERAL_EXPENSE: '6900',

  // Inventory Loss Expenses
  SHRINKAGE: '5110',
  DAMAGE: '5120',
  EXPIRY: '5130',
  /** Near-expiry lot NRV write-down (qty unchanged). Not 5130 dispose. */
  CLEARANCE_MARKDOWN: '5140',

  // Bad Debt (ADR-006) — uncollectible AR expense (not inventory loss, not CN 4010)
  BAD_DEBT_EXPENSE: '5210',

  // Returns & Allowances
  SALES_RETURNS: '4010',
  PURCHASE_RETURNS: '5010',

  // GR/IR Clearing (SAP WRX) — ONLY uninvoiced goods receipts post here
  GRIR_CLEARING: '2150',

  // Supplier Return Clearing — returns/credit notes AFTER invoice already posted
  // (Keeps GR/IR pure: SAP-style MR11 purity rule)
  SUPPLIER_RETURN_CLEARING: '2160',

  // Price Variance (GR/IR mismatch — SAP account 393000)
  PRICE_VARIANCE: '5020',

  // Withholding Tax
  WHT_PAYABLE: '2350',
  /** Customer withheld tax recoverable from URA (asset). */
  WHT_RECEIVABLE: '1250',

  // Fixed Assets
  FIXED_ASSETS: '1500',
  ACCUMULATED_DEPRECIATION: '1550',

  // Foreign Exchange
  REALIZED_FX_GAIN_LOSS: '4300',
  UNREALIZED_FX_GAIN_LOSS: '4310',
};

// =============================================================================
// SALE JOURNAL ENTRIES
// =============================================================================

export interface SaleData {
  saleId: string;
  saleNumber: string;
  saleDate: string;
  totalAmount: number;
  costAmount: number;
  paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'AIRTEL_MONEY' | 'CREDIT' | 'DEPOSIT';
  amountPaid?: number;  // Amount actually paid (for partial payment tracking)
  taxAmount?: number;   // Tax amount (posted to Tax Payable liability)
  customerId?: string;
  customerName?: string;
  // NEW: Line items for proper revenue/cost classification
  saleItems?: SaleItemData[];
  /**
   * When set, COGS/Inventory journals use this total (sum of actual FEFO batch deductions)
   * instead of item-level preview costs. Prevents GL 1300 vs inventory_batches drift.
   */
  actualInventoryCost?: number;
}

export interface SaleItemData {
  productType: 'inventory' | 'consumable' | 'service';
  totalPrice: number;
  unitCost: number;
  quantity: number;
  incomeAccountId?: string;  // UUID of revenue account (4000 or 4100)
}

/**
 * Record a completed sale in the general ledger
 * 
 * Journal entries for a MIXED sale (inventory + service):
 *   DR Cash (1010)                    totalAmount (tax-inclusive)
 *   CR Sales Revenue (4000)           inventoryRevenue (pre-tax)
 *   CR Service Revenue (4100)         serviceRevenue (pre-tax)
 *   CR Tax Payable (2300)             taxAmount
 *   
 *   DR Cost of Goods Sold (5000)      inventoryCost (service items excluded)
 *   CR Inventory (1300)               inventoryCost (service items excluded)
 * 
 * Journal entries for a cash sale (inventory only):
 *   DR Cash (1010)              totalAmount (tax-inclusive)
 *   CR Sales Revenue (4000)     subtotal (pre-tax)
 *   CR Tax Payable (2300)       taxAmount
 *   
 *   DR Cost of Goods Sold (5000) costAmount
 *   CR Inventory (1300)          costAmount
 * 
 * Journal entries for a credit sale:
 *   DR Accounts Receivable (1200) totalAmount (tax-inclusive)
 *   CR Sales Revenue (4000)       inventoryRevenue (pre-tax)
 *   CR Service Revenue (4100)     serviceRevenue (pre-tax)
 *   CR Tax Payable (2300)         taxAmount
 *   
 *   DR Cost of Goods Sold (5000)  inventoryCost
 *   CR Inventory (1300)           inventoryCost
 */
export async function recordSaleToGL(sale: SaleData, pool?: pg.Pool, txClient?: pg.PoolClient): Promise<void> {
  try {
    // Calculate amounts for proper GL posting using Money utility (decimal-safe)
    // For credit sales with partial payment, only AR should reflect unpaid portion
    const totalAmount = Money.parseDb(sale.totalAmount);
    const amountPaid = Money.parseDb(sale.amountPaid ?? 0); // Default to zero if not specified (safest for AR calculation)
    const unpaidAmount = Money.subtract(totalAmount, amountPaid);

    // NEW: Calculate revenue and cost split by product type using Decimal-safe Money utility
    let grossInventoryRevenue = Money.zero();
    let grossServiceRevenue = Money.zero();
    let inventoryCost = Money.zero();
    // Net revenue after discount allocation (initialized, will be set in either branch)
    let inventoryRevenue = Money.zero();
    let serviceRevenue = Money.zero();

    if (sale.saleItems && sale.saleItems.length > 0) {
      // Use sale items for accurate revenue/cost classification
      for (const item of sale.saleItems) {
        if (item.productType === 'service') {
          grossServiceRevenue = Money.add(grossServiceRevenue, item.totalPrice);
          // Service items have no cost (no COGS entry)
        } else {
          // Inventory and consumable items
          grossInventoryRevenue = Money.add(grossInventoryRevenue, item.totalPrice);
          inventoryCost = Money.add(inventoryCost, Money.lineTotal(item.quantity, item.unitCost));
        }
      }

      // ============================================================
      // CRITICAL: DISCOUNT ALLOCATION TO REVENUE ACCOUNTS
      // ============================================================
      // Problem: Line totals are PRE-discount, but we debit POST-discount amount
      // Fix: Calculate discount and allocate proportionally to revenue accounts
      // This ensures DR = CR (balanced GL entry)
      // ============================================================
      const grossTotal = Money.add(grossInventoryRevenue, grossServiceRevenue);
      // BUG FIX: Discount must be calculated against the pretax subtotal, not the
      // tax-inclusive totalAmount. Using totalAmount causes the "discount" to absorb
      // the tax amount too, which overstates inventoryRevenue by taxAmount. When the
      // Tax Payable line is then added, total credits exceed total debits by exactly
      // taxAmount → DoubleEntryViolationError → the entire sale posting throws.
      // Fix: subtract known tax from totalAmount first to get the pretax base.
      const knownTax = Money.parseDb(sale.taxAmount ?? 0);
      const pretaxBase = knownTax.greaterThan(0)
        ? Money.subtract(Money.parseDb(sale.totalAmount), knownTax)
        : Money.parseDb(sale.totalAmount);
      const discountAmount = Money.subtract(grossTotal, pretaxBase);

      // Net revenue after proportional discount allocation
      inventoryRevenue = grossInventoryRevenue;
      serviceRevenue = grossServiceRevenue;

      if (discountAmount.greaterThan(0.01) && grossTotal.greaterThan(0)) {
        // Proportionally allocate discount to each revenue type
        const discountRatio = Money.divide(discountAmount, grossTotal);
        const inventoryDiscount = Money.multiply(grossInventoryRevenue, discountRatio);
        const serviceDiscount = Money.multiply(grossServiceRevenue, discountRatio);

        inventoryRevenue = Money.round(Money.subtract(grossInventoryRevenue, inventoryDiscount));
        serviceRevenue = Money.round(Money.subtract(grossServiceRevenue, serviceDiscount));

        logger.info('Discount allocated to revenue accounts', {
          saleNumber: sale.saleNumber,
          grossTotal,
          discountAmount,
          discountRatio,
          grossInventoryRevenue,
          grossServiceRevenue,
          netInventoryRevenue: inventoryRevenue,
          netServiceRevenue: serviceRevenue,
          netTotal: Money.add(inventoryRevenue, serviceRevenue),
          expectedTotal: sale.totalAmount,
        });
      }

      logger.info('Sale revenue breakdown', {
        saleNumber: sale.saleNumber,
        inventoryRevenue,
        serviceRevenue,
        inventoryCost,
        totalRevenue: Money.add(inventoryRevenue, serviceRevenue)
      });
    } else {
      // Fallback: No item-level data, treat all as inventory revenue
      // (backward compatible with existing sales)
      inventoryRevenue = Money.parseDb(sale.totalAmount);
      serviceRevenue = Money.zero();
      inventoryCost = Money.parseDb(sale.costAmount);

      logger.warn('Sale without item-level data - treating all as inventory', {
        saleNumber: sale.saleNumber,
        totalAmount: sale.totalAmount
      });
    }

    // Convert Decimal values to numbers at the boundary for JournalLine interface
    const invRevenueNum = inventoryRevenue.toNumber();
    const svcRevenueNum = serviceRevenue.toNumber();
    let invCostNum =
      sale.actualInventoryCost !== undefined && sale.actualInventoryCost >= 0
        ? sale.actualInventoryCost
        : inventoryCost.toNumber();
    // Fallback: when all sale items had unitCost=0 (e.g. items were loaded without
    // cost data), inventoryCost stays 0 and shouldPostCogs=false would silently skip
    // the COGS/Inventory journal. Use sale.costAmount as a fallback so COGS is always
    // posted when the sale record itself carries a non-zero cost.
    if (invCostNum === 0 && Money.parseDb(sale.costAmount ?? 0).greaterThan(0)) {
      invCostNum = Money.parseDb(sale.costAmount!).toNumber();
      logger.warn('COGS fallback: item-level costs are 0, using sale.costAmount for COGS journal', {
        saleNumber: sale.saleNumber,
        costAmount: sale.costAmount,
      });
    }

    // Create ledger entries for revenue recognition and COGS
    const ledgerLines: JournalLine[] = [];

    // DEPOSIT sales: DR Accounts Receivable, CR Revenue
    // recordDepositApplicationToGL handles: DR Customer Deposits, CR AR
    // Net effect on AR = 0 (debit from sale, credit from deposit application)
    if (sale.paymentMethod === 'DEPOSIT') {
      logger.info('DEPOSIT sale - debiting AR (cleared by deposit application)', {
        saleNumber: sale.saleNumber,
        totalAmount: sale.totalAmount
      });
      // Debit AR - this gets cleared by the deposit application
      const customerId = requireCustomerIdForAr(sale.customerId, `deposit sale ${sale.saleNumber}`);
      ledgerLines.push(
        customerArLine({
          customerId,
          debitAmount: sale.totalAmount,
          description: 'DEPOSIT sale - A/R pending deposit application',
        }),
      );

      // Credit Revenue - split by product type
      if (invRevenueNum > 0) {
        ledgerLines.push({
          accountCode: AccountCodes.SALES_REVENUE,
          description: `Inventory sales revenue for ${sale.saleNumber}`,
          debitAmount: 0,
          creditAmount: invRevenueNum
        });
      }

      if (svcRevenueNum > 0) {
        ledgerLines.push({
          accountCode: AccountCodes.SERVICE_REVENUE,
          description: `Service revenue for ${sale.saleNumber}`,
          debitAmount: 0,
          creditAmount: svcRevenueNum
        });
      }
    } else if (sale.paymentMethod === 'CREDIT') {
      // CREDIT SALE LOGIC:
      // - If partial payment: DR Cash (paid), DR AR (unpaid), CR Revenue (total)
      // - If no payment: DR AR (total), CR Revenue (total)
      // - If full payment: DR Cash (total), CR Revenue (total) - shouldn't be CREDIT method

      if (amountPaid.gt(0)) {
        // Debit Cash for amount actually paid
        ledgerLines.push({
          accountCode: AccountCodes.CASH,
          description: `Partial payment received for ${sale.saleNumber}`,
          debitAmount: amountPaid.toNumber(),
          creditAmount: 0
        });
      }

      if (unpaidAmount.gt(0)) {
        const customerId = requireCustomerIdForAr(sale.customerId, `credit sale ${sale.saleNumber}`);
        ledgerLines.push(
          customerArLine({
            customerId,
            debitAmount: unpaidAmount.toNumber(),
            description: `Credit sale to ${sale.customerName || 'customer'} - ${sale.saleNumber}`,
          }),
        );
      }

      // Credit Revenue - split by product type
      if (invRevenueNum > 0) {
        ledgerLines.push({
          accountCode: AccountCodes.SALES_REVENUE,
          description: `Inventory sales revenue for ${sale.saleNumber}`,
          debitAmount: 0,
          creditAmount: invRevenueNum
        });
      }

      if (svcRevenueNum > 0) {
        ledgerLines.push({
          accountCode: AccountCodes.SERVICE_REVENUE,
          description: `Service revenue for ${sale.saleNumber}`,
          debitAmount: 0,
          creditAmount: svcRevenueNum
        });
      }

      logger.info('Credit sale GL entry created', {
        saleNumber: sale.saleNumber,
        totalAmount: sale.totalAmount,
        amountPaid: amountPaid.toNumber(),
        arAmount: unpaidAmount.toNumber()
      });
    } else {
      // CASH, CARD, MOBILE_MONEY - Full payment sales
      // BUG FIX: These should NEVER post to AR
      let debitAccountCode: string;
      let paymentDescription: string;

      switch (sale.paymentMethod) {
        case 'CASH':
          debitAccountCode = AccountCodes.CASH;
          paymentDescription = 'Cash payment received';
          break;
        case 'CARD':
          debitAccountCode = AccountCodes.CREDIT_CARD_RECEIPTS;
          paymentDescription = 'Credit card payment received';
          break;
        case 'MOBILE_MONEY':
        case 'AIRTEL_MONEY':
          debitAccountCode = AccountCodes.MOBILE_MONEY;
          paymentDescription = 'Mobile money payment received';
          break;
        default:
          debitAccountCode = AccountCodes.CASH;
          paymentDescription = 'Cash payment received';
          break;
      }

      // Debit payment account only when tender moves (skip zero-total sales
      // fully covered by exchange store credit / 100% discount).
      if (sale.totalAmount > 0.009) {
        ledgerLines.push({
          accountCode: debitAccountCode,
          description: `${paymentDescription} for ${sale.saleNumber}`,
          debitAmount: sale.totalAmount,
          creditAmount: 0
        });
      }

      // Credit Revenue - split by product type
      if (invRevenueNum > 0) {
        ledgerLines.push({
          accountCode: AccountCodes.SALES_REVENUE,
          description: `Inventory sales revenue for ${sale.saleNumber}`,
          debitAmount: 0,
          creditAmount: invRevenueNum
        });
      }

      if (svcRevenueNum > 0) {
        ledgerLines.push({
          accountCode: AccountCodes.SERVICE_REVENUE,
          description: `Service revenue for ${sale.saleNumber}`,
          debitAmount: 0,
          creditAmount: svcRevenueNum
        });
      }
    }

    // CREDIT: Tax Payable (Account 2300) - Tax collected on sale
    // Derive effective tax as the gap between sale.totalAmount (which may be tax-inclusive)
    // and the sum of item revenues. This ensures a balanced entry even when sale.taxAmount
    // was not populated (e.g., stored as 0 in DB but totalAmount includes tax).
    // Example: totalAmount=9000, items sum=8100, sale.taxAmount=0 → effectiveTax=900 → balanced.
    // Fallback: when no gap exists (items are tax-inclusive), use explicit sale.taxAmount.
    const revenueGap = Money.subtract(
      Money.parseDb(sale.totalAmount),
      Money.add(inventoryRevenue, serviceRevenue)
    );
    const effectiveTaxAmount = revenueGap.greaterThan(0.005)
      ? revenueGap.toNumber()
      : (sale.taxAmount ?? 0);
    if (effectiveTaxAmount > 0) {
      ledgerLines.push({
        accountCode: AccountCodes.TAX_PAYABLE,
        description: `Tax collected on sale ${sale.saleNumber}`,
        debitAmount: 0,
        creditAmount: effectiveTaxAmount
      });
    }

    // Record inventory cost (excludes service items)
    //
    // SAP-GOVERNANCE SPLIT (migration 013):
    //   Previously, the COGS/Inventory lines were appended to the SAME
    //   journal as the revenue lines (single journal under source
    //   'SALES_INVOICE'). That violated the SAP rule that account 1300
    //   (Inventory) must only be posted under source INVENTORY_MOVE.
    //
    //   The sale journal is now split in two:
    //     1. Revenue journal  — source=SALES_INVOICE, key=SALE-<id>
    //        (Cash/AR  +  Revenue  +  Tax)               ← this block below
    //     2. Goods-issue journal — source=INVENTORY_MOVE, key=SALE-COGS-<id>
    //        (DR COGS  /  CR Inventory)                   ← posted after revenue journal
    //
    //   Both journals share the same SALE.referenceId so reports that
    //   aggregate by reference remain correct. Idempotency keys differ
    //   so the two entries never collide.
    const shouldPostCogs = invCostNum > 0;

    // CRITICAL: txClient MUST be provided so GL commits atomically with the sale.
    // Without it, GL opens its own inner transaction — if the outer sale TX rolls
    // back (e.g. after a retry), the GL entry persists as a phantom journal.
    // Any call site that omits txClient is a latent data-integrity bug.
    if (!txClient) {
      logger.error(
        'recordSaleToGL called WITHOUT txClient — GL will not be atomic with sale! ' +
        'This is a latent phantom-journal risk. Pass the active PoolClient.',
        { saleNumber: sale.saleNumber, saleId: sale.saleId }
      );
      // Do NOT throw here: the repost tool (glValidationService) intentionally
      // calls outside a transaction for already-committed sales.
    }

    // Use AccountingCore for audit-safe, idempotent journal entry creation.
    // txClient is forwarded when available so both GL journals commit atomically
    // inside the caller's transaction (SAP LUW pattern). Without txClient the
    // journals open their own UnitOfWork transaction, which can lead to phantom
    // GL entries if the outer sale transaction rolls back.
    //
    // IDEMPOTENCY KEY: Use saleNumber (business ID), NOT saleId (UUID).
    // Each retry inside a rolled-back TX generates a NEW UUID for the sale row,
    // so UUID-based keys are different on every retry → phantom GL slips through.
    // saleNumber is generated with pg_advisory_xact_lock and is stable: when a TX
    // rolls back, the next retry reclaims the same slot number. This means a phantom
    // GL (if one somehow commits) will collide on the idempotency key on retry,
    // causing AccountingCore to return the existing entry instead of creating a new one.
    //
    // Zero-total sales fully paid by exchange store credit: net revenue journal is empty
    // (revenue recognized on EXCHANGE_CREDIT apply). Still post COGS/Inventory if stock moved.
    const hasRevenueJournalLines = ledgerLines.some(
      (l) => (l.debitAmount ?? 0) > 0.009 || (l.creditAmount ?? 0) > 0.009,
    );
    if (hasRevenueJournalLines) {
      await AccountingCore.createJournalEntry({
        entryDate: sale.saleDate,
        description: `Sale: ${sale.saleNumber}`,
        referenceType: 'SALE',
        referenceId: sale.saleId,
        referenceNumber: sale.saleNumber,
        lines: ledgerLines,
        userId: SYSTEM_USER_ID,
        idempotencyKey: `SALE-${sale.saleNumber}`,  // saleNumber-based: stable across retries
        source: 'SALES_INVOICE' as const,
      }, pool, txClient);
    } else {
      logger.info('Skipping empty SALE revenue journal (zero-total / full exchange credit)', {
        saleNumber: sale.saleNumber,
        saleId: sale.saleId,
        totalAmount: sale.totalAmount,
      });
    }

    // Post the separate INVENTORY_MOVE journal for the goods-issue leg.
    // NOTE: referenceType is 'SALE_COGS' (not 'SALE') to allow both journals
    // to coexist for the same sale without conflicting on any unique reference index.
    // Reports that need both legs should query by referenceId regardless of type.
    if (shouldPostCogs) {
      await AccountingCore.createJournalEntry({
        entryDate: sale.saleDate,
        description: `Sale goods issue (COGS): ${sale.saleNumber}`,
        referenceType: 'SALE_COGS',
        referenceId: sale.saleId,
        referenceNumber: sale.saleNumber,
        lines: [
          {
            accountCode: AccountCodes.COGS,
            description: `Cost of goods sold for ${sale.saleNumber}`,
            debitAmount: invCostNum,
            creditAmount: 0,
          },
          {
            accountCode: AccountCodes.INVENTORY,
            description: `Inventory reduction for ${sale.saleNumber}`,
            debitAmount: 0,
            creditAmount: invCostNum,
          },
        ],
        userId: SYSTEM_USER_ID,
        idempotencyKey: `SALE-COGS-${sale.saleNumber}`,  // saleNumber-based: stable across retries
        source: 'INVENTORY_MOVE' as const,
      }, pool, txClient);

      logger.info('COGS entry created under INVENTORY_MOVE (service items excluded)', {
        saleNumber: sale.saleNumber,
        inventoryCost: invCostNum,
        originalCostAmount: sale.costAmount,
      });
    }

    logger.info('Recorded sale to GL', {
      saleId: sale.saleId,
      saleNumber: sale.saleNumber,
      totalAmount: sale.totalAmount,
      costAmount: sale.costAmount
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record sale to GL', { error, sale });
    // CRITICAL: GL failure MUST throw to prevent sales without accounting entries
    // A sale without GL entries breaks double-entry accounting integrity
    throw new Error(`GL posting failed for sale ${sale.saleNumber}: ${(error instanceof Error ? error.message : String(error))}`);
  }
}

// =============================================================================
// CUSTOMER PAYMENT JOURNAL ENTRIES
// =============================================================================

export interface CustomerPaymentData {
  paymentId: string;
  paymentNumber: string;
  paymentDate: string;
  /** Gross AR settlement (invoice reduction). */
  amount: number;
  paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'AIRTEL_MONEY' | 'BANK_TRANSFER';
  customerId: string;
  customerName: string;
  /**
   * BUG FIX: Only credit AR if payment is actually reducing customer balance
   * Set to true when:
   * - Payment is allocated to a specific invoice, OR
   * - Payment reduces customer's outstanding balance
   * Set to false when:
   * - Payment is unallocated/on-account (should credit Unearned Revenue or Customer Prepayment)
   */
  reducesAR?: boolean;
  /**
   * Optional invoice reference for allocated payments
   */
  invoiceNumber?: string;
  /** Optional WHT withheld by customer; cash debit = amount − whtAmount. */
  whtAmount?: number;
  whtTypeName?: string;
  whtEntryId?: string;
  /** GL account for customer WHT receivable leg (defaults to 1250). */
  whtAccountCode?: string;
  /** @deprecated Receipts always clear through Undeposited Funds (1015). Bank settlement is Deposit Worksheet. */
  paymentAccountCode?: string;
}

/**
 * Record a customer payment in the general ledger (clearing step 1).
 *
 * Journal entry — PAYMENT_RECEIPT:
 *   DR Undeposited Funds (1015)       amount − WHT
 *   DR WHT Receivable (1250+)         WHT (when customer withheld)
 *   CR Accounts Receivable (1200)     amount   when reducesAR = true
 *   CR Customer Deposits (2200)       amount   when reducesAR = false (on-account prepayment)
 *
 * Bank/cash settlement is a separate Deposit Worksheet (TREASURY_DEPOSIT): DR bank / CR 1015.
 */
export async function recordCustomerPaymentToGL(
  payment: CustomerPaymentData,
  pool?: pg.Pool,
  txClient?: pg.PoolClient,
): Promise<{ transactionId: string }> {
  try {
    const reducesAR = payment.reducesAR !== false;
    const creditAccountCode = reducesAR
      ? AccountCodes.ACCOUNTS_RECEIVABLE
      : AccountCodes.CUSTOMER_DEPOSITS;

    const debitAccountCode = AccountCodes.UNDEPOSITED_FUNDS;

    const creditDescription = reducesAR
      ? `Reduce A/R for ${payment.customerName}${payment.invoiceNumber ? ` - ${payment.invoiceNumber}` : ''}`
      : `Customer prepayment from ${payment.customerName}`;

    const gross = payment.amount;
    const whtAmount = payment.whtAmount && payment.whtAmount > 0.009 ? payment.whtAmount : 0;
    if (whtAmount > 0.009 && !reducesAR) {
      throw new Error('Customer WHT can only be applied when the payment reduces Accounts Receivable');
    }
    const { cashDebit, whtDebit, arCredit } = splitCustomerPaymentDebits(gross, whtAmount);
    const whtLabel = payment.whtTypeName ? ` (${payment.whtTypeName})` : '';
    let whtAccountCode = payment.whtAccountCode?.trim() || AccountCodes.WHT_RECEIVABLE;

    if (whtDebit > 0.009 && txClient) {
      const { ensureWhtGlAccountForCode } = await import(
        '../modules/withholding-tax/ensureWhtAccounts.js'
      );
      whtAccountCode = await ensureWhtGlAccountForCode(txClient, whtAccountCode, 'CUSTOMER');
    }

    const lines: Array<{
      accountCode: string;
      description: string;
      debitAmount: number;
      creditAmount: number;
      entityType?: string;
      entityId?: string;
    }> = [
      {
        accountCode: debitAccountCode,
        description: whtDebit > 0
          ? `Net payment after customer WHT — ${payment.paymentNumber}`
          : `Payment received — ${payment.paymentNumber}`,
        debitAmount: cashDebit,
        creditAmount: 0,
        entityType: 'customer',
        entityId: payment.customerId,
      },
    ];

    if (whtDebit > 0.009) {
      lines.push({
        accountCode: whtAccountCode,
        description: `WHT withheld by customer${whtLabel} — ${payment.paymentNumber}`,
        debitAmount: whtDebit,
        creditAmount: 0,
        entityType: 'WHT',
        entityId: payment.whtEntryId,
      });
    }

    lines.push({
      accountCode: creditAccountCode,
      description: creditDescription,
      debitAmount: 0,
      creditAmount: arCredit,
      entityType: 'customer',
      entityId: payment.customerId,
    });

    const glResult = await AccountingCore.createJournalEntry({
      entryDate: payment.paymentDate,
      description: whtDebit > 0
        ? `Customer payment with WHT from ${payment.customerName}: ${payment.paymentNumber}`
        : `Customer payment from ${payment.customerName}: ${payment.paymentNumber}`,
      referenceType: 'CUSTOMER_PAYMENT',
      referenceId: payment.paymentId,
      referenceNumber: payment.paymentNumber,
      lines,
      userId: SYSTEM_USER_ID,
      idempotencyKey: `CUSTOMER_PAYMENT-${payment.paymentId}`,
      source: 'PAYMENT_RECEIPT' as const,
    }, txClient ? undefined : pool, txClient);

    logger.info('Recorded customer payment to GL', {
      paymentId: payment.paymentId,
      amount: payment.amount,
      customerId: payment.customerId,
      reducesAR,
      debitAccount: debitAccountCode,
      creditAccount: creditAccountCode,
      whtAmount: whtDebit,
      whtAccountCode: whtDebit > 0.009 ? whtAccountCode : undefined,
      transactionId: glResult.transactionId,
    });
    return { transactionId: glResult.transactionId };
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    if (error instanceof ValidationError) throw error;
    if (error instanceof AppError) throw error;
    logger.error('Failed to record customer payment to GL', { error, payment });
    // CRITICAL: GL failure MUST throw to prevent payments without AR adjustment.
    // Use [GL_ERROR] prefix so nested 'not found' is not misclassified as HTTP 404.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[GL_ERROR] GL posting failed for customer payment ${payment.paymentNumber}: ${detail}`);
  }
}

// =============================================================================
// EXPENSE JOURNAL ENTRIES
// =============================================================================

export interface ExpenseData {
  expenseId: string;
  expenseNumber: string;
  expenseDate: string;
  amount: number;
  categoryCode: string; // Maps to expense account code
  categoryName: string;
  description: string;
  paymentMethod: 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'PETTY_CASH' | 'MOBILE_MONEY' | 'AIRTEL_MONEY';
  supplierId?: string;
  supplierName?: string;
}

/**
 * Record a paid expense in the general ledger
 * 
 * Journal entry for expense:
 *   DR Expense Account (6xxx) amount
 *   CR Cash (1010)            amount
 */
export async function recordExpenseToGL(expense: ExpenseData, pool?: pg.Pool): Promise<void> {
  try {
    // Map category to expense account code
    const expenseAccountCode = mapExpenseCategoryToAccount(expense.categoryCode);

    // Determine credit account based on payment method
    let creditAccountCode: string;
    switch (expense.paymentMethod) {
      case 'CASH':
      case 'PETTY_CASH':
        creditAccountCode = AccountCodes.CASH;
        break;
      case 'CARD':
        creditAccountCode = AccountCodes.CHECKING_ACCOUNT;
        break;
      case 'BANK_TRANSFER':
        creditAccountCode = AccountCodes.CHECKING_ACCOUNT;
        break;
      case 'MOBILE_MONEY':
      case 'AIRTEL_MONEY':
        creditAccountCode = AccountCodes.MOBILE_MONEY;
        break;
      default:
        creditAccountCode = AccountCodes.CASH;
    }

    // Use AccountingCore for audit-safe, idempotent journal entry creation
    await AccountingCore.createJournalEntry({
      entryDate: expense.expenseDate,
      description: `Expense: ${expense.description || expense.categoryName}`,
      referenceType: 'EXPENSE',
      referenceId: expense.expenseId,
      referenceNumber: expense.expenseNumber,
      lines: [
        {
          accountCode: expenseAccountCode,
          description: `${expense.categoryName}: ${expense.description}`,
          debitAmount: expense.amount,
          creditAmount: 0
        },
        {
          accountCode: creditAccountCode,
          description: `Payment for ${expense.expenseNumber}`,
          debitAmount: 0,
          creditAmount: expense.amount
        }
      ],
      userId: SYSTEM_USER_ID,
      idempotencyKey: `EXPENSE-${expense.expenseId}`,
      // Paid expense recognition: cash-credit path — same allowlist as approval (not PURCHASE_BILL)
      source: 'EXPENSE_PAYMENT' as const,
    }, pool);

    logger.info('Recorded expense to GL', {
      expenseId: expense.expenseId,
      amount: expense.amount,
      category: expense.categoryName
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record expense to GL', { error, expense });
    // CRITICAL: GL failure MUST throw to prevent expenses without accounting entries
    throw new Error(`GL posting failed for expense ${expense.expenseNumber}: ${(error instanceof Error ? error.message : String(error))}`);
  }
}

/**
 * Map expense category to GL account code
 *
 * Prefer expense_categories.account_id at call sites (resolveExpenseGlAccountCode).
 * This table is the hardcoded fallback for aliases / missing DB links.
 */
function mapExpenseCategoryToAccount(categoryCode: string): string {
  // Keep in sync with shared/expense/categoryGlMap.ts
  const categoryMappings: Record<string, string> = {
    'OFFICE': AccountCodes.OFFICE_SUPPLIES,      // 6400
    'OFFICE_SUPPLIES': AccountCodes.OFFICE_SUPPLIES,
    'TRAVEL': '6800',
    'MEALS': '6800',
    'FUEL': '6800',
    'ACCOMMODATION': '6800',
    'UTILITIES': AccountCodes.UTILITIES,          // 6200
    'SALARIES': AccountCodes.SALARIES,            // 6000
    'ALLOWANCE': AccountCodes.SALARIES,
    'RENT': AccountCodes.RENT,                    // 6100
    'MARKETING': AccountCodes.MARKETING,          // 6300
    'INSURANCE': AccountCodes.INSURANCE,          // 6600
    'PROFESSIONAL': '6700',
    'PROFESSIONAL_SERVICES': '6700',
    'MAINTENANCE': AccountCodes.GENERAL_EXPENSE,  // 6900
    'EQUIPMENT': AccountCodes.GENERAL_EXPENSE,
    'SOFTWARE': AccountCodes.GENERAL_EXPENSE,
    'TRAINING': AccountCodes.GENERAL_EXPENSE,
    'OTHER': AccountCodes.GENERAL_EXPENSE,
    'GENERAL': AccountCodes.GENERAL_EXPENSE
  };

  const code = categoryCode.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return categoryMappings[code] || categoryMappings[categoryCode] || AccountCodes.GENERAL_EXPENSE;
}

// =============================================================================
// PURCHASE / GOODS RECEIPT JOURNAL ENTRIES
// =============================================================================

export interface GoodsReceiptData {
  grId: string;
  grNumber: string;
  grDate: string;
  totalAmount: number;
  supplierId: string;
  supplierName: string;
  poNumber?: string;
}

/**
 * Record goods receipt in the general ledger
 * 
 * Journal entry for receiving inventory:
 *   DR Inventory (1300)        totalAmount
 *   CR GRN/IR Clearing (2150) totalAmount
 *
 * SYSTEM RULE: GRN must NEVER create Accounts Payable.
 * Only a Supplier Invoice (Bill) can create AP (2100).
 * SAP/Odoo 3-way matching: GRN → GRIR Clearing → Supplier Invoice → AP.
 */
export async function recordGoodsReceiptToGL(
  gr: GoodsReceiptData,
  pool?: pg.Pool,
  txClient?: pg.PoolClient,
): Promise<void> {
  try {
    // 3-way match (SAP pattern): GRN posts to GRN/IR Clearing (2150), NOT AP.
    // AP is only created when the Supplier Invoice is posted via recordSupplierInvoiceToGL().
    await AccountingCore.createJournalEntry({
      entryDate: gr.grDate,
      description: `Goods Receipt: ${gr.grNumber} from ${gr.supplierName}`,
      referenceType: 'GOODS_RECEIPT',
      referenceId: gr.grId,
      referenceNumber: gr.grNumber,
      lines: [
        {
          accountCode: AccountCodes.INVENTORY,
          description: `Inventory received: ${gr.grNumber}`,
          debitAmount: gr.totalAmount,
          creditAmount: 0,
          entityType: 'supplier',
          entityId: gr.supplierId
        },
        {
          accountCode: AccountCodes.GRIR_CLEARING,
          description: `GRN clearing (pending invoice): ${gr.grNumber}`,
          debitAmount: 0,
          creditAmount: gr.totalAmount,
          entityType: 'supplier',
          entityId: gr.supplierId
        }
      ],
      userId: SYSTEM_USER_ID,
      idempotencyKey: `GOODS_RECEIPT-${gr.grId}`,
      // INVENTORY_MOVE: inventory leg drives this journal (SAP governance Rule H).
      source: 'INVENTORY_MOVE' as const,
    }, pool, txClient);

    logger.info('Recorded goods receipt to GL (GRN Clearing)', {
      grId: gr.grId,
      grNumber: gr.grNumber,
      amount: gr.totalAmount
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record goods receipt to GL', { error, gr });
    // CRITICAL: GL failure MUST throw to prevent GRN without inventory/GRIR entries
    throw new Error(`GL posting failed for goods receipt ${gr.grNumber}: ${(error instanceof Error ? error.message : String(error))}`);
  }
}

// =============================================================================
// RETURN GRN (SUPPLIER RETURN) JOURNAL ENTRIES
// =============================================================================
// SAP pattern: Goods return to supplier reverses the original GR posting.
// DR GRN/IR Clearing (2150) — reverses the GRN clearing credit
// CR Inventory (1300) — reduce inventory value (goods left the warehouse)
//
// This is the inverse of recordGoodsReceiptToGL(). Without this entry,
// inventory_batches would decrease but GL account 1300 would remain
// unchanged — a guaranteed GL-vs-subledger discrepancy.
// NOTE: AP is NOT debited here. If a credit note is issued by the supplier
// after an invoice was already posted, use the Supplier Credit Note workflow.
// =============================================================================

export interface SupplierInvoiceGLData {
  invoiceId: string;
  invoiceNumber: string;   // SBILL-YYYY-NNNN
  invoiceDate: string;     // YYYY-MM-DD
  /**
   * Supplier-reported total = the Accounts Payable credit amount.
   * For no-variance invoices this equals grnComputedTotal.
   * For variance invoices AP = supplier total; GR/IR = grnComputedTotal.
   */
  totalAmount: number;
  supplierId: string;
  supplierName: string;
  /**
   * true  → GR-linked invoice: DR GR/IR Clearing (2150) / CR AP (2100)
   * false → Standalone invoice (no GR): DR General Expense (6900) / CR AP (2100)
   */
  hasGrReference: boolean;
  /**
   * Variance support — only set when supplier-reported total ≠ GRN computed total.
   *
   * grnComputedTotal: the amount GR/IR clearing was debited when GRN was received.
   * varianceAmount  : grnComputedTotal − totalAmount (positive = supplier billed less).
   * varianceReason  : audit metadata stored on the invoice.
   *
   * When set, the GL entry becomes 3 lines:
   *   DR GR/IR Clearing (2150)   grnComputedTotal
   *   CR Accounts Payable (2100) totalAmount        (what we owe supplier)
   *   CR Price Variance (5020)   varianceAmount     (positive = credit; negative = debit)
   */
  grnComputedTotal?: number;
  varianceAmount?: number;
  varianceReason?: string;
}

export interface ReturnGrnGLData {
  returnGrnId: string;
  returnGrnNumber: string;
  returnDate: string;
  totalAmount: number;
  supplierId: string;
  supplierName: string;
  originalGrNumber?: string;
  /**
   * True when the originating GRN already has a posted supplier invoice.
   * In that case the return must NOT touch GR/IR Clearing (2150) — which is
   * already netted to zero by the invoice — and instead routes through the
   * dedicated Supplier Return Clearing account (2160).
   *
   * False (or undefined) means the goods receipt is still uninvoiced:
   * the return reverses the original GR/IR debit (standard 3-way match reversal).
   */
  hasInvoice?: boolean;
}

export async function recordReturnGrnToGL(
  data: ReturnGrnGLData,
  pool?: pg.Pool,
  txClient?: pg.PoolClient,
): Promise<void> {
  try {
    // ── MR11 PURITY RULE ─────────────────────────────────────────────────────
    // GR/IR Clearing (2150) must ONLY represent uninvoiced goods receipts.
    //
    //  • hasInvoice = false (or undefined): GRN not yet invoiced.
    //    The return reverses the original GRN clearing entry.
    //    DR GR/IR Clearing (2150) / CR Inventory (1300)  ← standard reversal
    //
    //  • hasInvoice = true: GRN already invoiced (2150 already netted to zero).
    //    Posting to 2150 would corrupt MR11 and inflate the GR/IR balance.
    //    DR Supplier Return Clearing (2160) / CR Inventory (1300)  ← clean path
    //    A subsequent Supplier Credit Note will: DR AP (2100) / CR 2160.
    // ─────────────────────────────────────────────────────────────────────────
    if (data.hasInvoice && txClient) {
      const { ensureSupplierReturnClearingAccount } = await import(
        '../modules/return-grn/ensureSupplierReturnClearingAccount.js'
      );
      await ensureSupplierReturnClearingAccount(txClient);
    }

    const clearingAccountCode = data.hasInvoice
      ? AccountCodes.SUPPLIER_RETURN_CLEARING
      : AccountCodes.GRIR_CLEARING;

    const clearingDescription = data.hasInvoice
      ? `Supplier return clearing (post-invoice) — ${data.returnGrnNumber}`
      : `Reverse GRN clearing — returned goods: ${data.returnGrnNumber}`;

    await AccountingCore.createJournalEntry({
      entryDate: data.returnDate,
      description: `Return to Supplier: ${data.returnGrnNumber} (${data.supplierName})${data.originalGrNumber ? ` — orig GR ${data.originalGrNumber}` : ''}`,
      referenceType: 'RETURN_GRN',
      referenceId: data.returnGrnId,
      referenceNumber: data.returnGrnNumber,
      lines: [
        {
          accountCode: clearingAccountCode,
          description: clearingDescription,
          debitAmount: data.totalAmount,
          creditAmount: 0,
          entityType: 'supplier',
          entityId: data.supplierId,
        },
        {
          accountCode: AccountCodes.INVENTORY,
          description: `Inventory returned to supplier: ${data.returnGrnNumber}`,
          debitAmount: 0,
          creditAmount: data.totalAmount,
          entityType: 'supplier',
          entityId: data.supplierId,
        },
      ],
      userId: SYSTEM_USER_ID,
      idempotencyKey: `RETURN_GRN-${data.returnGrnId}`,
      // INVENTORY_MOVE: inventory leg drives this reversal (SAP governance Rule H).
      source: 'INVENTORY_MOVE' as const,
    }, pool, txClient);

    logger.info('Recorded return GRN to GL', {
      returnGrnId: data.returnGrnId,
      returnGrnNumber: data.returnGrnNumber,
      amount: data.totalAmount,
      clearingAccount: clearingAccountCode,
      hasInvoice: data.hasInvoice ?? false,
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to record return GRN to GL', { error, data });
    if (msg.includes('2160') && msg.includes('not found')) {
      throw new BusinessRuleException(
        'GL account 2160 (Supplier Return Clearing) is missing. Deploy latest migrations or ask an admin to add account 2160, then re-post the return.',
        'ACCOUNT_2160_MISSING',
      );
    }
    throw new Error(`GL posting failed for return GRN ${data.returnGrnNumber}: ${msg}`);
  }
}

// =============================================================================
// SUPPLIER INVOICE (BILL) GL POSTING — TWO PATHS
// =============================================================================
//
// PATH A — GR-linked invoice (3-way match, standard procurement):
//   DR GRN/IR Clearing (2150) — clears the outstanding GRN clearing balance
//   CR Accounts Payable (2100)
//
// PATH B — Standalone invoice (no GR in system, e.g. service bills, ad-hoc):
//   DR General Expense (6900) — service/expense recognition (NEVER 1300 Inventory,
//     because no GR ever increased the physical batch subledger; routing such
//     bills to 1300 corrupts the inventory-vs-GL reconciliation).
//   CR Accounts Payable (2100)
//
// Rule: only invoices whose InternalReferenceNumber matches a completed GR
// should go through GR/IR Clearing. Standalone bills go to expense, not inventory.
// Routing is done by the caller (postInvoiceToGL) based on hasGrReference.
// =============================================================================
export async function recordSupplierInvoiceToGL(
  data: SupplierInvoiceGLData,
  pool?: pg.Pool,
  txClient?: pg.PoolClient,
): Promise<void> {
  // PATH A: GR-linked → DR GR/IR Clearing / CR AP  (2 or 3 lines)
  // PATH B: Standalone → DR General Expense / CR AP (NEVER Inventory)
  const debitAccountCode = data.hasGrReference
    ? AccountCodes.GRIR_CLEARING
    : AccountCodes.GENERAL_EXPENSE;
  const path = data.hasGrReference ? 'GR-linked (GRIR → AP)' : 'standalone (Expense → AP)';
  if (!data.hasGrReference) {
    logger.warn('Supplier invoice posted as standalone expense — no GR reference found', {
      invoiceId: data.invoiceId,
      invoiceNumber: data.invoiceNumber,
      amount: data.totalAmount,
    });
  }

  // ── Variance path (3-line GR-linked entry) ─────────────────────────────────
  // When a GR-linked invoice has a variance (supplier reported ≠ GRN computed):
  //   DR GR/IR Clearing (2150)   grnComputedTotal  ← fully clears GR/IR to zero
  //   CR Accounts Payable (2100) totalAmount        ← what we actually owe supplier
  //   CR/DR Price Variance (5020) varianceAmount    ← absorbs the difference
  //
  // Inventory value is NEVER touched — it was set correctly when the GRN was received.
  // ──────────────────────────────────────────────────────────────────────────────
  const hasVariance =
    data.hasGrReference &&
    data.grnComputedTotal !== undefined &&
    data.varianceAmount !== undefined &&
    Math.abs(data.varianceAmount) > 0.005;

  if (hasVariance) {
    const grnComputedTotal = data.grnComputedTotal as number;
    const varianceAmount = data.varianceAmount as number;
    // varianceAmount > 0 → supplier billed less → CR Price Variance (favorable)
    // varianceAmount < 0 → supplier billed more → DR Price Variance (unfavorable)
    const varianceCreditAmount = varianceAmount > 0 ? varianceAmount : 0;
    const varianceDebitAmount = varianceAmount < 0 ? Math.abs(varianceAmount) : 0;

    try {
      await AccountingCore.createJournalEntry({
        entryDate: data.invoiceDate,
        description: `Supplier Invoice: ${data.invoiceNumber} — ${data.supplierName} [3-way match, variance: ${data.varianceReason ?? 'PRICE_VARIANCE'}]`,
        referenceType: 'SUPPLIER_INVOICE',
        referenceId: data.invoiceId,
        referenceNumber: data.invoiceNumber,
        lines: [
          {
            accountCode: AccountCodes.GRIR_CLEARING,
            description: `Clear GRN/IR — Invoice ${data.invoiceNumber} (GRN value ${grnComputedTotal})`,
            debitAmount: grnComputedTotal,
            creditAmount: 0,
            entityType: 'supplier',
            entityId: data.supplierId,
          },
          {
            accountCode: AccountCodes.ACCOUNTS_PAYABLE,
            description: `Payable to ${data.supplierName}: ${data.invoiceNumber}`,
            debitAmount: 0,
            creditAmount: data.totalAmount,
            entityType: 'supplier',
            entityId: data.supplierId,
          },
          {
            accountCode: AccountCodes.PRICE_VARIANCE,
            description: `Invoice variance (${data.varianceReason ?? 'PRICE_VARIANCE'}): ${data.invoiceNumber}`,
            debitAmount: varianceDebitAmount,
            creditAmount: varianceCreditAmount,
            entityType: 'supplier',
            entityId: data.supplierId,
          },
        ],
        userId: SYSTEM_USER_ID,
        idempotencyKey: `SUPPLIER_INVOICE-${data.invoiceId}`,
        source: 'PURCHASE_BILL' as const,
      }, pool, txClient);

      logger.info('Recorded supplier invoice to GL (GR-linked, 3-line variance)', {
        invoiceId: data.invoiceId,
        invoiceNumber: data.invoiceNumber,
        grnComputedTotal,
        apAmount: data.totalAmount,
        varianceAmount,
        varianceReason: data.varianceReason,
      });
    } catch (error: unknown) {
      if (error instanceof BusinessRuleException) throw error;
      logger.error('Failed to record supplier invoice to GL (variance path)', { error, data });
      throw new Error(`[GL_ERROR] GL posting failed for supplier invoice ${data.invoiceNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  // ── Standard 2-line path ──────────────────────────────────────────────────
  try {
    await AccountingCore.createJournalEntry({
      entryDate: data.invoiceDate,
      description: `Supplier Invoice: ${data.invoiceNumber} — ${data.supplierName}`,
      referenceType: 'SUPPLIER_INVOICE',
      referenceId: data.invoiceId,
      referenceNumber: data.invoiceNumber,
      lines: [
        {
          accountCode: debitAccountCode,
          description: data.hasGrReference
            ? `Clear GRN/IR — Invoice ${data.invoiceNumber}`
            : `Expense (no GR) — Invoice ${data.invoiceNumber}`,
          debitAmount: data.totalAmount,
          creditAmount: 0,
          entityType: 'supplier',
          entityId: data.supplierId,
        },
        {
          accountCode: AccountCodes.ACCOUNTS_PAYABLE,
          description: `Payable to ${data.supplierName}: ${data.invoiceNumber}`,
          debitAmount: 0,
          creditAmount: data.totalAmount,
          entityType: 'supplier',
          entityId: data.supplierId,
        },
      ],
      userId: SYSTEM_USER_ID,
      idempotencyKey: `SUPPLIER_INVOICE-${data.invoiceId}`,
      source: 'PURCHASE_BILL' as const,
    }, pool, txClient);

    logger.info(`Recorded supplier invoice to GL (${path})`, {
      invoiceId: data.invoiceId,
      invoiceNumber: data.invoiceNumber,
      amount: data.totalAmount,
      hasGrReference: data.hasGrReference,
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record supplier invoice to GL', { error, data });
    throw new Error(`[GL_ERROR] GL posting failed for supplier invoice ${data.invoiceNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// =============================================================================
// SUPPLIER PAYMENT JOURNAL ENTRIES
// =============================================================================

export interface SupplierPaymentData {
  paymentId: string;
  paymentNumber: string;
  paymentDate: string;
  /** Gross AP settlement amount (invoice reduction). */
  amount: number;
  paymentMethod: 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'CHECK' | 'MOBILE_MONEY' | 'AIRTEL_MONEY';
  supplierId: string;
  supplierName: string;
  /** Explicit liquidity GL to credit (multi-bank / MoMo book). Overrides method default. */
  paymentAccountCode?: string;
  /** Optional WHT withheld from cash; cash credit = amount − whtAmount. */
  whtAmount?: number;
  whtTypeName?: string;
  whtEntryId?: string;
  /** GL account for supplier WHT payable leg (defaults to 2350). */
  whtAccountCode?: string;
}

/**
 * Record supplier payment in the general ledger
 *
 * Journal entry for paying supplier:
 *   DR Accounts Payable (2100) amount
 *   CR Cash/Bank (1010/1030)   amount − WHT (or full amount if no WHT)
 *   CR WHT Payable (2350+)     WHT amount (when withheld)
 */
export async function recordSupplierPaymentToGL(
  payment: SupplierPaymentData,
  pool?: pg.Pool,
  txClient?: pg.PoolClient,
): Promise<{ transactionId: string }> {
  try {
    // Determine credit account: explicit pay-from book wins; else method defaults
    let creditAccountCode: string;
    if (payment.paymentAccountCode?.trim()) {
      creditAccountCode = payment.paymentAccountCode.trim();
    } else {
      switch (payment.paymentMethod) {
        case 'CASH':
          creditAccountCode = AccountCodes.CASH;
          break;
        case 'BANK_TRANSFER':
        case 'CHECK':
          creditAccountCode = AccountCodes.CHECKING_ACCOUNT;
          break;
        case 'CARD':
          creditAccountCode = AccountCodes.CHECKING_ACCOUNT;
          break;
        case 'MOBILE_MONEY':
        case 'AIRTEL_MONEY':
          creditAccountCode = AccountCodes.MOBILE_MONEY;
          break;
        default:
          creditAccountCode = AccountCodes.CASH;
      }
    }

    const gross = payment.amount;
    const whtAmount = payment.whtAmount && payment.whtAmount > 0.009 ? payment.whtAmount : 0;
    const { cashCredit: cashAmount, whtCredit } = splitSupplierPaymentCredits(gross, whtAmount);
    const whtLabel = payment.whtTypeName ? ` (${payment.whtTypeName})` : '';
    let whtAccountCode = payment.whtAccountCode?.trim() || AccountCodes.WHT_PAYABLE;

    // Block overdrawing cash/bank/MoMo — same SSOT guard as treasury transfers
    if (cashAmount > 0.009) {
      const conn = txClient || pool || globalPool;
      const { assertSufficientLiquidityFunds } = await import(
        '../modules/treasury/liquidityFundsGuard.js'
      );
      await assertSufficientLiquidityFunds(conn, creditAccountCode, cashAmount, {
        asOfDate: payment.paymentDate,
        actionLabel: `supplier payment ${payment.paymentNumber}`,
      });
    }

    if (whtCredit > 0.009 && txClient) {
      const { ensureWhtGlAccountForCode } = await import(
        '../modules/withholding-tax/ensureWhtAccounts.js'
      );
      whtAccountCode = await ensureWhtGlAccountForCode(txClient, whtAccountCode, 'SUPPLIER');
    }

    const lines: Array<{
      accountCode: string;
      description: string;
      debitAmount: number;
      creditAmount: number;
      entityType?: string;
      entityId?: string;
    }> = [
      {
        accountCode: AccountCodes.ACCOUNTS_PAYABLE,
        description: `Reduce payable to ${payment.supplierName}`,
        debitAmount: gross,
        creditAmount: 0,
        entityType: 'supplier',
        entityId: payment.supplierId,
      },
      {
        accountCode: creditAccountCode,
        description: whtCredit > 0
          ? `Net payment after WHT: ${payment.paymentNumber}`
          : `Payment: ${payment.paymentNumber}`,
        debitAmount: 0,
        creditAmount: cashAmount,
      },
    ];

    if (whtCredit > 0.009) {
      lines.push({
        accountCode: whtAccountCode,
        description: `WHT withheld${whtLabel} — ${payment.paymentNumber}`,
        debitAmount: 0,
        creditAmount: whtCredit,
        entityType: 'WHT',
        entityId: payment.whtEntryId,
      });
    }

    // Use AccountingCore for audit-safe, idempotent journal entry creation
    const glResult = await AccountingCore.createJournalEntry({
      entryDate: payment.paymentDate,
      description: whtCredit > 0
        ? `Payment to supplier with WHT: ${payment.supplierName}`
        : `Payment to supplier: ${payment.supplierName}`,
      referenceType: 'SUPPLIER_PAYMENT',
      referenceId: payment.paymentId,
      referenceNumber: payment.paymentNumber,
      lines,
      userId: SYSTEM_USER_ID,
      idempotencyKey: `SUPPLIER_PAYMENT-${payment.paymentId}`,
      source: 'SUPPLIER_PAYMENT' as const,
    }, txClient ? undefined : pool, txClient);

    logger.info('Recorded supplier payment to GL', {
      paymentId: payment.paymentId,
      amount: payment.amount,
      supplierId: payment.supplierId,
      whtAccountCode: whtCredit > 0.009 ? whtAccountCode : undefined,
      transactionId: glResult.transactionId,
    });
    return { transactionId: glResult.transactionId };
  } catch (error: unknown) {
    // User-facing rules (e.g. insufficient cash/bank) — do not wrap as [GL_ERROR]
    if (error instanceof BusinessRuleException) throw error;
    if (error instanceof ValidationError) throw error;
    if (error instanceof AppError) throw error;

    logger.error('Failed to record supplier payment to GL', { error, payment });
    // CRITICAL: GL failure MUST throw to prevent payments without AP adjustment.
    // Use [GL_ERROR] prefix so the error handler does not misclassify
    // nested 'not found' messages (e.g. missing account code) as HTTP 404.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[GL_ERROR] GL posting failed for supplier payment ${payment.paymentNumber}: ${detail}`);
  }
}

// =============================================================================
// STOCK ADJUSTMENT JOURNAL ENTRIES
// =============================================================================

export interface StockAdjustmentData {
  adjustmentId: string;
  adjustmentNumber: string;
  adjustmentDate: string;
  adjustmentType: 'INCREASE' | 'DECREASE' | 'WRITE_OFF' | 'RECOUNT';
  totalValue: number;
  reason: string;
}

/**
 * Record stock adjustment in the general ledger
 * 
 * For INCREASE (found stock):
 *   DR Inventory (1300)
 *   CR Stock Adjustment Income (other income)
 * 
 * For DECREASE/WRITE_OFF (lost/damaged):
 *   DR Stock Adjustment Expense
 *   CR Inventory (1300)
 */
export async function recordStockAdjustmentToGL(adjustment: StockAdjustmentData, pool?: pg.Pool): Promise<void> {
  // ADR-004 Phase 2D: legacy 6900/4200 path retired — use StockMovementHandler / LossDisposalService.
  if (process.env.ALLOW_LEGACY_STOCK_ADJUSTMENT_GL !== '1') {
    throw new Error(
      'Legacy recordStockAdjustmentToGL (6900 General Expense / 4200 Other Income) is retired (ADR-004 LQ-INV-7). ' +
        'Use StockMovementHandler (5110/5120/5130/4110) or LossDisposalService.disposeFromQuarantine. ' +
        'Set ALLOW_LEGACY_STOCK_ADJUSTMENT_GL=1 only for emergency remediation scripts.',
    );
  }

  try {
    let lines: JournalLine[];
    if (adjustment.adjustmentType === 'INCREASE') {
      lines = [
        {
          accountCode: AccountCodes.INVENTORY,
          description: `Stock increase: ${adjustment.reason}`,
          debitAmount: adjustment.totalValue,
          creditAmount: 0
        },
        {
          accountCode: AccountCodes.OTHER_INCOME,
          description: `Stock adjustment income: ${adjustment.adjustmentNumber}`,
          debitAmount: 0,
          creditAmount: adjustment.totalValue
        }
      ];
    } else {
      // DECREASE, WRITE_OFF, RECOUNT (reduction)
      lines = [
        {
          accountCode: AccountCodes.GENERAL_EXPENSE,
          description: `Stock ${adjustment.adjustmentType.toLowerCase()}: ${adjustment.reason}`,
          debitAmount: adjustment.totalValue,
          creditAmount: 0
        },
        {
          accountCode: AccountCodes.INVENTORY,
          description: `Inventory reduction: ${adjustment.adjustmentNumber}`,
          debitAmount: 0,
          creditAmount: adjustment.totalValue
        }
      ];
    }

    // Use AccountingCore for audit-safe, idempotent journal entry creation
    await AccountingCore.createJournalEntry({
      entryDate: adjustment.adjustmentDate,
      description: `Stock Adjustment: ${adjustment.adjustmentNumber} - ${adjustment.reason}`,
      referenceType: 'STOCK_ADJUSTMENT',
      referenceId: adjustment.adjustmentId,
      referenceNumber: adjustment.adjustmentNumber,
      lines,
      userId: SYSTEM_USER_ID,
      idempotencyKey: `STOCK_ADJUSTMENT-${adjustment.adjustmentId}`,
      source: 'INVENTORY_MOVE' as const,
    }, pool);

    logger.info('Recorded stock adjustment to GL', {
      adjustmentId: adjustment.adjustmentId,
      type: adjustment.adjustmentType,
      value: adjustment.totalValue
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record stock adjustment to GL', { error, adjustment });
    // CRITICAL: GL failure MUST throw to prevent inventory changes without GL entries
    throw new Error(`GL posting failed for stock adjustment ${adjustment.adjustmentNumber}: ${(error instanceof Error ? error.message : String(error))}`);
  }
}

// =============================================================================
// DELIVERY JOURNAL ENTRIES
// =============================================================================

export interface DeliveryChargeData {
  deliveryId: string;
  deliveryNumber: string;
  deliveryDate: string;
  customerId: string;
  deliveryFee: number;
}

export interface DeliveryCompletedData {
  deliveryId: string;
  deliveryNumber: string;
  completedAt: string;
  totalCost: number;
}

/**
 * Record delivery charge as revenue in the general ledger
 * 
 * When a delivery order is created with a fee, we recognise income:
 *   DR Accounts Receivable (1200) deliveryFee
 *   CR Delivery Revenue    (4500) deliveryFee
 */
export async function recordDeliveryChargeToGL(data: DeliveryChargeData, pool?: pg.Pool): Promise<void> {
  try {
    if (data.deliveryFee <= 0) {
      logger.debug('Skipping delivery charge GL posting (fee is zero)', { deliveryId: data.deliveryId });
      return;
    }

    await AccountingCore.createJournalEntry({
      entryDate: data.deliveryDate,
      description: `Delivery charge: ${data.deliveryNumber}`,
      referenceType: 'DELIVERY_CHARGE',
      referenceId: data.deliveryId,
      referenceNumber: data.deliveryNumber,
      lines: [
        {
          accountCode: AccountCodes.ACCOUNTS_RECEIVABLE,
          description: `A/R for delivery ${data.deliveryNumber}`,
          debitAmount: data.deliveryFee,
          creditAmount: 0,
          entityType: 'customer',
          entityId: data.customerId
        },
        {
          accountCode: AccountCodes.DELIVERY_REVENUE,
          description: `Delivery revenue: ${data.deliveryNumber}`,
          debitAmount: 0,
          creditAmount: data.deliveryFee
        }
      ],
      userId: SYSTEM_USER_ID,
      idempotencyKey: `DELIVERY_CHARGE-${data.deliveryId}`,
      source: 'SALES_INVOICE' as const,
    }, pool);

    logger.info('Recorded delivery charge to GL', {
      deliveryId: data.deliveryId,
      deliveryNumber: data.deliveryNumber,
      deliveryFee: data.deliveryFee
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record delivery charge to GL', { error, data });
    throw new Error(`GL posting failed for delivery charge ${data.deliveryNumber}: ${(error instanceof Error ? error.message : String(error))}`);
  }
}

/**
 * Record delivery completion costs in the general ledger
 * 
 * When a delivery is completed, we recognise the costs incurred:
 *   DR Delivery Expense (6750) totalCost
 *   CR Cash             (1010) totalCost
 */
export async function recordDeliveryCompletedToGL(data: DeliveryCompletedData, pool?: pg.Pool): Promise<void> {
  try {
    if (data.totalCost <= 0) {
      logger.debug('Skipping delivery cost GL posting (cost is zero)', { deliveryId: data.deliveryId });
      return;
    }

    const entryDate = data.completedAt.split('T')[0]; // DATE only from ISO timestamp

    await AccountingCore.createJournalEntry({
      entryDate,
      description: `Delivery costs: ${data.deliveryNumber}`,
      referenceType: 'DELIVERY_COST',
      referenceId: data.deliveryId,
      referenceNumber: data.deliveryNumber,
      lines: [
        {
          accountCode: AccountCodes.DELIVERY_EXPENSE,
          description: `Delivery expense: ${data.deliveryNumber}`,
          debitAmount: data.totalCost,
          creditAmount: 0
        },
        {
          accountCode: AccountCodes.CASH,
          description: `Cash paid for delivery ${data.deliveryNumber}`,
          debitAmount: 0,
          creditAmount: data.totalCost
        }
      ],
      userId: SYSTEM_USER_ID,
      idempotencyKey: `DELIVERY_COST-${data.deliveryId}`,
      source: 'SALES_INVOICE' as const,
    }, pool);

    logger.info('Recorded delivery cost to GL', {
      deliveryId: data.deliveryId,
      deliveryNumber: data.deliveryNumber,
      totalCost: data.totalCost
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record delivery cost to GL', { error, data });
    throw new Error(`GL posting failed for delivery cost ${data.deliveryNumber}: ${(error instanceof Error ? error.message : String(error))}`);
  }
}

// =============================================================================
// DELIVERY NOTE GOODS ISSUE JOURNAL ENTRIES (DR COGS / CR Inventory)
// =============================================================================

export interface DeliveryNoteGoodsIssueData {
  deliveryNoteId: string;
  deliveryNoteNumber: string;
  postingDate: string;
  totalCost: number;
}

/**
 * Record COGS at Post Goods Issue (PGI) for a delivery note.
 * DR COGS (5000) / CR Inventory (1300)
 *
 * SAP equivalent: Goods Issue posting updates both inventory and COGS
 * in the same period as the physical stock movement.
 */
export async function recordDeliveryNoteGoodsIssueToGL(
  data: DeliveryNoteGoodsIssueData,
  pool?: pg.Pool,
  txClient?: pg.PoolClient,
): Promise<void> {
  try {
    if (data.totalCost <= 0) {
      logger.debug('Skipping DN goods issue GL (zero cost)', {
        deliveryNoteNumber: data.deliveryNoteNumber,
      });
      return;
    }

    const lines: JournalLine[] = [
      {
        accountCode: AccountCodes.COGS,
        description: `COGS — DN ${data.deliveryNoteNumber} goods issue`,
        debitAmount: data.totalCost,
        creditAmount: 0,
      },
      {
        accountCode: AccountCodes.INVENTORY,
        description: `Inventory reduction — DN ${data.deliveryNoteNumber} goods issue`,
        debitAmount: 0,
        creditAmount: data.totalCost,
      },
    ];

    await AccountingCore.createJournalEntry({
      entryDate: data.postingDate,
      description: `Delivery Note ${data.deliveryNoteNumber} — Post Goods Issue (COGS)`,
      referenceType: 'DELIVERY_NOTE_PGI',
      referenceId: data.deliveryNoteId,
      referenceNumber: data.deliveryNoteNumber,
      lines,
      userId: SYSTEM_USER_ID,
      idempotencyKey: `DN_PGI_COGS-${data.deliveryNoteId}`,
      source: 'INVENTORY_MOVE' as const,
    }, pool, txClient);

    logger.info('Recorded DN goods issue COGS to GL', {
      deliveryNoteId: data.deliveryNoteId,
      deliveryNoteNumber: data.deliveryNoteNumber,
      totalCost: data.totalCost,
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record DN goods issue to GL', { error, data });
    throw new Error(`GL posting failed for DN PGI ${data.deliveryNoteNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// =============================================================================
// DELIVERY NOTE INVOICE JOURNAL ENTRIES (DR AR / CR Revenue)
// =============================================================================

export interface DeliveryNoteInvoiceData {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  totalAmount: number;
  deliveryNoteNumber: string;
  customerId: string;
  customerName: string;
}

/**
 * Record a delivery note invoice in the GL.
 * DR Accounts Receivable (1200) / CR Sales Revenue (4000)
 */
export async function recordDeliveryNoteInvoiceToGL(
  data: DeliveryNoteInvoiceData,
  pool?: pg.Pool,
  txClient?: pg.PoolClient,
): Promise<void> {
  try {
    if (data.totalAmount <= 0) {
      logger.debug('Skipping DN invoice GL posting (zero or negative amount)', {
        invoiceNumber: data.invoiceNumber,
      });
      return;
    }

    const lines: JournalLine[] = [
      {
        accountCode: AccountCodes.ACCOUNTS_RECEIVABLE,
        description: `AR: DN Invoice ${data.invoiceNumber} from ${data.deliveryNoteNumber}`,
        debitAmount: data.totalAmount,
        creditAmount: 0,
        entityType: 'customer',
        entityId: data.customerId,
      },
      {
        accountCode: AccountCodes.SALES_REVENUE,
        description: `Revenue: DN Invoice ${data.invoiceNumber} from ${data.deliveryNoteNumber}`,
        debitAmount: 0,
        creditAmount: data.totalAmount,
      },
    ];

    await AccountingCore.createJournalEntry({
      entryDate: data.invoiceDate,
      description: `DN Invoice ${data.invoiceNumber} from ${data.deliveryNoteNumber} — ${data.customerName}`,
      referenceType: 'DELIVERY_NOTE_INVOICE',
      referenceId: data.invoiceId,
      referenceNumber: data.invoiceNumber,
      lines,
      userId: SYSTEM_USER_ID,
      idempotencyKey: `DN_INVOICE-${data.invoiceId}`,
      source: 'SALES_INVOICE' as const,
    }, txClient ? undefined : pool, txClient);

    logger.info('Recorded DN invoice to GL', {
      invoiceId: data.invoiceId,
      invoiceNumber: data.invoiceNumber,
      totalAmount: data.totalAmount,
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record DN invoice to GL', { error, data });
    throw new Error(`GL posting failed for DN invoice ${data.invoiceNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// =============================================================================
// SALE VOID (REVERSAL) JOURNAL ENTRIES
// =============================================================================

export interface SaleVoidData {
  saleId: string;
  saleNumber: string;
  voidDate: string;
  voidReason: string;
}

/**
 * Reverse a completed sale's GL entries when the sale is voided.
 *
 * Uses AccountingCore.reverseTransaction() which creates an exact mirror entry
 * (swaps debits/credits) and marks the original as REVERSED.
 */
export async function recordSaleVoidToGL(data: SaleVoidData, pool?: pg.Pool, txClient?: pg.PoolClient): Promise<void> {
  try {
    // Find the original SALE transaction
    const queryTarget = txClient || pool || globalPool;
    const existing = await queryTarget.query(
      `SELECT "Id" FROM ledger_transactions
       WHERE "ReferenceType" = 'SALE' AND "ReferenceId" = $1
         AND "IsReversed" = FALSE
       LIMIT 1`,
      [data.saleId]
    );

    if (existing.rows.length === 0) {
      logger.error('No GL transaction found for voided sale — cannot reverse', {
        saleId: data.saleId,
        saleNumber: data.saleNumber,
      });
      throw new Error(`No GL transaction found for sale ${data.saleNumber} — cannot void without GL reversal`);
    }

    const originalTransactionId = existing.rows[0].Id;

    await AccountingCore.reverseTransaction({
      originalTransactionId,
      reversalDate: data.voidDate,
      reason: `VOID: Sale ${data.saleNumber} — ${data.voidReason}`,
      userId: SYSTEM_USER_ID,
      idempotencyKey: `SALE_VOID-${data.saleId}`,
    }, pool, txClient);

    logger.info('Recorded sale void reversal to GL', {
      saleId: data.saleId,
      saleNumber: data.saleNumber,
      originalTransactionId,
    });

    // Also reverse SALE_COGS transaction(s) — posted separately for COGS/Inventory entries
    const cogsTransactions = await queryTarget.query(
      `SELECT "Id" FROM ledger_transactions
       WHERE "ReferenceType" = 'SALE_COGS' AND "ReferenceId" = $1
         AND "IsReversed" = FALSE`,
      [data.saleId]
    );

    for (const row of cogsTransactions.rows) {
      await AccountingCore.reverseTransaction({
        originalTransactionId: row.Id,
        reversalDate: data.voidDate,
        reason: `VOID COGS: Sale ${data.saleNumber} — ${data.voidReason}`,
        userId: SYSTEM_USER_ID,
        idempotencyKey: `SALE_COGS_VOID-${data.saleId}`,
      }, pool, txClient);

      logger.info('Recorded sale COGS void reversal to GL', {
        saleId: data.saleId,
        saleNumber: data.saleNumber,
        cogsTransactionId: row.Id,
      });
    }
  } catch (error: unknown) {
    if (error instanceof AccountingError && error.code === 'ALREADY_REVERSED') {
      logger.info('Sale GL already reversed (idempotent)', { saleId: data.saleId });
      return;
    }
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record sale void to GL', { error, data });
    throw new Error(`GL reversal failed for voided sale ${data.saleNumber}: ${(error instanceof Error ? error.message : String(error))}`);
  }
}

// =============================================================================
// SALE REFUND (PARTIAL/FULL REVERSAL) JOURNAL ENTRIES
// =============================================================================

function buildRefundRevenueCreditLines(data: SaleRefundData): JournalLine[] {
  const total = data.totalAmount;
  if (total <= 0.009) return [];

  const isExchange = data.refundType === 'EXCHANGE';

  if (isExchange && data.paymentMethod !== 'CREDIT') {
    // Store credit / exchange hold (2210) — not customer cash advances (2200).
    // Tag customer when known; otherwise tag the exchange refund so walk-in liability is traceable.
    const entity =
      data.customerId
        ? { entityType: 'customer' as const, entityId: data.customerId }
        : { entityType: 'exchange_refund' as const, entityId: data.refundId };
    return [
      {
        accountCode: AccountCodes.STORE_CREDIT,
        debitAmount: 0,
        creditAmount: total,
        description: `Exchange ${data.refundNumber}: store credit for ${data.saleNumber}`,
        ...entity,
      },
    ];
  }

  if (data.paymentMethod === 'CREDIT') {
    const arCredit = data.arCreditAmount ?? total;
    if (arCredit < -0.001 || arCredit > total + 0.01) {
      throw new BusinessRuleException(
        `Refund AR credit (${arCredit}) cannot exceed refund total (${total})`,
        'AR_REFUND_CREDIT_EXCEEDS_TOTAL',
        { refundNumber: data.refundNumber, arCredit, total },
      );
    }
    const cashCredit = total - arCredit;
    const lines: JournalLine[] = [];
    if (arCredit > 0.009) {
      const customerId = requireCustomerIdForAr(data.customerId, `refund ${data.refundNumber}`);
      lines.push(
        customerArLine({
          customerId,
          creditAmount: arCredit,
          description: `Refund ${data.refundNumber}: credit refund for ${data.saleNumber}`,
        }),
      );
    }
    if (cashCredit > 0.009) {
      lines.push({
        accountCode: AccountCodes.CASH,
        debitAmount: 0,
        creditAmount: cashCredit,
        description: `Refund ${data.refundNumber}: cash portion for ${data.saleNumber}`,
      });
    }
    return lines;
  }

  let creditAccountCode: string;
  switch (data.paymentMethod) {
    case 'CARD':
      creditAccountCode = AccountCodes.CREDIT_CARD_RECEIPTS;
      break;
    case 'MOBILE_MONEY':
    case 'AIRTEL_MONEY':
      creditAccountCode = AccountCodes.MOBILE_MONEY;
      break;
    case 'DEPOSIT':
      creditAccountCode = AccountCodes.CUSTOMER_DEPOSITS;
      break;
    default:
      creditAccountCode = AccountCodes.CASH;
  }

  return [
    {
      accountCode: creditAccountCode,
      debitAmount: 0,
      creditAmount: total,
      description: `Refund ${data.refundNumber}: ${data.paymentMethod} refund for ${data.saleNumber}`,
      ...(creditAccountCode === AccountCodes.CUSTOMER_DEPOSITS && data.customerId
        ? { entityType: 'customer' as const, entityId: data.customerId }
        : {}),
    },
  ];
}

export interface SaleRefundData {
  refundId: string;
  refundNumber: string;
  saleId: string;
  saleNumber: string;
  refundDate: string;
  reason: string;
  totalAmount: number;  // Revenue to reverse
  totalCost: number;    // COGS to reverse
  paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'AIRTEL_MONEY' | 'CREDIT' | 'DEPOSIT';
  customerId?: string;
  /** AR credit portion for CREDIT-method refunds (capped to open-item reduction). Defaults to totalAmount. */
  arCreditAmount?: number;
  /** REFUND = cash/AR repayment; EXCHANGE = store credit (2200) for POS replacement */
  refundType?: 'REFUND' | 'EXCHANGE';
}

/**
 * Record a sale refund in the general ledger.
 *
 * For a FULL refund this uses AccountingCore.reverseTransaction() (same as void).
 * For a PARTIAL refund we create a new journal entry with proportional amounts:
 *   DR Sales Returns (4010)       refundAmount  (reverse revenue — aligned with credit notes)
 *   CR Cash / AR / Store Credit   refundAmount  (pay back customer or hold for exchange)
 *   DR Inventory (1300)          costAmount    (restore inventory asset)
 *   CR COGS (5000)               costAmount    (reverse cost of goods)
 *
 * @returns The GL transaction ID if created, undefined if no GL entry was needed
 */
export async function recordSaleRefundToGL(
  data: SaleRefundData,
  pool?: pg.Pool,
  txClient?: pg.PoolClient,
): Promise<string | undefined> {
  try {
    const {
      SALE_REFUND_GL_REFERENCE,
      assertSaleRefundGlReferenceTypesDistinct,
    } = await import('@shared/accounting/saleRefundGlReference.js');
    assertSaleRefundGlReferenceTypesDistinct();

    const queryTarget = txClient || pool || globalPool;

    if (data.refundType === 'EXCHANGE') {
      const { ensureStoreCreditAccount } = await import('../modules/sales/ensureStoreCreditAccount.js');
      if (txClient) {
        await ensureStoreCreditAccount(txClient);
      } else {
        const client = await (pool || globalPool).connect();
        try {
          await ensureStoreCreditAccount(client);
        } finally {
          client.release();
        }
      }
    }

    // Find ALL non-reversed SALE transactions for this sale
    const existing = await queryTarget.query(
      `SELECT "Id" FROM ledger_transactions
       WHERE "ReferenceType" = 'SALE' AND "ReferenceId" = $1
         AND "IsReversed" = FALSE
       LIMIT 1`,
      [data.saleId]
    );

    if (existing.rows.length === 0) {
      logger.warn('No GL transaction found for refunded sale — creating standalone refund entry', {
        saleId: data.saleId,
        saleNumber: data.saleNumber,
        refundNumber: data.refundNumber,
      });
      // Fall through to create a standalone refund entry below
    }

    // Determine credit lines (where economic value goes back to customer)
    const revenueEntries: JournalLine[] = [];
    const inventoryEntries: JournalLine[] = [];

    // 1. DR Sales Returns — reverse revenue (4010, same account as customer credit notes)
    if (data.totalAmount > 0) {
      revenueEntries.push({
        accountCode: AccountCodes.SALES_RETURNS,
        debitAmount: data.totalAmount,
        creditAmount: 0,
        description: `${data.refundType === 'EXCHANGE' ? 'Exchange' : 'Refund'} ${data.refundNumber}: Sales return for ${data.saleNumber}`,
      });

      revenueEntries.push(...buildRefundRevenueCreditLines(data));
    }

    // 3. DR Inventory — restore inventory asset
    if (data.totalCost > 0) {
      inventoryEntries.push({
        accountCode: AccountCodes.INVENTORY, // 1300
        debitAmount: data.totalCost,
        creditAmount: 0,
        description: `Refund ${data.refundNumber}: Inventory restored for ${data.saleNumber}`,
      });

      // 4. CR COGS — reverse cost of goods sold
      inventoryEntries.push({
        accountCode: AccountCodes.COGS, // 5000
        debitAmount: 0,
        creditAmount: data.totalCost,
        description: `Refund ${data.refundNumber}: COGS reversal for ${data.saleNumber}`,
      });
    }

    if (revenueEntries.length === 0 && inventoryEntries.length === 0) {
      logger.warn('No GL entries to create for refund (zero amounts)', {
        refundId: data.refundId,
        refundNumber: data.refundNumber,
      });
      return undefined;
    }

    // Post revenue-reversal journal (source: SALES_INVOICE) if applicable.
    let primaryTransactionId: string | undefined;
    if (revenueEntries.length > 0) {
      const journalResult = await AccountingCore.createJournalEntry({
        entryDate: data.refundDate,
        description: `REFUND: ${data.refundNumber} for Sale ${data.saleNumber} — ${data.reason}`,
        referenceType: SALE_REFUND_GL_REFERENCE.revenue,
        referenceId: data.refundId,
        referenceNumber: data.refundNumber,
        lines: revenueEntries,
        userId: SYSTEM_USER_ID,
        idempotencyKey: `SALE_REFUND-${data.refundId}`,
        source: 'SALES_REFUND' as const,
      }, pool, txClient);
      primaryTransactionId = journalResult.transactionId;
    }

    // Post inventory-restoration journal (source: INVENTORY_MOVE) if applicable.
    // referenceType MUST be SALE_REFUND_COGS (not SALE_REFUND): uq_ledger_transactions_reference
    // is UNIQUE(ReferenceType, ReferenceId). Same pattern as SALE + SALE_COGS on the original sale.
    // Bliss REF-2026-0005 failed with ERR_CONSTRAINT when both revenue + inventory used SALE_REFUND.
    if (inventoryEntries.length > 0) {
      const inventoryResult = await AccountingCore.createJournalEntry({
        entryDate: data.refundDate,
        description: `REFUND goods return: ${data.refundNumber} for Sale ${data.saleNumber}`,
        referenceType: SALE_REFUND_GL_REFERENCE.inventory,
        referenceId: data.refundId,
        referenceNumber: data.refundNumber,
        lines: inventoryEntries,
        userId: SYSTEM_USER_ID,
        idempotencyKey: `SALE_REFUND-INV-${data.refundId}`,
        source: 'INVENTORY_MOVE' as const,
      }, pool, txClient);
      if (!primaryTransactionId) {
        primaryTransactionId = inventoryResult.transactionId;
      }
    }

    const journalResult = { transactionId: primaryTransactionId ?? '' };

    logger.info('Recorded sale refund to GL', {
      refundId: data.refundId,
      refundNumber: data.refundNumber,
      saleId: data.saleId,
      saleNumber: data.saleNumber,
      transactionId: journalResult.transactionId,
      totalAmount: data.totalAmount,
      totalCost: data.totalCost,
    });

    return journalResult.transactionId;
  } catch (error: unknown) {
    if (error instanceof AccountingError && error.code === 'IDEMPOTENCY_CONFLICT') {
      logger.info('Sale refund GL already posted (idempotent)', { refundId: data.refundId });
      return undefined;
    }
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record sale refund to GL', { error, data });
    throw new Error(
      `GL posting failed for refund ${data.refundNumber}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export interface ExchangeCreditApplicationData {
  refundId: string;
  refundNumber: string;
  saleId: string;
  saleNumber: string;
  applicationDate: string;
  amount: number;
  customerId?: string;
}

/**
 * Clear store-credit liability (2210) when exchange credit is applied on a replacement POS sale.
 * Pairs with the EXCHANGE refund journal that credited 2210.
 *
 * DR  Store Credit (2210)
 * CR  Sales Revenue (4000)
 */
export async function recordExchangeCreditApplicationToGL(
  data: ExchangeCreditApplicationData,
  pool?: pg.Pool,
  txClient?: pg.PoolClient,
): Promise<void> {
  if (data.amount <= 0) return;

  const { ensureStoreCreditAccount } = await import('../modules/sales/ensureStoreCreditAccount.js');
  if (txClient) {
    await ensureStoreCreditAccount(txClient);
  } else if (pool) {
    const client = await pool.connect();
    try {
      await ensureStoreCreditAccount(client);
    } finally {
      client.release();
    }
  }

  const entity =
    data.customerId
      ? { entityType: 'customer' as const, entityId: data.customerId }
      : { entityType: 'exchange_refund' as const, entityId: data.refundId };

  await AccountingCore.createJournalEntry({
    entryDate: data.applicationDate,
    description: `Exchange credit applied: ${data.refundNumber} → sale ${data.saleNumber}`,
    referenceType: 'EXCHANGE_CREDIT',
    referenceId: data.saleId,
    referenceNumber: data.saleNumber,
    lines: [
      {
        accountCode: AccountCodes.STORE_CREDIT,
        debitAmount: data.amount,
        creditAmount: 0,
        description: `Clear store credit from exchange ${data.refundNumber}`,
        ...entity,
      },
      {
        accountCode: AccountCodes.SALES_REVENUE,
        debitAmount: 0,
        creditAmount: data.amount,
        description: `Exchange credit applied on ${data.saleNumber}`,
      },
    ],
    userId: SYSTEM_USER_ID,
    idempotencyKey: `EXCHANGE_CREDIT-${data.refundId}-${data.saleId}`,
    source: 'SALES_REFUND' as const,
  }, pool, txClient);
}

export interface ExchangeResidualPayoutData {
  refundId: string;
  refundNumber: string;
  payoutDate: string;
  amount: number;
  /** Original sale tender — where residual cash leaves the books */
  paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'AIRTEL_MONEY' | 'CREDIT' | 'DEPOSIT';
  customerId?: string;
}

/**
 * Pay out unused exchange store credit (cheaper replacement or abandoned swap).
 *
 * DR  Store Credit (2210)     amount
 * CR  Cash / Card / Mobile    amount  (same economic tender family as original sale)
 */
export async function recordExchangeResidualPayoutToGL(
  data: ExchangeResidualPayoutData,
  pool?: pg.Pool,
  txClient?: pg.PoolClient,
): Promise<void> {
  if (data.amount <= 0.009) return;

  const { ensureStoreCreditAccount } = await import('../modules/sales/ensureStoreCreditAccount.js');
  if (txClient) {
    await ensureStoreCreditAccount(txClient);
  } else if (pool) {
    const client = await pool.connect();
    try {
      await ensureStoreCreditAccount(client);
    } finally {
      client.release();
    }
  }

  let creditAccountCode: string;
  switch (data.paymentMethod) {
    case 'CARD':
      creditAccountCode = AccountCodes.CREDIT_CARD_RECEIPTS;
      break;
    case 'MOBILE_MONEY':
    case 'AIRTEL_MONEY':
      creditAccountCode = AccountCodes.MOBILE_MONEY;
      break;
    case 'CREDIT':
    case 'DEPOSIT':
    case 'CASH':
    default:
      creditAccountCode = AccountCodes.CASH;
      break;
  }

  const entity =
    data.customerId
      ? { entityType: 'customer' as const, entityId: data.customerId }
      : { entityType: 'exchange_refund' as const, entityId: data.refundId };

  await AccountingCore.createJournalEntry({
    entryDate: data.payoutDate,
    description: `Exchange residual payout: ${data.refundNumber}`,
    referenceType: 'EXCHANGE_RESIDUAL',
    referenceId: data.refundId,
    referenceNumber: data.refundNumber,
    lines: [
      {
        accountCode: AccountCodes.STORE_CREDIT,
        debitAmount: data.amount,
        creditAmount: 0,
        description: `Clear unused store credit ${data.refundNumber}`,
        ...entity,
      },
      {
        accountCode: creditAccountCode,
        debitAmount: 0,
        creditAmount: data.amount,
        description: `Payout residual for ${data.refundNumber} via ${data.paymentMethod}`,
      },
    ],
    userId: SYSTEM_USER_ID,
    idempotencyKey: `EXCHANGE_RESIDUAL-${data.refundId}`,
    source: 'SALES_REFUND' as const,
  }, pool, txClient);
}

// =============================================================================
// CUSTOMER DEPOSIT JOURNAL ENTRIES
// =============================================================================

export interface CustomerDepositData {
  depositId: string;
  depositNumber: string;
  depositDate: string;
  amount: number;
  paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'AIRTEL_MONEY' | 'BANK_TRANSFER';
  customerId: string;
  customerName: string;
}

/**
 * Record a customer deposit in the general ledger (clearing step 1).
 *
 * Journal entry — PAYMENT_RECEIPT (same cash hygiene as AR receipts):
 *   DR Undeposited Funds (1015)    amount
 *   CR Customer Deposits (2200)    amount   (liability until applied to sale)
 *
 * Bank/cash recognition is step 2 — PAYMENT_DEPOSIT (separate process).
 * paymentMethod is retained for operational reporting; it does not select the GL debit.
 */
export async function recordCustomerDepositToGL(deposit: CustomerDepositData, pool?: pg.Pool, txClient?: pg.PoolClient): Promise<void> {
  try {
    await AccountingCore.createJournalEntry({
      entryDate: deposit.depositDate,
      description: `Customer Deposit: ${deposit.customerName} — ${deposit.depositNumber}`,
      referenceType: 'CUSTOMER_DEPOSIT',
      referenceId: deposit.depositId,
      referenceNumber: deposit.depositNumber,
      lines: [
        {
          accountCode: AccountCodes.UNDEPOSITED_FUNDS,
          description: `Deposit received — ${deposit.depositNumber}`,
          debitAmount: deposit.amount,
          creditAmount: 0,
          entityType: 'customer',
          entityId: deposit.customerId,
        },
        {
          accountCode: AccountCodes.CUSTOMER_DEPOSITS,
          description: `Customer deposit liability — ${deposit.depositNumber}`,
          debitAmount: 0,
          creditAmount: deposit.amount,
          entityType: 'customer',
          entityId: deposit.customerId,
        },
      ],
      userId: SYSTEM_USER_ID,
      idempotencyKey: `CUSTOMER_DEPOSIT-${deposit.depositId}`,
      source: 'PAYMENT_RECEIPT' as const,
    }, pool, txClient);

    logger.info('Recorded customer deposit to GL', {
      depositId: deposit.depositId,
      amount: deposit.amount,
      customerId: deposit.customerId,
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record customer deposit to GL', { error, deposit });
    throw new Error(`GL posting failed for customer deposit ${deposit.depositNumber}: ${(error instanceof Error ? error.message : String(error))}`);
  }
}

// =============================================================================
// DEPOSIT APPLICATION JOURNAL ENTRIES (POS Sale → Deposit Clearing)
// =============================================================================

export interface DepositApplicationGLData {
  applicationId: string;
  depositId: string;
  depositNumber: string;
  saleId: string;
  saleNumber: string;
  applicationDate: string;
  amount: number;
  customerId: string;
  customerName: string;
}

/**
 * Record a deposit application to the general ledger.
 * Called when a customer deposit is applied to a POS sale.
 *
 * Journal entry (source DEPOSIT_APPLICATION — never PAYMENT_RECEIPT):
 *   DR Customer Deposits (2200)    amount   — reduce liability (deposit consumed)
 *   CR Accounts Receivable (1200)  amount   — clear the AR created by recordSaleToGL
 *
 * Cash already hit Undeposited Funds when the deposit was taken.
 * Applying is liability↔AR only; Rule E receipt structure does not apply.
 *
 * Net effect: the DEPOSIT sale's AR debit is fully offset by this credit.
 */
export async function recordDepositApplicationToGL(
  data: DepositApplicationGLData,
  pool?: pg.Pool,
  txClient?: pg.PoolClient,
): Promise<void> {
  try {
    const depositLabel = data.depositNumber || `DEPOSIT-${data.depositId.slice(0, 8)}`;
    const referenceNumber = data.depositNumber
      ? `${data.depositNumber}->${data.saleNumber}`
      : `DEP-APP-${data.applicationId.slice(0, 8)}`;

    await AccountingCore.createJournalEntry({
      entryDate: data.applicationDate,
      description: `Deposit Application: ${depositLabel} applied to ${data.saleNumber} (${data.customerName})`,
      referenceType: 'DEPOSIT_APPLICATION',
      referenceId: data.applicationId,
      referenceNumber,
      lines: [
        {
          accountCode: AccountCodes.CUSTOMER_DEPOSITS,
          description: `Deposit liability cleared — ${depositLabel} applied to ${data.saleNumber}`,
          debitAmount: data.amount,
          creditAmount: 0,
          entityType: 'customer',
          entityId: data.customerId,
        },
        {
          accountCode: AccountCodes.ACCOUNTS_RECEIVABLE,
          description: `AR cleared via deposit — ${data.saleNumber}`,
          debitAmount: 0,
          creditAmount: data.amount,
          entityType: 'customer',
          entityId: data.customerId,
        },
      ],
      userId: SYSTEM_USER_ID,
      idempotencyKey: `DEPOSIT_APPLICATION-${data.applicationId}`,
      source: 'DEPOSIT_APPLICATION' as const,
    }, pool, txClient);

    logger.info('Recorded deposit application to GL', {
      applicationId: data.applicationId,
      depositNumber: depositLabel,
      saleNumber: data.saleNumber,
      amount: data.amount,
      customerId: data.customerId,
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record deposit application to GL', { error, data });
    throw new Error(
      `GL posting failed for deposit application ${data.depositNumber || data.depositId} → ${data.saleNumber}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// =============================================================================
// CUSTOMER INVOICE JOURNAL ENTRIES
// =============================================================================

export interface CustomerInvoiceData {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  totalAmount: number;
  customerId: string;
  customerName: string;
}

/**
 * Record a customer invoice in the general ledger
 *
 * Journal entry (when invoice is issued / transitions from Draft):
 *   DR Accounts Receivable (1200) totalAmount
 *   CR Sales Revenue (4000)       totalAmount
 */
export async function recordCustomerInvoiceToGL(invoice: CustomerInvoiceData, pool?: pg.Pool, txClient?: pg.PoolClient): Promise<void> {
  try {
    await AccountingCore.createJournalEntry({
      entryDate: invoice.invoiceDate,
      description: `Customer Invoice: ${invoice.invoiceNumber}`,
      referenceType: 'INVOICE',
      referenceId: invoice.invoiceId,
      referenceNumber: invoice.invoiceNumber,
      lines: [
        {
          accountCode: AccountCodes.ACCOUNTS_RECEIVABLE,
          description: `Invoice ${invoice.invoiceNumber} — ${invoice.customerName}`,
          debitAmount: invoice.totalAmount,
          creditAmount: 0,
          entityType: 'customer',
          entityId: invoice.customerId,
        },
        {
          accountCode: AccountCodes.SALES_REVENUE,
          description: `Revenue — Invoice ${invoice.invoiceNumber}`,
          debitAmount: 0,
          creditAmount: invoice.totalAmount,
          entityType: 'customer',
          entityId: invoice.customerId,
        },
      ],
      userId: SYSTEM_USER_ID,
      idempotencyKey: `INVOICE-${invoice.invoiceId}`,
      source: 'SALES_INVOICE' as const,
    }, txClient ? undefined : pool, txClient);

    logger.info('Recorded customer invoice to GL', {
      invoiceId: invoice.invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      totalAmount: invoice.totalAmount,
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record customer invoice to GL', { error, invoice });
    throw new Error(`GL posting failed for invoice ${invoice.invoiceNumber}: ${(error instanceof Error ? error.message : String(error))}`);
  }
}

// =============================================================================
// INVOICE PAYMENT JOURNAL ENTRIES
// =============================================================================

export interface InvoicePaymentData {
  paymentId: string;
  receiptNumber: string;
  paymentDate: string;
  amount: number;
  paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'AIRTEL_MONEY' | 'BANK_TRANSFER' | 'CREDIT' | 'DEPOSIT';
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName?: string;
}

/**
 * Record an invoice payment in the general ledger
 *
 * Journal entry (two-step clearing flow):
 *   Step 1 — PAYMENT_RECEIPT (this function):
 *     DR Undeposited Funds (1015)    amount
 *     CR Accounts Receivable (1200)  amount
 *
 *   Step 2 — PAYMENT_DEPOSIT (separate process):
 *     DR Cash / Bank (payment-method-specific)  amount
 *     CR Undeposited Funds (1015)               amount
 *
 * DEPOSIT payments are skipped (already posted via deposit lifecycle).
 */
export async function recordInvoicePaymentToGL(payment: InvoicePaymentData, pool?: pg.Pool, txClient?: pg.PoolClient): Promise<void> {
  try {
    // Deposit payments: money already received via deposit, no clearing needed
    if (payment.paymentMethod === 'DEPOSIT') {
      logger.info('Invoice payment via DEPOSIT — skipping GL (deposit already posted)', {
        receiptNumber: payment.receiptNumber,
      });
      return;
    }

    const customerId = requireCustomerIdForAr(
      payment.customerId,
      `invoice payment ${payment.receiptNumber}`,
    );

    await AccountingCore.createJournalEntry({
      entryDate: payment.paymentDate,
      description: `Invoice Payment: ${payment.receiptNumber} for ${payment.invoiceNumber}`,
      referenceType: 'INVOICE_PAYMENT',
      referenceId: payment.paymentId,
      referenceNumber: payment.receiptNumber,
      lines: [
        {
          accountCode: AccountCodes.UNDEPOSITED_FUNDS,
          description: `Payment received — ${payment.receiptNumber}`,
          debitAmount: payment.amount,
          creditAmount: 0,
          entityType: 'customer',
          entityId: customerId,
        },
        customerArLine({
          customerId,
          creditAmount: payment.amount,
          description: `AR reduced — ${payment.receiptNumber}`,
        }),
      ],
      userId: SYSTEM_USER_ID,
      idempotencyKey: `INVOICE_PAYMENT-${payment.paymentId}`,
      source: 'PAYMENT_RECEIPT' as const,
    }, pool, txClient);

    logger.info('Recorded invoice payment to GL', {
      paymentId: payment.paymentId,
      receiptNumber: payment.receiptNumber,
      amount: payment.amount,
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record invoice payment to GL', { error, payment });
    throw new Error(`GL posting failed for invoice payment ${payment.receiptNumber}: ${(error instanceof Error ? error.message : String(error))}`);
  }
}

// =============================================================================
// STOCK MOVEMENT JOURNAL ENTRIES (ADJUSTMENTS, DAMAGE, EXPIRY)
// =============================================================================

export interface StockMovementData {
  movementId: string;
  movementNumber: string;
  movementDate: string;
  movementType: 'ADJUSTMENT_IN' | 'ADJUSTMENT_OUT' | 'DAMAGE' | 'EXPIRY';
  movementValue: number;     // quantity * unit_cost
  productName?: string;
  /** ADR-004 LQ-INV-7: explicit expense account (5110/5120/5130) */
  expenseAccountCode?: string;
}

/**
 * Record a manual stock movement in the general ledger.
 * Only called for ADJUSTMENT_IN/OUT, DAMAGE, EXPIRY — NOT for SALE or GOODS_RECEIPT
 * (those have their own posting functions).
 *
 * ADJUSTMENT_OUT / DAMAGE / EXPIRY (loss):
 *   DR Shrinkage/Damage/Expiry (5110/5120/5130)  value
 *   CR Inventory (1300)                           value
 *
 * ADJUSTMENT_IN (found stock):
 *   DR Inventory (1300)                           value
 *   CR Stock Overage Income (4110)                value
 */
export async function recordStockMovementToGL(movement: StockMovementData, pool?: pg.Pool, txClient?: pg.PoolClient): Promise<void> {
  try {
    if (movement.movementValue <= 0) {
      logger.debug('Skipping stock movement GL posting (zero value)', {
        movementNumber: movement.movementNumber,
      });
      return;
    }

    const description = `Stock ${movement.movementType}: ${movement.productName ?? 'Unknown'} — ${movement.movementNumber}`;
    let lines: JournalLine[];

    if (movement.movementType === 'ADJUSTMENT_IN') {
      lines = [
        {
          accountCode: AccountCodes.INVENTORY,
          description: `Inventory increase: ${movement.movementNumber}`,
          debitAmount: movement.movementValue,
          creditAmount: 0,
        },
        {
          accountCode: AccountCodes.STOCK_OVERAGE_INCOME,
          description: `Stock overage: ${movement.movementNumber}`,
          debitAmount: 0,
          creditAmount: movement.movementValue,
        },
      ];
    } else {
      // ADJUSTMENT_OUT, DAMAGE, EXPIRY — loss entries
      let expenseAccountCode: string;
      if (
        movement.expenseAccountCode === AccountCodes.DAMAGE ||
        movement.expenseAccountCode === AccountCodes.EXPIRY ||
        movement.expenseAccountCode === AccountCodes.SHRINKAGE
      ) {
        expenseAccountCode = movement.expenseAccountCode;
      } else {
        switch (movement.movementType) {
          case 'DAMAGE':
            expenseAccountCode = AccountCodes.DAMAGE;
            break;
          case 'EXPIRY':
            expenseAccountCode = AccountCodes.EXPIRY;
            break;
          default:
            expenseAccountCode = AccountCodes.SHRINKAGE;
        }
      }

      lines = [
        {
          accountCode: expenseAccountCode,
          description,
          debitAmount: movement.movementValue,
          creditAmount: 0,
        },
        {
          accountCode: AccountCodes.INVENTORY,
          description: `Inventory reduction: ${movement.movementNumber}`,
          debitAmount: 0,
          creditAmount: movement.movementValue,
        },
      ];
    }

    await AccountingCore.createJournalEntry({
      entryDate: movement.movementDate,
      description,
      referenceType: 'STOCK_MOVEMENT',
      referenceId: movement.movementId,
      referenceNumber: movement.movementNumber,
      lines,
      userId: SYSTEM_USER_ID,
      idempotencyKey: `STOCK_MOVEMENT-${movement.movementId}`,
      source: 'INVENTORY_MOVE' as const,
    }, pool, txClient);

    logger.info('Recorded stock movement to GL', {
      movementId: movement.movementId,
      type: movement.movementType,
      value: movement.movementValue,
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record stock movement to GL', { error, movement });
    throw new Error(`GL posting failed for stock movement ${movement.movementNumber}: ${(error instanceof Error ? error.message : String(error))}`);
  }
}

// =============================================================================
// OPENING STOCK / BULK IMPORT JOURNAL ENTRIES
// =============================================================================

export interface OpeningStockImportSummaryData {
  grId: string;
  grNumber: string;
  importDate: string;
  /** Total DR Inventory (1300) — must equal batch subledger increase. */
  totalValue: number;
}

/**
 * Single FI document for bulk opening stock import (SAP/Odoo: one material + one accounting doc).
 * Posts inside the same LUW as batch creation when txClient is provided.
 */
export async function recordOpeningStockImportSummaryToGL(
  data: OpeningStockImportSummaryData,
  pool?: pg.Pool,
  txClient?: pg.PoolClient,
): Promise<void> {
  if (data.totalValue === 0) return;

  const absValue = Math.abs(data.totalValue);
  const isReversal = data.totalValue < 0;

  const lines: JournalLine[] = isReversal
    ? [
        {
          accountCode: AccountCodes.OPENING_BALANCE_EQUITY,
          description: `Opening stock import reversal: ${data.grNumber}`,
          debitAmount: absValue,
          creditAmount: 0,
        },
        {
          accountCode: AccountCodes.INVENTORY,
          description: `Inventory decrease (opening import): ${data.grNumber}`,
          debitAmount: 0,
          creditAmount: absValue,
        },
      ]
    : [
        {
          accountCode: AccountCodes.INVENTORY,
          description: `Inventory increase (opening import): ${data.grNumber}`,
          debitAmount: absValue,
          creditAmount: 0,
        },
        {
          accountCode: AccountCodes.OPENING_BALANCE_EQUITY,
          description: `Opening balance equity: ${data.grNumber}`,
          debitAmount: 0,
          creditAmount: absValue,
        },
      ];

  await AccountingCore.createJournalEntry({
    entryDate: data.importDate,
    description: `Opening stock import ${data.grNumber}`,
    referenceType: 'OPENING_STOCK',
    referenceId: data.grId,
    referenceNumber: data.grNumber,
    lines,
    userId: SYSTEM_USER_ID,
    idempotencyKey: `OPENING_STOCK_IMPORT-${data.grId}`,
    source: 'OPENING_BALANCE_WIZARD' as const,
  }, pool, txClient);
}

export interface OpeningStockData {
  movementId: string;
  movementNumber: string;
  movementDate: string;
  movementValue: number;     // quantity * unit_cost
  productId: string;         // for idempotency key (product-scoped, not movement-scoped)
  batchNumber: string;       // for idempotency key (product+batch = stable key across re-imports)
  productName?: string;
}

/**
 * Record opening stock (from bulk CSV import) in the general ledger.
 *
 * Per SAP/Odoo/Tally/QuickBooks best practices, opening stock credits EQUITY
 * (not revenue). This prevents imported quantities from inflating P&L.
 *
 *   DR Inventory (1300)              value
 *   CR Opening Balance Equity (3050) value
 *
 * This function is ONLY for bulk imports / opening balance stock.
 * For found-stock adjustments (physical count surplus), use recordStockMovementToGL
 * which correctly credits Stock Overage Income (4110).
 */
export async function recordOpeningStockToGL(data: OpeningStockData, pool?: pg.Pool): Promise<void> {
  try {
    if (data.movementValue === 0) {
      logger.debug('Skipping opening stock GL posting (zero value)', {
        movementNumber: data.movementNumber,
      });
      return;
    }

    const absValue = Math.abs(data.movementValue);
    const isReversal = data.movementValue < 0;

    const description = isReversal
      ? `Opening stock reversal: ${data.productName ?? 'Unknown'} — ${data.movementNumber}`
      : `Opening stock import: ${data.productName ?? 'Unknown'} — ${data.movementNumber}`;

    // Positive value: DR Inventory / CR Opening Balance Equity (stock increase)
    // Negative value: DR Opening Balance Equity / CR Inventory (stock decrease/revaluation)
    const lines: JournalLine[] = isReversal
      ? [
        {
          accountCode: AccountCodes.OPENING_BALANCE_EQUITY,
          description: `Opening balance equity reversal: ${data.movementNumber}`,
          debitAmount: absValue,
          creditAmount: 0,
        },
        {
          accountCode: AccountCodes.INVENTORY,
          description: `Inventory decrease (import correction): ${data.movementNumber}`,
          debitAmount: 0,
          creditAmount: absValue,
        },
      ]
      : [
        {
          accountCode: AccountCodes.INVENTORY,
          description: `Inventory increase (import): ${data.movementNumber}`,
          debitAmount: absValue,
          creditAmount: 0,
        },
        {
          accountCode: AccountCodes.OPENING_BALANCE_EQUITY,
          description: `Opening balance equity: ${data.movementNumber}`,
          debitAmount: 0,
          creditAmount: absValue,
        },
      ];

    await AccountingCore.createJournalEntry({
      entryDate: data.movementDate,
      description,
      referenceType: 'OPENING_STOCK',
      referenceId: data.movementId,
      referenceNumber: data.movementNumber,
      lines,
      userId: SYSTEM_USER_ID,
      idempotencyKey: `OPENING_STOCK-${data.productId}-${data.batchNumber}`,
      source: 'OPENING_BALANCE_WIZARD' as const,
    }, pool);

    logger.info('Recorded opening stock to GL', {
      movementId: data.movementId,
      value: data.movementValue,
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record opening stock to GL', { error, data });
    throw new Error(`GL posting failed for opening stock ${data.movementNumber}: ${(error instanceof Error ? error.message : String(error))}`);
  }
}

// =============================================================================
// EXPENSE APPROVAL JOURNAL ENTRIES (UNPAID EXPENSE → AP)
// =============================================================================

export interface ExpenseApprovalData {
  expenseId: string;
  expenseNumber: string;
  expenseDate: string;
  amount: number;
  categoryCode: string;   // Fallback map when expenseAccountCode omitted
  description: string;
  isPaidAtApproval: boolean;
  paymentAccountId?: string;
  /** Prefer DB-resolved CoA code from expense_categories.account_id */
  expenseAccountCode?: string;
}

/**
 * Record expense approval in the general ledger.
 *
 * If paid at approval time:
 *   DR Expense (6xxx)  amount
 *   CR Cash (1010)     amount
 *
 * If unpaid at approval time:
 *   DR Expense (6xxx)       amount
 *   CR Accounts Payable (2100) amount
 */
export async function recordExpenseApprovalToGL(expense: ExpenseApprovalData, pool?: pg.Pool, txClient?: pg.PoolClient): Promise<void> {
  try {
    const expenseAccountCode =
      expense.expenseAccountCode || mapExpenseCategoryToAccount(expense.categoryCode);
    const creditAccountCode = expense.isPaidAtApproval
      ? AccountCodes.CASH
      : AccountCodes.ACCOUNTS_PAYABLE;

    await AccountingCore.createJournalEntry({
      entryDate: expense.expenseDate,
      description: `Expense: ${expense.description || expense.expenseNumber}`,
      referenceType: 'EXPENSE',
      referenceId: expense.expenseId,
      referenceNumber: expense.expenseNumber,
      lines: [
        {
          accountCode: expenseAccountCode,
          description: `Expense: ${expense.description || expense.expenseNumber}`,
          debitAmount: expense.amount,
          creditAmount: 0,
        },
        {
          accountCode: creditAccountCode,
          description: `Expense recognition: ${expense.expenseNumber}`,
          debitAmount: 0,
          creditAmount: expense.amount,
        },
      ],
      userId: SYSTEM_USER_ID,
      idempotencyKey: `EXPENSE-${expense.expenseId}`,
      // Expense P&L accounts (e.g. 6900) allow EXPENSE_PAYMENT / TREASURY_PETTY_CASH / SYSTEM_CORRECTION
      // — not PURCHASE_BILL (supplier GR/invoice path). Use EXPENSE_PAYMENT for both:
      //   paid:   Dr Expense / Cr Cash
      //   unpaid: Dr Expense / Cr AP  (AP AllowedSources includes EXPENSE_PAYMENT, mig 512)
      source: 'EXPENSE_PAYMENT' as const,
    }, pool, txClient);

    logger.info('Recorded expense approval to GL', {
      expenseId: expense.expenseId,
      expenseNumber: expense.expenseNumber,
      amount: expense.amount,
      isPaid: expense.isPaidAtApproval,
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record expense approval to GL', { error, expense });
    throw new Error(`GL posting failed for expense ${expense.expenseNumber}: ${(error instanceof Error ? error.message : String(error))}`);
  }
}

// =============================================================================
// EXPENSE PAYMENT JOURNAL ENTRIES (CLEAR AP ON PAYMENT)
// =============================================================================

export interface ExpensePaymentData {
  expenseId: string;
  expenseNumber: string;
  paymentDate: string;
  amount: number;
  paymentAccountCode?: string;  // Cash/bank account code (defaults to 1010)
}

/**
 * Record expense payment clearing AP in the general ledger.
 * Called when an already-approved (unpaid) expense is paid.
 *
 * Journal entry:
 *   DR Accounts Payable (2100) amount
 *   CR Cash / Bank (1010/1030) amount
 */
export async function recordExpensePaymentToGL(payment: ExpensePaymentData, pool?: pg.Pool, txClient?: pg.PoolClient): Promise<void> {
  try {
    const creditAccountCode = payment.paymentAccountCode || AccountCodes.CASH;

    await AccountingCore.createJournalEntry({
      entryDate: payment.paymentDate,
      description: `Payment for expense: ${payment.expenseNumber}`,
      referenceType: 'EXPENSE_PAYMENT',
      referenceId: payment.expenseId,
      referenceNumber: payment.expenseNumber,
      lines: [
        {
          accountCode: AccountCodes.ACCOUNTS_PAYABLE,
          description: `Clear AP for expense: ${payment.expenseNumber}`,
          debitAmount: payment.amount,
          creditAmount: 0,
        },
        {
          accountCode: creditAccountCode,
          description: `Payment for expense: ${payment.expenseNumber}`,
          debitAmount: 0,
          creditAmount: payment.amount,
        },
      ],
      userId: SYSTEM_USER_ID,
      idempotencyKey: `EXPENSE_PAYMENT-${payment.expenseId}`,
      source: 'EXPENSE_PAYMENT' as const,
    }, pool, txClient);

    logger.info('Recorded expense payment to GL', {
      expenseId: payment.expenseId,
      expenseNumber: payment.expenseNumber,
      amount: payment.amount,
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record expense payment to GL', { error, payment });
    throw new Error(`GL posting failed for expense payment ${payment.expenseNumber}: ${(error instanceof Error ? error.message : String(error))}`);
  }
}

// =============================================================================
// CREDIT NOTE / DEBIT NOTE JOURNAL ENTRIES
// =============================================================================

export interface CreditNoteGLData {
  noteId: string;
  noteNumber: string;
  noteDate: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  customerId?: string;
  customerName?: string;
  /** Parent invoice (e.g. INV-2026-0001) — shown in GL so credits link to the original charge */
  referenceInvoiceNumber?: string;
  saleNumber?: string;
  supplierId?: string;
  supplierName?: string;
  /**
   * Override the credit-side account for supplier credit notes.
   * Default: PURCHASE_RETURNS (5010) for price adjustments.
   * For Return-GRN-linked notes use GRIR_CLEARING (2150) to clear the
   * GRN clearing debit that was created when the Return GRN was posted.
   */
  clearingAccountCode?: string;
}

/**
 * Customer Credit Note GL posting.
 * Reverses the original invoice impact on AR and revenue.
 *
 * DR  Sales Returns & Allowances (4010) — subtotal
 * DR  Tax Payable / Output VAT (2300) — tax
 * CR  Accounts Receivable (1200) — total
 */
export async function recordCustomerCreditNoteToGL(
  data: CreditNoteGLData,
  pool: pg.Pool = globalPool,
  txClient?: pg.PoolClient,
): Promise<void> {
  try {
    const refParts = [
      data.referenceInvoiceNumber ? `invoice ${data.referenceInvoiceNumber}` : null,
      data.saleNumber ? `sale ${data.saleNumber}` : null,
    ].filter(Boolean);
    const refSuffix = refParts.length ? ` (reverses ${refParts.join(', ')})` : '';
    const lines: JournalLine[] = [];

    if (data.subtotal > 0) {
      lines.push({
        accountCode: AccountCodes.SALES_RETURNS,
        description: `Credit note ${data.noteNumber}${refSuffix} - sales return`,
        debitAmount: data.subtotal,
        creditAmount: 0,
      });
    }

    if (data.taxAmount > 0) {
      lines.push({
        accountCode: AccountCodes.TAX_PAYABLE,
        description: `Credit note ${data.noteNumber}${refSuffix} - output VAT reversal`,
        debitAmount: data.taxAmount,
        creditAmount: 0,
      });
    }

    lines.push({
      accountCode: AccountCodes.ACCOUNTS_RECEIVABLE,
      description: `Credit note ${data.noteNumber}${refSuffix} - reduce AR`,
      debitAmount: 0,
      creditAmount: data.totalAmount,
      entityType: 'customer',
      entityId: data.customerId,
    });

    await AccountingCore.createJournalEntry({
      entryDate: data.noteDate,
      description: `Customer credit note ${data.noteNumber}${refSuffix}${data.customerName ? ` — ${data.customerName}` : ''}`,
      referenceType: 'CREDIT_NOTE',
      referenceId: data.noteId,
      referenceNumber: data.noteNumber,
      lines,
      userId: SYSTEM_USER_ID,
      idempotencyKey: `CREDIT_NOTE-${data.noteId}`,
      source: 'SALES_REFUND' as const,
    }, pool, txClient);

    logger.info('Recorded customer credit note to GL', {
      noteId: data.noteId,
      noteNumber: data.noteNumber,
      totalAmount: data.totalAmount,
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record customer credit note to GL', { error, data });
    throw new Error(`GL posting failed for credit note ${data.noteNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Customer Debit Note GL posting.
 * Adds additional charges to a customer's AR balance.
 *
 * DR  Accounts Receivable (1200) — total
 * CR  Sales Revenue (4000) — subtotal
 * CR  Tax Payable / Output VAT (2300) — tax
 */
export async function recordCustomerDebitNoteToGL(
  data: CreditNoteGLData,
  pool: pg.Pool = globalPool,
  txClient?: pg.PoolClient,
): Promise<void> {
  try {
    const lines: JournalLine[] = [];

    lines.push({
      accountCode: AccountCodes.ACCOUNTS_RECEIVABLE,
      description: `Debit note ${data.noteNumber} - increase AR`,
      debitAmount: data.totalAmount,
      creditAmount: 0,
      entityType: 'customer',
      entityId: data.customerId,
    });

    if (data.subtotal > 0) {
      lines.push({
        accountCode: AccountCodes.SALES_REVENUE,
        description: `Debit note ${data.noteNumber} - additional revenue`,
        debitAmount: 0,
        creditAmount: data.subtotal,
      });
    }

    if (data.taxAmount > 0) {
      lines.push({
        accountCode: AccountCodes.TAX_PAYABLE,
        description: `Debit note ${data.noteNumber} - output VAT`,
        debitAmount: 0,
        creditAmount: data.taxAmount,
      });
    }

    await AccountingCore.createJournalEntry({
      entryDate: data.noteDate,
      description: `Customer debit note ${data.noteNumber}${data.customerName ? ` for ${data.customerName}` : ''}`,
      referenceType: 'DEBIT_NOTE',
      referenceId: data.noteId,
      referenceNumber: data.noteNumber,
      lines,
      userId: SYSTEM_USER_ID,
      idempotencyKey: `DEBIT_NOTE-${data.noteId}`,
      // Mirror invoice charging path: DR AR / CR revenue may post to 1200 under SALES_INVOICE.
      // (Credit notes use SALES_REFUND for the reverse AR credit.)
      source: 'SALES_INVOICE' as const,
    }, pool, txClient);

    logger.info('Recorded customer debit note to GL', {
      noteId: data.noteId,
      noteNumber: data.noteNumber,
      totalAmount: data.totalAmount,
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record customer debit note to GL', { error, data });
    throw new Error(`GL posting failed for debit note ${data.noteNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Supplier Credit Note GL posting.
 * Supplier has issued a credit — reduces our AP liability.
 *
 * DR  Accounts Payable (2100) — total (we owe less)
 * CR  Purchase Returns & Allowances (5010) — subtotal
 * CR  Tax Payable / Input VAT (2300) — tax
 */
export async function recordSupplierCreditNoteToGL(
  data: CreditNoteGLData,
  pool: pg.Pool = globalPool,
  txClient?: pg.PoolClient,
): Promise<void> {
  try {
    const lines: JournalLine[] = [];

    lines.push({
      accountCode: AccountCodes.ACCOUNTS_PAYABLE,
      description: `Supplier credit note ${data.noteNumber} - reduce AP`,
      debitAmount: data.totalAmount,
      creditAmount: 0,
      entityType: 'supplier',
      entityId: data.supplierId,
    });

    if (data.subtotal > 0) {
      lines.push({
        accountCode: data.clearingAccountCode || AccountCodes.PURCHASE_RETURNS,
        description: `Supplier credit note ${data.noteNumber} - ${data.clearingAccountCode === AccountCodes.GRIR_CLEARING ? 'clear GRN/IR' : 'purchase return'}`,
        debitAmount: 0,
        creditAmount: data.subtotal,
      });
    }

    if (data.taxAmount > 0) {
      lines.push({
        accountCode: AccountCodes.TAX_PAYABLE,
        description: `Supplier credit note ${data.noteNumber} - input VAT reversal`,
        debitAmount: 0,
        creditAmount: data.taxAmount,
      });
    }

    await AccountingCore.createJournalEntry({
      entryDate: data.noteDate,
      description: `Supplier credit note ${data.noteNumber}${data.supplierName ? ` from ${data.supplierName}` : ''}`,
      referenceType: 'SUPPLIER_CREDIT_NOTE',
      referenceId: data.noteId,
      referenceNumber: data.noteNumber,
      lines,
      userId: SYSTEM_USER_ID,
      idempotencyKey: `SUPPLIER_CREDIT_NOTE-${data.noteId}`,
      source: 'PURCHASE_BILL' as const,
    }, pool, txClient);

    logger.info('Recorded supplier credit note to GL', {
      noteId: data.noteId,
      noteNumber: data.noteNumber,
      totalAmount: data.totalAmount,
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record supplier credit note to GL', { error, data });
    throw new Error(`GL posting failed for supplier credit note ${data.noteNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Supplier Debit Note GL posting.
 * We charge the supplier more — increases our AP obligation.
 *
 * DR  COGS (5000) — additional cost (not Inventory, since we cannot
 *     identify which specific batches/cost layers to revalue)
 * DR  Tax Payable / Input VAT (2300) — tax
 * CR  Accounts Payable (2100) — total
 *
 * NOTE: To properly debit Inventory (1300), the system would need
 * to revalue specific inventory_batches and cost_layers. Until that
 * feature is built, COGS absorbs the cost to prevent GL-vs-batch drift.
 */
export async function recordSupplierDebitNoteToGL(
  data: CreditNoteGLData,
  pool: pg.Pool = globalPool,
  txClient?: pg.PoolClient,
): Promise<void> {
  try {
    const lines: JournalLine[] = [];

    if (data.subtotal > 0) {
      lines.push({
        accountCode: AccountCodes.COGS,
        description: `Supplier debit note ${data.noteNumber} - additional cost`,
        debitAmount: data.subtotal,
        creditAmount: 0,
      });
    }

    if (data.taxAmount > 0) {
      lines.push({
        accountCode: AccountCodes.TAX_PAYABLE,
        description: `Supplier debit note ${data.noteNumber} - input VAT`,
        debitAmount: data.taxAmount,
        creditAmount: 0,
      });
    }

    lines.push({
      accountCode: AccountCodes.ACCOUNTS_PAYABLE,
      description: `Supplier debit note ${data.noteNumber} - increase AP`,
      debitAmount: 0,
      creditAmount: data.totalAmount,
      entityType: 'supplier',
      entityId: data.supplierId,
    });

    await AccountingCore.createJournalEntry({
      entryDate: data.noteDate,
      description: `Supplier debit note ${data.noteNumber}${data.supplierName ? ` from ${data.supplierName}` : ''}`,
      referenceType: 'SUPPLIER_DEBIT_NOTE',
      referenceId: data.noteId,
      referenceNumber: data.noteNumber,
      lines,
      userId: SYSTEM_USER_ID,
      idempotencyKey: `SUPPLIER_DEBIT_NOTE-${data.noteId}`,
      source: 'INVENTORY_MOVE' as const,
    }, pool, txClient);

    logger.info('Recorded supplier debit note to GL', {
      noteId: data.noteId,
      noteNumber: data.noteNumber,
      totalAmount: data.totalAmount,
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record supplier debit note to GL', { error, data });
    throw new Error(`GL posting failed for supplier debit note ${data.noteNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// =============================================================================
// DOWN PAYMENT CLEARING JOURNAL ENTRIES (SAP-STYLE)
// =============================================================================

export interface DownPaymentClearingData {
  clearingId: string;
  clearingNumber: string;
  clearingDate: string;
  amount: number;
  depositNumber: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
}

/**
 * Record a down payment clearing in the general ledger
 *
 * When a deposit is applied to an invoice, the liability is transferred to AR:
 *   DR Customer Deposits (2200)    amount   (reduce liability)
 *   CR Accounts Receivable (1200)  amount   (reduce AR)
 */
export async function recordDownPaymentClearingToGL(data: DownPaymentClearingData, pool?: pg.Pool, txClient?: pg.PoolClient): Promise<void> {
  try {
    await AccountingCore.createJournalEntry({
      entryDate: data.clearingDate,
      description: `Down Payment Clearing: ${data.clearingNumber} — ${data.depositNumber} applied to ${data.invoiceNumber} (${data.customerName})`,
      referenceType: 'DOWN_PAYMENT_CLEARING',
      referenceId: data.clearingId,
      referenceNumber: data.clearingNumber,
      lines: [
        {
          accountCode: AccountCodes.CUSTOMER_DEPOSITS,
          description: `Deposit liability cleared — ${data.depositNumber}`,
          debitAmount: data.amount,
          creditAmount: 0,
          entityType: 'customer',
          entityId: data.customerId,
        },
        {
          accountCode: AccountCodes.ACCOUNTS_RECEIVABLE,
          description: `AR reduced via deposit — ${data.invoiceNumber}`,
          debitAmount: 0,
          creditAmount: data.amount,
          entityType: 'customer',
          entityId: data.customerId,
        },
      ],
      userId: SYSTEM_USER_ID,
      idempotencyKey: `DOWN_PAYMENT_CLEARING-${data.clearingId}`,
    }, pool, txClient);

    logger.info('Recorded down payment clearing to GL', {
      clearingId: data.clearingId,
      clearingNumber: data.clearingNumber,
      amount: data.amount,
      depositNumber: data.depositNumber,
      invoiceNumber: data.invoiceNumber,
    });
  } catch (error: unknown) {
    if (error instanceof BusinessRuleException) throw error;
    logger.error('Failed to record down payment clearing to GL', { error, data });
    throw new Error(`GL posting failed for clearing ${data.clearingNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export default {
  AccountCodes,
  recordSaleToGL,
  recordCustomerPaymentToGL,
  recordExpenseToGL,
  recordGoodsReceiptToGL,
  recordSupplierPaymentToGL,
  recordStockAdjustmentToGL,
  recordDeliveryChargeToGL,
  recordDeliveryCompletedToGL,
  recordSaleVoidToGL,
  recordCustomerDepositToGL,
  recordDepositApplicationToGL,
  recordCustomerInvoiceToGL,
  recordInvoicePaymentToGL,
  recordDownPaymentClearingToGL,
  recordStockMovementToGL,
  recordExpenseApprovalToGL,
  recordExpensePaymentToGL,
  recordCustomerCreditNoteToGL,
  recordCustomerDebitNoteToGL,
  recordSupplierCreditNoteToGL,
  recordSupplierDebitNoteToGL,
};
