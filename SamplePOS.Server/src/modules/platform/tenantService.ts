// Tenant Provisioning Service
// File: SamplePOS.Server/src/modules/platform/tenantService.ts
//
// Handles tenant lifecycle: provisioning, suspension, plan changes.
// Provisioning uses PostgreSQL TEMPLATE database for instant, consistent cloning.
// The template DB is refreshed from a healthy reference tenant on startup and before each provision.

import type pg from 'pg';
import bcrypt from 'bcrypt';
import { execSync, type ExecSyncOptions } from 'child_process';
import { connectionManager } from '../../db/connectionManager.js';
import { tenantRepository } from './tenantRepository.js';
import { getAllPermissions } from '../../rbac/permissions.js';
import {
  isSystemAccountantPermission,
  isSystemCashierPermission,
  isSystemManagerPermission,
  isSystemWaiterPermission,
} from '@shared/authorization/systemRoleGrants.js';
import { normalizeTenant, PLAN_LIMITS } from '../../../../shared/types/tenant.js';
import type {
  Tenant,
  TenantDbRow,
  CreateTenantRequest,
  TenantUsage,
} from '../../../../shared/types/tenant.js';
import { invalidateTenantCache } from '../../middleware/tenantMiddleware.js';
import { tenantMigrationService } from '../system/tenantMigrationService.js';
import { assertTenantSchemaIntegrity } from '../system/tenantSchemaIntegrity.js';
import { CURRENT_SCHEMA_VERSION } from '../../constants/schemaVersion.js';
import logger from '../../utils/logger.js';

const TEMPLATE_DB_NAME = 'pos_template';

/** Run pg_dump/psql via shell with PGPASSWORD in env (works on Windows + Linux). */
function pgShellExec(command: string, dbPassword: string, options?: ExecSyncOptions): string {
  const execOptions: ExecSyncOptions = {
    encoding: 'utf-8',
    shell: process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh',
    env: { ...process.env, PGPASSWORD: dbPassword },
    ...options,
  };
  return execSync(command, execOptions) as string;
}

// Tables that every tenant MUST have — provisioning fails if any are missing
const CRITICAL_TABLES = [
  'users',
  'products',
  'product_inventory',
  'product_valuation',
  'sales',
  'sale_items',
  'customers',
  'suppliers',
  'purchase_orders',
  'purchase_order_items',
  'goods_receipts',
  'goods_receipt_items',
  'inventory_batches',
  'stock_movements',
  'accounts',
  'ledger_entries',
  'journal_entries',
  'journal_entry_lines',
  'invoices',
  'invoice_line_items',
  'audit_log',
  'system_settings',
  'uoms',
  'product_uoms',
  'refresh_tokens',
  'user_sessions',
  'cash_registers',
  'cash_register_sessions',
  'expenses',
  'ar_customer_payments',
  'ar_payment_allocations',
  'quotations',
  'quotation_items',
  'delivery_notes',
  'delivery_note_lines',
  'product_inventory',
  'product_valuation',
  'system_settings',
  'goods_receipts',
  'goods_receipt_items',
] as const;

// Platform-only tables excluded from template
const PLATFORM_TABLES = [
  'tenants',
  'super_admins',
  'tenant_api_keys',
  'tenant_audit_log',
  'sync_ledger',
  'billing_events',
  'schema_migrations',
  '__EFMigrationsHistory',
];

