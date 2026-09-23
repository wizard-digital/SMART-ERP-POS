import type { Pool } from 'pg';
import {
  CRITICAL_SCHEMA_COLUMNS,
  verifyTenantSchemaIntegrity,
} from './tenantSchemaIntegrity.js';

function mockPool(
  tables: string[],
  columnsByTable: Record<string, string[]>
): Pool {
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('information_schema.tables')) {
        const table = params?.[0] as string;
        return { rows: [{ exists: tables.includes(table) }] };
      }
      if (sql.includes('information_schema.columns')) {
        const table = params?.[0] as string;
        const cols = columnsByTable[table] ?? [];
        return { rows: cols.map((column_name) => ({ column_name })) };
      }
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
  } as unknown as Pool;
}

describe('tenantSchemaIntegrity', () => {
  it('requires customer_group_id on customers (quotations / pricing)', () => {
    expect(CRITICAL_SCHEMA_COLUMNS.customers).toContain('customer_group_id');
  });

  it('requires uom columns on quotation_items', () => {
    expect(CRITICAL_SCHEMA_COLUMNS.quotation_items).toEqual(
      expect.arrayContaining(['uom_id', 'uom_name'])
    );
  });

  it('passes when all critical columns exist', async () => {
    const tables = Object.keys(CRITICAL_SCHEMA_COLUMNS);
    const columnsByTable: Record<string, string[]> = {};
    for (const [table, cols] of Object.entries(CRITICAL_SCHEMA_COLUMNS)) {
      columnsByTable[table] = [...cols];
    }
    const result = await verifyTenantSchemaIntegrity(mockPool(tables, columnsByTable));
    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it('fails when customer_group_id is missing (Bliss drift case)', async () => {
    const tables = ['customers'];
    const columnsByTable = {
      customers: CRITICAL_SCHEMA_COLUMNS.customers.filter((c) => c !== 'customer_group_id'),
    };
    const result = await verifyTenantSchemaIntegrity(mockPool(tables, columnsByTable));
    expect(result.ok).toBe(false);
    expect(result.missing).toContainEqual({ table: 'customers', column: 'customer_group_id' });
  });

  it('fails when pos_session_policy is missing (session SSOT)', async () => {
    const tables = Object.keys(CRITICAL_SCHEMA_COLUMNS);
    const columnsByTable: Record<string, string[]> = {};
    for (const [table, cols] of Object.entries(CRITICAL_SCHEMA_COLUMNS)) {
      columnsByTable[table] = [...cols];
    }
    columnsByTable.system_settings = columnsByTable.system_settings.filter(
      (c) => c !== 'pos_session_policy'
    );
    const result = await verifyTenantSchemaIntegrity(mockPool(tables, columnsByTable));
    expect(result.ok).toBe(false);
    expect(result.missing).toContainEqual({
      table: 'system_settings',
      column: 'pos_session_policy',
    });
  });
});
