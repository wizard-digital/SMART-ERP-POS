/**
 * Cancel open customer invoices when the linked sale is dead
 * (VOID / VOIDED_BY_RETURN / full refund).
 *
 * SSOT rules:
 * - Subledger only: status → CANCELLED, amount_due → 0.
 * - Does NOT post GL. AR 1200 must already be relieved by the sale void/refund journal
 *   (SALE_VOID / SALE_REFUND / SALE_REFUND_CORRECTION). Posting again would double-credit AR.
 * - Always recalculate customers.balance from remaining open invoices.
 */
import type { Pool, PoolClient } from 'pg';
import logger from '../../utils/logger.js';
import { syncCustomerBalanceFromInvoices } from '../../utils/customerBalanceSync.js';

export type DeadSaleInvoiceCancelReason =
  | 'SALE_VOID'
  | 'SALE_VOIDED_BY_RETURN'
  | 'SALE_FULL_RETURN_SYNC';

export interface CancelLinkedInvoicesResult {
  cancelledInvoiceIds: string[];
  customerIdsSynced: string[];
}

export async function cancelLinkedInvoicesForDeadSale(
  client: Pool | PoolClient,
  saleId: string,
  reason: DeadSaleInvoiceCancelReason,
): Promise<CancelLinkedInvoicesResult> {
  const linked = await client.query<{ id: string; customer_id: string | null; status: string }>(
    `SELECT id, customer_id, status::text AS status
     FROM invoices
     WHERE sale_id = $1
       AND status NOT IN ('CANCELLED', 'VOIDED', 'DRAFT')`,
    [saleId],
  );

  const cancelledInvoiceIds: string[] = [];
  const customerIds = new Set<string>();

  for (const row of linked.rows) {
    await client.query(
      `UPDATE invoices
       SET status = 'CANCELLED',
           amount_due = 0,
           updated_at = NOW()
       WHERE id = $1
         AND status NOT IN ('CANCELLED', 'VOIDED', 'DRAFT')`,
      [row.id],
    );
    cancelledInvoiceIds.push(row.id);
    if (row.customer_id) customerIds.add(row.customer_id);
    logger.info('Invoice cancelled for dead sale', {
      saleId,
      invoiceId: row.id,
      priorStatus: row.status,
      reason,
    });
  }

  const customerIdsSynced: string[] = [];
  for (const customerId of customerIds) {
    await syncCustomerBalanceFromInvoices(client, customerId, reason);
    customerIdsSynced.push(customerId);
  }

  return { cancelledInvoiceIds, customerIdsSynced };
}
