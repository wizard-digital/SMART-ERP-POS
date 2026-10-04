// System Settings TypeScript Interfaces

export interface TaxRate {
    name: string;
    rate: number;
    default?: boolean;
    description?: string;
}

export interface SystemSettings {
    id: string;

    // General Settings
    businessName: string;
    currencyCode: string;
    currencySymbol: string;
    dateFormat: string;
    timeFormat: string;
    timezone: string;

    // Tax Settings
    taxEnabled: boolean;
    defaultTaxRate: number;
    taxName: string;
    taxNumber?: string;
    taxInclusive: boolean;
    taxRates: TaxRate[];
    /**
     * When true, DocumentTaxService applies output VAT only for VAT-registered customers.
     * Walk-in (no customer) and non-registered customers → 0 VAT. Default false (BC).
     */
    vatOutputRequiresRegisteredCustomer: boolean;

    // Printing Settings - Receipt
    receiptPrinterEnabled: boolean;
    receiptPrinterName?: string;
    /** FOH guest check / restaurant bill — routed via print bridge X-Printer-Name */
    guestBillPrinterName?: string;
    receiptPaperWidth: number;
    receiptAutoPrint: boolean;
    receiptShowLogo: boolean;
    receiptLogoUrl?: string;
    receiptHeaderText?: string;
    receiptFooterText?: string;
    receiptShowTaxBreakdown: boolean;
    receiptShowQrCode: boolean;

    // Printing Settings - Invoice
    invoicePrinterEnabled: boolean;
    invoicePrinterName?: string;
    invoicePaperSize: string;
    invoiceTemplate: string;
    invoiceShowLogo: boolean;
    invoiceShowPaymentTerms: boolean;
    invoiceDefaultPaymentTerms?: string;

    // POS Session Policy
    posSessionPolicy: 'DISABLED' | 'PER_CASHIER_SESSION' | 'PER_COUNTER_SHARED_SESSION' | 'GLOBAL_STORE_SESSION';

    // POS Transaction Mode (SAP-style order→payment split)
    posTransactionMode: 'DirectSale' | 'OrderToPayment';

    // Low Stock Alerts
    lowStockAlertsEnabled: boolean;
    lowStockThreshold: number;

    // Multi-Store Warehouse Network (default false — legacy single-store behaviour)
    isMultistoreEnabled: boolean;

    /** ADR-003 Phase 1A — Treasury Document domain (default false) */
    treasuryDocumentEnabled: boolean;

    /** Restaurant module FOH/KOT (default false — retail unchanged) */
    restaurantModeEnabled: boolean;

    /** Sales Targets module (default false — tenants opt in) */
    salesTargetsEnabled: boolean;

    /** ADR-005 Kitchen Production Batch cook-to-stock (default false) */
    kitchenProductionEnabled: boolean;

    /** ADR-004 Phase 2A — Loss & Quarantine disposal documents (default false) */
    lossQuarantineDocumentEnabled: boolean;

    // Transfer workflow policy (Phase E)
    transferPolicyRequireApprovalAll: boolean;
    transferPolicyAllowDirect: boolean;
    transferPolicyValueThreshold: number | null;
    transferPolicyQtyThreshold: number | null;
    transferPolicySpecialStoresRequireApproval: boolean;

    /** Phase 3 — assortment expansion when transferring restricted/hidden products */
    transferAssortmentExpansionPolicy: import('./transferAssortment.js').TransferAssortmentExpansionPolicy;

    /** Phase 9 — nightly move of expired stock to EXPIRED store */
    expiryAutomationEnabled: boolean;

    /** Soft quarantine P4 — auto-dispose aged EXPIRED quarantine (posts P&L). Default off. */
    quarantineAutoDisposeEnabled: boolean;
    /** Days in quarantine before auto-dispose is eligible. Default 30. */
    quarantineAutoDisposeMinAgeDays: number;

    // Audit
    createdAt: string;
    updatedAt: string;
    updatedById?: string;
}

