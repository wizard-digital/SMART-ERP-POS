import fs from 'fs';
import path from 'path';
import { describe, expect, it } from '@jest/globals';
import {
  decideCopyMigrationLedgerRow,
  findDriftedMigrationFiles,
  MIGRATION_COLUMN_ANCHORS,
  TENANT_REQUIRED_TABLES,
  migrationHasColumnDrift,
} from './migrationAnchors.js';
import { CURRENT_SCHEMA_VERSION } from '../../constants/schemaVersion.js';

describe('tenantMigrationDrift', () => {
  it('flags 418 when ar_customer_payments is missing (Bliss drift case)', () => {
    const tables = new Set(['customers', 'invoices', 'users']);
    const anchors = {
      '418_ar_customer_payment_allocations.sql': ['ar_customer_payments', 'ar_payment_allocations'],
    };
    const drifted = findDriftedMigrationFiles(tables, anchors);
    expect(drifted).toContain('418_ar_customer_payment_allocations.sql');
  });

  it('passes when AR payment tables exist', () => {
    const anchors = {
      '418_ar_customer_payment_allocations.sql': ['ar_customer_payments', 'ar_payment_allocations'],
    };
    const tables = new Set(['ar_customer_payments', 'ar_payment_allocations']);
    expect(findDriftedMigrationFiles(tables, anchors)).toHaveLength(0);
  });

  it('flags when only one of two anchor tables exists', () => {
    const anchors = {
      '418_ar_customer_payment_allocations.sql': ['ar_customer_payments', 'ar_payment_allocations'],
    };
    const tables = new Set(['ar_customer_payments']);
    expect(findDriftedMigrationFiles(tables, anchors)).toContain(
      '418_ar_customer_payment_allocations.sql',
    );
  });
});

