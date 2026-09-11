/**
 * Lot Carrying-Value Write-Down / Inventory Clearance Markdown — pure rules.
 *
 * Damaged / calendar-expired / quarantined stock is NOT eligible (those are 5120/5130 write-offs).
 * Still-sellable lots expiring within LOT_WRITE_DOWN_MAX_DAYS (60) may be marked down so POS
 * can sell at the new carrying cost (at or above new carrying; may be below original).
 * The Expiring Items Critical KPI band stays ≤7d — do not widen it for write-down.
 * Carrying cost (inventory_batches.cost_price) may fall; original_cost_price never does.
 */

import { classifyExpiryUrgency } from '../reports/expiringItemsSsot.js';
import { DEFAULT_LOT_POLICY } from './lotPolicy.js';
import { isLotEligibleForSale, normalizeLotDate } from './lotRules.js';
import type { LotDate } from './lotTypes.js';

export const LOT_WRITE_DOWN_EXPENSE_ACCOUNT = '5140';
export const LOT_WRITE_DOWN_REASON = 'NEAR_EXPIRY' as const;
export const LOT_WRITE_DOWN_REFERENCE_TYPE = 'LOT_WRITE_DOWN';
/** Governed floor for carrying cost (POS ±0.01 / money cent). Cannot write down to 0. */
export const LOT_WRITE_DOWN_MIN_CARRYING = 0.01;
/** Still-sellable lots with 1..60 days until expiry. Independent of Critical (≤7d) KPI. */
export const LOT_WRITE_DOWN_MAX_DAYS = 60;

export type LotWriteDownRejectReason =
  | 'NO_EXPIRY'
  | 'EXPIRED'
  | 'NOT_CRITICAL'
  | 'NOT_SELLABLE'
  | 'NOT_ACTIVE'
  | 'NO_QTY'
  | 'INVALID_NEW_COST'
  | 'NOT_BELOW_CARRYING'
  | 'BELOW_FLOOR'
  | 'ABOVE_ORIGINAL';

const REJECT_MESSAGE: Record<LotWriteDownRejectReason, string> = {
  NO_EXPIRY: 'Write-down is only for soon-to-expire lots. This batch has no expiry date. If it is damaged, use quarantine.',
  EXPIRED: 'Calendar-expired stock cannot be written down to sell. Quarantine then dispose (5130).',
  NOT_CRITICAL: `Write-down is only for lots expiring within ${LOT_WRITE_DOWN_MAX_DAYS} days that are still sellable. Expired stock must be quarantined.`,
  NOT_SELLABLE: 'This batch is inside the product min-days-before-sale window and cannot be sold on POS. Do not write it down.',
  NOT_ACTIVE: 'Quarantined, expired, or blocked lots cannot be written down. Damaged stock stays in quarantine.',
  NO_QTY: 'No remaining quantity to write down.',
  INVALID_NEW_COST: 'New carrying cost must be greater than zero.',
  NOT_BELOW_CARRYING: 'New carrying cost must be below the current book cost.',
  BELOW_FLOOR: 'New carrying cost cannot be below the governed floor (0.01).',
  ABOVE_ORIGINAL: 'New carrying cost cannot exceed original acquisition cost.',
};

