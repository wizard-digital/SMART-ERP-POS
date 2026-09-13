import type { Pool } from 'pg';
import { getBusinessDate } from '../../utils/dateRange.js';
import { inventoryService } from '../inventory/inventoryService.js';
import { publishNotificationEvent } from './notificationPublisher.js';

export async function publishInventoryConditionNotifications(pool: Pool, tenantId?: string | null): Promise<void> {
  const day = getBusinessDate();
  try {
    const lowStock = await inventoryService.getProductsNeedingReorder(pool);
    for (const item of lowStock.slice(0, 50)) {
      const productId = String((item as { productId?: string; product_id?: string }).productId
        || (item as { product_id?: string }).product_id
        || '');
      if (!productId) continue;
      const name = String(
        (item as { productName?: string; name?: string }).productName
          || (item as { name?: string }).name
          || 'Product',
      );
      publishNotificationEvent({
        pool,
        tenantId,
        typeKey: 'INVENTORY_LOW_STOCK',
        entityType: 'product',
        entityId: productId,
        idempotencyKey: `INVENTORY_LOW_STOCK:product:${productId}:${day}`,
        payload: { summary: `${name} is below reorder level`, documentRef: name },
      });
    }
  } catch {
    // existing inventory query is SSOT; failures must not break the job runner
  }

  try {
    const batches = await inventoryService.getBatchesExpiringSoon(pool, 30);
    for (const batch of batches.slice(0, 50)) {
      const batchId = String((batch as { id?: string }).id || '');
      if (!batchId) continue;
      publishNotificationEvent({
        pool,
        tenantId,
        typeKey: 'INVENTORY_EXPIRY_WARNING',
        entityType: 'inventory_batch',
        entityId: batchId,
        idempotencyKey: `INVENTORY_EXPIRY_WARNING:batch:${batchId}:${day}`,
        payload: { summary: 'A stock batch is nearing expiry', documentRef: batchId },
      });
    }
  } catch {
    // same
  }
}
