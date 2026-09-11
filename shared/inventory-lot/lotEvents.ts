import type { LotAttributes, LotDate, LotSourceType, LotStoredStatus } from './lotTypes.js';

export type LotEventType =
  | 'LOT_RECEIVED'
  | 'LOT_ATTRIBUTES_CORRECTED'
  | 'LOT_STATUS_CHANGED'
  | 'LOT_CONSUMED'
  | 'LOT_RETURNED'
  | 'LOT_TRANSFERRED'
  | 'LOT_ADJUSTED'
  | 'LOT_SPLIT'
  | 'LOT_MERGED';

export interface LotEventBase {
  type: LotEventType;
  lotId: string;
  productId: string;
  lotNumber: string;
  occurredAt: string;
  userId?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
}

export interface LotReceivedEvent extends LotEventBase {
  type: 'LOT_RECEIVED';
  attributes: LotAttributes;
  quantity: number;
  costPrice: number;
  sourceType: LotSourceType;
  goodsReceiptId?: string | null;
}

export interface LotAttributesCorrectedEvent extends LotEventBase {
  type: 'LOT_ATTRIBUTES_CORRECTED';
  oldAttributes: Partial<LotAttributes>;
  newAttributes: Partial<LotAttributes>;
  reason: string;
}

export interface LotStatusChangedEvent extends LotEventBase {
  type: 'LOT_STATUS_CHANGED';
  oldStatus: LotStoredStatus;
  newStatus: LotStoredStatus;
  reason?: string | null;
}

export interface LotConsumedEvent extends LotEventBase {
  type: 'LOT_CONSUMED';
  quantity: number;
  selectionPolicy: string;
}

export interface LotTransferredEvent extends LotEventBase {
  type: 'LOT_TRANSFERRED';
  fromStoreLocationId: string;
  toStoreLocationId: string;
  quantity: number;
}

export type LotEvent =
  | LotReceivedEvent
  | LotAttributesCorrectedEvent
  | LotStatusChangedEvent
  | LotConsumedEvent
  | LotTransferredEvent
  | LotEventBase;

export interface LotConsumeInput {
  productId: string;
  quantity: number;
  storeLocationId?: string | null;
  specificLotId?: string | null;
  selectionPolicy?: import('./lotTypes.js').SelectionPolicy;
  minDaysBeforeExpiry?: number;
  movementType?: string;
  referenceType: string;
  referenceId: string;
  userId: string;
  productName?: string;
  /** Default true — set false when caller records movements separately */
  recordMovement?: boolean;
  /** Default true */
  syncProduct?: boolean;
  /**
   * With specificLotId + MANUAL in multistore: deduct warehouse balances across all stores
   * (supplier return / StockMovementHandler when no source store).
   * Default when multistore + specificLotId + no storeLocationId: true (INV-002 dual-write).
   * Set false only with skipStoreBalanceDeduction when caller already adjusted balances.
   */
  deductAcrossAllStoreBalances?: boolean;
  /**
   * Caller already mutated inventory_balances for this consume (legacy split write).
   * When true, only the batch master is decremented — do not use on new paths.
   */
  skipStoreBalanceDeduction?: boolean;
  /**
   * ADR-004 Phase 2C: dispose from quarantine — allow QUARANTINED/EXPIRED lots and
   * DAMAGE/EXPIRED/RETURN store balances (never for POS sale).
   */
  allowDisposalStatuses?: boolean;
}

export interface LotConsumeLayer {
  lotId: string;
  lotNumber: string;
  quantity: number;
  costPrice: number;
  productLotId?: string | null;
}

export interface LotConsumeResult {
  layers: LotConsumeLayer[];
  totalCost: number;
  selectionPolicy: import('./lotTypes.js').SelectionPolicy;
  shortfall: number;
}

export interface LotReceiveInput {
  productId: string;
  lotNumber: string;
  quantity: number;
  costPrice: number;
  attributes: LotAttributes;
  sourceType: LotSourceType;
  goodsReceiptId?: string | null;
  goodsReceiptItemId?: string | null;
  purchaseOrderId?: string | null;
  purchaseOrderItemId?: string | null;
  targetStoreLocationId?: string | null;
  isBonus?: boolean;
  userId: string;
}

export interface LotCorrectAttributesInput {
  lotId: string;
  newExpiryDate: LotDate;
  reason: string;
  userId: string;
  /** Governance approval when moving expiry to an earlier calendar date (INV-006). */
  hasBackwardsExpiryApproval?: boolean;
}

export interface LotTransferInput {
  productLotId: string;
  fromStoreLocationId: string;
  toStoreLocationId: string;
  quantity: number;
  userId: string;
}

export interface LotReturnInput {
  productId: string;
  lotNumber?: string | null;
  batchId?: string | null;
  quantity: number;
  expiryDate?: LotDate | null;
  costPrice: number;
  targetStoreLocationId?: string | null;
  referenceType: string;
  referenceId: string;
  notes?: string | null;
  userId: string;
}

export interface LotStatusTransitionInput {
  lotId: string;
  newStatus: LotStoredStatus;
  reason?: string | null;
  userId: string;
}

/** Opening balance / CSV import — idempotent batch upsert */
export type OpeningLotDuplicateStrategy = 'UPDATE' | 'SKIP' | 'FAIL';

export interface LotOpeningReceiveInput extends LotReceiveInput {
  duplicateStrategy: OpeningLotDuplicateStrategy;
}

export interface LotOpeningReceiveResult {
  lot: import('./lotTypes.js').InventoryLot | null;
  skipped: boolean;
}

/**
 * Split qty off an ACTIVE parent lot into a new child lot (same cost/expiry).
 * Product Σ remaining unchanged; no loss GL. Used for partial soft quarantine.
 */
export interface LotSplitInput {
  lotId: string;
  quantity: number;
  userId: string;
  reason?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  /** Optional explicit child lot number; otherwise `{parent}-S{n}` */
  childLotNumber?: string | null;
}

export interface LotSplitResult {
  parent: import('./lotTypes.js').InventoryLot;
  child: import('./lotTypes.js').InventoryLot;
  quantitySplit: number;
}
