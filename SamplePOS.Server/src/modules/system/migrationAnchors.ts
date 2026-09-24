import fs from 'fs';
import path from 'path';

/** Migrations that only apply to the master registry DB — never tenant anchors. */
export const PLATFORM_MIGRATION_FILES = new Set([
    '400_multi_tenant.sql',
]);

/** Tables owned by the master registry — excluded from tenant drift anchors. */
export const PLATFORM_TABLES = new Set([
    'tenants',
    'super_admins',
    'tenant_api_keys',
    'sync_ledger',
    'tenant_audit_log',
    'billing_events',
]);

/** Same filter as migrate.mjs / tenantMigrationService._runPendingMigrations. */
export const MIGRATION_FILE_EXCLUDE = /^999_rollback|^apply-|^fix_|^backfill_/i;

/** Numbered migration files only (NNN_*.sql). */
export const NUMBERED_MIGRATION = /^[0-9]{3}_/;

const CREATE_TABLE_IF_NOT_EXISTS =
    /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(?:public\.)?"?([a-z][a-z0-9_]*)"?/gi;

const BARE_CREATE_TABLE =
    /CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i;

/**
 * Parse idempotent CREATE TABLE targets from a migration SQL file.
 * Returns null when the file contains non-idempotent CREATE TABLE (unsafe to re-run).
 */
export function parseIdempotentTablesFromSql(sql: string): string[] | null {
    if (BARE_CREATE_TABLE.test(sql)) return null;

    const tables: string[] = [];
    CREATE_TABLE_IF_NOT_EXISTS.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CREATE_TABLE_IF_NOT_EXISTS.exec(sql)) !== null) {
        const name = match[1];
        if (!PLATFORM_TABLES.has(name)) {
            tables.push(name);
        }
    }
    return tables;
}

export function resolveSqlDirFromModule(): string {
    const candidates = [
        '/app/shared/sql',
        '/shared/sql',
        path.resolve(process.cwd(), '..', 'shared', 'sql'),
        path.resolve(process.cwd(), 'shared', 'sql'),
    ];
    for (const dir of candidates) {
        if (fs.existsSync(dir)) return dir;
    }
    throw new Error(`Cannot find shared/sql directory. Tried: ${candidates.join(', ')}`);
}

let cachedAnchors: Readonly<Record<string, readonly string[]>> | null = null;

/**
 * Build migration → required-table anchors from idempotent numbered SQL files.
 * Cached for process lifetime.
 */
export function buildMigrationTableAnchors(sqlDir?: string): Readonly<Record<string, readonly string[]>> {
    if (cachedAnchors && !sqlDir) return cachedAnchors;

    const dir = sqlDir ?? resolveSqlDirFromModule();
    const anchors: Record<string, string[]> = {};

    for (const filename of fs.readdirSync(dir).sort()) {
        if (!filename.endsWith('.sql')) continue;
        if (!NUMBERED_MIGRATION.test(filename)) continue;
        if (MIGRATION_FILE_EXCLUDE.test(filename)) continue;
        if (PLATFORM_MIGRATION_FILES.has(filename)) continue;

        const sql = fs.readFileSync(path.join(dir, filename), 'utf-8');
        const tables = parseIdempotentTablesFromSql(sql);
        if (!tables || tables.length === 0) continue;

        anchors[filename] = tables;
    }

    if (!sqlDir) {
        cachedAnchors = anchors;
    }
    return anchors;
}

/** View or legacy-table names that satisfy an anchor table name. */
export const TABLE_SATISFACTION_ALIASES: Readonly<Record<string, readonly string[]>> = {
    dist_invoices: ['dist_invoices', 'dist_invoices_legacy'],
    dist_invoice_lines: ['dist_invoice_lines', 'dist_invoice_lines_legacy'],
};

export function relationSatisfiesAnchor(
    tableName: string,
    existingTables: ReadonlySet<string>,
    existingViews: ReadonlySet<string>,
): boolean {
    const candidates = TABLE_SATISFACTION_ALIASES[tableName] ?? [tableName];
    return candidates.some((name) => existingTables.has(name) || existingViews.has(name));
}

/** ALTER-only migrations verified by column presence (not CREATE TABLE anchors). */
export const MIGRATION_COLUMN_ANCHORS: Readonly<
    Record<string, Readonly<Record<string, readonly string[]>>>