describe('tenant schema SSOT — copy ledger cannot fake apply', () => {
  it('anchors 502 pos_session_policy so a copied filename is not treated as applied', () => {
    expect(MIGRATION_COLUMN_ANCHORS['502_pos_session_enforcement.sql']?.system_settings).toContain(
      'pos_session_policy',
    );
  });

  it('skips copying 502 when the column is missing (Bliss ledger clone)', () => {
    const columnMap = new Map<string, Set<string>>([
      ['system_settings', new Set(['id'])],
      ['sales', new Set(['id'])],
    ]);
    const decision = decideCopyMigrationLedgerRow({
      filename: '502_pos_session_enforcement.sql',
      tableAnchors: {},
      columnMap,
      targetTables: new Set(['system_settings', 'sales']),
      targetViews: new Set(),
      targetCoreSchemaComplete: false,
      hasPostcondition: false,
    });
    expect(decision).toBe('skip-drift');
  });

  it('does not copy unverifiable filenames onto an incomplete tenant', () => {
    const decision = decideCopyMigrationLedgerRow({
      filename: '059_price_rules_seed_data.sql',
      tableAnchors: {},
      columnMap: new Map(),
      targetTables: new Set(['schema_migrations']),
      targetViews: new Set(),
      targetCoreSchemaComplete: false,
      hasPostcondition: false,
    });
    expect(decision).toBe('skip-unproven');
  });

  it('may copy unverifiable filenames onto a complete clone (objects already exist)', () => {
    const decision = decideCopyMigrationLedgerRow({
      filename: '059_price_rules_seed_data.sql',
      tableAnchors: {},
      columnMap: new Map(),
      targetTables: new Set(TENANT_REQUIRED_TABLES),
      targetViews: new Set(),
      targetCoreSchemaComplete: true,
      hasPostcondition: false,
    });
    expect(decision).toBe('copy');
  });

  it('anchors 052/637 so FEFO columns cannot be ledger-faked', () => {
    expect(MIGRATION_COLUMN_ANCHORS['052_pharmacy_features.sql']?.products).toContain(
      'min_days_before_expiry_sale',
    );
    expect(MIGRATION_COLUMN_ANCHORS['637_fefo_allocated_cost_column_ssot.sql']?.inventory_batches).toContain(
      'status',
    );
    expect(MIGRATION_COLUMN_ANCHORS['637_fefo_allocated_cost_column_ssot.sql']?.product_valuation).toContain(
      'cost_price',
    );
  });

  it('CURRENT_SCHEMA_VERSION matches 621–643 MoMo/banking/targets/expense/ownership/FEFO/sale-totals/store-issue/gift SSOT', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(643);
    const sqlDir = path.resolve(process.cwd(), '..', 'shared', 'sql');
    const stamp = fs.readFileSync(path.join(sqlDir, '621_tenant_schema_ssot.sql'), 'utf8');
    expect(stamp).toContain('SELECT 621');
    const reverseSql = fs.readFileSync(path.join(sqlDir, '622_expense_reversal_ssot.sql'), 'utf8');
    expect(reverseSql).toContain('REVERSED');
    const capitalSql = fs.readFileSync(path.join(sqlDir, '624_owner_capital_coa_heal.sql'), 'utf8');
    expect(capitalSql).toContain('OWNER_CAPITAL');
    expect(capitalSql).toContain("'3200'");
    expect(capitalSql).toContain("'3300'");
    expect(capitalSql).toContain('Owner Capital');
    const momoSql = fs.readFileSync(path.join(sqlDir, '625_momo_airtel_payment_ssot.sql'), 'utf8');
    expect(momoSql).toContain('AIRTEL_MONEY');
    expect(momoSql).toContain("'1040'");
    expect(momoSql).toContain('SALES_INVOICE');
    expect(momoSql).toContain('SELECT 625');
    const dupSql = fs.readFileSync(path.join(sqlDir, '626_bank_mirror_no_duplicate_ssot.sql'), 'utf8');
    expect(dupSql).toContain('uq_bank_txn_expense_source_live');
    expect(dupSql).toContain('uq_bank_txn_sale_source_desc_live');
    expect(dupSql).toContain('SELECT 626');
    const colSql = fs.readFileSync(path.join(sqlDir, '627_tenant_banking_momo_column_ssot.sql'), 'utf8');
    expect(colSql).toContain('ADD COLUMN IF NOT EXISTS');
    expect(colSql).toContain('gl_transaction_id');
    expect(colSql).toContain('is_main_cash');
    expect(colSql).toContain('AllowedSources');
    expect(colSql).toContain('SELECT 627');
    const refSql = fs.readFileSync(path.join(sqlDir, '628_drop_ledger_reference_unique_ssot.sql'), 'utf8');
    expect(refSql).toContain('DROP CONSTRAINT IF EXISTS uq_ledger_transactions_reference');
    expect(refSql).toContain('DROP INDEX IF EXISTS uq_ledger_transactions_reference');
    expect(refSql).toContain('DROP INDEX IF EXISTS idx_ledger_transactions_reference_unique');
    expect(refSql).toContain('idx_ledger_transactions_reference');
    const replay = fs.readFileSync(path.join(sqlDir, 'concurrency_idempotency_fixes.sql'), 'utf8');
    expect(replay).not.toContain('ADD CONSTRAINT uq_ledger_transactions_reference');
    expect(replay).toContain('DROP CONSTRAINT IF EXISTS uq_ledger_transactions_reference');
    expect(refSql).toContain('SELECT 628');
    const targetsSql = fs.readFileSync(path.join(sqlDir, '631_sales_targets.sql'), 'utf8');
    expect(targetsSql).toContain('sales_targets');
    expect(targetsSql).toContain('SELECT 631');
    const targetsEnabledSql = fs.readFileSync(path.join(sqlDir, '632_sales_targets_enabled.sql'), 'utf8');
    expect(targetsEnabledSql).toContain('sales_targets_enabled');
    expect(targetsEnabledSql).toContain('SELECT 632');
    const targetsScopeSql = fs.readFileSync(path.join(sqlDir, '633_sales_targets_general_team.sql'), 'utf8');
    expect(targetsScopeSql).toContain('GENERAL');
    expect(targetsScopeSql).toContain('TEAM');
    expect(targetsScopeSql).toContain('SELECT 633');
    const targetsDupSql = fs.readFileSync(path.join(sqlDir, '634_sales_targets_no_duplicate_ssot.sql'), 'utf8');
    expect(targetsDupSql).toContain('uq_sales_target_teams_name_ci');
    expect(targetsDupSql).toContain('SELECT 634');
    const expensePmSql = fs.readFileSync(path.join(sqlDir, '635_expense_payment_method_optional.sql'), 'utf8');
    expect(expensePmSql).toContain('SELECT 635');
    const ownershipSql = fs.readFileSync(path.join(sqlDir, '636_ownership_equity.sql'), 'utf8');
    expect(ownershipSql).toContain("'3400'");
    expect(ownershipSql).toContain('Share Capital');
    expect(ownershipSql).toContain('SOLE_PROPRIETOR');
    expect(ownershipSql).not.toContain('CREATE TRIGGER trg_cost_layer');
    expect(ownershipSql).not.toContain('CREATE OR REPLACE FUNCTION fn_post_cost_layer');
    expect(ownershipSql).toContain('SELECT 636');
    expect(ownershipSql).not.toContain("SET \"AccountName\" = 'Share Capital'");
    expect(ownershipSql).toContain('3200 Owner Capital');
    expect(ownershipSql).toContain('Not owner capital 3200');
    expect(ownershipSql).not.toContain("WHERE \"AccountCode\" = '3200'"); // never retargets 3200 rows
    const fefoColSql = fs.readFileSync(
      path.join(sqlDir, '637_fefo_allocated_cost_column_ssot.sql'),
      'utf8',
    );
    expect(fefoColSql).toContain('min_days_before_expiry_sale');
    expect(fefoColSql).toContain('ADD COLUMN IF NOT EXISTS status');
    expect(fefoColSql).toContain('product_valuation');
    expect(fefoColSql).toContain('SELECT 637');
    const saleTotalsSql = fs.readFileSync(
      path.join(sqlDir, '638_sale_totals_trigger_ssot.sql'),
      'utf8',
    );
    expect(saleTotalsSql).toContain('DROP TRIGGER IF EXISTS trg_sync_sale_totals');
    expect(saleTotalsSql).not.toContain('CREATE TRIGGER trg_sync_sale_totals');
    expect(saleTotalsSql).toContain('SELECT 638');
    const storeIssueSql = fs.readFileSync(
      path.join(sqlDir, '639_store_issue_to_expense.sql'),
      'utf8',
    );
    expect(storeIssueSql).toContain('store_issue_documents');
    expect(storeIssueSql).toContain('INSERT INTO schema_version (version) VALUES (639)');
    const storeIssueUomSql = fs.readFileSync(path.join(sqlDir, '640_store_issue_uom.sql'), 'utf8');
    expect(storeIssueUomSql).toContain('uom_id');
    expect(storeIssueUomSql).toContain('uom_name');
    expect(storeIssueUomSql).toContain('conversion_factor');
    expect(storeIssueUomSql).toContain('INSERT INTO schema_version (version) VALUES (640)');
    const storeIssueReverseSql = fs.readFileSync(
      path.join(sqlDir, '641_store_issue_reversal.sql'),
      'utf8',
    );
    expect(storeIssueReverseSql).toContain('GOODS_ISSUE_REVERSAL');
    expect(storeIssueReverseSql).toContain('REVERSED');
    expect(storeIssueReverseSql).toContain('INSERT INTO schema_version (version) VALUES (641)');
    const storeIssueGovSql = fs.readFileSync(
      path.join(sqlDir, '642_store_issue_reverse_governance.sql'),
      'utf8',
    );
    expect(storeIssueGovSql).toContain('reversal_reason');
    expect(storeIssueGovSql).toContain('kitchen.production.reverse');
    expect(storeIssueGovSql).toContain('INSERT INTO schema_version (version) VALUES (642)');
    expect(MIGRATION_COLUMN_ANCHORS['640_store_issue_uom.sql']?.store_issue_lines).toEqual(
      expect.arrayContaining(['uom_id', 'uom_name', 'conversion_factor']),
    );
    expect(MIGRATION_COLUMN_ANCHORS['641_store_issue_reversal.sql']?.store_issue_documents).toEqual(
      expect.arrayContaining(['reversed_by', 'reversed_at', 'reversal_journal_id']),
    );
    expect(MIGRATION_COLUMN_ANCHORS['642_store_issue_reverse_governance.sql']?.store_issue_documents).toEqual(
      expect.arrayContaining(['reversal_reason']),
    );
    const giftSql = fs.readFileSync(path.join(sqlDir, '643_sale_gift_foc.sql'), 'utf8');
    expect(giftSql).toContain("ADD VALUE 'GIFT'");
    expect(giftSql).toContain('gift_reason');
    expect(giftSql).toContain('gift_amount');
    expect(giftSql).toContain('sales.gift');
    expect(giftSql).toContain("'administrator'");
    expect(giftSql).not.toContain("'Manager'");
    expect(giftSql).toContain('INSERT INTO schema_version (version) VALUES (643)');
    expect(MIGRATION_COLUMN_ANCHORS['643_sale_gift_foc.sql']?.sales).toEqual(
      expect.arrayContaining(['gift_reason', 'gift_amount']),
    );
    const comprehensiveTriggers = fs.readFileSync(
      path.join(sqlDir, 'comprehensive_data_triggers.sql'),
      'utf8',
    );
    expect(comprehensiveTriggers).toContain('DROP TRIGGER IF EXISTS trg_sync_sale_totals');
    expect(comprehensiveTriggers).not.toMatch(
      /CREATE\s+TRIGGER\s+trg_sync_sale_totals/i,
    );
    const sessionSql = fs.readFileSync(path.join(sqlDir, '620_pos_session_policy_ssot.sql'), 'utf8');
    expect(sessionSql).toMatch(/pg_constraint WHERE conname = 'chk_pos_session_policy'/);
    expect(sessionSql).not.toMatch(/^ALTER TABLE system_settings\s+ADD CONSTRAINT/m);
    const catSql = fs.readFileSync(
      path.join(sqlDir, '618_product_category_name_unique_ssot.sql'),
      'utf8',
    );
    expect(catSql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(catSql).not.toMatch(/^\s*COMMIT\s*;/m);
  });

  it('requires banking + MoMo tables on every tenant (no missing-table drift)', () => {
    expect(TENANT_REQUIRED_TABLES).toEqual(
      expect.arrayContaining([
        'cash_register_session_participants',
        'accounts',
        'expenses',
        'bank_accounts',
        'bank_transactions',
        'bank_categories',
        'payment_methods',
      ]),
    );
  });
});

