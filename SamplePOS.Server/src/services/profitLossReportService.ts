/**
 * Profit & Loss Report Service
 *
 * ERP-grade P&L reporting (ADR-007 / RP-INV-1):
 *   ✔ Single Source of Truth — posted ledger via fn_get_profit_loss*
 *   ✔ Migration 644 classification (5210 = OpEx; other 5xxx = COGS)
 *   ✔ No frontend calculations
 *   ✔ Totals reconcile via verifyProfitLossConsistency
 */

import { Pool } from 'pg';
import Decimal from 'decimal.js';
import { Money } from '../utils/money.js';
import logger from '../utils/logger.js';

// Configure Decimal.js for financial precision
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

// =============================================================================
// TYPES
// =============================================================================

export interface ProfitLossLineItem {
    section: string;
    accountCode: string;
    accountName: string;
    debitTotal: number;
    creditTotal: number;
    netAmount: number;
    displayAmount: number;
}

export interface ProfitLossSummary {
    totalRevenue: number;
    totalCogs: number;
    grossProfit: number;
    grossMarginPercent: number;
    totalOperatingExpenses: number;
    operatingIncome: number;
    operatingMarginPercent: number;
    netIncome: number;
    netMarginPercent: number;
}

export interface ProfitLossReport {
    periodStart: string;
    periodEnd: string;
    generatedAt: string;
    revenueAccounts: ProfitLossLineItem[];
    cogsAccounts: ProfitLossLineItem[];
    expenseAccounts: ProfitLossLineItem[];
    summary: ProfitLossSummary;
}

export interface CustomerProfitability {
    customerId: string;
    customerName: string;
    totalRevenue: number;
    totalCogs: number;
    grossProfit: number;
    grossMarginPercent: number;
    transactionCount: number;
}

export interface ProductProfitability {
    productId: string;
    productName: string;
    productSku: string;
    totalRevenue: number;
    totalCogs: number;
    grossProfit: number;
    grossMarginPercent: number;
    quantitySold: number;
}

// =============================================================================
// PROFIT & LOSS REPORT SERVICE
// =============================================================================

export class ProfitLossReportService {
    private pool: Pool;

    constructor(pool: Pool) {
        this.pool = pool;
    }

    /**
     * Get complete Profit & Loss report for a date range.
     * ADR-007 Phase 5B — same SSOT as ERP `/reports/profit-loss` (fn_get_profit_loss*).
     */
    async getProfitLossReport(dateFrom: string, dateTo: string): Promise<ProfitLossReport> {
        try {
            const [detailResult, summaryResult] = await Promise.all([
                this.pool.query('SELECT * FROM fn_get_profit_loss($1::DATE, $2::DATE)', [
                    dateFrom,
                    dateTo,
                ]),
                this.pool.query('SELECT * FROM fn_get_profit_loss_summary($1::DATE, $2::DATE)', [
                    dateFrom,
                    dateTo,
                ]),
            ]);

            const revenueAccounts: ProfitLossLineItem[] = [];
            const cogsAccounts: ProfitLossLineItem[] = [];
            const expenseAccounts: ProfitLossLineItem[] = [];

            for (const row of detailResult.rows) {
                const item: ProfitLossLineItem = {
                    section: row.section,
                    accountCode: row.account_code,
                    accountName: row.account_name,
                    debitTotal: Money.parseDb(row.debit_total).toNumber(),
                    creditTotal: Money.parseDb(row.credit_total).toNumber(),
                    netAmount: Money.parseDb(row.net_amount).toNumber(),
                    displayAmount: Money.parseDb(row.display_amount).toNumber(),
                };

                switch (row.section) {
                    case 'REVENUE':
                        revenueAccounts.push(item);
                        break;
                    case 'COST_OF_GOODS_SOLD':
                        cogsAccounts.push(item);
                        break;
                    case 'OPERATING_EXPENSES':
                    case 'OTHER':
                        expenseAccounts.push(item);
                        break;
                }
            }

            const summaryRow = summaryResult.rows[0] || {};
            const summary: ProfitLossSummary = {
                totalRevenue: Money.parseDb(summaryRow.total_revenue).toNumber(),
                totalCogs: Money.parseDb(summaryRow.total_cogs).toNumber(),
                grossProfit: Money.parseDb(summaryRow.gross_profit).toNumber(),
                grossMarginPercent: Money.parseDb(summaryRow.gross_margin_percent).toNumber(),
                totalOperatingExpenses: Money.parseDb(summaryRow.total_operating_expenses).toNumber(),
                operatingIncome: Money.parseDb(summaryRow.operating_income).toNumber(),
                operatingMarginPercent: Money.parseDb(summaryRow.operating_margin_percent).toNumber(),
                netIncome: Money.parseDb(summaryRow.net_income).toNumber(),
                netMarginPercent: Money.parseDb(summaryRow.net_margin_percent).toNumber(),
            };

            logger.info('P&L report generated', {
                dateFrom,
                dateTo,
                source: 'fn_get_profit_loss*',
                revenue: summary.totalRevenue,
                netIncome: summary.netIncome,
            });

            return {
                periodStart: dateFrom,
                periodEnd: dateTo,
                generatedAt: new Date().toISOString(),
                revenueAccounts,
                cogsAccounts,
                expenseAccounts,
                summary,
            };
        } catch (error: unknown) {
            logger.error('Failed to generate P&L report', { dateFrom, dateTo, error });
            throw error;
        }
    }

