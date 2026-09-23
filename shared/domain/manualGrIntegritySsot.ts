/**
 * Manual GR E2E integrity SSOT — status + line parity contracts.
 *
 * Lifecycle (accurate, no false “goods already received”):
 *   1. Save Manual GR → GR=DRAFT, tracking PO=PENDING + manual_receipt=true
 *      (ordered qty = received qty on every line)
 *   2. Finalize GR → GR=COMPLETED, inventory/GRIR post, sync PO → COMPLETED
 *   3. Legacy shells: older rows may still have PO=COMPLETED before GR post;
 *      Finalize remains allowed when manual_receipt=true (compat).
 *
 * Consumers: ManualGRModal, createManualPO, poAllowsGoodsReceiptFinalize,
 *            assertPOAllowsReceiving, evidence proofs.
 */

import {
  poAllowsGoodsReceiptFinalize,
  type GoodsReceiptFinalizeContext,
  type POWorkflowStatus,
} from './poReceiptWorkflowSsot.js';

/** Tracking PO status at Manual GR create — open until GR posts stock. */
export const MANUAL_PO_STATUS_ON_CREATE: POWorkflowStatus = 'PENDING';

/** GR header status at Manual GR create — never auto-posted. */
export const MANUAL_GR_STATUS_ON_CREATE = 'DRAFT' as const;

export type ManualGrLifecyclePhase =
  | 'DRAFT_OPEN'
  | 'POSTED'
  | 'CANCELLED'
  | 'BLOCKED_NON_MANUAL';

export function resolveManualGrLifecycle(input: {
  grStatus: string | null | undefined;
  poStatus: string | null | undefined;
  manualReceipt: boolean | null | undefined;
}): ManualGrLifecyclePhase {
  const gr = String(input.grStatus || '').toUpperCase();
  const manual = input.manualReceipt === true;
  if (gr === 'CANCELLED') return 'CANCELLED';
  if (gr === 'COMPLETED') return 'POSTED';
  if (gr === 'DRAFT') {
    return poAllowsGoodsReceiptFinalize(input.poStatus, {
      manualReceipt: manual,
    } satisfies GoodsReceiptFinalizeContext)
      ? 'DRAFT_OPEN'
      : 'BLOCKED_NON_MANUAL';
  }
  return 'BLOCKED_NON_MANUAL';
}

/** Line parity: Manual GR has no pre-order — ordered must equal received. */
export function assertManualGrLineOrderedEqualsReceived(
  orderedQuantity: number,
  receivedQuantity: number,
  eps = 1e-9,
): boolean {
  return Math.abs(Number(orderedQuantity) - Number(receivedQuantity)) <= eps;
}

/**
 * Expected PO status after successful Manual GR finalize when fully received.
 * syncPOStatusWithReceipts is the sole writer.
 */
export const MANUAL_PO_STATUS_AFTER_FULL_RECEIPT: POWorkflowStatus = 'COMPLETED';

/** True when Finalize must be offered for a Manual GR draft. */
export function manualGrDraftAllowsFinalize(input: {
  grStatus: string | null | undefined;
  poStatus: string | null | undefined;
  manualReceipt: boolean | null | undefined;
}): boolean {
  if (String(input.grStatus || '').toUpperCase() !== 'DRAFT') return false;
  return poAllowsGoodsReceiptFinalize(input.poStatus, {
    manualReceipt: input.manualReceipt === true,
  });
}
