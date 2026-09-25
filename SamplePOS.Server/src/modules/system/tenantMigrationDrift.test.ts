import fs from 'fs';
import path from 'path';
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

  it('CURRENT_SCHEMA_VERSION matches 621–628 MoMo/banking column SSOT', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(628);
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