export interface SystemSettingsDbRow {
    id: string;
    business_name: string;
    currency_code: string;
    currency_symbol: string;
    date_format: string;
    time_format: string;
    timezone: string;
    tax_enabled: boolean;
    default_tax_rate: string;
    tax_name: string;
    tax_number?: string;
    tax_inclusive: boolean;
    tax_rates: TaxRate[];
    vat_output_requires_registered_customer?: boolean;
    receipt_printer_enabled: boolean;
    receipt_printer_name?: string;
    guest_bill_printer_name?: string | null;
    receipt_paper_width: number;
    receipt_auto_print: boolean;
    receipt_show_logo: boolean;
    receipt_logo_url?: string;
    receipt_header_text?: string;
    receipt_footer_text?: string;
    receipt_show_tax_breakdown: boolean;
    receipt_show_qr_code: boolean;
    invoice_printer_enabled: boolean;
    invoice_printer_name?: string;
    invoice_paper_size: string;
    invoice_template: string;
    invoice_show_logo: boolean;
    invoice_show_payment_terms: boolean;
    invoice_default_payment_terms?: string;
    pos_session_policy: string;
    pos_transaction_mode: string;
    low_stock_alerts_enabled: boolean;
    low_stock_threshold: number;
    is_multistore_enabled: boolean;
    treasury_document_enabled?: boolean;
    restaurant_mode_enabled?: boolean;
    sales_targets_enabled?: boolean;
    kitchen_production_enabled?: boolean;
    loss_quarantine_document_enabled?: boolean;
    transfer_policy_require_approval_all: boolean;
    transfer_policy_allow_direct: boolean;
    transfer_policy_value_threshold: string | null;
    transfer_policy_qty_threshold: string | null;
    transfer_policy_special_stores_require_approval: boolean;
    transfer_assortment_expansion_policy: string;
    expiry_automation_enabled: boolean;
    quarantine_auto_dispose_enabled?: boolean;
    quarantine_auto_dispose_min_age_days?: number;
    created_at: string;
    updated_at: string;
    updated_by_id?: string;
}

export interface UpdateSystemSettingsDto {
    businessName?: string;
    currencyCode?: string;
    currencySymbol?: string;
    dateFormat?: string;
    timeFormat?: string;
    timezone?: string;
    taxEnabled?: boolean;
    defaultTaxRate?: number;
    taxName?: string;
    taxNumber?: string;
    taxInclusive?: boolean;
    taxRates?: TaxRate[];
    vatOutputRequiresRegisteredCustomer?: boolean;
    receiptPrinterEnabled?: boolean;
    receiptPrinterName?: string;
    guestBillPrinterName?: string | null;
    receiptPaperWidth?: number;
    receiptAutoPrint?: boolean;
    receiptShowLogo?: boolean;
    receiptLogoUrl?: string;
    receiptHeaderText?: string;
    receiptFooterText?: string;
    receiptShowTaxBreakdown?: boolean;
    receiptShowQrCode?: boolean;
    invoicePrinterEnabled?: boolean;
    invoicePrinterName?: string;
    invoicePaperSize?: string;
    invoiceTemplate?: string;
    invoiceShowLogo?: boolean;
    invoiceShowPaymentTerms?: boolean;
    invoiceDefaultPaymentTerms?: string;
    posSessionPolicy?: 'DISABLED' | 'PER_CASHIER_SESSION' | 'PER_COUNTER_SHARED_SESSION' | 'GLOBAL_STORE_SESSION';
    posTransactionMode?: 'DirectSale' | 'OrderToPayment';
    lowStockAlertsEnabled?: boolean;
    lowStockThreshold?: number;
    isMultistoreEnabled?: boolean;
    treasuryDocumentEnabled?: boolean;
    restaurantModeEnabled?: boolean;
    salesTargetsEnabled?: boolean;
    kitchenProductionEnabled?: boolean;
    lossQuarantineDocumentEnabled?: boolean;
    transferPolicyRequireApprovalAll?: boolean;
    transferPolicyAllowDirect?: boolean;
    transferPolicyValueThreshold?: number | null;
    transferPolicyQtyThreshold?: number | null;
    transferPolicySpecialStoresRequireApproval?: boolean;
    transferAssortmentExpansionPolicy?: import('./transferAssortment.js').TransferAssortmentExpansionPolicy;
    expiryAutomationEnabled?: boolean;
    quarantineAutoDisposeEnabled?: boolean;
    quarantineAutoDisposeMinAgeDays?: number;
    updatedById?: string;
}