> = {
    '523_products_stock_level_columns.sql': {
        products: ['max_stock_level', 'reorder_point', 'optimal_stock_level'],
    },
    '525_warehouse_network_foundation.sql': {
        system_settings: ['is_multistore_enabled'],
        store_locations: ['code', 'store_type'],
        product_lots: ['lot_number', 'cost_price'],
        inventory_balances: ['store_location_id', 'product_lot_id'],
    },
    '526_warehouse_grn_transfers.sql': {
        goods_receipt_items: ['target_store_location_id'],
        store_transfers: ['transfer_number', 'status', 'transit_store_id'],
        store_transfer_lines: ['store_transfer_id', 'product_lot_id', 'quantity_dispatched'],
    },
    '527_transfer_workflow_engine.sql': {
        store_transfers: ['workflow_mode', 'permission_used', 'total_inventory_value'],
        system_settings: [
            'transfer_policy_require_approval_all',
            'transfer_policy_allow_direct',
        ],
        store_transfer_audit_events: ['store_transfer_id', 'event_type', 'workflow_mode'],
    },
    '528_product_store_distribution.sql': {
        products: ['distribution_policy'],
        product_store_assignments: ['product_id', 'store_location_id', 'is_assigned', 'is_pos_visible'],
    },
    '529_transfer_assortment_expansion.sql': {
        system_settings: ['transfer_assortment_expansion_policy'],
        store_transfers: ['assortment_expansion_decisions'],
    },
    '530_stock_count_store_lot_expiry_automation.sql': {
        stock_count_lines: ['product_lot_id'],
        system_settings: ['expiry_automation_enabled'],
    },
    '531_sale_return_store_trace.sql': {
        sale_items: ['store_location_id', 'product_lot_id'],
        sale_refund_items: ['store_location_id', 'product_lot_id'],
    },
    '532_transfer_line_negotiation.sql': {
        store_transfer_lines: ['quantity_approved', 'quantity_shortage', 'approval_comment'],
    },
    '603_expense_employee_link.sql': {
        expenses: ['employee_id'],
    },
    '604_hr_enterprise_payroll.sql': {
        employee_salary_history: ['EmployeeId', 'EffectiveFrom', 'BasicSalary', 'MonthlyAllowance'],
        leave_types: ['Name', 'IsPaid'],
        leave_requests: ['EmployeeId', 'LeaveTypeId', 'StartDate', 'EndDate', 'Status'],
        payroll_period_adjustments: ['PayrollPeriodId', 'EmployeeId', 'OvertimePay', 'Bonus'],
        hr_statutory_settings: ['Enabled', 'NssfEmployeeRate', 'PayeEnabled', 'WorkingDaysPerMonth'],
        payroll_entries: ['OvertimePay', 'Bonus', 'UnpaidLeaveDays', 'LeaveDeduction', 'NssfEmployee', 'Paye', 'NssfEmployer'],
        employees: ['BankName', 'BankAccountNumber', 'NssfNumber', 'TinNumber'],
    },
    '605_hr_employee_master.sql': {
        employees: [
            'EmployeeNumber',
            'NationalId',
            'DateOfBirth',
            'Gender',
            'Nationality',
            'MaritalStatus',
            'AddressLine1',
            'AddressDistrict',
            'NextOfKinName',
            'NextOfKinPhone',
            'NextOfKinRelation',
            'BankBranch',
            'BankAccountName',
            'MobileMoneyNumber',
            'MobileMoneyProvider',
            'PreferredPaymentMethod',
        ],
    },
    '606_hr_employment_contracts.sql': {
        employee_contracts: [
            'EmployeeId',
            'EmploymentType',
            'StartDate',
            'EndDate',
            'ProbationEndDate',
            'Status',
            'SignedAt',
            'PreviousContractId',
        ],
    },
    '607_hr_payroll_pay_modes.sql': {
        payroll_entries: ['AmountPaid'],
        payroll_periods: ['Status'],
    },
    '608_quarantine_auto_dispose.sql': {
        system_settings: [
            'quarantine_auto_dispose_enabled',
            'quarantine_auto_dispose_min_age_days',
        ],
    },
    '609_lot_split_parent.sql': {
        inventory_batches: ['parent_lot_id'],
    },
    '502_pos_session_enforcement.sql': {
        system_settings: ['pos_session_policy'],
        sales: ['cash_register_session_id'],
    },
    '622_expense_reversal_ssot.sql': {
        expenses: ['reversed_by', 'reversed_at', 'reversal_reason'],
    },
    '625_momo_airtel_payment_ssot.sql': {
        payment_methods: ['code', 'name', 'requires_reference'],
        accounts: ['AccountCode', 'AllowedSources', 'SystemAccountTag'],
        bank_accounts: ['gl_account_id', 'is_active', 'account_code', 'is_main_cash', 'is_main_bank'],
    },
    '626_bank_mirror_no_duplicate_ssot.sql': {
        bank_transactions: ['source_type', 'source_id', 'is_reversed', 'description', 'gl_transaction_id'],
    },
    '627_tenant_banking_momo_column_ssot.sql': {
        payment_methods: ['code', 'name', 'description', 'requires_reference', 'is_active'],
        bank_accounts: [
            'gl_account_id',
            'is_active',
            'is_default',
            'account_code',
            'account_name',
            'account_type',
            'currency_code',
            'opening_balance',
            'is_main_cash',
            'is_main_bank',
        ],
        bank_transactions: [
            'transaction_number',
            'bank_account_id',
            'transaction_date',
            'type',
            'category_id',
            'description',
            'reference',
            'amount',
            'contra_account_id',
            'gl_transaction_id',
            'source_type',
            'source_id',
            'is_reconciled',
            'is_reversed',
            'created_by',
        ],
        bank_categories: ['code', 'name', 'direction'],
        accounts: ['AccountCode', 'AllowedSources', 'SystemAccountTag', 'IsPostingAccount', 'IsActive'],
    },
};

