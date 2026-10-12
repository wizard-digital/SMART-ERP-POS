/**
 * Cross-tenant cache isolation for isMultistoreEnabled / warehouse schema probe.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../../db/schemaColumnCache.js', () => ({
  tableHasColumn: jest.fn(async () => true),
}));

const { isMultistoreEnabled, clearMultistoreSettingsCache } = await import('./multistoreSettings.js');

function mockConn(dbName: string, opts: { multistore: boolean; hasStoreLocations: boolean }) {
  return {
    query: jest.fn(async (sql: string) => {
      const text = String(sql);
      if (text.includes('current_database')) {
        return { rows: [{ db: dbName }] };
      }
      if (text.includes('is_multistore_enabled')) {
        return { rows: [{ enabled: opts.multistore }] };
      }
      if (text.includes('store_locations')) {
        return { rows: [{ exists: opts.hasStoreLocations }] };
      }
      return { rows: [] };
    }),
  };
}

describe('multistoreSettings tenant cache SSOT', () => {
  beforeEach(() => {
    clearMultistoreSettingsCache();
    jest.clearAllMocks();
  });

  it('does not let a tenant without warehouse schema poison a tenant that has it', async () => {
    const legacy = mockConn('pos_tenant_legacy', { multistore: true, hasStoreLocations: false });
    const modern = mockConn('pos_tenant_modern', { multistore: true, hasStoreLocations: true });

    // Probe legacy first — old global cache would stick false for everyone
    await expect(isMultistoreEnabled(legacy as never)).resolves.toBe(false);
    await expect(isMultistoreEnabled(modern as never)).resolves.toBe(true);
  });

  it('does not let a warehouse tenant make a legacy tenant look multistore-capable', async () => {
    const modern = mockConn('pos_tenant_modern', { multistore: true, hasStoreLocations: true });
    const legacy = mockConn('pos_tenant_legacy', { multistore: true, hasStoreLocations: false });

    await expect(isMultistoreEnabled(modern as never)).resolves.toBe(true);
    await expect(isMultistoreEnabled(legacy as never)).resolves.toBe(false);
  });

  it('respects per-tenant multistore flag when schema exists', async () => {
    const on = mockConn('pos_tenant_on', { multistore: true, hasStoreLocations: true });
    const off = mockConn('pos_tenant_off', { multistore: false, hasStoreLocations: true });

    await expect(isMultistoreEnabled(on as never)).resolves.toBe(true);
    await expect(isMultistoreEnabled(off as never)).resolves.toBe(false);
  });
});
