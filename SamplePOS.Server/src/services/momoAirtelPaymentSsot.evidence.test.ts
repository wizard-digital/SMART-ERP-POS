/**
 * Platform SSOT: MoMo / Airtel — no tenant mix, no missing columns, no duplicate GL.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CURRENT_SCHEMA_VERSION } from '../constants/schemaVersion.js';
import {
  MIGRATION_COLUMN_ANCHORS,
  TENANT_REQUIRED_TABLES,
} from '../modules/system/migrationAnchors.js';
import { MIGRATION_POSTCONDITION_FILES } from '../modules/system/migrationPostconditions.js';

const root = process.cwd();
const sharedSql = join(root, '..', 'shared', 'sql');
const sharedZod = join(root, '..', 'shared', 'zod');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

describe('MoMo / Airtel — no tenant mismatch, no missing columns', () => {
  it('CURRENT_SCHEMA_VERSION is 627 with column heal + anchors', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(627);
    const sql627 = readFileSync(join(sharedSql, '627_tenant_banking_momo_column_ssot.sql'), 'utf8');
    expect(sql627).toContain('ADD COLUMN IF NOT EXISTS');
    expect(sql627).toContain('gl_transaction_id');
    expect(sql627).toContain('is_main_cash');
    expect(sql627).toContain('AllowedSources');
    expect(sql627).toContain('AIRTEL_MONEY');
    expect(sql627).toContain('SELECT 627');
  });

  it('column anchors flag missing MoMo/banking columns (Bliss drift cannot hide)', () => {
    expect(MIGRATION_COLUMN_ANCHORS['627_tenant_banking_momo_column_ssot.sql']).toBeDefined();
    expect(MIGRATION_COLUMN_ANCHORS['627_tenant_banking_momo_column_ssot.sql']?.bank_transactions).toEqual(
      expect.arrayContaining(['gl_transaction_id', 'source_type', 'source_id', 'is_reversed']),
    );
    expect(MIGRATION_COLUMN_ANCHORS['627_tenant_banking_momo_column_ssot.sql']?.bank_accounts).toEqual(
      expect.arrayContaining(['gl_account_id', 'account_code', 'is_main_cash']),
    );
    expect(MIGRATION_COLUMN_ANCHORS['625_momo_airtel_payment_ssot.sql']).toBeDefined();
    expect(MIGRATION_COLUMN_ANCHORS['626_bank_mirror_no_duplicate_ssot.sql']).toBeDefined();
  });

  it('every tenant requires banking + payment_methods tables', () => {
    expect(TENANT_REQUIRED_TABLES).toEqual(
      expect.arrayContaining([
        'bank_accounts',
        'bank_transactions',
        'bank_categories',
        'payment_methods',
      ]),
    );
  });

  it('fail-closed postconditions include 627', () => {
    expect(MIGRATION_POSTCONDITION_FILES).toEqual(
      expect.arrayContaining([
        '625_momo_airtel_payment_ssot.sql',
        '626_bank_mirror_no_duplicate_ssot.sql',
        '627_tenant_banking_momo_column_ssot.sql',
      ]),
    );
  });

  it('client POSSaleSchema accepts AIRTEL_MONEY', () => {
    const zod = readFileSync(join(sharedZod, 'pos-sale.ts'), 'utf8');
    expect(zod).toMatch(/z\.enum\(\[[^\]]*AIRTEL_MONEY/);
  });

  it('sale + expense mirrors never createTransaction (no second GL)', () => {
    const svc = read('src/services/bankingService.ts');
    const createFromSale = svc.slice(
      svc.indexOf('static async createFromSale'),
      svc.indexOf('static async createFromExpense'),
    );
    const createFromExpense = svc.slice(
      svc.indexOf('static async createFromExpense'),
      svc.indexOf('static async getTemplates'),
    );
    expect(createFromSale).not.toContain('this.createTransaction');
    expect(createFromExpense).not.toContain('this.createTransaction');
  });
});
