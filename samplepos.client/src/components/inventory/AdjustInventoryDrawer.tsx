/**
 * AdjustInventoryDrawer — SSOT Adjust Inventory workspace.
 *
 * Used by Inventory → Adjustments and Products → Edit Product.
 * One submit path: BatchAdjustmentSchema + useAdjustBatch (no forked APIs).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { BatchAdjustmentSchema } from '@shared/zod/inventory';
import { useAdjustBatch } from '../../hooks/useInventory';
import { handleApiError } from '../../utils/errorHandler';
import SlideDrawer from '../ui/SlideDrawer';
import { ResponsiveGrid } from '../ui/ResponsiveGrid';
import apiClient from '../../utils/api';

export type AdjustInventoryLotOption = {
  /** Stable select key */
  key: string;
  productLotId?: string;
  batchId?: string;
  batchNumber: string;
  availableQuantity: number;
  expiryDate?: string | null;
};

export type AdjustInventoryTarget = {
  productId: string;
  productName: string;
  currentQuantity: number;
  batchId?: string;
  productLotId?: string;
  batchNumber?: string;
  /** Multistore only — omit when single-store */
  storeLocationId?: string;
  /** Display label for store (subtitle) */
  storeLabel?: string;
  /** FEFO-ordered lot/batch choices for smart pick in the drawer */
  lotOptions?: AdjustInventoryLotOption[];
};

export type AdjustInventoryMovementCategory = 'ADJUSTMENT' | 'DAMAGE' | 'EXPIRY';
type MovementCategory = AdjustInventoryMovementCategory;
type AdjustmentType = 'increase' | 'decrease';

export type AdjustInventoryDrawerProps = {
  open: boolean;
  target: AdjustInventoryTarget | null;
  onClose: () => void;
  onSuccess?: () => void;
  /** Prefill category when opening from Damage / Expiry row actions */
  initialMovementCategory?: MovementCategory;
};

type AdjustStorePick = {
  id: string;
  storeType: string;
  isPosSelling?: boolean;
  isDefaultReceiving?: boolean;
  isActive?: boolean;
  name?: string;
  code?: string;
};

/**
 * INV-POS SSOT: sellable adjust defaults to SELLING (same as Inventory → Adjustments).
 * Never prefer MAIN when a SELLING store exists.
 */
export function resolveDefaultAdjustStoreId(
  stores: ReadonlyArray<AdjustStorePick>,
): string {
  const active = stores.filter((s) => s.isActive !== false);
  const selling =
    active.find((s) => s.storeType === 'SELLING' && s.isPosSelling) ??
    active.find((s) => s.storeType === 'SELLING');
  const main =
    active.find((s) => s.storeType === 'MAIN') ??
    active.find((s) => s.isDefaultReceiving);
  return selling?.id ?? main?.id ?? '';
}

export function formatAdjustStoreLabel(store: AdjustStorePick | undefined): string | undefined {
  if (!store) return undefined;
  if (store.name && store.code) return `${store.name} (${store.code})`;
  return store.name || store.code || undefined;
}

function formatExpiryLabel(expiryDate: string | null | undefined): string {
  if (!expiryDate) return 'no expiry';
  return expiryDate.includes('T') ? expiryDate.split('T')[0]! : expiryDate;
}

function pickLotOption(
  options: AdjustInventoryLotOption[],
  preferred?: { productLotId?: string; batchId?: string },
): AdjustInventoryLotOption | undefined {
  if (options.length === 0) return undefined;
  if (preferred?.productLotId) {
    const byLot = options.find((o) => o.productLotId === preferred.productLotId);
    if (byLot) return byLot;
  }
  if (preferred?.batchId) {
    const byBatch = options.find((o) => o.batchId === preferred.batchId);
    if (byBatch) return byBatch;
  }
  return options.find((o) => o.availableQuantity > 0) ?? options[0];
}