export function roundWriteDownMoney(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** SSOT: 1–60 days remaining (not expired). Critical KPI stays ≤7d. */
export function isNearExpiryWriteDownBand(daysUntilExpiry: number): boolean {
  return Number.isFinite(daysUntilExpiry) && daysUntilExpiry > 0 && daysUntilExpiry <= LOT_WRITE_DOWN_MAX_DAYS;
}

export function assertWriteDownBandMatchesLotPolicy(): boolean {
  return (
    LOT_WRITE_DOWN_MAX_DAYS === 60 &&
    isNearExpiryWriteDownBand(1) &&
    isNearExpiryWriteDownBand(7) &&
    isNearExpiryWriteDownBand(30) &&
    isNearExpiryWriteDownBand(60) &&
    !isNearExpiryWriteDownBand(61) &&
    !isNearExpiryWriteDownBand(0) &&
    !isNearExpiryWriteDownBand(-1) &&
    DEFAULT_LOT_POLICY.criticalDays === 7 &&
    classifyExpiryUrgency(7) === 'critical' &&
    classifyExpiryUrgency(8) === 'warning' &&
    classifyExpiryUrgency(1) === 'critical' &&
    classifyExpiryUrgency(0) === 'expired'
  );
}

export type LotWriteDownGateInput = {
  status: string;
  expiryDate: string | Date | null | undefined;
  remainingQuantity: number;
  carryingUnitCost: number;
  originalUnitCost: number;
  newUnitCost: number;
  minDaysBeforeExpirySale?: number;
  businessDate: LotDate;
};

export type LotWriteDownGateResult =
  | { ok: true; daysUntilExpiry: number; writeDownAmount: number; quantity: number }
  | { ok: false; reason: LotWriteDownRejectReason; message: string };

export function evaluateLotWriteDownGate(input: LotWriteDownGateInput): LotWriteDownGateResult {
  const status = String(input.status || 'ACTIVE').toUpperCase();
  if (status !== 'ACTIVE') {
    return { ok: false, reason: 'NOT_ACTIVE', message: REJECT_MESSAGE.NOT_ACTIVE };
  }

  const expiry = normalizeLotDate(input.expiryDate);
  if (!expiry) {
    return { ok: false, reason: 'NO_EXPIRY', message: REJECT_MESSAGE.NO_EXPIRY };
  }

  const qty = Number(input.remainingQuantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, reason: 'NO_QTY', message: REJECT_MESSAGE.NO_QTY };
  }

  const days = (() => {
    const [ey, em, ed] = expiry.split('-').map(Number);
    const [by, bm, bd] = input.businessDate.split('-').map(Number);
    return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(by, bm - 1, bd)) / 86_400_000);
  })();

  if (days <= 0) {
    return { ok: false, reason: 'EXPIRED', message: REJECT_MESSAGE.EXPIRED };
  }
  if (!isNearExpiryWriteDownBand(days)) {
    return { ok: false, reason: 'NOT_CRITICAL', message: REJECT_MESSAGE.NOT_CRITICAL };
  }

  const minDays = input.minDaysBeforeExpirySale ?? 0;
  if (!isLotEligibleForSale(expiry, input.businessDate, minDays)) {
    return { ok: false, reason: 'NOT_SELLABLE', message: REJECT_MESSAGE.NOT_SELLABLE };
  }

  const carrying = Number(input.carryingUnitCost);
  const original = Number(input.originalUnitCost) > 0 ? Number(input.originalUnitCost) : carrying;
  const next = Number(input.newUnitCost);

  if (!Number.isFinite(next) || next <= 0) {
    return { ok: false, reason: 'INVALID_NEW_COST', message: REJECT_MESSAGE.INVALID_NEW_COST };
  }
  if (roundWriteDownMoney(next) < LOT_WRITE_DOWN_MIN_CARRYING) {
    return { ok: false, reason: 'BELOW_FLOOR', message: REJECT_MESSAGE.BELOW_FLOOR };
  }
  if (roundWriteDownMoney(next) >= roundWriteDownMoney(carrying)) {
    return { ok: false, reason: 'NOT_BELOW_CARRYING', message: REJECT_MESSAGE.NOT_BELOW_CARRYING };
  }
  if (roundWriteDownMoney(next) - roundWriteDownMoney(original) > 0.001) {
    return { ok: false, reason: 'ABOVE_ORIGINAL', message: REJECT_MESSAGE.ABOVE_ORIGINAL };
  }

  const amount = roundWriteDownMoney((carrying - next) * qty);
  if (amount <= 0) {
    return { ok: false, reason: 'NOT_BELOW_CARRYING', message: REJECT_MESSAGE.NOT_BELOW_CARRYING };
  }

  return { ok: true, daysUntilExpiry: days, writeDownAmount: amount, quantity: qty };
}

export function lotWriteDownErrorCode(reason: LotWriteDownRejectReason): string {
  return `LOT_WRITE_DOWN_${reason}`;
}

/** GL markdown amount must equal remaining qty × (old carrying − new carrying). */
export function assertWriteDownCouplesSubledger(input: {
  quantity: number;
  previousCarrying: number;
  newCarrying: number;
  glAmount: number;
}): void {
  const expected = roundWriteDownMoney(
    (Number(input.previousCarrying) - Number(input.newCarrying)) * Number(input.quantity),
  );
  const gl = roundWriteDownMoney(input.glAmount);
  if (Math.abs(expected - gl) > 0.01) {
    throw new Error(
      `Write-down GL ${gl} does not match batch value drop ${expected} (qty ${input.quantity} × (${input.previousCarrying} − ${input.newCarrying}))`,
    );
  }
}
