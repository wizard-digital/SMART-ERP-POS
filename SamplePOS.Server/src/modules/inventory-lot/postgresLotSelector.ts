import type { PoolClient } from 'pg';
import type { SelectableLot } from '@shared/inventory-lot/lotSelection.js';
import { normalizeLotDate } from '@shared/inventory-lot/lotRules.js';

type DbClient = PoolClient;

export interface LoadSelectableLotsOptions {
  forUpdate?: boolean;
  minDaysBeforeExpiry?: number;
  specificLotId?: string | null;
  /**
   * ADR-004 Phase 2C: allow QUARANTINED/EXPIRED lots when disposing (specificLotId required).
   */
  allowDisposalStatuses?: boolean;
}


function mapMasterRow(row: Record<string, unknown>): SelectableLot {
  return {
    lotId: String(row.id),
    lotNumber: String(row.batch_number),
    productId: String(row.product_id),
    remainingQuantity: Number(row.remaining_quantity ?? 0),
    costPrice: Number(row.cost_price ?? 0),
    expiryDate: normalizeLotDate(row.expiry_date as string | null),
    receivedDate: normalizeLotDate(row.received_date as string | null)
      ?? normalizeLotDate(row.created_at as string | null),
  };
}

function buildMasterExpiryClause(minDays: number, startParam: number): { clause: string; paramCount: number } {
  if (minDays > 0) {
    return {
      clause: `(expiry_date IS NULL OR expiry_date > CURRENT_DATE + $${startParam} * INTERVAL '1 day')`,
      paramCount: 1,
    };
  }
  return { clause: '(expiry_date IS NULL OR expiry_date > CURRENT_DATE)', paramCount: 0 };
}

/**
 * Global lot selection — inventory_batches master (single-store / legacy path).
 */
export async function loadGlobalSelectableLots(
  client: DbClient,
  productId: string,
  options: LoadSelectableLotsOptions = {},
): Promise<SelectableLot[]> {
  const lockSql = options.forUpdate ? ' FOR UPDATE' : '';
  const minDays = options.minDaysBeforeExpiry ?? 0;

  if (options.specificLotId) {
    const expiry = options.allowDisposalStatuses
      ? { clause: 'TRUE', paramCount: 0 }
      : buildMasterExpiryClause(minDays, 3);
    const params: unknown[] = [options.specificLotId, productId];
    if (expiry.paramCount) params.push(minDays);
    const statusClause = options.allowDisposalStatuses
      ? `COALESCE(status::text, 'ACTIVE') IN ('ACTIVE', 'QUARANTINED', 'EXPIRED', 'BLOCKED')`
      : `COALESCE(status::text, 'ACTIVE') = 'ACTIVE'`;

    const result = await client.query(
      `SELECT id, batch_number, product_id, remaining_quantity, cost_price,
              expiry_date, received_date, created_at
       FROM inventory_batches
       WHERE id = $1 AND product_id = $2 AND ${statusClause}
         AND remaining_quantity > 0
         AND ${expiry.clause}
       ${lockSql}`,
      params,
    );
    return result.rows.map(mapMasterRow);
  }

  const expiry = buildMasterExpiryClause(minDays, 2);
  const params: unknown[] = [productId];
  if (expiry.paramCount) params.push(minDays);

  const result = await client.query(
    `SELECT id, batch_number, product_id, remaining_quantity, cost_price,
            expiry_date, received_date, created_at
     FROM inventory_batches
     WHERE product_id = $1 AND remaining_quantity > 0 AND status = 'ACTIVE'
       AND ${expiry.clause}
     ORDER BY expiry_date ASC NULLS LAST, received_date ASC, batch_number ASC
     ${lockSql}`,
    params,
  );
  return result.rows.map(mapMasterRow);
}

/**
 * Store-scoped lot selection — sellable quantity at a store, expiry from batch master.
 */
export async function loadStoreSelectableLots(
  client: DbClient,
  productId: string,
  storeLocationId: string,
  options: LoadSelectableLotsOptions = {},
): Promise<SelectableLot[]> {
  const lockSql = options.forUpdate ? ' FOR UPDATE OF ib_bal' : '';
  const minDays = options.minDaysBeforeExpiry ?? 0;
  const params: unknown[] = [storeLocationId, productId];
  let paramIdx = 3;

  let expiryClause = options.allowDisposalStatuses
    ? 'TRUE'
    : '(ib.expiry_date IS NULL OR ib.expiry_date > CURRENT_DATE)';
  if (!options.allowDisposalStatuses && minDays > 0) {
    expiryClause = `(ib.expiry_date IS NULL OR ib.expiry_date > CURRENT_DATE + $${paramIdx} * INTERVAL '1 day')`;
    params.push(minDays);
    paramIdx += 1;
  }

  let specificClause = '';
  if (options.specificLotId) {
    specificClause = ` AND ib.id = $${paramIdx}`;
    params.push(options.specificLotId);
  }

  const storeTypeClause = options.allowDisposalStatuses
    ? `sl.store_type IN ('MAIN', 'SELLING', 'DAMAGE', 'EXPIRED', 'RETURN')`
    : `sl.store_type IN ('MAIN', 'SELLING')`;
  const lotStatusClause = options.allowDisposalStatuses
    ? `COALESCE(pl.status::text, 'ACTIVE') IN ('ACTIVE', 'QUARANTINED', 'EXPIRED', 'BLOCKED')
       AND COALESCE(ib.status::text, 'ACTIVE') IN ('ACTIVE', 'QUARANTINED', 'EXPIRED', 'BLOCKED')`
    : `COALESCE(pl.status::text, 'ACTIVE') = 'ACTIVE'
       AND COALESCE(ib.status::text, 'ACTIVE') = 'ACTIVE'`;

  const result = await client.query(
    `SELECT
       ib.id,
       ib.batch_number,
       ib.product_id,
       GREATEST(
         ib_bal.quantity_on_hand - ib_bal.quantity_reserved - ib_bal.quantity_committed,
         0
       ) AS remaining_quantity,
       ib.cost_price,
       ib.expiry_date,
       ib.received_date,
       ib.created_at,
       pl.id AS product_lot_id
     FROM inventory_balances ib_bal
     INNER JOIN product_lots pl ON pl.id = ib_bal.product_lot_id
     INNER JOIN inventory_batches ib ON ib.id = pl.inventory_batch_id
     INNER JOIN store_locations sl ON sl.id = ib_bal.store_location_id
     WHERE ib_bal.store_location_id = $1
       AND pl.product_id = $2
       AND ${lotStatusClause}
       AND NOT ib_bal.blocked
       AND ${storeTypeClause}
       AND ${expiryClause}
       AND (ib_bal.quantity_on_hand - ib_bal.quantity_reserved - ib_bal.quantity_committed) > 0
       ${specificClause}
     ORDER BY ib.expiry_date ASC NULLS LAST, ib.received_date ASC, pl.lot_number ASC
     ${lockSql}`,
    params,
  );

  return result.rows.map((row) => ({
    ...mapMasterRow(row),
    storeLocationId,
    productLotId: String(row.product_lot_id),
  }));
}
