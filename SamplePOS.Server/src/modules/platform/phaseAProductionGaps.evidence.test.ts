/**
 * Phase A production gaps — source evidence (DIST AR SSOT, sync cost lock, Sales Rep RBAC).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from '@jest/globals';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('Phase A production gaps', () => {
  it('syncService refuses edge overwrite of inventory_batches cost columns', () => {
    const sync = readFileSync(
      path.join(serverRoot, 'src/modules/platform/syncService.ts'),
      'utf8',
    );
    expect(sync).toContain('CLOUD_OWNED_INVENTORY_COST_COLUMNS');
    expect(sync).toContain('original_cost_price');
    expect(sync).toMatch(
      /inventory_batches[\s\S]*CLOUD_OWNED_INVENTORY_COST_COLUMNS/,
    );
    expect(sync).toContain(
      "filter((c) => !(tableName === 'inventory_batches' && CLOUD_OWNED_INVENTORY_COST_COLUMNS.has(c)))",
    );
  });

  it('Sales Representative seed excludes privileged sales corrections', () => {
    const tenant = readFileSync(
      path.join(serverRoot, 'src/modules/platform/tenantService.ts'),
      'utf8',
    );
    const salesRepBlock = tenant.slice(
      tenant.indexOf("name: 'Sales Representative'"),
      tenant.indexOf("name: 'HR Manager'"),
    );
    expect(salesRepBlock).toContain('sales.tax_restatement');
    expect(salesRepBlock).toContain('sales.tax_override');
    expect(salesRepBlock).toContain('sales.reassign_customer');
    expect(salesRepBlock).toMatch(/!\[[\s\S]*sales\.tax_restatement/);
  });

  it('heal script targets Sales Representative privileged keys', () => {
    const heal = readFileSync(
      path.join(serverRoot, 'scripts/heal-sales-rep-privileged-sales-rbac.mjs'),
      'utf8',
    );
    expect(heal).toContain('sales.tax_restatement');
    expect(heal).toContain('sales.tax_override');
    expect(heal).toContain('sales.reassign_customer');
    expect(heal).toContain('Sales Representative');
    expect(heal).toContain('--apply');
  });
});