    /**
     * Get P&L by Customer
     *
     * Analyzes profitability by customer using GL data
     */
    async getProfitLossByCustomer(
        dateFrom: string,
        dateTo: string
    ): Promise<CustomerProfitability[]> {
        try {
            const result = await this.pool.query(
                `
                SELECT * FROM fn_get_profit_loss_by_customer($1::DATE, $2::DATE)
            `,
                [dateFrom, dateTo]
            );

            const customers = result.rows.map((row) => ({
                customerId: row.customer_id,
                customerName: row.customer_name,
                totalRevenue: Money.parseDb(row.total_revenue).toNumber(),
                totalCogs: Money.parseDb(row.total_cogs).toNumber(),
                grossProfit: Money.parseDb(row.gross_profit).toNumber(),
                grossMarginPercent: Money.parseDb(row.gross_margin_percent).toNumber(),
                transactionCount: parseInt(row.transaction_count || '0'),
            }));

            logger.info('P&L by customer generated', {
                dateFrom,
                dateTo,
                customerCount: customers.length,
            });

            return customers;
        } catch (error: unknown) {
            logger.error('Failed to generate P&L by customer', { dateFrom, dateTo, error });
            throw error;
        }
    }

    /**
     * Get P&L by Product
     *
     * Analyzes profitability by product
     */
    async getProfitLossByProduct(dateFrom: string, dateTo: string): Promise<ProductProfitability[]> {
        try {
            const result = await this.pool.query(
                `
                SELECT * FROM fn_get_profit_loss_by_product($1::DATE, $2::DATE)
            `,
                [dateFrom, dateTo]
            );

            const products = result.rows.map((row) => ({
                productId: row.product_id,
                productName: row.product_name,
                productSku: row.product_sku || '',
                totalRevenue: Money.parseDb(row.total_revenue).toNumber(),
                totalCogs: Money.parseDb(row.total_cogs).toNumber(),
                grossProfit: Money.parseDb(row.gross_profit).toNumber(),
                grossMarginPercent: Money.parseDb(row.gross_margin_percent).toNumber(),
                quantitySold: Money.parseDb(row.quantity_sold).toNumber(),
            }));

            logger.info('P&L by product generated', {
                dateFrom,
                dateTo,
                productCount: products.length,
            });

            return products;
        } catch (error: unknown) {
            logger.error('Failed to generate P&L by product', { dateFrom, dateTo, error });
            throw error;
        }
    }

