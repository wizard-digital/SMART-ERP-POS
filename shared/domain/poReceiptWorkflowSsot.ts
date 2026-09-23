/**
 * PO receipt workflow SSOT (net-received model).
 *
 * Contract:
 * 1. Workflow: DRAFT | PENDING | COMPLETED | CANCELLED.
 * 2. Net received = gross − posted returns (gross history immutable).
 * 3. Fully net-received → COMPLETED.
 * 4. Fully reversed (net≈0 after posted GR history) → DRAFT so the user can edit/cancel/resubmit.
 *    No "Reopened (reversed)" noise — the economic document is unwound.
 *    After the user resubmits (DRAFT→PENDING), status stays PENDING for Send to supplier —
 *    list heal must not force PENDING back to DRAFT from historical reversed GRs.
 * 5. Partial open with remaining net → PENDING (Partially Received).
 * 6. Submitted, never received → PENDING (Awaiting Receipt).
 *
 * Server: syncPOStatusWithReceipts is the sole auto-writer for 3–4 (event path).
 *         healFullyReversedPurchaseOrdersToDraft only heals stuck COMPLETED → DRAFT.
 *         Both cancel leftover DRAFT GRs so Finalize cannot run until Submit → Send.
 * 7. Finalize goods receipt when PO is PENDING (`poAllowsGoodsReceiptFinalize`).
 *    Manual GR: createManualPO inserts PENDING + manual_receipt; Finalize posts GR
 *    then sync → COMPLETED. Legacy COMPLETED+manual_receipt shells remain receivable.
 */

export const PO_RECEIPT_QTY_EPS = 0.0001;

export type POWorkflowStatus = 'DRAFT' | 'PENDING' | 'COMPLETED' | 'CANCELLED' | string;

/** Receipt progress fields returned on PO list/detail APIs. */
export interface POReceiptProgress {
  orderedQtyTotal?: number | string | null;
  ordered_qty_total?: number | string | null;
  netReceivedQtyTotal?: number | string | null;
  net_received_qty_total?: number | string | null;
  openQtyTotal?: number | string | null;
  open_qty_total?: number | string | null;
  completedGrCount?: number | string | null;
  completed_gr_count?: number | string | null;
}

