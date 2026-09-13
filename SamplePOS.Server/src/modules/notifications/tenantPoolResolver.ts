import type { Pool } from 'pg';
import { connectionManager } from '../../db/connectionManager.js';
import { tenantRepository } from '../platform/tenantRepository.js';
import logger from '../../utils/logger.js';

export async function resolveNotificationWorkerPool(
  tenantId: string | undefined,
  fallback: Pool,
): Promise<Pool | null> {
  if (!tenantId) return fallback;
  const existing = connectionManager.getPoolById(tenantId);
  if (existing) return existing;

  try {
    const master = connectionManager.getMasterPool();
    const row = await tenantRepository.findById(master, tenantId);
    if (!row) return null;
    if (row.status !== 'ACTIVE' && row.status !== 'PROVISIONING') {
      logger.info('Notification worker skipped inactive tenant', { tenantId, status: row.status });
      return null;
    }
    return connectionManager.getPool({
      tenantId: row.id,
      slug: row.slug,
      databaseName: row.database_name,
      databaseHost: row.database_host,
      databasePort: Number(row.database_port),
      plan: row.plan as 'FREE' | 'STARTER' | 'PROFESSIONAL' | 'ENTERPRISE',
    });
  } catch (err: unknown) {
    logger.warn('Notification worker failed to resolve tenant pool', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function sweepAllActiveTenantNotificationEvents(
  fallback: Pool,
): Promise<{ tenants: number; processed: number; usedFallback: boolean }> {
  const { sweepPendingNotificationEvents } = await import('./notificationWorker.js');
  try {
    const master = connectionManager.getMasterPool();
    const { rows } = await master.query<{
      id: string;
      slug: string;
      database_name: string;
      database_host: string;
      database_port: number;
      plan: string;
    }>(
      `SELECT id, slug, database_name, database_host, database_port, plan
         FROM tenants WHERE status = 'ACTIVE'`,
    );
    if (rows.length === 0) {
      const processed = await sweepPendingNotificationEvents(fallback, null);
      return { tenants: 0, processed, usedFallback: true };
    }
    let processed = 0;
    for (const row of rows) {
      const workerPool = await resolveNotificationWorkerPool(row.id, fallback);
      if (!workerPool) continue;
      processed += await sweepPendingNotificationEvents(workerPool, row.id);
    }
    return { tenants: rows.length, processed, usedFallback: false };
  } catch (err: unknown) {
    logger.warn('Notification sweep fell back to default pool', {
      error: err instanceof Error ? err.message : String(err),
    });
    const processed = await sweepPendingNotificationEvents(fallback, null);
    return { tenants: 0, processed, usedFallback: true };
  }
}
