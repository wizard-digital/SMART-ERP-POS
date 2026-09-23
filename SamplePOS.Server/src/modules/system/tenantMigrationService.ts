import type { Pool } from 'pg';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { schemaVersionRepository } from './schemaVersionRepository.js';
import { CURRENT_SCHEMA_VERSION } from '../../constants/schemaVersion.js';
import { assertTenantSchemaIntegrity, verifyTenantSchemaIntegrity } from './tenantSchemaIntegrity.js';
import {
    buildMigrationTableAnchors,
    findDriftedMigrationFiles,
    findColumnDriftedMigrationFiles,
    decideCopyMigrationLedgerRow,
    relationSatisfiesAnchor,
    TENANT_REQUIRED_TABLES,
    NUMBERED_MIGRATION,
    MIGRATION_FILE_EXCLUDE,
    PLATFORM_MIGRATION_FILES,
} from './migrationAnchors.js';
import {
    findPostconditionDriftedMigrationFiles,
    verifyMigrationPostcondition,
    MIGRATION_POSTCONDITION_FILES,
} from './migrationPostconditions.js';
import logger from '../../utils/logger.js';

const { Pool: PgPool } = pg;

async function loadTableColumnMap(pool: Pool): Promise<Map<string, Set<string>>> {
    const { rows } = await pool.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public'`
    );
    const map = new Map<string, Set<string>>();
    for (const row of rows) {
        let cols = map.get(row.table_name);
        if (!cols) {
            cols = new Set<string>();
            map.set(row.table_name, cols);
        }
        cols.add(row.column_name);
    }
    return map;
}

// ============================================================================
// SQL directory resolution
// ============================================================================
// In Docker production:  /app/shared/sql/
// In local development:  ../../shared/sql/ (relative to SamplePOS.Server/)
//
// We try the Docker path first, then fall back to local development path.
function resolveSqlDir(): string {
    const candidates = [
        '/app/shared/sql',                                               // Docker production (if mounted)
        '/shared/sql',                                                   // Docker production (Dockerfile COPY ../shared/sql)
        path.resolve(process.cwd(), '..', 'shared', 'sql'),             // Local (cwd = SamplePOS.Server)
        path.resolve(process.cwd(), 'shared', 'sql'),                   // Local (cwd = repo root)
    ];
    for (const dir of candidates) {
        if (fs.existsSync(dir)) return dir;
    }
    throw new Error(`Cannot find shared/sql directory. Tried: ${candidates.join(', ')}`);
}

// ============================================================================
// Per-tenant migration lock (in-memory)
// ============================================================================
// Prevents concurrent migration attempts for the same tenant DB when
// multiple requests arrive simultaneously for an outdated tenant.
const migrationLocks = new Map<string, Promise<void>>();

// ============================================================================
// Up-to-date cache (in-memory)
// ============================================================================
// Once a tenant has been verified/migrated during this process lifetime,
// skip the DB check on subsequent requests. Cleared on process restart.
const verifiedTenants = new Set<string>();

// Re-export for tests and tooling
export { findDriftedMigrationFiles, buildMigrationTableAnchors, TENANT_REQUIRED_TABLES } from './migrationAnchors.js';

// ============================================================================
// Service
// ============================================================================