export function normalizeSystemSettings(dbRow: SystemSettingsDbRow): SystemSettings {
    return {
        id: dbRow.id,
        businessName: dbRow.business_name,
        currencyCode: dbRow.currency_code,
        currencySymbol: dbRow.currency_symbol,
        dateFormat: dbRow.date_format,
        timeFormat: dbRow.time_format,
        timezone: dbRow.timezone,
        taxEnabled: dbRow.tax_enabled,
        defaultTaxRate: parseFloat(dbRow.default_tax_rate),
        taxName: dbRow.tax_name,
        taxNumber: dbRow.tax_number,
        taxInclusive: dbRow.tax_inclusive,
        taxRates: dbRow.tax_rates || [],
        vatOutputRequiresRegisteredCustomer:
            dbRow.vat_output_requires_registered_customer ?? false,
        receiptPrinterEnabled: dbRow.receipt_printer_enabled,
        receiptPrinterName: dbRow.receipt_printer_name,
        guestBillPrinterName: dbRow.guest_bill_printer_name?.trim() || undefined,
        receiptPaperWidth: dbRow.receipt_paper_width,
        receiptAutoPrint: dbRow.receipt_auto_print,
        receiptShowLogo: dbRow.receipt_show_logo,
        receiptLogoUrl: dbRow.receipt_logo_url,
        receiptHeaderText: dbRow.receipt_header_text,
        receiptFooterText: dbRow.receipt_footer_text,
        receiptShowTaxBreakdown: dbRow.receipt_show_tax_breakdown,
        receiptShowQrCode: dbRow.receipt_show_qr_code,
        invoicePrinterEnabled: dbRow.invoice_printer_enabled,
        invoicePrinterName: dbRow.invoice_printer_name,
        invoicePaperSize: dbRow.invoice_paper_size,
        invoiceTemplate: dbRow.invoice_template,
        invoiceShowLogo: dbRow.invoice_show_logo,
        invoiceShowPaymentTerms: dbRow.invoice_show_payment_terms,
        invoiceDefaultPaymentTerms: dbRow.invoice_default_payment_terms,
        posSessionPolicy: (dbRow.pos_session_policy || 'DISABLED') as SystemSettings['posSessionPolicy'],
        posTransactionMode: (dbRow.pos_transaction_mode || 'DirectSale') as SystemSettings['posTransactionMode'],
        lowStockAlertsEnabled: dbRow.low_stock_alerts_enabled,
        lowStockThreshold: dbRow.low_stock_threshold,
        isMultistoreEnabled: dbRow.is_multistore_enabled ?? false,
        treasuryDocumentEnabled: dbRow.treasury_document_enabled ?? false,
        restaurantModeEnabled: dbRow.restaurant_mode_enabled ?? false,
        salesTargetsEnabled: dbRow.sales_targets_enabled ?? false,
        kitchenProductionEnabled: dbRow.kitchen_production_enabled ?? false,
        lossQuarantineDocumentEnabled: dbRow.loss_quarantine_document_enabled ?? false,
        transferPolicyRequireApprovalAll: dbRow.transfer_policy_require_approval_all ?? true,
        transferPolicyAllowDirect: dbRow.transfer_policy_allow_direct ?? true,
        transferPolicyValueThreshold:
            dbRow.transfer_policy_value_threshold != null
                ? parseFloat(dbRow.transfer_policy_value_threshold)
                : null,
        transferPolicyQtyThreshold:
            dbRow.transfer_policy_qty_threshold != null
                ? parseFloat(dbRow.transfer_policy_qty_threshold)
                : null,
        transferPolicySpecialStoresRequireApproval:
            dbRow.transfer_policy_special_stores_require_approval ?? true,
        transferAssortmentExpansionPolicy:
            (dbRow.transfer_assortment_expansion_policy as SystemSettings['transferAssortmentExpansionPolicy']) ??
            'PROMPT',
        expiryAutomationEnabled: dbRow.expiry_automation_enabled ?? false,
        quarantineAutoDisposeEnabled: dbRow.quarantine_auto_dispose_enabled ?? false,
        quarantineAutoDisposeMinAgeDays:
            dbRow.quarantine_auto_dispose_min_age_days != null
                ? Number(dbRow.quarantine_auto_dispose_min_age_days)
                : 30,
        createdAt: dbRow.created_at,
        updatedAt: dbRow.updated_at,
        updatedById: dbRow.updated_by_id,
    };
}
