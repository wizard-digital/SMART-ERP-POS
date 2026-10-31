/**
 * HANDLER PROOF: Store Issue enabled + posts use the tenant database.
 *
 * Production bug: kitchen-production/issues/enabled read global DATABASE_URL
 * (pos_system), so a tenant with restaurant ON still got enabled=false.
 *
 * Run: node --experimental-vm-modules ./node_modules/jest/bin/jest.js src/modules/kitchen-production/storeIssueEnabled.tenantPool.harness.test.ts --no-coverage --forceExit
 */
import { jest, describe, it, expect } from '@jest/globals';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request } from 'express';
import type { Pool } from 'pg';

type MockFn = (...args: unknown[]) => Promise<unknown>;

const tenantPool = { id: 'tenant' } as unknown as Pool;
const platformPool = { id: 'platform' } as unknown as Pool;

const mockIsRestaurant = jest.fn<MockFn>();
const mockTableExists = jest.fn<MockFn>().mockResolvedValue(true);

jest.unstable_mockModule('../../db/pool.js', () => ({ pool: platformPool }));

jest.unstable_mockModule('../restaurant/restaurantSettings.js', () => ({
  isRestaurantModeEnabled: mockIsRestaurant,
}));

jest.unstable_mockModule('./storeIssueRepository.js', () => ({
  storeIssueRepository: { tableExists: mockTableExists },
}));

const { kitchenDb } = await import('./kitchenDb.js');
const { storeIssueService } = await import('./storeIssueService.js');

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dir, '../../../..');

describe('store issue enabled uses tenant pool', () => {
  it('kitchenDb prefers req.tenantPool over global DATABASE_URL', () => {
    expect(kitchenDb({ tenantPool } as Request)).toBe(tenantPool);
    expect(kitchenDb({} as Request)).toBe(platformPool);
    expect(kitchenDb({ tenantPool: undefined } as Request)).toBe(platformPool);
  });

  it('isEnabled is true on the tenant when restaurant is on there, even if platform is off', async () => {
    mockIsRestaurant.mockImplementation(async (conn: unknown) => conn === tenantPool);

    const onTenant = await storeIssueService.isEnabled(tenantPool);
    const onPlatform = await storeIssueService.isEnabled(platformPool);

    expect(onTenant).toBe(true);
    expect(onPlatform).toBe(false);
    expect(mockIsRestaurant).toHaveBeenCalledWith(tenantPool);
    expect(mockIsRestaurant).toHaveBeenCalledWith(platformPool);

    const payload = {
      title: 'PROOF_STORE_ISSUE_TENANT_POOL_ENABLED',
      runAt: new Date().toISOString(),
      verdict: 'PASS',
      exercised: 'kitchenDb(req) + storeIssueService.isEnabled(tenant vs platform)',
      tenantEnabled: onTenant,
      platformEnabled: onPlatform,
    };
    writeFileSync(
      path.join(repoRoot, 'PROOF_STORE_ISSUE_TENANT_POOL_ENABLED.json'),
      JSON.stringify(payload, null, 2),
    );
    writeFileSync(
      path.join(repoRoot, 'SamplePOS.Server/PROOF_STORE_ISSUE_TENANT_POOL_ENABLED.json'),
      JSON.stringify(payload, null, 2),
    );
  });
});
