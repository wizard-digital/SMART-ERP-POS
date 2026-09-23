import fs from 'fs';
import path from 'path';
import {
  decideCopyMigrationLedgerRow,
  findDriftedMigrationFiles,
  MIGRATION_COLUMN_ANCHORS,
  TENANT_REQUIRED_TABLES,
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

  it('CURRENT_SCHEMA_VERSION matches 621 stamp file and 622 expense reverse', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(622);
    const sqlDir = path.resolve(process.cwd(), '..', 'shared', 'sql');
    const stamp = fs.readFileSync(path.join(sqlDir, '621_tenant_schema_ssot.sql'), 'utf8');
    expect(stamp).toContain('SELECT 621');
    const reverseSql = fs.readFileSync(path.join(sqlDir, '622_expense_reversal_ssot.sql'), 'utf8');
    expect(reverseSql).toContain('REVERSED');
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

  it('requires session tables on every tenant', () => {
    expect(TENANT_REQUIRED_TABLES).toEqual(
      expect.arrayContaining([
        'cash_register_session_participants',
        'accounts',
        'expenses',
      ]),
    );
  });
});
