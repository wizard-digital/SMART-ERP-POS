import fs from 'fs';
import path from 'path';
import {
  buildMigrationTableAnchors,
  clearMigrationAnchorCache,
  findDriftedMigrationFiles,
  parseIdempotentTablesFromSql,
  TENANT_REQUIRED_TABLES,
} from './migrationAnchors.js';

describe('migrationAnchors', () => {
  afterEach(() => {
    clearMigrationAnchorCache();
  });

  it('parses CREATE TABLE IF NOT EXISTS from SQL', () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS ar_customer_payments (id UUID PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS ar_payment_allocations (id UUID PRIMARY KEY);
    `;
    expect(parseIdempotentTablesFromSql(sql)).toEqual([
      'ar_customer_payments',
      'ar_payment_allocations',
    ]);
  });

  it('returns null for non-idempotent CREATE TABLE files', () => {
    const sql = `CREATE TABLE users (id UUID PRIMARY KEY);`;
    expect(parseIdempotentTablesFromSql(sql)).toBeNull();
  });

  it('builds anchors for 418 from shared/sql', () => {
    const sqlDir = path.resolve(process.cwd(), '..', 'shared', 'sql');
    if (!fs.existsSync(sqlDir)) return;

    const anchors = buildMigrationTableAnchors(sqlDir);
    expect(anchors['418_ar_customer_payment_allocations.sql']).toEqual(
      expect.arrayContaining(['ar_customer_payments', 'ar_payment_allocations']),
    );
    expect(anchors['400_multi_tenant.sql']).toBeUndefined();
  });

  it('flags Bliss-style drift when AR tables are missing', () => {
    const anchors = {
      '418_ar_customer_payment_allocations.sql': ['ar_customer_payments', 'ar_payment_allocations'],
    };
    const tables = new Set(['customers', 'invoices']);
    expect(findDriftedMigrationFiles(tables, anchors)).toContain(
      '418_ar_customer_payment_allocations.sql',
    );
  });

  it('treats dist_invoices VIEW as satisfying 014 anchor', () => {
    const anchors = {
      '014_catchup_missing_tables.sql': ['dist_invoices', 'dist_invoice_lines'],
    };
    const tables = new Set(['dist_invoices_legacy', 'dist_invoice_lines_legacy']);
    const views = new Set(['dist_invoices', 'dist_invoice_lines']);
    expect(findDriftedMigrationFiles(tables, anchors, views)).toHaveLength(0);
  });

  it('anchors 620 participants table for drift repair', () => {
    const sqlDir = path.resolve(process.cwd(), '..', 'shared', 'sql');
    if (!fs.existsSync(sqlDir)) return;
    const anchors = buildMigrationTableAnchors(sqlDir);
    expect(anchors['620_pos_session_policy_ssot.sql']).toEqual(
      expect.arrayContaining(['cash_register_session_participants']),
    );
  });
});