export const tenantService = {
  /**
   * List all tenants with pagination and filtering
   */
  async listTenants(
    masterPool: pg.Pool,
    options: { page: number; limit: number; status?: string; plan?: string; search?: string }
  ): Promise<{ tenants: Tenant[]; total: number; page: number; totalPages: number }> {
    const offset = (options.page - 1) * options.limit;
    const { rows, total } = await tenantRepository.findAll(masterPool, {
      status: options.status,
      plan: options.plan,
      search: options.search,
      limit: options.limit,
      offset,
    });

    return {
      tenants: rows.map(normalizeTenant),
      total,
      page: options.page,
      totalPages: Math.ceil(total / options.limit),
    };
  },

  /**
   * Get a single tenant by ID
   */
  async getTenant(masterPool: pg.Pool, tenantId: string): Promise<Tenant | null> {
    const row = await tenantRepository.findById(masterPool, tenantId);
    return row ? normalizeTenant(row) : null;
  },

  /**
   * Provision a new tenant: create database, run schema, seed admin user
   */
  async provisionTenant(
    masterPool: pg.Pool,
    input: CreateTenantRequest,
    actor: string
  ): Promise<Tenant> {
    // 1. Check slug uniqueness
    const existing = await tenantRepository.findBySlug(masterPool, input.slug);
    if (existing) {
      throw new Error(`Tenant slug '${input.slug}' is already taken`);
    }

    const plan = input.plan || 'FREE';
    const limits = PLAN_LIMITS[plan];
    const databaseName = `pos_tenant_${input.slug.replace(/-/g, '_')}`;
    const databaseHost = process.env.DB_HOST || 'localhost';
    const databasePort = parseInt(process.env.DB_PORT || '5432', 10);

    // 2. Create tenant record (status = PROVISIONING)
    const tenantRow = await tenantRepository.create(masterPool, {
      slug: input.slug,
      name: input.name,
      databaseName,
      databaseHost,
      databasePort,
      plan,
      billingEmail: input.billingEmail,
      country: input.country || 'UG',
      currency: input.currency || 'UGX',
      timezone: input.timezone || 'Africa/Kampala',
      maxUsers: limits.maxUsers,
      maxProducts: limits.maxProducts,
      maxLocations: limits.maxLocations,
      storageLimitMb: limits.storageLimitMb,
    });

    try {
      // 3. Create the PostgreSQL database from template
      await this.createDatabaseFromTemplate(masterPool, databaseName);

      // 4. Connect to the new tenant DB and validate the cloned schema
      const tenantPool = connectionManager.getPool({
        tenantId: tenantRow.id,
        slug: input.slug,
        databaseName,
        databaseHost,
        databasePort,
      });

      await this.validateTenantSchema(tenantPool, databaseName);

      // 4b. Ensure migration tracking + schema version match production before go-live
      await tenantMigrationService.prepareNewTenantDatabase(tenantPool, input.slug, masterPool);

      // 5. Seed the admin user
      await this.seedAdminUser(tenantPool, {
        email: input.ownerEmail,
        password: input.ownerPassword,
        fullName: input.ownerFullName,
      });

      // 5b. Seed internal system user (required for automated GL posting audit trail)
      await this.seedSystemUser(tenantPool);

      // 6. Seed default system settings
      await this.seedSystemSettings(tenantPool, {
        companyName: input.name,
        currency: input.currency || 'UGX',
        country: input.country || 'UG',
        timezone: input.timezone || 'Africa/Kampala',
      });

      // 7. Ensure RBAC + UOM data exists (fallback if template didn't include them)
      const { rows: rbacCheck } = await tenantPool.query(
        'SELECT count(*)::int AS cnt FROM rbac_roles'
      );
      if ((rbacCheck[0]?.cnt ?? 0) === 0) {
        logger.info('RBAC roles missing — seeding defaults');
        await this.seedDefaultRbac(tenantPool);
      }

      const { rows: uomCheck } = await tenantPool.query('SELECT count(*)::int AS cnt FROM uoms');
      if ((uomCheck[0]?.cnt ?? 0) === 0) {
        logger.info('UOMs missing — seeding defaults');
        await this.seedDefaultUoms(tenantPool);
      }

      // 8. Assign admin user the Super Administrator RBAC role
      await this.assignAdminRbacRole(tenantPool, input.ownerEmail);

      // 9. Activate the tenant
      const activated = await tenantRepository.updateStatus(masterPool, tenantRow.id, 'ACTIVE');

      // 10. Log the provisioning
      await tenantRepository.logAudit(masterPool, tenantRow.id, 'PROVISIONED', actor, {
        plan,
        databaseName,
        ownerEmail: input.ownerEmail,
      });

      logger.info(`Tenant provisioned: ${input.slug} → ${databaseName}`, {
        tenantId: tenantRow.id,
      });

      return normalizeTenant(activated || tenantRow);
    } catch (error) {
      // Rollback: mark as failed, log error
      await tenantRepository.updateStatus(masterPool, tenantRow.id, 'DEACTIVATED');
      await tenantRepository.logAudit(masterPool, tenantRow.id, 'PROVISIONING_FAILED', actor, {
        error: error instanceof Error ? error.message : String(error),
      });

      logger.error(`Tenant provisioning failed: ${input.slug}`, { error });

      // Try to clean up the database
      try {
        await this.dropDatabase(masterPool, databaseName);
      } catch (dropErr) {
        logger.error(`Failed to drop database after provisioning failure: ${databaseName}`, {
          error: dropErr,
        });
      }

      throw new Error(
        `Failed to provision tenant: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },

  /**
   * Suspend a tenant (disable access but keep data)
   */
  async suspendTenant(
    masterPool: pg.Pool,
    tenantId: string,
    actor: string,
    reason?: string
  ): Promise<Tenant> {
    const updated = await tenantRepository.updateStatus(masterPool, tenantId, 'SUSPENDED');
    if (!updated) throw new Error('Tenant not found');

    await tenantRepository.logAudit(masterPool, tenantId, 'SUSPENDED', actor, { reason });
    invalidateTenantCache(tenantId, updated.slug);

    // Remove the pool so no more queries go through
    await connectionManager.removePool(tenantId);

    return normalizeTenant(updated);
  },

  /**
   * Deactivate a tenant (soft-delete: disable access, remove pool, keep data)
   */
  async deactivateTenant(
    masterPool: pg.Pool,
    tenantId: string,
    actor: string,
    reason?: string
  ): Promise<Tenant> {
    const updated = await tenantRepository.updateStatus(masterPool, tenantId, 'DEACTIVATED');
    if (!updated) throw new Error('Tenant not found');

    await tenantRepository.logAudit(masterPool, tenantId, 'DEACTIVATED', actor, { reason });
    invalidateTenantCache(tenantId, updated.slug);

    // Remove the pool so no more queries go through
    await connectionManager.removePool(tenantId);

    return normalizeTenant(updated);
  },

  /**
   * Reactivate a suspended tenant
   */
  async activateTenant(masterPool: pg.Pool, tenantId: string, actor: string): Promise<Tenant> {
    const updated = await tenantRepository.updateStatus(masterPool, tenantId, 'ACTIVE');
    if (!updated) throw new Error('Tenant not found');

    await tenantRepository.logAudit(masterPool, tenantId, 'ACTIVATED', actor);
    invalidateTenantCache(tenantId, updated.slug);

    return normalizeTenant(updated);
  },

  /**
   * Update tenant settings (plan, limits, metadata)
   */
  async updateTenant(
    masterPool: pg.Pool,
    tenantId: string,
    data: Record<string, unknown>,
    actor: string
  ): Promise<Tenant> {
    // If plan is changing, update limits to match
    if (data.plan && typeof data.plan === 'string') {
      const limits = PLAN_LIMITS[data.plan as keyof typeof PLAN_LIMITS];
      if (limits) {
        // Use plan defaults unless explicitly overridden in this request
        data.maxUsers = data.maxUsers ?? limits.maxUsers;
        data.maxProducts = data.maxProducts ?? limits.maxProducts;
        data.maxLocations = data.maxLocations ?? limits.maxLocations;
        data.storageLimitMb = data.storageLimitMb ?? limits.storageLimitMb;
      }
    }

    const updated = await tenantRepository.update(masterPool, tenantId, data);
    if (!updated) throw new Error('Tenant not found');

    await tenantRepository.logAudit(masterPool, tenantId, 'UPDATED', actor, data);
    invalidateTenantCache(tenantId, updated.slug);

    return normalizeTenant(updated);
  },

  /**
   * Get tenant usage statistics by querying the tenant's database
   */
  async getTenantUsage(masterPool: pg.Pool, tenantId: string): Promise<TenantUsage> {
    const tenant = await tenantRepository.findById(masterPool, tenantId);
    if (!tenant) throw new Error('Tenant not found');

    const tenantPool = connectionManager.getPool({
      tenantId: tenant.id,
      slug: tenant.slug,
      databaseName: tenant.database_name,
      databaseHost: tenant.database_host,
      databasePort: tenant.database_port,
    });

    // Query the tenant database for usage stats (each with fallback to prevent partial failure)
    const fallback = { rows: [{ count: 0 }] };
    const [users, products, sales, dbSize] = await Promise.all([
      tenantPool.query('SELECT COUNT(*)::int as count FROM users WHERE is_active = true')
        .catch(() => fallback),
      tenantPool.query('SELECT COUNT(*)::int as count FROM products')
        .catch(() => fallback),
      tenantPool.query(
        `SELECT COUNT(*)::int as count FROM sales 
         WHERE sale_date >= date_trunc('month', CURRENT_DATE)
           AND status = 'COMPLETED'`
      ).catch(() => fallback),
      tenantPool
        .query(`SELECT pg_database_size(current_database())::bigint as size_bytes`)
        .catch(() => ({ rows: [{ size_bytes: 0 }] })),
    ]);

    const sizeBytes = Number(dbSize.rows[0]?.size_bytes || 0);
    const storageMb = Math.round((sizeBytes / (1024 * 1024)) * 100) / 100;

    return {
      tenantId,
      userCount: users.rows[0]?.count || 0,
      productCount: products.rows[0]?.count || 0,
      locationCount: 1, // TODO: implement locations table
      storageUsedMb: storageMb,
      salesThisMonth: sales.rows[0]?.count || 0,
    };
  },

  // ============================================================
  // Template Database Management
  // ============================================================

  /**
   * Ensure the template database exists and is up-to-date.
   * Called on server startup and before each tenant provisioning.
   *
   * Schema is cloned from a healthy reference tenant when available (accurate migration
   * history). Falls back to pos_system schema dump on first install.
   */
  async ensureTemplateDatabase(masterPool: pg.Pool): Promise<void> {
    const dbHost = process.env.DB_HOST || 'localhost';
    const dbPort = process.env.DB_PORT || '5432';
    const dbUser = process.env.DB_USER || 'postgres';
    const dbPassword = process.env.DB_PASSWORD || 'password';
    const masterDbName = process.env.DB_NAME || 'pos_system';

    const reference = await tenantMigrationService.findReferenceTenantPool(masterPool);
    const schemaSourceDb = reference
      ? (await masterPool.query<{ database_name: string }>(
          `SELECT database_name FROM tenants WHERE slug = $1`,
          [reference.slug]
        )).rows[0]?.database_name ?? masterDbName
      : masterDbName;

    if (reference) {
      logger.info(`Template schema source: reference tenant "${reference.slug}" (${schemaSourceDb})`);
      await reference.pool.end().catch(() => { /* released after lookup */ });
    } else {
      logger.warn('No reference tenant at current schema version — template will use pos_system schema');
    }

    const client = await masterPool.connect();
    let rebuildRequired = false;
    try {
      const { rows } = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [
        TEMPLATE_DB_NAME,
      ]);

      if (rows.length > 0) {
        const templateVersion = this.getTemplateSchemaVersion(
          dbHost,
          dbPort,
          dbUser,
          dbPassword
        );

        if (templateVersion >= CURRENT_SCHEMA_VERSION) {
          logger.info(
            `Template DB at schema v${templateVersion} (target v${CURRENT_SCHEMA_VERSION})`
          );
          await this.syncTemplateDatabase(masterPool);
          return;
        }

        logger.info(
          `Template DB stale (v${templateVersion} vs v${CURRENT_SCHEMA_VERSION}), rebuilding...`
        );
        rebuildRequired = true;

        await client.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [TEMPLATE_DB_NAME]
        );
        await client.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB_NAME}`);
      } else {
        rebuildRequired = true;
      }

      if (rebuildRequired) {
        await client.query(`CREATE DATABASE ${TEMPLATE_DB_NAME}`);
        logger.info(`Created empty template database: ${TEMPLATE_DB_NAME}`);
      }
    } finally {
      client.release();
    }

    if (!rebuildRequired) {
      return;
    }

    // Clone schema from reference tenant (preferred) or master registry DB
    const excludeArgs = PLATFORM_TABLES.map((t) => `--exclude-table=${t}`).join(' ');

    const pgDumpCmd =
      `pg_dump -h ${dbHost} -p ${dbPort} -U ${dbUser} ` +
      `--schema-only --no-owner --no-privileges ${excludeArgs} ${schemaSourceDb}`;
    const psqlCmd =
      `psql -h ${dbHost} -p ${dbPort} -U ${dbUser} ` +
      `-d ${TEMPLATE_DB_NAME} -v ON_ERROR_STOP=0`;

    try {
      pgShellExec(`${pgDumpCmd} | ${psqlCmd}`, dbPassword, {
        timeout: 120_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      logger.info(`Template database schema loaded from ${schemaSourceDb}`);

      // Seed essential reference data — migration history is synced separately
      const seedTables = [
        'accounts',
        'uoms',
        'rbac_permissions_catalog',
        'rbac_roles',
        'rbac_role_permissions',
      ];
      const seedSourceDb = reference ? schemaSourceDb : masterDbName;
      for (const table of seedTables) {
        try {
          const dumpDataCmd =
            `pg_dump -h ${dbHost} -p ${dbPort} -U ${dbUser} ` +
            `--data-only --table=${table} --no-owner --no-privileges ${seedSourceDb}`;
          pgShellExec(`${dumpDataCmd} | ${psqlCmd}`, dbPassword, {
            timeout: 15_000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          logger.info(`Template seeded with ${table} data`);
        } catch {
          logger.warn(`Could not seed ${table} data into template (non-fatal)`);
        }
      }

      // RBAC data is now seeded via pg_dump (included in seedTables above).
      // The seedDefaultRbac() fallback in createTenant() handles any gaps.

      // Zero out account balances — template must start clean.
      // The accounts seed copies CurrentBalance from master (which has real data).
      // New tenants must not inherit those balances.
      try {
        pgShellExec(
          `psql -h ${dbHost} -p ${dbPort} -U ${dbUser} ` +
          `-d ${TEMPLATE_DB_NAME} -c 'UPDATE accounts SET "CurrentBalance" = 0 WHERE "CurrentBalance" != 0;'`,
          dbPassword,
          { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        logger.info('Template account balances zeroed out');
      } catch {
        logger.warn('Could not zero template account balances (non-fatal)');
      }

      // Seed internal system user required for automated GL journal entry audit trail
      try {
        pgShellExec(
          `psql -h ${dbHost} -p ${dbPort} -U ${dbUser} ` +
          `-d ${TEMPLATE_DB_NAME} -c "INSERT INTO users (id, email, password_hash, full_name, role, is_active, user_number) ` +
          `VALUES ('00000000-0000-0000-0000-000000000000', 'system@internal', 'NOLOGIN', 'System', 'ADMIN', false, 'SYS-0000') ` +
          `ON CONFLICT (id) DO NOTHING;"`,
          dbPassword,
          { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        logger.info('Template seeded with system user');
      } catch {
        logger.warn('Could not seed system user into template (non-fatal)');
      }
    } catch (error: unknown) {
      // Check if enough tables were created despite warnings
      let tableCount = 0;
      try {
        const result = pgShellExec(
          `psql -h ${dbHost} -p ${dbPort} -U ${dbUser} ` +
          `-d ${TEMPLATE_DB_NAME} -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"`,
          dbPassword,
          { timeout: 10_000 },
        );
        tableCount = parseInt(result.trim(), 10) || 0;
      } catch {
        /* ignore */
      }

      if (tableCount < CRITICAL_TABLES.length) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`Template DB creation failed (${tableCount} tables): ${msg}`);
        // Drop the broken template so next attempt rebuilds
        const dropClient = await masterPool.connect();
        try {
          await dropClient.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB_NAME}`);
        } finally {
          dropClient.release();
        }
        throw new Error(`Failed to create template database: only ${tableCount} tables`);
      }

      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`Template DB loaded with warnings (${tableCount} tables): ${msg}`);
    }

    await this.syncTemplateDatabase(masterPool);
  },

  /**
   * Reconcile pos_template migration tracking with a healthy reference tenant.
   */
  async syncTemplateDatabase(masterPool: pg.Pool): Promise<void> {
    const reference = await tenantMigrationService.findReferenceTenantPool(masterPool);
    if (!reference) {
      logger.warn(
        'Template migration sync skipped — no ACTIVE tenant at current schema version to use as reference'
      );
      return;
    }

    const templatePool = this.getTemplatePool();
    try {
      await tenantMigrationService.syncDatabaseFromReference(
        reference.pool,
        templatePool,
        reference.slug,
        '__template__'
      );
      await assertTenantSchemaIntegrity(templatePool, '__template__');
      logger.info(`Template database migration state synced from "${reference.slug}"`);
    } finally {
      await reference.pool.end().catch(() => { /* ignore */ });
    }
  },

  getTemplatePool(): pg.Pool {
    return connectionManager.getPool({
      tenantId: '00000000-0000-0000-0000-000000000001',
      slug: '__template__',
      databaseName: TEMPLATE_DB_NAME,
      databaseHost: process.env.DB_HOST || 'localhost',
      databasePort: parseInt(process.env.DB_PORT || '5432', 10),
      plan: 'FREE',
    });
  },

  getTemplateSchemaVersion(
    dbHost: string,
    dbPort: string,
    dbUser: string,
    dbPassword: string
  ): number {
    try {
      const result = pgShellExec(
        `psql -h ${dbHost} -p ${dbPort} -U ${dbUser} ` +
        `-d ${TEMPLATE_DB_NAME} -t -A -c "SELECT COALESCE(MAX(version), 0) FROM schema_version"`,
        dbPassword,
        { timeout: 10_000 },
      );
      return parseInt(result.trim(), 10) || 0;
    } catch {
      return 0;
    }
  },

  // ============================================================
  // Tenant Database Management
  // ============================================================

  /**
   * Create a new tenant database using PostgreSQL TEMPLATE cloning.
   * This is instant — PostgreSQL copies all tables, indexes, constraints,
   * sequences, enums, and defaults in a single atomic operation.
   *
   * Falls back to pg_dump if template cloning fails.
   */
  async createDatabaseFromTemplate(masterPool: pg.Pool, databaseName: string): Promise<void> {
    const safeName = databaseName.replace(/[^a-z0-9_]/gi, '');
    const client = await masterPool.connect();
    try {
      // Check if database already exists
      const exists = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [
        databaseName,
      ]);
      if (exists.rows.length > 0) {
        logger.warn(`Database ${databaseName} already exists, skipping creation`);
        return;
      }

      // Ensure template is up-to-date before cloning
      await this.ensureTemplateDatabase(masterPool);

      // Terminate any lingering connections to the template
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEMPLATE_DB_NAME]
      );

      // Clone via TEMPLATE — instant, atomic, includes everything
      await client.query(`CREATE DATABASE ${safeName} TEMPLATE ${TEMPLATE_DB_NAME}`);
      logger.info(`Created tenant database from template: ${safeName}`);
    } catch (error) {
      // Fallback: create empty DB + pg_dump schema clone
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`Template clone failed, falling back to pg_dump: ${msg}`);
      await this.createDatabaseFallback(masterPool, safeName);
    } finally {
      client.release();
    }
  },

  /**
   * Fallback: create DB + clone schema via pg_dump (if TEMPLATE fails).
   */
  async createDatabaseFallback(masterPool: pg.Pool, databaseName: string): Promise<void> {
    const dbHost = process.env.DB_HOST || 'localhost';
    const dbPort = process.env.DB_PORT || '5432';
    const dbUser = process.env.DB_USER || 'postgres';
    const dbPassword = process.env.DB_PASSWORD || 'password';
    const masterDbName = process.env.DB_NAME || 'pos_system';

    const client = await masterPool.connect();
    try {
      const exists = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [
        databaseName,
      ]);
      if (exists.rows.length === 0) {
        await client.query(`CREATE DATABASE ${databaseName}`);
      }
    } finally {
      client.release();
    }

    const excludeArgs = PLATFORM_TABLES.map((t) => `--exclude-table=${t}`).join(' ');

    const pgDumpCmd =
      `pg_dump -h ${dbHost} -p ${dbPort} -U ${dbUser} ` +
      `--schema-only --no-owner --no-privileges ${excludeArgs} ${masterDbName}`;
    const psqlCmd =
      `psql -h ${dbHost} -p ${dbPort} -U ${dbUser} ` +
      `-d ${databaseName} -v ON_ERROR_STOP=0`;

    pgShellExec(`${pgDumpCmd} | ${psqlCmd}`, dbPassword, {
      timeout: 60_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    logger.info(`Fallback schema clone completed for ${databaseName}`);
  },

  /**
   * Validate that a newly created tenant DB has all critical tables.
   */
  async validateTenantSchema(tenantPool: pg.Pool, databaseName: string): Promise<void> {
    const { rows } = await tenantPool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const existingTables = new Set(rows.map((r: { table_name: string }) => r.table_name));

    const missingTables = CRITICAL_TABLES.filter((t) => !existingTables.has(t));
    if (missingTables.length > 0) {
      throw new Error(
        `Tenant ${databaseName} is missing ${missingTables.length} critical tables: ${missingTables.join(', ')}`
      );
    }

    logger.info(
      `Tenant schema validated: ${existingTables.size} tables, all ${CRITICAL_TABLES.length} critical tables present`
    );
  },

  /**
   * Drop a tenant database (destructive — use with caution)
   */
  async dropDatabase(masterPool: pg.Pool, databaseName: string): Promise<void> {
    const client = await masterPool.connect();
    try {
      const safeName = databaseName.replace(/[^a-z0-9_]/gi, '');

      // Terminate connections
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [safeName]
      );

      await client.query(`DROP DATABASE IF EXISTS ${safeName}`);
      logger.info(`Dropped database: ${safeName}`);
    } finally {
      client.release();
    }
  },

  /**
   * Seed the initial admin user in a tenant database.
   * Uses user_number_seq for the auto-generated user number.
   */
  async seedAdminUser(
    tenantPool: pg.Pool,
    user: { email: string; password: string; fullName: string }
  ): Promise<void> {
    const passwordHash = await bcrypt.hash(user.password, 12);

    await tenantPool.query(
      `INSERT INTO users (email, password_hash, full_name, role, is_active, user_number)
       VALUES ($1, $2, $3, 'ADMIN', true, 'USR-' || LPAD(nextval('user_number_seq')::TEXT, 4, '0'))
       ON CONFLICT (email) DO NOTHING`,
      [user.email, passwordHash, user.fullName]
    );

    logger.info(`Seeded admin user: ${user.email}`);
  },

  /**
   * Seed the internal system user used for automated GL journal entries.
   * This user cannot log in (is_active = false, password = 'NOLOGIN').
   * Required because audit_log.user_id has a FK to users.id.
   */
  async seedSystemUser(tenantPool: pg.Pool): Promise<void> {
    await tenantPool.query(
      `INSERT INTO users (id, email, password_hash, full_name, role, is_active, user_number)
       VALUES ($1, $2, $3, $4, $5, false, $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        '00000000-0000-0000-0000-000000000000',
        'system@internal',
        'NOLOGIN',
        'System',
        'ADMIN',
        'SYS-0000',
      ]
    );
    logger.info('Seeded internal system user (GL audit trail)');
  },

  /**
   * Seed default system settings for a tenant.
   * Uses the structured system_settings schema (not key/value).
   */
  async seedSystemSettings(
    tenantPool: pg.Pool,
    config: { companyName: string; currency: string; country: string; timezone: string }
  ): Promise<void> {
    // system_settings is a single-row structured table, not key/value
    await tenantPool.query(
      `INSERT INTO system_settings (business_name, currency_code, currency_symbol, timezone, default_tax_rate, tax_name)
       VALUES ($1, $2, $3, $4, 18.00, 'VAT')
       ON CONFLICT DO NOTHING`,
      [
        config.companyName,
        config.currency,
        config.currency === 'UGX' ? 'USh' : config.currency,
        config.timezone,
      ]
    );

    // Accounts (chart of accounts) are pre-seeded in the template from master.
    // Verify they exist; if not (fallback path), copy from master.
    const { rows } = await tenantPool.query(`SELECT count(*)::int AS cnt FROM accounts`);
    if ((rows[0]?.cnt ?? 0) === 0) {
      logger.warn('Accounts not found in tenant — seeding from master via fallback');
      await this.seedAccountsFromMaster(tenantPool);
    }

    logger.info('Seeded system settings');
  },

  /**
   * Copy chart of accounts from master DB into tenant.
   * Only used as fallback when template didn't include accounts data.
   */
  async seedAccountsFromMaster(tenantPool: pg.Pool): Promise<void> {
    const dbHost = process.env.DB_HOST || 'localhost';
    const dbPort = process.env.DB_PORT || '5432';
    const dbUser = process.env.DB_USER || 'postgres';
    const dbPassword = process.env.DB_PASSWORD || 'password';
    const masterDbName = process.env.DB_NAME || 'pos_system';

    // Get the tenant's database name from the pool config
    const { rows: dbRows } = await tenantPool.query('SELECT current_database()');
    const tenantDbName = dbRows[0]?.current_database;
    if (!tenantDbName) {
      logger.error('Could not determine tenant database name for accounts seed');
      return;
    }

    try {
      const dumpCmd =
        `pg_dump -h ${dbHost} -p ${dbPort} -U ${dbUser} ` +
        `--data-only --table=accounts --no-owner --no-privileges ${masterDbName}`;
      const loadCmd =
        `psql -h ${dbHost} -p ${dbPort} -U ${dbUser} ` +
        `-d ${tenantDbName} -v ON_ERROR_STOP=0`;

      pgShellExec(`${dumpCmd} | ${loadCmd}`, dbPassword, {
        timeout: 15_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      logger.info('Seeded accounts from master database');
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to seed accounts from master: ${msg}`);
    }
  },

  /**
   * Seed default UOMs into a tenant when template didn't include them.
   */
  async seedDefaultUoms(tenantPool: pg.Pool): Promise<void> {
    await tenantPool.query(`
      INSERT INTO uoms (id, name, symbol, type) VALUES
        (gen_random_uuid(), 'Each', 'EA', 'QUANTITY'),
        (gen_random_uuid(), 'Box', 'BOX', 'QUANTITY'),
        (gen_random_uuid(), 'Carton', 'CTN', 'QUANTITY'),
        (gen_random_uuid(), 'Dozen', 'DZ', 'QUANTITY'),
        (gen_random_uuid(), 'Kilogram', 'kg', 'QUANTITY'),
        (gen_random_uuid(), 'Packet', 'PKT', 'QUANTITY'),
        (gen_random_uuid(), 'Bottle', 'btl', 'QUANTITY'),
        (gen_random_uuid(), 'Piece', 'pc', 'QUANTITY')
      ON CONFLICT DO NOTHING
    `);
  },

  /**
   * Seed RBAC roles + permissions into a tenant DB directly (fallback when template lacks them).
   * Uses getAllPermissions() from permissions.ts as single source of truth.
   */
  async seedDefaultRbac(tenantPool: pg.Pool): Promise<void> {
    const sysUser = '00000000-0000-0000-0000-000000000001';
    const permissions = getAllPermissions();

    // 1. Seed ALL permissions from the canonical catalog
    for (const perm of permissions) {
      await tenantPool.query(
        `INSERT INTO rbac_permissions_catalog (key, module, action, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET
           module = EXCLUDED.module, action = EXCLUDED.action, description = EXCLUDED.description`,
        [perm.key, perm.module, perm.action, perm.description]
      );
    }

    // 2. Seed all 9 system roles matching production
    const roleConfigs: Array<{
      name: string;
      desc: string;
      filter: (perm: { key: string; module: string; action: string }) => boolean;
    }> = [
        {
          name: 'Super Administrator',
          desc: 'Full system access - all permissions',
          filter: () => true,
        },
        {
          name: 'Administrator',
          desc: 'Administrative access — full permissions (aligned with legacy ADMIN)',
          filter: () => true,
        },
        {
          name: 'Manager',
          desc: 'Operational management - sales, inventory, purchasing, accounting',
          filter: (p) => isSystemManagerPermission(p),
        },
        {
          name: 'Cashier',
          desc: 'Point of sale operations',
          filter: (p) => isSystemCashierPermission(p),
        },
        {
          name: 'Waiter',
          desc: 'Restaurant floor service — open checks, KOT, and bill (no kitchen config or payment)',
          filter: (p) => isSystemWaiterPermission(p),
        },
        {
          name: 'Auditor',
          desc: 'Read-only access for auditing purposes',
          filter: (p) => p.action === 'read',
        },
        {
          name: 'Accountant',
          desc: 'Financial operations - accounting, banking, payments, and reporting',
          filter: (p) => isSystemAccountantPermission(p),
        },
        {
          name: 'Warehouse Clerk',
          desc: 'Inventory and warehouse operations - receiving, stock counts, deliveries',
          filter: (p) =>
            ['inventory', 'delivery'].includes(p.module) ||
            ['purchasing.read', 'purchasing.post', 'suppliers.read', 'settings.read', 'reports.read'].includes(p.key),
        },
        {
          name: 'Sales Representative',
          desc: 'Sales operations - sales, customers, CRM, and quotations',
          // Privileged sales corrections: Manager / Admin / Accountant only
          filter: (p) =>
            !['sales.tax_restatement', 'sales.tax_override', 'sales.reassign_customer'].includes(
              p.key,
            ) &&
            (['sales', 'customers', 'crm', 'reports', 'quotations'].includes(p.module) ||
              ['pos.read', 'pos.create', 'inventory.read', 'delivery.read', 'settings.read'].includes(
                p.key,
              )),
        },
        {
          name: 'HR Manager',
          desc: 'Human resources and payroll management',
          filter: (p) =>
            ['hr', 'reports'].includes(p.module) ||
            ['settings.read', 'accounting.read'].includes(p.key),
        },
      ];

    for (const role of roleConfigs) {
      const { rows: roleRows } = await tenantPool.query(
        `INSERT INTO rbac_roles (name, description, is_system_role, created_by, updated_by)
         VALUES ($1, $2, true, $3, $3)
         ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
         RETURNING id`,
        [role.name, role.desc, sysUser]
      );
      const roleId = roleRows[0]?.id;
      if (!roleId) continue;

      const grantKeys = permissions
        .filter((p) => role.filter(p))
        .map((p) => p.key);

      for (const key of grantKeys) {
        await tenantPool.query(
          `INSERT INTO rbac_role_permissions (role_id, permission_key, granted_by)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [roleId, key, sysUser]
        );
      }
    }
  },

  /**
   * Assign the Super Administrator RBAC role to the admin user.
   */
  async assignAdminRbacRole(tenantPool: pg.Pool, adminEmail: string): Promise<void> {
    const sysUser = '00000000-0000-0000-0000-000000000001';

    // Get admin user ID
    const { rows: userRows } = await tenantPool.query('SELECT id FROM users WHERE email = $1', [
      adminEmail,
    ]);
    const userId = userRows[0]?.id;
    if (!userId) {
      logger.warn(`Cannot assign RBAC role: admin user ${adminEmail} not found`);
      return;
    }

    // Get Super Administrator role ID
    const { rows: roleRows } = await tenantPool.query(
      "SELECT id FROM rbac_roles WHERE name = 'Super Administrator'"
    );
    const roleId = roleRows[0]?.id;
    if (!roleId) {
      logger.warn('Cannot assign RBAC role: Super Administrator role not found');
      return;
    }

    await tenantPool.query(
      `INSERT INTO rbac_user_roles (user_id, role_id, scope_type, assigned_by, is_active)
       VALUES ($1, $2, 'global', $3, true)
       ON CONFLICT DO NOTHING`,
      [userId, roleId, sysUser]
    );
    logger.info(`Assigned Super Administrator RBAC role to ${adminEmail}`);
  },
};
