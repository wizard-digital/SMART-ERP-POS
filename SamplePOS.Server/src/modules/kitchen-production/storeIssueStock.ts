/**
 * Issuable qty for Store Issue — same FEFO selector as consumeLot.
 */

import type { Pool, PoolClient } from 'pg';
import { AppError, ValidationError } from '../../middleware/errorHandler.js';
import {
  loadGlobalSelectableLots,
  loadStoreSelectableLots,
} from '../inventory-lot/postgresLotSelector.js';
import { storeLocationRepository } from '../inventory/warehouse/storeLocationRepository.js';
import {
  consumeStoreIdForIssue,
  formatInsufficientStoreIssue,
  issuedExceedsAvailable,
  sumIssuableQty,
} from '../../../../shared/store-issue/issuePlan.js';

type DbConn = Pool | PoolClient;

export async function previewStoreIssueAvailability(
  conn: DbConn,
  productId: string,
  storeLocationId: string | null,
  multistore: boolean,
  opts?: { forUpdate?: boolean },
): Promise<{ available: number; storeLabel: string }> {
  const consumeStoreId = consumeStoreIdForIssue(multistore, storeLocationId);
  const lots = consumeStoreId
    ? await loadStoreSelectableLots(conn as PoolClient, productId, consumeStoreId, {
        minDaysBeforeExpiry: 0,
        forUpdate: opts?.forUpdate === true,
      })
    : await loadGlobalSelectableLots(conn as PoolClient, productId, {
        minDaysBeforeExpiry: 0,
        forUpdate: opts?.forUpdate === true,
      });

  let storeLabel = 'company stock';
  if (consumeStoreId) {
    const store = await storeLocationRepository.getById(conn, consumeStoreId);
    storeLabel = store?.name || store?.code || 'selected store';
  }

  return { available: sumIssuableQty(lots), storeLabel };
}

export async function assertStoreIssueStock(
  conn: DbConn,
  input: {
    productId: string;
    productName: string;
    issuedQty: number;
    storeLocationId: string | null;
    multistore: boolean;
  },
): Promise<{ available: number; storeLabel: string }> {
  const preview = await previewStoreIssueAvailability(
    conn,
    input.productId,
    input.storeLocationId,
    input.multistore,
    { forUpdate: true },
  );
  if (issuedExceedsAvailable(input.issuedQty, preview.available)) {
    throw new ValidationError(
      formatInsufficientStoreIssue({
        productName: input.productName,
        requested: input.issuedQty,
        available: preview.available,
        storeLabel: preview.storeLabel,
      }),
    );
  }
  return preview;
}

export function wrapConsumeStockError(
  err: unknown,
  ctx: {
    productName: string;
    requested: number;
    available: number;
    storeLabel: string;
  },
): never {
  if (err instanceof AppError && !(err instanceof Error && /insufficient stock/i.test(err.message))) {
    throw err;
  }
  if (err instanceof Error && /insufficient stock/i.test(err.message)) {
    throw new ValidationError(formatInsufficientStoreIssue(ctx));
  }
  throw err;
}
