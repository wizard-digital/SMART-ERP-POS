/**
 * Add Transaction = quiet bank receipt. Capital defaults to 3200 / 3300 (JE-aligned).
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

describe('Banking Add Transaction — quiet owner capital', () => {
  it('624 heals 3200 Owner Capital and 3300 Owner Drawings (623 may have stamped early)', () => {
    const sql = read('../shared/sql/624_owner_capital_coa_heal.sql');
    expect(sql).toContain("'3200'");
    expect(sql).toContain("'3300'");
    expect(sql).toContain('Owner Capital');
    expect(sql).toContain('Owner Drawings');
    expect(sql).toContain('SELECT 624');
    expect(read('src/constants/schemaVersion.ts')).toMatch(/CURRENT_SCHEMA_VERSION = 627/);
  });

  it('manual BANK_TXN refuses sales, AR, and cash↔cash', () => {
    const svc = read('src/services/bankingService.ts');
    const createFn = svc.slice(
      svc.indexOf('static async createTransaction'),
      svc.indexOf('static async reverseTransaction'),
    );
    expect(createFn).toContain("contraAccountCode === '4000'");
    expect(createFn).toContain("contraAccountCode === '1200'");
    expect(createFn).toContain('Cash↔bank moves use Transfer');
  });

  it('Journal Entries capital preset uses 3200 / 3300', () => {
    const je = read('../samplepos.client/src/pages/JournalEntriesPage.tsx');
    expect(je).toContain("accountNumber === '3200'");
    expect(je).toContain("accountNumber === '3300'");
    expect(je).toContain('capital-investment');
  });
});