function num(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function readPOReceiptProgress(po: POReceiptProgress): {
  orderedQtyTotal: number;
  netReceivedQtyTotal: number;
  openQtyTotal: number;
  completedGrCount: number;
} {
  return {
    orderedQtyTotal: num(po.orderedQtyTotal ?? po.ordered_qty_total),
    netReceivedQtyTotal: num(po.netReceivedQtyTotal ?? po.net_received_qty_total),
    openQtyTotal: num(po.openQtyTotal ?? po.open_qty_total),
    completedGrCount: num(po.completedGrCount ?? po.completed_gr_count),
  };
}

/** True when every line was received then fully returned/reversed. */
export function isPOFullyReversedProgress(progress: POReceiptProgress): boolean {
  const { netReceivedQtyTotal, openQtyTotal, completedGrCount, orderedQtyTotal } =
    readPOReceiptProgress(progress);
  return (
    completedGrCount > 0 &&
    netReceivedQtyTotal <= PO_RECEIPT_QTY_EPS &&
    openQtyTotal > PO_RECEIPT_QTY_EPS &&
    orderedQtyTotal > PO_RECEIPT_QTY_EPS
  );
}

export interface POWorkflowReceiptFlags {
  fullyReceived: boolean;
  /** Net≈0 after completed GR history (full reverse / full return). */
  fullyReversed: boolean;
}

/**
 * Target workflow after receipt events.
 * CANCELLED never auto-moved.
 * Fully reversed → DRAFT only from COMPLETED (posted cycle unwound).
 * PENDING is never auto-drafted here — intentional resubmit must stick until
 * the reverse/return event path passes `{ forceDraftIfFullyReversed: true }`.
 * Returns null when no status write is needed.
 */
export function resolveTargetPOWorkflowStatus(
  currentStatus: POWorkflowStatus,
  flags: boolean | POWorkflowReceiptFlags,
): 'DRAFT' | 'PENDING' | 'COMPLETED' | null {
  const st = String(currentStatus || '').toUpperCase();
  if (st === 'CANCELLED') return null;

  const fullyReceived = typeof flags === 'boolean' ? flags : flags.fullyReceived;
  const fullyReversed = typeof flags === 'boolean' ? false : flags.fullyReversed;

  if (fullyReceived) {
    // Never auto-complete a DRAFT that was never submitted
    if (st === 'DRAFT') return null;
    return st === 'COMPLETED' ? null : 'COMPLETED';
  }

  if (fullyReversed) {
    // Only unwind a completed receipt cycle. Do not yank PENDING after resubmit.
    if (st === 'COMPLETED') return 'DRAFT';
    return null;
  }

  // Partial: reopen Completed so remaining qty can be received
  if (st === 'COMPLETED') return 'PENDING';
  return null;
}

export type POReceiptLane =
  | 'DRAFT'
  | 'CANCELLED'
  | 'AWAITING_RECEIPT'
  | 'PARTIALLY_RECEIVED'
  | 'COMPLETED'
  | 'PENDING_OTHER';

export const PO_RECEIPT_LANE_LABELS: Record<
  POReceiptLane,
  { icon: string; label: string; color: string; title: string }
> = {
  DRAFT: {
    icon: '📝',
    label: 'Draft',
    color: 'bg-gray-100 text-gray-800',
    title: 'Draft — edit, cancel, or submit again.',
  },
  CANCELLED: {
    icon: '❌',
    label: 'Cancelled',
    color: 'bg-red-100 text-red-800',
    title: 'Purchase order cancelled.',
  },
  AWAITING_RECEIPT: {
    icon: '⏳',
    label: 'Awaiting Receipt',
    color: 'bg-yellow-100 text-yellow-800',
    title: 'Sent to supplier — no goods receipt posted yet.',
  },
  PARTIALLY_RECEIVED: {
    icon: '📦',
    label: 'Partially Received',
    color: 'bg-orange-100 text-orange-800',
    title: 'Some quantity still open after a partial receipt or return.',
  },
  COMPLETED: {
    icon: '✅',
    label: 'Completed',
    color: 'bg-green-100 text-green-800',
    title: 'Fully received (net).',
  },
  PENDING_OTHER: {
    icon: '⏳',
    label: 'Pending',
    color: 'bg-yellow-100 text-yellow-800',
    title: 'Purchase order pending.',
  },
};

export function classifyPOReceiptLane(
  workflowStatus: POWorkflowStatus,
  progress: POReceiptProgress,
): POReceiptLane {
  const st = String(workflowStatus || '').toUpperCase();
  const { openQtyTotal, netReceivedQtyTotal, completedGrCount } = readPOReceiptProgress(progress);

  if (st === 'DRAFT') return 'DRAFT';
  if (st === 'CANCELLED') return 'CANCELLED';
  if (st === 'COMPLETED') return 'COMPLETED';

  if (st === 'PENDING') {
    if (
      completedGrCount > 0 &&
      netReceivedQtyTotal > PO_RECEIPT_QTY_EPS &&
      openQtyTotal > PO_RECEIPT_QTY_EPS
    ) {
      return 'PARTIALLY_RECEIVED';
    }
    if (completedGrCount === 0) return 'AWAITING_RECEIPT';
  }

  return 'PENDING_OTHER';
}

/** Show progress only while there is active net stock on the PO — not after full reverse. */
export function shouldShowPOReceiptProgressLine(progress: POReceiptProgress): boolean {
  const { netReceivedQtyTotal } = readPOReceiptProgress(progress);
  return netReceivedQtyTotal > PO_RECEIPT_QTY_EPS;
}

/**
 * Finalize GR when PO is PENDING (submitted / sent cycle).
 * After full reverse PO is DRAFT — Submit → Send creates a fresh draft GR.
 *
 * Manual GR: createManualPO inserts PENDING + manual_receipt (open until GR posts).
 * Legacy rows may still be COMPLETED+manual_receipt before GR finalize — still allow.
 */
export type GoodsReceiptFinalizeContext = {
  /** purchase_orders.manual_receipt — auto PO from Manual GR */
  manualReceipt?: boolean | null;
};

export function poAllowsGoodsReceiptFinalize(
  poStatus: string | null | undefined,
  ctx?: GoodsReceiptFinalizeContext,
): boolean {
  const st = String(poStatus || '').toUpperCase();
  if (st === 'PENDING') return true;
  if (ctx?.manualReceipt === true && st === 'COMPLETED') return true;
  return false;
}