function readCurrentUserId(): string | null {
  try {
    const userStr = localStorage.getItem('user');
    if (!userStr) return null;
    const user = JSON.parse(userStr) as { id?: string };
    return user.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve inventory target for adjust (FEFO lot/batch + store-available qty).
 * Multistore: store product lots (with inventoryBatchId) — same basis as Adjustments.
 * Single-store: inventory_batches FEFO.
 */
export async function resolveAdjustInventoryTarget(input: {
  productId: string;
  productName: string;
  preferredBatchId?: string;
  productLotId?: string;
  batchNumber?: string;
  currentQuantity?: number;
  storeLocationId?: string;
  storeLabel?: string;
}): Promise<AdjustInventoryTarget> {
  let batchId = input.preferredBatchId;
  let productLotId = input.productLotId;
  let batchNumber = input.batchNumber ?? 'MAIN';
  let currentQuantity =
    input.currentQuantity != null && Number.isFinite(input.currentQuantity)
      ? Number(input.currentQuantity)
      : 0;
  const storeLocationId = input.storeLocationId;
  const storeLabel = input.storeLabel;
  const hadExplicitQty =
    input.currentQuantity != null && Number.isFinite(input.currentQuantity);
  let lotOptions: AdjustInventoryLotOption[] = [];

  // Multistore: FEFO store lots + batch coupling (inventoryBatchId)
  if (storeLocationId) {
    try {
      const lotRes = await apiClient.get(`/inventory/store-products/${input.productId}/lots`, {
        params: { storeLocationId },
      });
      const lots = (lotRes.data?.data ?? []) as Array<{
        productLotId: string;
        lotNumber: string;
        availableQuantity: number | string;
        inventoryBatchId?: string | null;
        expiryDate?: string | null;
      }>;
      lotOptions = lots.map((l) => {
        const avail = Number(l.availableQuantity) || 0;
        const bid = l.inventoryBatchId ? String(l.inventoryBatchId) : undefined;
        return {
          key: l.productLotId,
          productLotId: l.productLotId,
          batchId: bid,
          batchNumber: l.lotNumber || 'LOT',
          availableQuantity: avail,
          expiryDate: l.expiryDate ?? null,
        };
      });
      const preferred = pickLotOption(lotOptions, {
        productLotId: input.productLotId,
        batchId: input.preferredBatchId,
      });
      if (preferred) {
        productLotId = preferred.productLotId;
        batchId = preferred.batchId ?? batchId;
        batchNumber = preferred.batchNumber;
        currentQuantity = preferred.availableQuantity;
      } else if (hadExplicitQty) {
        currentQuantity = Number(input.currentQuantity);
      } else {
        currentQuantity = 0;
      }
    } catch {
      // Fall through to batch FEFO
    }
  }

  // Single-store (or multistore fallback): FEFO inventory_batches
  if (lotOptions.length === 0) {
    try {
      const res = await apiClient.get('/inventory/batches', {
        params: { productId: input.productId },
      });
      const rows = (res.data?.data ?? []) as Array<{
        id: string;
        batch_number: string;
        remaining_quantity: number | string;
        expiry_date?: string | null;
        expiryDate?: string | null;
      }>;
      lotOptions = rows.map((b) => ({
        key: b.id,
        batchId: b.id,
        batchNumber: b.batch_number || 'MAIN',
        availableQuantity: Number(b.remaining_quantity) || 0,
        expiryDate: b.expiry_date ?? b.expiryDate ?? null,
      }));
      const preferred = pickLotOption(lotOptions, {
        productLotId: input.productLotId,
        batchId: input.preferredBatchId ?? batchId,
      });
      if (preferred) {
        batchId = preferred.batchId;
        batchNumber = preferred.batchNumber;
        if (productLotId) {
          // Keep store-available ∩ batch when lot already known from caller
          currentQuantity = Math.min(
            hadExplicitQty ? Number(input.currentQuantity) : preferred.availableQuantity,
            preferred.availableQuantity,
          );
        } else if (storeLocationId && hadExplicitQty) {
          // Multistore but no lots returned — keep seed (often 0), still bind FEFO batch for IN
          currentQuantity = Number(input.currentQuantity);
          batchId = preferred.batchId;
          batchNumber = preferred.batchNumber;
        } else {
          currentQuantity = preferred.availableQuantity;
        }
      } else if (hadExplicitQty) {
        currentQuantity = Number(input.currentQuantity);
      }
    } catch {
      // Backend FEFO-selects when batchId omitted
    }
  } else if (batchId) {
    // Cap store-available by coupled batch remaining when we know batchId
    try {
      const res = await apiClient.get('/inventory/batches', {
        params: { productId: input.productId },
      });
      const rows = (res.data?.data ?? []) as Array<{
        id: string;
        remaining_quantity: number | string;
      }>;
      const matched = rows.find((b) => b.id === batchId);
      if (matched) {
        const batchRemaining = Number(matched.remaining_quantity);
        if (Number.isFinite(batchRemaining)) {
          currentQuantity = Math.min(currentQuantity, batchRemaining);
          lotOptions = lotOptions.map((o) =>
            o.key === productLotId || o.batchId === batchId
              ? { ...o, availableQuantity: Math.min(o.availableQuantity, batchRemaining) }
              : o,
          );
        }
      }
    } catch {
      /* keep store-available */
    }
  }

  return {
    productId: input.productId,
    productName: input.productName,
    currentQuantity,
    batchId,
    productLotId,
    batchNumber,
    storeLocationId,
    storeLabel,
    lotOptions: lotOptions.length > 0 ? lotOptions : undefined,
  };
}

export function AdjustInventoryDrawer({
  open,
  target,
  onClose,
  onSuccess,
  initialMovementCategory = 'ADJUSTMENT',
}: AdjustInventoryDrawerProps) {
  const adjustBatchMutation = useAdjustBatch();
  const quantityInputRef = useRef<HTMLInputElement>(null);
  const reasonInputRef = useRef<HTMLTextAreaElement>(null);

  const [movementCategory, setMovementCategory] = useState<MovementCategory>('ADJUSTMENT');
  const [adjustmentType, setAdjustmentType] = useState<AdjustmentType>('increase');
  const [adjustmentQuantity, setAdjustmentQuantity] = useState('');
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [selectedLotKey, setSelectedLotKey] = useState<string>('');
  const [workingQty, setWorkingQty] = useState(0);
  const [workingBatchId, setWorkingBatchId] = useState<string | undefined>();
  const [workingProductLotId, setWorkingProductLotId] = useState<string | undefined>();
  const [workingBatchNumber, setWorkingBatchNumber] = useState('MAIN');

  // Reset form + bind FEFO / preferred lot whenever a new target opens
  useEffect(() => {
    if (!open || !target) return;
    const cat = initialMovementCategory ?? 'ADJUSTMENT';
    setMovementCategory(cat);
    setAdjustmentType(cat === 'DAMAGE' || cat === 'EXPIRY' ? 'decrease' : 'increase');
    setAdjustmentQuantity('');
    setAdjustmentReason('');

    const options = target.lotOptions ?? [];
    const preferred = pickLotOption(options, {
      productLotId: target.productLotId,
      batchId: target.batchId,
    });
    if (preferred) {
      setSelectedLotKey(preferred.key);
      setWorkingQty(preferred.availableQuantity);
      setWorkingBatchId(preferred.batchId);
      setWorkingProductLotId(preferred.productLotId);
      setWorkingBatchNumber(preferred.batchNumber);
    } else {
      setSelectedLotKey('');
      setWorkingQty(Number(target.currentQuantity) || 0);
      setWorkingBatchId(target.batchId);
      setWorkingProductLotId(target.productLotId);
      setWorkingBatchNumber(target.batchNumber || 'MAIN');
    }

    const t = window.setTimeout(() => quantityInputRef.current?.focus(), 100);
    return () => window.clearTimeout(t);
  }, [open, target?.productId, target?.batchId, target?.productLotId, target?.storeLocationId, initialMovementCategory]);

  const applyLotOption = useCallback((opt: AdjustInventoryLotOption) => {
    setSelectedLotKey(opt.key);
    setWorkingQty(opt.availableQuantity);
    setWorkingBatchId(opt.batchId);
    setWorkingProductLotId(opt.productLotId);
    setWorkingBatchNumber(opt.batchNumber);
  }, []);

  const previewNewQuantity = useMemo(() => {
    if (!target || !adjustmentQuantity) return null;
    const current = new Decimal(workingQty);
    const adjustment = new Decimal(adjustmentQuantity || 0);

    if (movementCategory === 'DAMAGE' || movementCategory === 'EXPIRY') {
      if (adjustment.gt(0) && adjustment.lt(current)) {
        return current.minus(adjustment).toNumber();
      }
      return current.toNumber();
    }

    return (
      adjustmentType === 'increase' ? current.plus(adjustment) : current.minus(adjustment)
    ).toNumber();
  }, [target, adjustmentQuantity, adjustmentType, movementCategory, workingQty]);

  const quarantinePreviewHint = useMemo(() => {
    if (
      (movementCategory !== 'DAMAGE' && movementCategory !== 'EXPIRY') ||
      !target ||
      !adjustmentQuantity
    ) {
      return null;
    }
    const current = Number(workingQty);
    const qty = Number(adjustmentQuantity);
    if (!(qty > 0) || qty > current + 0.0001) return null;
    if (Math.abs(qty - current) <= 0.0001) {
      return 'Full batch will be quarantined (non-sellable). No P&L until Dispose.';
    }
    return `Partial: ${qty} quarantined; ${(current - qty).toFixed(2)} stays sellable on this batch (lot split). No P&L until Dispose.`;
  }, [movementCategory, target, adjustmentQuantity, workingQty]);

  const formValidation = useMemo(() => {
    const errors: Record<string, string> = {};
    if (adjustmentQuantity && parseFloat(adjustmentQuantity) <= 0) {
      errors.quantity = 'Quantity must be greater than zero';
    }
    if (previewNewQuantity !== null && previewNewQuantity < 0) {
      errors.quantity = 'Resulting quantity cannot be negative';
    }
    if (adjustmentReason && adjustmentReason.length < 5) {
      errors.reason = 'Reason must be at least 5 characters';
    }
    return {
      errors,
      isValid: Object.keys(errors).length === 0 && !!adjustmentQuantity && !!adjustmentReason,
    };
  }, [adjustmentQuantity, adjustmentReason, previewNewQuantity]);

  const handleSubmit = useCallback(async () => {
    if (!target) {
      alert('Missing required data. Please try again.');
      return;
    }
    const userId = readCurrentUserId();
    if (!userId) {
      alert('You must be signed in to adjust inventory.');
      return;
    }

    const qty = new Decimal(adjustmentQuantity || 0).toNumber();
    if (qty <= 0) {
      alert('Quantity must be a positive number.');
      return;
    }

    const reason =
      movementCategory === 'DAMAGE'
        ? 'DAMAGE'
        : movementCategory === 'EXPIRY'
          ? 'EXPIRY'
          : 'ADJUSTMENT';

    const direction =
      movementCategory === 'DAMAGE' || movementCategory === 'EXPIRY'
        ? 'OUT'
        : adjustmentType === 'increase'
          ? 'IN'
          : 'OUT';

    try {
      const validatedData = BatchAdjustmentSchema.parse({
        batchId: workingBatchId,
        productLotId: workingProductLotId,
        productId: target.productId,
        storeLocationId: target.storeLocationId,
        quantity: qty,
        direction,
        reason,
        notes: adjustmentReason,
        userId,
      });

      await adjustBatchMutation.mutateAsync(validatedData);

      const isPartialQuarantine =
        (reason === 'DAMAGE' || reason === 'EXPIRY') &&
        qty > 0 &&
        qty < Number(workingQty) - 0.0001;

      const typeLabel =
        reason === 'DAMAGE'
          ? isPartialQuarantine
            ? `Partial damage quarantined (${qty} units; remainder stays sellable). Dispose from Inventory → Quarantine (DAMAGE band).`
            : 'Damage quarantined (no P&L yet). Dispose from Inventory → Quarantine (DAMAGE band).'
          : reason === 'EXPIRY'
            ? isPartialQuarantine
              ? `Partial expiry quarantined (${qty} units; remainder stays sellable). Dispose from Inventory → Quarantine (EXPIRED band).`
              : 'Expiry quarantined (no P&L yet). Dispose from Inventory → Quarantine (EXPIRED band).'
            : direction === 'IN'
              ? 'Stock increased'
              : 'Stock decreased';

      alert(`${typeLabel} successfully!`);
      onClose();
      onSuccess?.();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const first = error.issues[0];
        alert(`Validation: ${first?.message ?? 'Invalid input'}`);
        return;
      }
      const apiErr = error as {
        response?: {
          data?: {
            error?: string;
            error_code?: string;
            details?: {
              remaining?: number;
              requested?: number;
              deltaGap?: number;
              batchNumber?: string;
            };
          };
        };
      };
      const errorCode = apiErr?.response?.data?.error_code;
      const details = apiErr?.response?.data?.details;
      if (errorCode === 'INSUFFICIENT_BATCH_QTY') {
        alert(
          `Cannot reduce stock.\nBatch has ${details?.remaining ?? 0} unit(s) remaining, but ${details?.requested ?? qty} unit(s) were requested.`,
        );
        return;
      }
      if (errorCode === 'ERR_INVENTORY_BATCH_NO_COST') {
        alert(
          apiErr?.response?.data?.error ??
            'This batch has no unit cost. Repair batch valuation or receive stock with cost before reducing inventory.',
        );
        return;
      }
      if (errorCode === 'ERR_WAREHOUSE_LAYER_COUPLING') {
        alert(
          apiErr?.response?.data?.error ??
            'Warehouse batch and store balances are out of sync for this product. Retry the adjustment; if it persists, contact support.',
        );
        return;
      }
      if (errorCode === 'ERR_INVENTORY_GL_COUPLING') {
        alert(
          apiErr?.response?.data?.error ??
            `Inventory and GL would drift by ${details?.deltaGap ?? 'unknown'} UGX. Use Repair Valuation or contact support.`,
        );
        return;
      }
      console.error('Adjustment failed:', error);
      handleApiError(error, { fallback: 'Failed to adjust inventory' });
    }
  }, [
    target,
    adjustmentQuantity,
    adjustmentType,
    adjustmentReason,
    movementCategory,
    adjustBatchMutation,
    onClose,
    onSuccess,
    workingBatchId,
    workingProductLotId,
    workingQty,
  ]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && e.target !== reasonInputRef.current) {
        e.preventDefault();
        if (adjustmentQuantity && adjustmentReason && !adjustBatchMutation.isPending) {
          void handleSubmit();
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    open,
    adjustmentQuantity,
    adjustmentReason,
    adjustBatchMutation.isPending,
    handleSubmit,
    onClose,
  ]);

  if (!open || !target) return null;

  const title =
    movementCategory === 'DAMAGE'
      ? 'Record Damage'
      : movementCategory === 'EXPIRY'
        ? 'Quarantine Expired Stock'
        : 'Adjust Inventory';

  const subtitleParts = [
    target.productName,
    workingBatchNumber || target.batchNumber || 'batch',
    target.storeLabel ? `@ ${target.storeLabel}` : null,
  ].filter(Boolean);

  const lotOptions = target.lotOptions ?? [];
  const storeTotal =
    lotOptions.length > 0
      ? lotOptions.reduce((sum, o) => sum + (Number(o.availableQuantity) || 0), 0)
      : workingQty;

  return (
    <SlideDrawer
      open
      onClose={onClose}
      title={title}
      subtitle={subtitleParts.join(' — ')}
      width="xl"
      transactional
      cancellable={false}
      guardLabel="Stock adjustment"
      footer={
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium"
            disabled={adjustBatchMutation.isPending}
          >
            Cancel (Esc)
          </button>
          <button
            type="button"
            data-adjust-inventory-submit="true"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void handleSubmit();
            }}
            disabled={adjustBatchMutation.isPending || !formValidation.isValid}
            className="px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-lg font-medium disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {adjustBatchMutation.isPending
              ? 'Saving...'
              : movementCategory === 'DAMAGE'
                ? 'Record Damage'
                : movementCategory === 'EXPIRY'
                  ? 'Quarantine expired'
                  : 'Save Adjustment (Enter)'}
          </button>
        </div>
      }
    >
      <div className="space-y-4 -mt-2" data-adjust-inventory-drawer="true">
        {lotOptions.length > 0 && (
          <div>
            <label htmlFor="adj-lot-batch" className="block text-sm font-medium text-gray-700 mb-1">
              {target.storeLocationId ? 'Lot / batch (FEFO)' : 'Batch (FEFO)'}
            </label>
            <select
              id="adj-lot-batch"
              data-adjust-lot-select="true"
              value={selectedLotKey}
              onChange={(e) => {
                const opt = lotOptions.find((o) => o.key === e.target.value);
                if (opt) applyLotOption(opt);
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white"
            >
              {lotOptions.map((o, idx) => (
                <option key={o.key} value={o.key}>
                  {`${idx === 0 ? '★ FEFO · ' : ''}${o.batchNumber} · qty ${o.availableQuantity.toFixed(2)} · exp ${formatExpiryLabel(o.expiryDate)}`}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              {target.storeLocationId
                ? `Store-available across ${lotOptions.length} lot(s): ${storeTotal.toFixed(2)}. Adjust posts to the selected lot/batch.`
                : `FEFO order (earliest expiry first). ${lotOptions.length} batch(es) with stock.`}
            </p>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Current Quantity</label>
          <div className="text-2xl font-bold text-gray-900">{Number(workingQty).toFixed(2)}</div>
          {target.storeLocationId && lotOptions.length > 1 ? (
            <p className="text-xs text-gray-500 mt-1">
              Selected lot only (not full store total {storeTotal.toFixed(2)})
            </p>
          ) : null}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Movement Category</label>
          <ResponsiveGrid cols={3} className="gap-2">
            <button
              type="button"
              onClick={() => {
                setMovementCategory('ADJUSTMENT');
                setAdjustmentType('increase');
              }}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                movementCategory === 'ADJUSTMENT'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              ⚖️ Adjustment
            </button>
            <button
              type="button"
              onClick={() => {
                setMovementCategory('DAMAGE');
                setAdjustmentType('decrease');
              }}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                movementCategory === 'DAMAGE'
                  ? 'bg-orange-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              ⚠️ Damage
            </button>
            <button
              type="button"
              onClick={() => {
                setMovementCategory('EXPIRY');
                setAdjustmentType('decrease');
              }}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                movementCategory === 'EXPIRY'
                  ? 'bg-red-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              ⏰ Expiry
            </button>
          </ResponsiveGrid>
        </div>

        {movementCategory === 'ADJUSTMENT' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Adjustment Type</label>
            <div className="flex gap-4">
              <button
                type="button"
                onClick={() => setAdjustmentType('increase')}
                className={`flex-1 px-4 py-2 rounded-lg font-medium transition-colors ${
                  adjustmentType === 'increase'
                    ? 'bg-green-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                ➕ Increase
              </button>
              <button
                type="button"
                onClick={() => setAdjustmentType('decrease')}
                className={`flex-1 px-4 py-2 rounded-lg font-medium transition-colors ${
                  adjustmentType === 'decrease'
                    ? 'bg-red-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                ➖ Decrease
              </button>
            </div>
          </div>
        )}

        <div>
          <label htmlFor="adj-quantity" className="block text-sm font-medium text-gray-700 mb-1">
            Adjustment Quantity *
          </label>
          <input
            ref={quantityInputRef}
            id="adj-quantity"
            type="number"
            min="0"
            step="0.01"
            value={adjustmentQuantity}
            onChange={(e) => setAdjustmentQuantity(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                reasonInputRef.current?.focus();
              }
            }}
            className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 ${
              formValidation.errors.quantity ? 'border-red-500' : 'border-gray-300'
            }`}
            placeholder="0.00"
          />
          {formValidation.errors.quantity && (
            <p className="text-red-600 text-sm mt-1">{formValidation.errors.quantity}</p>
          )}
        </div>

        {previewNewQuantity !== null && (
          <div
            className={`border rounded-lg p-3 ${
              previewNewQuantity < 0 ? 'bg-red-50 border-red-300' : 'bg-blue-50 border-blue-200'
            }`}
          >
            <div
              className={`text-sm ${previewNewQuantity < 0 ? 'text-red-800' : 'text-blue-800'}`}
            >
              <strong>
                {(movementCategory === 'DAMAGE' || movementCategory === 'EXPIRY') &&
                Number(adjustmentQuantity) > 0 &&
                Number(adjustmentQuantity) < Number(workingQty)
                  ? 'Sellable left on this batch:'
                  : 'New Quantity:'}
              </strong>{' '}
              {previewNewQuantity.toFixed(2)}
              {previewNewQuantity < 0 && (
                <span className="ml-2">⚠️ Negative quantity not allowed</span>
              )}
            </div>
            {quarantinePreviewHint && (
              <p className="text-xs text-blue-700 mt-1">{quarantinePreviewHint}</p>
            )}
          </div>
        )}

        <div>
          <label htmlFor="adj-reason" className="block text-sm font-medium text-gray-700 mb-1">
            Reason * (min 5 characters)
          </label>
          <textarea
            ref={reasonInputRef}
            id="adj-reason"
            value={adjustmentReason}
            onChange={(e) => setAdjustmentReason(e.target.value)}
            className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 ${
              formValidation.errors.reason ? 'border-red-500' : 'border-gray-300'
            }`}
            rows={3}
            placeholder={
              movementCategory === 'DAMAGE'
                ? 'Describe the damage: broken packaging, water damage, etc.'
                : movementCategory === 'EXPIRY'
                  ? 'Expired batch disposal, date: ...'
                  : 'Physical count correction, damaged goods, etc.'
            }
          />
          {formValidation.errors.reason && (
            <p className="text-red-600 text-sm mt-1">{formValidation.errors.reason}</p>
          )}
          <p
            className={`text-xs mt-1 ${
              adjustmentReason.length >= 5 ? 'text-green-600' : 'text-gray-500'
            }`}
          >
            {adjustmentReason.length}/5 characters minimum
          </p>
        </div>

        <div className="bg-gray-50 border border-gray-200 rounded-lg p-2">
          <p className="text-xs text-gray-600">
            <strong>Keyboard shortcuts:</strong> Enter to submit | Esc to cancel
          </p>
        </div>
      </div>
    </SlideDrawer>
  );
}

export default AdjustInventoryDrawer;