    /**
     * Verify P&L totals match Trial Balance
     *
     * Ensures consistency between reports (Clean Core principle)
     */
    async verifyProfitLossConsistency(
        dateFrom: string,
        dateTo: string
    ): Promise<{
        isConsistent: boolean;
        plNetIncome: number;
        trialBalanceNetIncome: number;
        difference: number;
        totalRevenue: number;
        totalCOGS: number;
        totalOperatingExpenses: number;
        grossProfit: number;
    }> {
        try {
            // Same SSOT as the P&L page: live posted ledger via SQL functions
            const plResult = await this.pool.query(
                `SELECT * FROM fn_get_profit_loss_summary($1::DATE, $2::DATE)`,
                [dateFrom, dateTo]
            );

            const row = plResult.rows[0] || {};
            const plNetIncome = Money.parseDb(row.net_income).toNumber();
            const totalRevenue = Money.parseDb(row.total_revenue).toNumber();
            const totalCOGS = Money.parseDb(row.total_cogs).toNumber();
            const totalOperatingExpenses = Money.parseDb(row.total_operating_expenses).toNumber();
            const grossProfit = Money.parseDb(row.gross_profit).toNumber();

            // Independent rollup from detail lines (same ledger + classification)
            const detailResult = await this.pool.query(
                `SELECT section, COALESCE(SUM(display_amount), 0) AS total
                 FROM fn_get_profit_loss($1::DATE, $2::DATE)
                 GROUP BY section`,
                [dateFrom, dateTo]
            );

            let revenue = 0;
            let cogs = 0;
            let opex = 0;
            for (const r of detailResult.rows) {
                const amt = Money.parseDb(r.total).toNumber();
                if (r.section === 'REVENUE') revenue = amt;
                else if (r.section === 'COST_OF_GOODS_SOLD') cogs = amt;
                else if (r.section === 'OPERATING_EXPENSES') opex = amt;
            }
            const trialBalanceNetIncome = Money.toNumber(
                new Decimal(revenue).minus(cogs).minus(opex)
            );

            const difference = Money.toNumber(new Decimal(plNetIncome).minus(trialBalanceNetIncome));
            const isConsistent = Math.abs(difference) < 0.01;

            if (!isConsistent) {
                logger.warn('P&L consistency check failed', {
                    plNetIncome,
                    trialBalanceNetIncome,
                    difference,
                    dateFrom,
                    dateTo,
                });
            }

            return {
                isConsistent,
                plNetIncome,
                trialBalanceNetIncome,
                difference,
                totalRevenue,
                totalCOGS,
                totalOperatingExpenses,
                grossProfit,
            };
        } catch (error: unknown) {
            logger.error('Failed to verify P&L consistency', { dateFrom, dateTo, error });
            throw error;
        }
    }

    /**
     * Get comparative P&L (current vs previous period)
     */
    async getComparativeProfitLoss(
        currentPeriodStart: string,
        currentPeriodEnd: string,
        previousPeriodStart: string,
        previousPeriodEnd: string
    ): Promise<{
        currentPeriod: ProfitLossSummary;
        previousPeriod: ProfitLossSummary;
        variance: {
            revenueChange: number;
            revenueChangePercent: number;
            grossProfitChange: number;
            grossProfitChangePercent: number;
            netIncomeChange: number;
            netIncomeChangePercent: number;
        };
    }> {
        const [currentReport, previousReport] = await Promise.all([
            this.getProfitLossReport(currentPeriodStart, currentPeriodEnd),
            this.getProfitLossReport(previousPeriodStart, previousPeriodEnd),
        ]);

        const calcChange = (current: number, previous: number) => ({
            change: current - previous,
            changePercent: previous !== 0 ? ((current - previous) / Math.abs(previous)) * 100 : 0,
        });

        const revenueVar = calcChange(
            currentReport.summary.totalRevenue,
            previousReport.summary.totalRevenue
        );
        const grossProfitVar = calcChange(
            currentReport.summary.grossProfit,
            previousReport.summary.grossProfit
        );
        const netIncomeVar = calcChange(
            currentReport.summary.netIncome,
            previousReport.summary.netIncome
        );

        return {
            currentPeriod: currentReport.summary,
            previousPeriod: previousReport.summary,
            variance: {
                revenueChange: revenueVar.change,
                revenueChangePercent: revenueVar.changePercent,
                grossProfitChange: grossProfitVar.change,
                grossProfitChangePercent: grossProfitVar.changePercent,
                netIncomeChange: netIncomeVar.change,
                netIncomeChangePercent: netIncomeVar.changePercent,
            },
        };
    }
}

// Export singleton factory
const plReportServiceInstance: ProfitLossReportService | null = null;

export function getProfitLossReportService(pool: Pool): ProfitLossReportService {
    return new ProfitLossReportService(pool);
}