describe('tenant schema SSOT — column drift fail-closed', () => {
  it('flags 627 when bank_transactions.gl_transaction_id is missing', () => {
    const columnMap = new Map<string, Set<string>>([
      ['bank_transactions', new Set(['id', 'amount', 'source_type'])],
      [
        'bank_accounts',
        new Set([
          'id',
          'gl_account_id',
          'account_code',
          'is_main_cash',
          'is_main_bank',
          'is_active',
          'is_default',
          'account_name',
          'account_type',
          'currency_code',
          'opening_balance',
        ]),
      ],
      ['payment_methods', new Set(['code', 'name', 'description', 'requires_reference', 'is_active'])],
      ['bank_categories', new Set(['code', 'name', 'direction'])],
      ['accounts', new Set(['AccountCode', 'AllowedSources', 'SystemAccountTag', 'IsPostingAccount', 'IsActive'])],
    ]);
    expect(migrationHasColumnDrift('627_tenant_banking_momo_column_ssot.sql', columnMap)).toBe(true);
  });

  it('passes 627 when all MoMo/banking columns exist', () => {
    const columnMap = new Map<string, Set<string>>([
      [
        'bank_transactions',
        new Set([
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
        ]),
      ],
      [
        'bank_accounts',
        new Set([
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
        ]),
      ],
      ['payment_methods', new Set(['code', 'name', 'description', 'requires_reference', 'is_active'])],
      ['bank_categories', new Set(['code', 'name', 'direction'])],
      ['accounts', new Set(['AccountCode', 'AllowedSources', 'SystemAccountTag', 'IsPostingAccount', 'IsActive'])],
    ]);
    expect(migrationHasColumnDrift('627_tenant_banking_momo_column_ssot.sql', columnMap)).toBe(false);
  });
});