export const tenantMigrationService = {
    /**
     * Ensure a tenant database is at CURRENT_SCHEMA_VERSION.
     *
     * Called from tenantMiddleware on every request.
     * Fast path: in-memory set lookup (~1 µs) after first verification.
     * Slow path: one DB query (MAX(version)) on first request per tenant per process.
     *
     * If the tenant is behind, pending migrations are applied atomically.
     * If any migration fails, the error propagates and the request is rejected.
     */
    async ensureTenantUpToDate(tenantPool: Pool, tenantSlug: string): Promise<void> {
        if (verifiedTenants.has(tenantSlug)) return;

        const existing = migrationLocks.get(tenantSlug);
        if (existing) {
            try {
                await existing;
            } catch {
                // Previous attempt failed — retry below rather than treating the tenant as current.
            }
            if (verifiedTenants.has(tenantSlug)) return;
        }

        if (migrationLocks.has(tenantSlug)) {
            const inFlight = migrationLocks.get(tenantSlug);
            if (inFlight) {
                try {
                    await inFlight;
                } catch {
                    /* retry */
                }
                if (verifiedTenants.has(tenantSlug)) return;
            }
        }

        const task = this._doEnsure(tenantPool, tenantSlug);
        migrationLocks.set(tenantSlug, task);
        try {
            await task;
        } finally {
            if (migrationLocks.get(tenantSlug) === task) {
                migrationLocks.delete(tenantSlug);
            }
        }
    },

    async _doEnsure(tenantPool: Pool, tenantSlug: string): Promise<void> {
        // Repair copied-ledger drift, then apply any file not recorded as run.
        await this._repairMigrationTableDrift(tenantPool, tenantSlug);
        await this._runPendingMigrations(tenantPool, tenantSlug);

        const tenantVersion = await schemaVersionRepository.getSchemaVersion(tenantPool);
        if (tenantVersion < CURRENT_SCHEMA_VERSION) {
            logger.warn(
                `Tenant "${tenantSlug}" schema v${tenantVersion} detected. Upgrading to v${CURRENT_SCHEMA_VERSION}...`
            );
            await this._runPendingMigrations(tenantPool, tenantSlug);
        }

        await this._assertTenantSchemaCurrent(tenantPool, tenantSlug);
        await this._ensureApGovernance(tenantPool, tenantSlug);
        verifiedTenants.add(tenantSlug);
        logger.info(`Tenant "${tenantSlug}" schema current at v${await schemaVersionRepository.getSchemaVersion(tenantPool)}.`);
    },

    /**
     * A tenant is current only when files, version, required tables, and
     * critical columns all match. Version alone is not enough (Bliss drift).
     */
    async _assertTenantSchemaCurrent(tenantPool: Pool, tenantSlug: string): Promise<void> {
        const pending = await this._listPendingMigrationFiles(tenantPool);
        if (pending.length > 0) {
            throw new Error(
                `Tenant "${tenantSlug}" has ${pending.length} pending migration(s): ${pending.slice(0, 8).join(', ')}`
            );
        }

        const version = await schemaVersionRepository.getSchemaVersion(tenantPool);
        if (version < CURRENT_SCHEMA_VERSION) {
            throw new Error(
                `Tenant "${tenantSlug}" schema v${version}, expected v${CURRENT_SCHEMA_VERSION}`
            );
        }

        const { rows } = await tenantPool.query<{ tablename: string }>(
            `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
        );
        const existing = new Set(rows.map((r) => r.tablename));
        const missing = TENANT_REQUIRED_TABLES.filter((t) => !existing.has(t));
        if (missing.length > 0) {
            throw new Error(
                `Tenant "${tenantSlug}" missing required table(s): ${missing.join(', ')}`
            );
        }

        await assertTenantSchemaIntegrity(tenantPool, tenantSlug);
    },

    async _listPendingMigrationFiles(tenantPool: Pool): Promise<string[]> {
        await this.ensureSchemaMigrationsTable(tenantPool);
        const { rows: applied } = await tenantPool.query<{ filename: string }>(
            'SELECT filename FROM schema_migrations ORDER BY filename'
        );
        const appliedSet = new Set(applied.map((r) => r.filename));
        return this._discoverNumberedMigrationFiles().filter((f) => !appliedSet.has(f));
    },

    _discoverNumberedMigrationFiles(): string[] {
        const sqlDir = resolveSqlDir();
        return fs
            .readdirSync(sqlDir)
            .filter((f: string) => f.endsWith('.sql'))
            .filter((f: string) => NUMBERED_MIGRATION.test(f))
            .filter((f: string) => !MIGRATION_FILE_EXCLUDE.test(f))
            .filter((f: string) => !PLATFORM_MIGRATION_FILES.has(f))
            .sort();
    },

    async _ensureApGovernance(tenantPool: Pool, tenantSlug: string): Promise<void> {
        try {
            const { ensureTenantApCachesAligned } = await import(
                '../supplier-payments/apBalanceGovernance.js'
            );
            await ensureTenantApCachesAligned(tenantPool, tenantSlug);
        } catch (err) {
            logger.error(`Tenant "${tenantSlug}" AP governance check failed`, { err });
            throw err;
        }
    },

    /**
     * Run pending migrations against a tenant pool.
     * Replicates the logic from shared/sql/migrate.mjs but runs in-process.
     */
    /**
     * Normalize schema_migrations to the canonical shape expected by the runner.
     */
    async ensureSchemaMigrationsTable(pool: Pool): Promise<void> {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id SERIAL PRIMARY KEY,
                filename TEXT UNIQUE NOT NULL,
                executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                checksum TEXT
            );
        `);
        await pool.query(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT`);
    },

    /**
     * Copy migration filenames recorded on a healthy tenant into a target DB.
     * Used when the target schema already exists (template clone) but tracking is incomplete.
     */
    async copyMissingMigrationsFrom(sourcePool: Pool, targetPool: Pool): Promise<number> {
        await this.ensureSchemaMigrationsTable(targetPool);

        const anchors = buildMigrationTableAnchors();
        const { rows: targetTableRows } = await targetPool.query<{ tablename: string }>(
            `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
        );
        const { rows: targetViewRows } = await targetPool.query<{ viewname: string }>(
            `SELECT viewname FROM pg_views WHERE schemaname = 'public'`
        );
        const targetTables = new Set(targetTableRows.map((r) => r.tablename));
        const targetViews = new Set(targetViewRows.map((r) => r.viewname));
        const targetColumns = await loadTableColumnMap(targetPool);
        const missingRequired = TENANT_REQUIRED_TABLES.filter((t) => !targetTables.has(t));
        const integrity = await verifyTenantSchemaIntegrity(targetPool);
        const targetCoreSchemaComplete = missingRequired.length === 0 && integrity.ok;

        const { rows: sourceRows } = await sourcePool.query<{
            filename: string;
            executed_at: Date | string | null;
            checksum: string | null;
        }>('SELECT filename, executed_at, checksum FROM schema_migrations ORDER BY filename');

        const { rows: targetRows } = await targetPool.query<{ filename: string }>(
            'SELECT filename FROM schema_migrations'
        );
        const existing = new Set(targetRows.map((r) => r.filename));

        let inserted = 0;
        let skippedDrift = 0;
        for (const row of sourceRows) {
            if (existing.has(row.filename)) continue;

            const decision = decideCopyMigrationLedgerRow({
                filename: row.filename,
                tableAnchors: anchors,
                columnMap: targetColumns,
                targetTables,
                targetViews,
                targetCoreSchemaComplete,
                hasPostcondition: (MIGRATION_POSTCONDITION_FILES as readonly string[]).includes(
                    row.filename
                ),
            });
            if (decision !== 'copy') {
                skippedDrift++;
                continue;
            }

            if (
                (MIGRATION_POSTCONDITION_FILES as readonly string[]).includes(row.filename) &&
                !(await verifyMigrationPostcondition(targetPool, row.filename))
            ) {
                skippedDrift++;
                continue;
            }

            await targetPool.query(
                'INSERT INTO schema_migrations (filename, executed_at, checksum) VALUES ($1, COALESCE($2, now()), $3)',
                [row.filename, row.executed_at, row.checksum]
            );
            inserted++;
        }

        if (skippedDrift > 0) {
            logger.info(
                `Skipped copying ${skippedDrift} migration record(s) — target missing objects or incomplete core schema (will run DDL)`
            );
        }

        return inserted;
    },

    /**
     * Mirror schema_version rows from a reference tenant so version checks match migration history.
     */
    async copySchemaVersionFromReference(sourcePool: Pool, targetPool: Pool): Promise<void> {
        await targetPool.query(`
            CREATE TABLE IF NOT EXISTS schema_version (
                id SERIAL PRIMARY KEY,
                version INTEGER NOT NULL,
                applied_at TIMESTAMPTZ DEFAULT now()
            )
        `);

        const sourceVersion = await schemaVersionRepository.getSchemaVersion(sourcePool);
        const targetVersion = await schemaVersionRepository.getSchemaVersion(targetPool);

        if (targetVersion >= sourceVersion) return;

        await targetPool.query('DELETE FROM schema_version');
        const { rows } = await sourcePool.query<{ version: number; applied_at: Date | string | null }>(
            'SELECT version, applied_at FROM schema_version ORDER BY version'
        );
        for (const row of rows) {
            await targetPool.query(
                'INSERT INTO schema_version (version, applied_at) VALUES ($1, COALESCE($2, now()))',
                [row.version, row.applied_at]
            );
        }
    },

    /**
     * Find an ACTIVE tenant DB at the current schema version with complete migration history.
     */
    async findReferenceTenantPool(masterPool: Pool): Promise<{ pool: Pool; slug: string } | null> {
        const dbUser = process.env.DB_USER || 'postgres';
        const dbPassword = process.env.DB_PASSWORD || process.env.DATABASE_PASSWORD || 'password';

        const { rows } = await masterPool.query<{
            slug: string;
            database_name: string;
            database_host: string;
            database_port: number;
        }>(
            `SELECT slug, database_name, database_host, database_port
             FROM tenants
             WHERE status = 'ACTIVE' AND database_name IS NOT NULL
             ORDER BY created_at DESC`
        );

        for (const tenant of rows) {
            const pool = new PgPool({
                host: tenant.database_host,
                port: tenant.database_port,
                database: tenant.database_name,
                user: dbUser,
                password: dbPassword,
                max: 2,
                idleTimeoutMillis: 5000,
                connectionTimeoutMillis: 10000,
            });

            try {
                const version = await schemaVersionRepository.getSchemaVersion(pool);
                if (version < CURRENT_SCHEMA_VERSION) {
                    await pool.end().catch(() => { /* ignore */ });
                    continue;
                }

                const { rows: migRows } = await pool.query<{ c: number }>(
                    `SELECT count(*)::int AS c FROM schema_migrations WHERE filename ~ '^[0-9]{3}_'`
                );
                if ((migRows[0]?.c ?? 0) < 50) {
                    await pool.end().catch(() => { /* ignore */ });
                    continue;
                }

                await this.ensureSchemaMigrationsTable(pool);
                const { rows: checksumCol } = await pool.query<{ exists: boolean }>(
                    `SELECT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public'
                          AND table_name = 'schema_migrations'
                          AND column_name = 'checksum'
                    ) AS exists`
                );
                if (!checksumCol[0]?.exists) {
                    await pool.end().catch(() => { /* ignore */ });
                    continue;
                }

                const integrity = await verifyTenantSchemaIntegrity(pool);
                if (!integrity.ok) {
                    await pool.end().catch(() => { /* ignore */ });
                    continue;
                }

                return { pool, slug: tenant.slug };
            } catch {
                await pool.end().catch(() => { /* ignore */ });
            }
        }

        return null;
    },

    /**
     * Align a target DB (template or new tenant) with a healthy reference tenant, then apply pending migrations.
     */
    async syncDatabaseFromReference(
        referencePool: Pool,
        targetPool: Pool,
        referenceSlug: string,
        targetLabel: string
    ): Promise<void> {
        const copied = await this.copyMissingMigrationsFrom(referencePool, targetPool);
        if (copied > 0) {
            logger.info(
                `Copied ${copied} schema_migrations from "${referenceSlug}" to "${targetLabel}"`
            );
        }

        await this.copySchemaVersionFromReference(referencePool, targetPool);
        await this.ensureTenantUpToDate(targetPool, targetLabel);

        const version = await schemaVersionRepository.getSchemaVersion(targetPool);
        if (version < CURRENT_SCHEMA_VERSION) {
            throw new Error(
                `"${targetLabel}" schema v${version} still behind v${CURRENT_SCHEMA_VERSION} after sync`
            );
        }
    },

    /**
     * Finalize a freshly cloned tenant DB before activation.
     * When masterPool is provided, mirrors migration tracking from a healthy reference
     * tenant first (same as template sync) so pending DDL does not re-run on cloned schema.
     */
    async prepareNewTenantDatabase(
        tenantPool: Pool,
        tenantSlug: string,
        masterPool?: Pool,
    ): Promise<void> {
        await this.ensureSchemaMigrationsTable(tenantPool);

        if (masterPool) {
            const reference = await this.findReferenceTenantPool(masterPool);
            if (reference) {
                try {
                    await this.syncDatabaseFromReference(
                        reference.pool,
                        tenantPool,
                        reference.slug,
                        tenantSlug,
                    );
                } finally {
                    await reference.pool.end().catch(() => { /* ignore */ });
                }
            } else {
                await this.ensureTenantUpToDate(tenantPool, tenantSlug);
                const version = await schemaVersionRepository.getSchemaVersion(tenantPool);
                if (version < CURRENT_SCHEMA_VERSION) {
                    throw new Error(
                        `Tenant "${tenantSlug}" provisioning incomplete: schema v${version}, expected v${CURRENT_SCHEMA_VERSION}`
                    );
                }
            }
        } else {
            await this.ensureTenantUpToDate(tenantPool, tenantSlug);
            const version = await schemaVersionRepository.getSchemaVersion(tenantPool);
            if (version < CURRENT_SCHEMA_VERSION) {
                throw new Error(
                    `Tenant "${tenantSlug}" provisioning incomplete: schema v${version}, expected v${CURRENT_SCHEMA_VERSION}`
                );
            }
        }

        await assertTenantSchemaIntegrity(tenantPool, tenantSlug);
    },

    async _applyMigrationFile(
        tenantPool: Pool,
        tenantSlug: string,
        filename: string,
        sqlDir: string,
    ): Promise<void> {
        const filePath = path.join(sqlDir, filename);
        const sql = fs.readFileSync(filePath, 'utf-8');
        const checksum = crypto.createHash('sha256').update(sql).digest('hex');

        const client = await tenantPool.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query(
                `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)
                 ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, executed_at = now()`,
                [filename, checksum]
            );
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => { /* ignore rollback error */ });
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`Tenant "${tenantSlug}" migration failed on ${filename}: ${msg}`);
        } finally {
            client.release();
        }
    },

    /**
     * Re-apply anchor migrations when tracking says "applied" but tables/columns are absent.
     */
    async _repairMigrationTableDrift(tenantPool: Pool, tenantSlug: string): Promise<void> {
        const sqlDir = resolveSqlDir();
        await this.ensureSchemaMigrationsTable(tenantPool);

        const { rows } = await tenantPool.query<{ tablename: string }>(
            `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
        );
        const { rows: viewRows } = await tenantPool.query<{ viewname: string }>(
            `SELECT viewname FROM pg_views WHERE schemaname = 'public'`
        );
        const existingTables = new Set(rows.map((r) => r.tablename));
        const existingViews = new Set(viewRows.map((r) => r.viewname));
        const columnMap = await loadTableColumnMap(tenantPool);
        const anchors = buildMigrationTableAnchors();

        const tableDrifted = findDriftedMigrationFiles(existingTables, anchors, existingViews);
        const columnDrifted = findColumnDriftedMigrationFiles(columnMap);
        const postconditionDrifted = await findPostconditionDriftedMigrationFiles(tenantPool);
        const toRepair = [...new Set([...tableDrifted, ...columnDrifted, ...postconditionDrifted])].sort();

        for (const filename of toRepair) {
            const filePath = path.join(sqlDir, filename);
            if (!fs.existsSync(filePath)) {
                logger.error(
                    `Tenant "${tenantSlug}" drift on ${filename} but SQL file not found`
                );
                continue;
            }

            const missingTables = anchors[filename]?.filter(
                (t) => !relationSatisfiesAnchor(t, existingTables, existingViews),
            ) ?? [];
            const detail =
                missingTables.length > 0
                    ? `${missingTables.join(', ')} missing`
                    : postconditionDrifted.includes(filename)
                      ? `constraint/account postcondition failed on ${filename}`
                      : `column drift on ${filename}`;
            logger.warn(
                `Tenant "${tenantSlug}" migration drift: ${detail} — re-applying ${filename}`
            );

            await this._applyMigrationFile(tenantPool, tenantSlug, filename, sqlDir);
            logger.info(`Tenant "${tenantSlug}": drift repair ✅ ${filename}`);

            for (const table of anchors[filename] ?? []) {
                existingTables.add(table);
            }
            const refreshed = await loadTableColumnMap(tenantPool);
            for (const [table, cols] of refreshed) {
                columnMap.set(table, cols);
            }
        }
    },

    async _runPendingMigrations(tenantPool: Pool, tenantSlug: string): Promise<void> {
        const sqlDir = resolveSqlDir();

        await this.ensureSchemaMigrationsTable(tenantPool);

        const pending = await this._listPendingMigrationFiles(tenantPool);
        if (pending.length === 0) {
            return;
        }

        logger.info(`Tenant "${tenantSlug}": applying ${pending.length} pending migration(s)...`);

        for (const filename of pending) {
            await this._applyMigrationFile(tenantPool, tenantSlug, filename, sqlDir);
            logger.info(`Tenant "${tenantSlug}": ✅ ${filename}`);
        }
    },

    isVerified(tenantSlug: string): boolean {
        return verifiedTenants.has(tenantSlug);
    },

    /**
     * Clear the in-memory verified set. Useful for testing.
     */
    clearCache(): void {
        verifiedTenants.clear();
        migrationLocks.clear();
    },

    // ========================================================================
    // Startup: sync ALL tenants to master schema version
    // ========================================================================

    /**
     * Required tables that every tenant DB must have for core features.
     * If any are missing after migration, a CRITICAL error is logged.
     */
    REQUIRED_TABLES: TENANT_REQUIRED_TABLES,

    /**
     * Sync ALL active tenants to current schema version.
     * Called at application startup and by the CLI `migrate:tenants` command.
     *
     * Returns a summary of what happened per tenant.
     */
    async syncAllTenants(masterPool: Pool): Promise<{
        total: number;
        upgraded: number;
        upToDate: number;
        failed: string[];
    }> {
        const result = { total: 0, upgraded: 0, upToDate: 0, failed: [] as string[] };

        // 1. Read all active tenants from master registry
        const { rows: tenants } = await masterPool.query<{
            slug: string;
            database_name: string;
            database_host: string;
            database_port: number;
        }>(
            `SELECT slug, database_name, database_host, database_port
             FROM tenants WHERE status = 'ACTIVE'`
        );
        result.total = tenants.length;

        if (tenants.length === 0) {
            logger.info('No active tenants found — nothing to sync.');
            return result;
        }

        logger.info(`Starting tenant schema sync for ${tenants.length} active tenant(s)...`);

        // 2. For each tenant, connect and run pending migrations
        const dbUser = process.env.DB_USER || 'postgres';
        const dbPassword = process.env.DB_PASSWORD || process.env.DATABASE_PASSWORD || 'password';

        for (const tenant of tenants) {
            let tenantPool: pg.Pool | null = null;
            try {
                tenantPool = new PgPool({
                    host: tenant.database_host,
                    port: tenant.database_port,
                    database: tenant.database_name,
                    user: dbUser,
                    password: dbPassword,
                    max: 3, // small pool for migration work
                    idleTimeoutMillis: 5000,
                    connectionTimeoutMillis: 10000,
                });

                // Set UTC timezone on every connection
                tenantPool.on('connect', (client: pg.PoolClient) => {
                    client.query('SET timezone = "UTC"');
                });

                const versionBefore = await schemaVersionRepository.getSchemaVersion(tenantPool);

                await this._repairMigrationTableDrift(tenantPool, tenant.slug);
                await this._runPendingMigrations(tenantPool, tenant.slug);
                await this._assertTenantSchemaCurrent(tenantPool, tenant.slug);
                await this._ensureApGovernance(tenantPool, tenant.slug);

                const versionAfter = await schemaVersionRepository.getSchemaVersion(tenantPool);
                verifiedTenants.add(tenant.slug);

                if (versionBefore >= CURRENT_SCHEMA_VERSION && versionAfter >= CURRENT_SCHEMA_VERSION) {
                    result.upToDate++;
                } else if (versionAfter >= CURRENT_SCHEMA_VERSION) {
                    result.upgraded++;
                    logger.info(
                        `Tenant "${tenant.slug}" upgraded from v${versionBefore} to v${versionAfter}`
                    );
                } else {
                    throw new Error(
                        `Tenant "${tenant.slug}" still at v${versionAfter}, expected v${CURRENT_SCHEMA_VERSION}`
                    );
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                result.failed.push(tenant.slug);
                verifiedTenants.delete(tenant.slug);
                logger.error(`Tenant "${tenant.slug}" migration FAILED: ${msg}`);
            } finally {
                if (tenantPool) {
                    await tenantPool.end().catch(() => { /* ignore */ });
                }
            }
        }

        // 3. Summary
        logger.info(
            `Tenant schema sync complete: ${result.total} total, ${result.upgraded} upgraded, ${result.upToDate} up-to-date, ${result.failed.length} failed`
        );
        if (result.failed.length > 0) {
            logger.error(`FAILED tenants: ${result.failed.join(', ')}`);
        }

        return result;
    },

    /**
     * Startup health check: verify all active tenants have required tables.
     * Logs CRITICAL for any missing tables. Non-blocking — does not prevent startup.
     */
    async healthCheckAllTenants(masterPool: Pool): Promise<void> {
        const { rows: tenants } = await masterPool.query<{
            slug: string;
            database_name: string;
            database_host: string;
            database_port: number;
        }>(
            `SELECT slug, database_name, database_host, database_port
             FROM tenants WHERE status = 'ACTIVE'`
        );

        if (tenants.length === 0) return;

        const dbUser = process.env.DB_USER || 'postgres';
        const dbPassword = process.env.DB_PASSWORD || process.env.DATABASE_PASSWORD || 'password';

        for (const tenant of tenants) {
            let tenantPool: pg.Pool | null = null;
            try {
                tenantPool = new PgPool({
                    host: tenant.database_host,
                    port: tenant.database_port,
                    database: tenant.database_name,
                    user: dbUser,
                    password: dbPassword,
                    max: 2,
                    idleTimeoutMillis: 5000,
                    connectionTimeoutMillis: 10000,
                });

                await this._assertTenantSchemaCurrent(tenantPool, tenant.slug);
                logger.info(`Tenant "${tenant.slug}" health check OK — schema current`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                verifiedTenants.delete(tenant.slug);
                logger.error(`CRITICAL: Tenant "${tenant.slug}" health check FAILED: ${msg}`);
            } finally {
                if (tenantPool) {
                    await tenantPool.end().catch(() => { /* ignore */ });
                }
            }
        }
    },
};
