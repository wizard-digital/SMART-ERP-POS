/**
 * PROOF: legacy trg_invoice_payment_sync / PascalCase InvoiceNumber cannot remain.
 * Live root cause (Bliss Interior 2026-11-02): ERR_SALE_007
 *   column "InvoiceNumber" does not exist
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from '@jest/globals';
import { LEGACY_TRIGGERS_BY_MIGRATION } from '../system/legacyTriggerPostconditions.js';
import { MIGRATION_POSTCONDITION_FILES } from '../system/migrationPostconditions.js';
import { CURRENT_SCHEMA_VERSION } from '../../constants/schemaVersion.js';

const repoRoot = path.resolve(process.cwd(), '..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

describe('PROOF: drop legacy invoice payment sync (PascalCase InvoiceNumber)', () => {
  it('migration 645 drops trigger + function and stamps schema 645', () => {
    const sql = read('shared/sql/645_drop_legacy_invoice_payment_sync.sql');
    expect(sql).toContain('DROP TRIGGER IF EXISTS trg_invoice_payment_sync ON invoice_payments');
    expect(sql).toContain('DROP FUNCTION IF EXISTS fn_sync_invoice_payment() CASCADE');
    expect(sql).toContain('INSERT INTO schema_version (version) VALUES (645)');
    expect(CURRENT_SCHEMA_VERSION).toBe(645);
  });

  it('postcondition + legacy trigger registry keep the trigger absent forever', () => {
    expect(MIGRATION_POSTCONDITION_FILES).toContain(
      '645_drop_legacy_invoice_payment_sync.sql',
    );
    const pairs = LEGACY_TRIGGERS_BY_MIGRATION['645_drop_legacy_invoice_payment_sync.sql'];
    expect(pairs).toEqual(
      expect.arrayContaining([['invoice_payments', 'trg_invoice_payment_sync']]),
    );
    const post = read('SamplePOS.Server/src/modules/system/migrationPostconditions.ts');
    expect(post).toContain('fn_sync_invoice_payment');
    expect(post).toContain('645_drop_legacy_invoice_payment_sync.sql');
  });

  it('ERR_SALE_007 carries reason and UI does not claim sale completed', () => {
    const svc = read('SamplePOS.Server/src/modules/sales/salesService.ts');
    expect(svc).toMatch(/ERR_SALE_007[\s\S]{0,200}reason:\s*invoiceFailReason/);
    const ui = read('samplepos.client/src/utils/errorHandler.ts');
    expect(ui).toContain('Credit sale invoice failed (sale was not saved)');
    expect(ui).not.toContain('Credit sale completed but invoice creation failed');
  });

  it('comprehensive_invoice_triggers never recreates the sync trigger (second-time root cause)', () => {
    const sql = read('shared/sql/comprehensive_invoice_triggers.sql');
    expect(sql).toContain('DROP TRIGGER IF EXISTS trg_invoice_payment_sync');
    expect(sql).not.toMatch(/CREATE\s+TRIGGER\s+trg_invoice_payment_sync/i);
    expect(sql).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+fn_sync_invoice_payment/i);
  });
});