export type TableColumnMap = ReadonlyMap<string, ReadonlySet<string>>;

export function migrationHasColumnDrift(
    filename: string,
    columnMap: TableColumnMap,
): boolean {
    const anchors = MIGRATION_COLUMN_ANCHORS[filename];
    if (!anchors) return false;

    for (const [table, columns] of Object.entries(anchors)) {
        const existing = columnMap.get(table);
        if (!existing) return true;
        if (columns.some((c) => !existing.has(c))) return true;
    }
    return false;
}

export function findColumnDriftedMigrationFiles(
    columnMap: TableColumnMap,
): string[] {
    return Object.keys(MIGRATION_COLUMN_ANCHORS).filter((filename) =>
        migrationHasColumnDrift(filename, columnMap),
    );
}

export type CopyMigrationDecision = 'copy' | 'skip-drift' | 'skip-unproven';

/**
 * Ledger rows are copied only when the target can prove the migration ran,
 * or when the target already has a complete core schema (true template clone).
 * Incomplete DBs must not inherit filenames without DDL (Bliss drift).
 */
export function decideCopyMigrationLedgerRow(args: {
    filename: string;
    tableAnchors: Readonly<Record<string, readonly string[]>>;
    columnMap: TableColumnMap;
    targetTables: ReadonlySet<string>;
    targetViews: ReadonlySet<string>;
    targetCoreSchemaComplete: boolean;
    hasPostcondition: boolean;
}): CopyMigrationDecision {
    const tables = args.tableAnchors[args.filename];
    if (tables?.some((t) => !relationSatisfiesAnchor(t, args.targetTables, args.targetViews))) {
        return 'skip-drift';
    }
    if (migrationHasColumnDrift(args.filename, args.columnMap)) {
        return 'skip-drift';
    }
    const proven =
        Boolean(tables?.length) ||
        Boolean(MIGRATION_COLUMN_ANCHORS[args.filename]) ||
        args.hasPostcondition;
    if (!proven && !args.targetCoreSchemaComplete) {
        return 'skip-unproven';
    }
    return 'copy';
}

/** Which anchor migrations need re-application because required tables are absent. */
export function findDriftedMigrationFiles(
    existingTables: ReadonlySet<string>,
    anchors: Readonly<Record<string, readonly string[]>> = buildMigrationTableAnchors(),
    existingViews: ReadonlySet<string> = new Set(),
): string[] {
    const drifted: string[] = [];
    for (const [filename, requiredTables] of Object.entries(anchors)) {
        if (requiredTables.some((t) => !relationSatisfiesAnchor(t, existingTables, existingViews))) {
            drifted.push(filename);
        }
    }
    return drifted;
}

/**
 * Tables every active tenant must have for core ERP flows.
 * Superset of historical REQUIRED_TABLES — used for startup health checks.
 */
export const TENANT_REQUIRED_TABLES: readonly string[] = [
    'users',
    'schema_migrations',
    'schema_version',
    'products',
    'product_inventory',
    'product_valuation',
    'product_categories',
    'product_uoms',
    'uoms',
    'customers',
    'customer_groups',
    'suppliers',
    'sales',
    'sale_items',
    'invoices',
    'invoice_line_items',
    'invoice_payments',
    'purchase_orders',
    'purchase_order_items',
    'goods_receipts',
    'goods_receipt_items',
    'inventory_batches',
    'stock_movements',
    'accounts',
    'ledger_entries',
    'expenses',
    'system_settings',
    'quotations',
    'quotation_items',
    'ar_customer_payments',
    'ar_payment_allocations',
    'delivery_notes',
    'delivery_note_lines',
    'pos_orders',
    'pos_order_items',
    'sale_refunds',
    'sale_refund_items',
    'item_uom_conversions',
    'supplier_invoice_grn_links',
    'import_jobs',
    'cash_registers',
    'cash_register_sessions',
    'cash_register_session_participants',
    'bank_accounts',
    'bank_transactions',
    'bank_categories',
    'payment_methods',
] as const;

/** Clear cached anchors (tests). */
export function clearMigrationAnchorCache(): void {
    cachedAnchors = null;
}
