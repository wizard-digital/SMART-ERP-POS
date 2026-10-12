import type { Pool, PoolClient } from 'pg';
import { tableHasColumn } from '../../../db/schemaColumnCache.js';

export type DbConn = Pool | PoolClient;

/** Per-database cache — never share across tenants in one Node process. */
const warehouseTablesExistByDb = new Map<string, boolean>();
const poolDatabaseCache = new WeakMap<object, string>();

async function resolveDatabaseName(conn: DbConn): Promise<string> {
    const cached = poolDatabaseCache.get(conn as object);
    if (cached) return cached;
    const result = await conn.query<{ db: string }>('SELECT current_database() AS db');
    const name = result.rows[0]?.db || 'unknown';
    poolDatabaseCache.set(conn as object, name);
    return name;
}

/**
 * Returns true only when THIS tenant has enabled multistore AND warehouse schema is present.
 * Defaults to false — preserves legacy single-store behaviour.
 * SSOT: decision is always from the connection's database, never another tenant's cache.
 */
export async function isMultistoreEnabled(conn: DbConn): Promise<boolean> {
    const hasFlagColumn = await tableHasColumn(conn, 'system_settings', 'is_multistore_enabled');
    if (!hasFlagColumn) {
        return false;
    }

    const settingsResult = await conn.query<{ enabled: boolean }>(
        `SELECT COALESCE(is_multistore_enabled, false) AS enabled
         FROM system_settings
         LIMIT 1`,
    );

    if (!settingsResult.rows[0]?.enabled) {
        return false;
    }

    return warehouseSchemaExists(conn);
}

async function warehouseSchemaExists(conn: DbConn): Promise<boolean> {
    const db = await resolveDatabaseName(conn);
    const cached = warehouseTablesExistByDb.get(db);
    if (cached !== undefined) {
        return cached;
    }

    const result = await conn.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'store_locations'
         ) AS exists`,
    );

    const exists = result.rows[0]?.exists === true;
    warehouseTablesExistByDb.set(db, exists);
    return exists;
}

/** Test-only: reset cached warehouse schema probe */
export function clearMultistoreSettingsCache(): void {
    warehouseTablesExistByDb.clear();
}
