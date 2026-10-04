import { Pool, type PoolClient } from 'pg';
import {
    SystemSettings,
    SystemSettingsDbRow,
    normalizeSystemSettings,
    UpdateSystemSettingsDto,
} from '../../../../shared/types/systemSettings.js';

export const systemSettingsRepository = {
    /**
     * Get system settings (singleton - always returns the first/only row)
     */
    async getSettings(conn: Pool | PoolClient): Promise<SystemSettings | null> {
        const result = await conn.query<SystemSettingsDbRow>(
            `SELECT * FROM system_settings LIMIT 1`
        );

        if (result.rows.length === 0) {
            return null;
        }

        return normalizeSystemSettings(result.rows[0]);
    },

    /**
     * Update system settings
     */
    async updateSettings(
        conn: Pool | PoolClient,
        updates: UpdateSystemSettingsDto
    ): Promise<SystemSettings> {
        // Build dynamic SET clause
        const setClauses: string[] = [];
        const values: unknown[] = [];
        let paramIndex = 1;

        if (updates.businessName !== undefined) {
            setClauses.push(`business_name = $${paramIndex++}`);
            values.push(updates.businessName);
        }
        if (updates.currencyCode !== undefined) {
            setClauses.push(`currency_code = $${paramIndex++}`);
            values.push(updates.currencyCode);
        }
        if (updates.currencySymbol !== undefined) {
            setClauses.push(`currency_symbol = $${paramIndex++}`);
            values.push(updates.currencySymbol);
        }
        if (updates.dateFormat !== undefined) {
            setClauses.push(`date_format = $${paramIndex++}`);
            values.push(updates.dateFormat);
        }
        if (updates.timeFormat !== undefined) {
            setClauses.push(`time_format = $${paramIndex++}`);
            values.push(updates.timeFormat);
        }
        if (updates.timezone !== undefined) {
            setClauses.push(`timezone = $${paramIndex++}`);
            values.push(updates.timezone);
        }
        if (updates.taxEnabled !== undefined) {
            setClauses.push(`tax_enabled = $${paramIndex++}`);
            values.push(updates.taxEnabled);
        }
        if (updates.defaultTaxRate !== undefined) {
            setClauses.push(`default_tax_rate = $${paramIndex++}`);
            values.push(updates.defaultTaxRate);
        }
        if (updates.taxName !== undefined) {
            setClauses.push(`tax_name = $${paramIndex++}`);
            values.push(updates.taxName);
        }
        if (updates.taxNumber !== undefined) {
            setClauses.push(`tax_number = $${paramIndex++}`);
            values.push(updates.taxNumber);
        }
        if (updates.taxInclusive !== undefined) {
            setClauses.push(`tax_inclusive = $${paramIndex++}`);
            values.push(updates.taxInclusive);
        }
        if (updates.taxRates !== undefined) {
            setClauses.push(`tax_rates = $${paramIndex++}`);
            values.push(JSON.stringify(updates.taxRates));
        }
        if (updates.vatOutputRequiresRegisteredCustomer !== undefined) {
            setClauses.push(`vat_output_requires_registered_customer = $${paramIndex++}`);
            values.push(updates.vatOutputRequiresRegisteredCustomer);
        }
        if (updates.receiptPrinterEnabled !== undefined) {
            setClauses.push(`receipt_printer_enabled = $${paramIndex++}`);
            values.push(updates.receiptPrinterEnabled);
        }
        if (updates.receiptPrinterName !== undefined) {
            setClauses.push(`receipt_printer_name = $${paramIndex++}`);
            values.push(updates.receiptPrinterName);
        }
        if (updates.guestBillPrinterName !== undefined) {
            setClauses.push(`guest_bill_printer_name = $${paramIndex++}`);
            values.push(updates.guestBillPrinterName?.trim() || null);
        }
        if (updates.receiptPaperWidth !== undefined) {
            setClauses.push(`receipt_paper_width = $${paramIndex++}`);
            values.push(updates.receiptPaperWidth);
        }
        if (updates.receiptAutoPrint !== undefined) {
            setClauses.push(`receipt_auto_print = $${paramIndex++}`);
            values.push(updates.receiptAutoPrint);
        }
        if (updates.receiptShowLogo !== undefined) {
            setClauses.push(`receipt_show_logo = $${paramIndex++}`);
            values.push(updates.receiptShowLogo);
        }
        if (updates.receiptLogoUrl !== undefined) {
            setClauses.push(`receipt_logo_url = $${paramIndex++}`);
            values.push(updates.receiptLogoUrl);
        }
        if (updates.receiptHeaderText !== undefined) {
            setClauses.push(`receipt_header_text = $${paramIndex++}`);
            values.push(updates.receiptHeaderText);
        }
        if (updates.receiptFooterText !== undefined) {
            setClauses.push(`receipt_footer_text = $${paramIndex++}`);
            values.push(updates.receiptFooterText);
        }
        if (updates.receiptShowTaxBreakdown !== undefined) {
            setClauses.push(`receipt_show_tax_breakdown = $${paramIndex++}`);
            values.push(updates.receiptShowTaxBreakdown);
        }
        if (updates.receiptShowQrCode !== undefined) {
            setClauses.push(`receipt_show_qr_code = $${paramIndex++}`);
            values.push(updates.receiptShowQrCode);
        }
        if (updates.invoicePrinterEnabled !== undefined) {
            setClauses.push(`invoice_printer_enabled = $${paramIndex++}`);
            values.push(updates.invoicePrinterEnabled);
        }
        if (updates.invoicePrinterName !== undefined) {
            setClauses.push(`invoice_printer_name = $${paramIndex++}`);
            values.push(updates.invoicePrinterName);
        }
        if (updates.invoicePaperSize !== undefined) {
            setClauses.push(`invoice_paper_size = $${paramIndex++}`);
            values.push(updates.invoicePaperSize);
        }
        if (updates.invoiceTemplate !== undefined) {
            setClauses.push(`invoice_template = $${paramIndex++}`);
            values.push(updates.invoiceTemplate);
        }
        if (updates.invoiceShowLogo !== undefined) {
            setClauses.push(`invoice_show_logo = $${paramIndex++}`);
            values.push(updates.invoiceShowLogo);
        }
        if (updates.invoiceShowPaymentTerms !== undefined) {
            setClauses.push(`invoice_show_payment_terms = $${paramIndex++}`);
            values.push(updates.invoiceShowPaymentTerms);
        }
        if (updates.invoiceDefaultPaymentTerms !== undefined) {
            setClauses.push(`invoice_default_payment_terms = $${paramIndex++}`);
            values.push(updates.invoiceDefaultPaymentTerms);
        }
        if (updates.posSessionPolicy !== undefined) {
            setClauses.push(`pos_session_policy = $${paramIndex++}`);
            values.push(updates.posSessionPolicy);
        }
        if (updates.posTransactionMode !== undefined) {
            setClauses.push(`pos_transaction_mode = $${paramIndex++}`);
            values.push(updates.posTransactionMode);
        }
        if (updates.lowStockAlertsEnabled !== undefined) {
            setClauses.push(`low_stock_alerts_enabled = $${paramIndex++}`);
            values.push(updates.lowStockAlertsEnabled);
        }
        if (updates.lowStockThreshold !== undefined) {
            setClauses.push(`low_stock_threshold = $${paramIndex++}`);
            values.push(updates.lowStockThreshold);
        }
        if (updates.isMultistoreEnabled !== undefined) {
            setClauses.push(`is_multistore_enabled = $${paramIndex++}`);
            values.push(updates.isMultistoreEnabled);
        }
        if (updates.treasuryDocumentEnabled !== undefined) {
            setClauses.push(`treasury_document_enabled = $${paramIndex++}`);
            values.push(updates.treasuryDocumentEnabled);
        }
        if (updates.restaurantModeEnabled !== undefined) {
            setClauses.push(`restaurant_mode_enabled = $${paramIndex++}`);
            values.push(updates.restaurantModeEnabled);
        }
        if (updates.salesTargetsEnabled !== undefined) {
            setClauses.push(`sales_targets_enabled = $${paramIndex++}`);
            values.push(updates.salesTargetsEnabled);
        }
        if (updates.kitchenProductionEnabled !== undefined) {
            setClauses.push(`kitchen_production_enabled = $${paramIndex++}`);
            values.push(updates.kitchenProductionEnabled);
        }
        if (updates.lossQuarantineDocumentEnabled !== undefined) {
            setClauses.push(`loss_quarantine_document_enabled = $${paramIndex++}`);
            values.push(updates.lossQuarantineDocumentEnabled);
        }
        if (updates.transferPolicyRequireApprovalAll !== undefined) {
            setClauses.push(`transfer_policy_require_approval_all = $${paramIndex++}`);
            values.push(updates.transferPolicyRequireApprovalAll);
        }
        if (updates.transferPolicyAllowDirect !== undefined) {
            setClauses.push(`transfer_policy_allow_direct = $${paramIndex++}`);
            values.push(updates.transferPolicyAllowDirect);
        }
        if (updates.transferPolicyValueThreshold !== undefined) {
            setClauses.push(`transfer_policy_value_threshold = $${paramIndex++}`);
            values.push(updates.transferPolicyValueThreshold);
        }
        if (updates.transferPolicyQtyThreshold !== undefined) {
            setClauses.push(`transfer_policy_qty_threshold = $${paramIndex++}`);
            values.push(updates.transferPolicyQtyThreshold);
        }
        if (updates.transferPolicySpecialStoresRequireApproval !== undefined) {
            setClauses.push(`transfer_policy_special_stores_require_approval = $${paramIndex++}`);
            values.push(updates.transferPolicySpecialStoresRequireApproval);
        }
        if (updates.transferAssortmentExpansionPolicy !== undefined) {
            setClauses.push(`transfer_assortment_expansion_policy = $${paramIndex++}`);
            values.push(updates.transferAssortmentExpansionPolicy);
        }
        if (updates.expiryAutomationEnabled !== undefined) {
            setClauses.push(`expiry_automation_enabled = $${paramIndex++}`);
            values.push(updates.expiryAutomationEnabled);
        }
        if (updates.quarantineAutoDisposeEnabled !== undefined) {
            setClauses.push(`quarantine_auto_dispose_enabled = $${paramIndex++}`);
            values.push(updates.quarantineAutoDisposeEnabled);
        }
        if (updates.quarantineAutoDisposeMinAgeDays !== undefined) {
            setClauses.push(`quarantine_auto_dispose_min_age_days = $${paramIndex++}`);
            values.push(updates.quarantineAutoDisposeMinAgeDays);
        }
        if (updates.updatedById !== undefined) {
            setClauses.push(`updated_by_id = $${paramIndex++}`);
            values.push(updates.updatedById);
        }

        if (setClauses.length === 0) {
            throw new Error('No fields to update');
        }

        setClauses.push(`updated_at = NOW()`);

        const query = `
      UPDATE system_settings 
      SET ${setClauses.join(', ')}
      WHERE id = (SELECT id FROM system_settings LIMIT 1)
      RETURNING *
    `;

        const result = await conn.query<SystemSettingsDbRow>(query, values);

        if (result.rows.length === 0) {
            throw new Error('Failed to update system settings');
        }

        return normalizeSystemSettings(result.rows[0]);
    },

    /**
     * Initialize default settings if table is empty
     */
    async initializeDefaults(pool: Pool): Promise<SystemSettings> {
        const existing = await this.getSettings(pool);
        if (existing) {
            return existing;
        }

        const result = await pool.query<SystemSettingsDbRow>(
            `INSERT INTO system_settings (
        business_name,
        currency_code,
        currency_symbol,
        tax_enabled,
        default_tax_rate,
        tax_name,
        tax_inclusive
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
            ['SMART ERP', 'UGX', 'UGX', false, 18.0, 'VAT', true]
        );

        return normalizeSystemSettings(result.rows[0]);
    },
};
