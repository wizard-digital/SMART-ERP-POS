/**
 * Store Issue line grid — same chrome as TransferProductLinePicker
 * (EnterpriseProductSearch + DataTable + Input + UomSelector). FEFO posts on Issue now.
 */

import { useCallback, useMemo, useRef } from 'react';
import { toast } from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DataTable, type DataTableColumn } from '@/components/shared/DataTable';
import {
  EnterpriseProductSearch,
  type ProcurementProduct,
  type WarehouseSearchProduct,
} from '@/components/inventory/shared/EnterpriseProductSearch';
import { UomSelector } from '@/components/inventory/UomSelector';
import type { ProductUomDetail } from '@/hooks/useProductWithUoms';
import { api } from '@/utils/api';
import {
  formatMultiUomQuantity,
  productFromApiUoms,
} from '@/utils/formatQuantity';
import {
  convertPoLineQuantityForUomChange,
  poLineBaseQuantity,
} from '@shared/utils/po-line-uom';
import {
  formatQtyWithUom,
  issueShortage,
  issuedExceedsAvailable,
  issuedExceedsRequested,
} from '@shared/store-issue/issuePlan';

export type StoreIssueDraftLine = {
  productId: string;
  productName: string;
  sku?: string | null;
  availableQty: number;
  requestedQty: string;
  issuedQty: string;
  selectedUomId: string | null;
  conversionFactor: string;
  uomName: string;
  nearestExpiry?: string | null;
  storeName?: string | null;
  uoms?: unknown;
  actualUnitCost?: number | null;
  actualLineCost?: number | null;
};

interface StoreIssueLinePickerProps {
  lines: StoreIssueDraftLine[];
  onChange: (lines: StoreIssueDraftLine[]) => void;
  storeLocationId: string;
  storeLabel?: string;
  warehouseMode: boolean;
  disabled?: boolean;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
}

function mapApiUomsToPrefetched(uoms: unknown): ProductUomDetail[] {
  const arr = Array.isArray(uoms) ? uoms : [];
  return arr.map((raw: Record<string, unknown>) => ({
    id: String(raw.uomId ?? ''),
    uomId: String(raw.uomId ?? ''),
    uomName: String(raw.name ?? raw.uomName ?? ''),
    uomSymbol: (raw.symbol ?? raw.uomSymbol ?? null) as string | null,
    conversionFactor: String(raw.conversionFactor ?? 1),
    barcode: null,
    isDefault: Boolean(raw.isDefault),
    priceOverride: raw.price != null ? String(raw.price) : null,
    costOverride: raw.cost != null ? String(raw.cost) : null,
    factor: String(raw.conversionFactor ?? 1),
    displayCost: String(raw.cost ?? 0),
    displayPrice: String(raw.price ?? 0),
    marginPct: '0',
  }));
}

function formatFreeQty(n: number, uoms?: unknown): string {
  if (Array.isArray(uoms) && uoms.length > 0) {
    return formatMultiUomQuantity(n, productFromApiUoms(uoms));
  }
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function lineBaseRequested(line: StoreIssueDraftLine): number {
  return poLineBaseQuantity(line.requestedQty, line.conversionFactor);
}

function lineBaseIssued(line: StoreIssueDraftLine): number {
  return poLineBaseQuantity(line.issuedQty, line.conversionFactor);
}

export function StoreIssueLinePicker({
  lines,
  onChange,
  storeLocationId,
  storeLabel,
  warehouseMode,
  disabled = false,
  searchInputRef: externalSearchRef,
}: StoreIssueLinePickerProps) {
  const internalSearchRef = useRef<HTMLInputElement>(null);
  const searchInputRef = externalSearchRef ?? internalSearchRef;
  const qtyRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  const resolveIssuable = useCallback(
    async (productId: string, fallbackQty: number, fallbackLabel: string) => {
      try {
        const res = await api.kitchenProduction.issueAvailability(
          productId,
          warehouseMode ? storeLocationId : null,
        );
        const data = res.data.data;
        return {
          availableQty: Number(data?.availableQty ?? fallbackQty),
          storeLabel: data?.storeLabel || fallbackLabel,
          productName: data?.productName || fallbackLabel,
        };
      } catch {
        return { availableQty: fallbackQty, storeLabel: fallbackLabel, productName: fallbackLabel };
      }
    },
    [storeLocationId, warehouseMode],
  );

  const addLine = useCallback(
    async (input: {
      productId: string;
      productName: string;
      sku?: string | null;
      catalogFree: number;
      nearestExpiry?: string | null;
      storeName?: string | null;
      uoms?: unknown;
    }) => {
      if (disabled) return;
      if (lines.some((l) => l.productId === input.productId)) {
        toast.error('Product already on this issue');
        setTimeout(() => qtyRefs.current.get(input.productId)?.focus(), 0);
        return;
      }

      const issuable = await resolveIssuable(
        input.productId,
        input.catalogFree,
        input.productName,
      );
      if (!(issuable.availableQty > 0.001)) {
        toast.error(`No issuable stock for ${input.productName} at ${issuable.storeLabel}`);
        return;
      }

      const starter = Math.min(1, issuable.availableQty);
      const prefetchedUoms = mapApiUomsToPrefetched(input.uoms);
      const defaultUom = prefetchedUoms.find((u) => u.isDefault) ?? prefetchedUoms[0];
      const factor = defaultUom?.conversionFactor ?? '1';
      const displayStarter = convertPoLineQuantityForUomChange(starter, 1, factor);
      onChange([
        ...lines,
        {
          productId: input.productId,
          productName: input.productName,
          sku: input.sku,
          availableQty: issuable.availableQty,
          requestedQty: displayStarter,
          issuedQty: displayStarter,
          selectedUomId: defaultUom?.uomId ?? null,
          conversionFactor: factor,
          uomName: defaultUom?.uomSymbol || defaultUom?.uomName || '',
          nearestExpiry: input.nearestExpiry,
          storeName: input.storeName || issuable.storeLabel,
          uoms: input.uoms,
        },
      ]);
      setTimeout(() => qtyRefs.current.get(input.productId)?.focus(), 0);
    },
    [disabled, lines, onChange, resolveIssuable],
  );

  const handleWarehouseSelect = useCallback(
    (product: WarehouseSearchProduct) => {
      void addLine({
        productId: product.productId,
        productName: product.productName,
        sku: product.sku,
        catalogFree: product.freeQuantity ?? product.availableQuantity,
        nearestExpiry: product.nearestExpiry,
        storeName: product.storeName,
        uoms: product.uoms,
      });
    },
    [addLine],
  );

  const handleProcurementSelect = useCallback(
    (product: ProcurementProduct) => {
      void addLine({
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        catalogFree: product.quantityOnHand,
        nearestExpiry: null,
        storeName: null,
      });
    },
    [addLine],
  );

  const updateLine = (productId: string, patch: Partial<StoreIssueDraftLine>) => {
    onChange(lines.map((row) => (row.productId === productId ? { ...row, ...patch } : row)));
  };

  const removeLine = (productId: string) => {
    onChange(lines.filter((row) => row.productId !== productId));
    setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  const handleQtyKeyDown = (e: React.KeyboardEvent, productId: string) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchInputRef.current?.focus();
    }
    if (e.key === 'Escape') {
      removeLine(productId);
    }
  };

  const columns = useMemo((): DataTableColumn<StoreIssueDraftLine>[] => {
    return [
      {
        id: 'product',
        header: 'Product',
        cell: (line) => (
          <div className="min-w-[10rem]">
            <p className="font-medium text-sm text-gray-900">{line.productName}</p>
            {line.sku ? <p className="text-xs text-gray-500">SKU {line.sku}</p> : null}
          </div>
        ),
      },
      {
        id: 'available',
        header: 'Free qty',
        align: 'right',
        cell: (line) => (
          <span className="font-mono text-green-700 text-sm">
            {formatFreeQty(line.availableQty, line.uoms)}
          </span>
        ),
      },
      {
        id: 'requested',
        header: 'Requested',
        align: 'right',
        cellClassName: 'align-top',
        cell: (line) => (
          <Input
            type="number"
            min={0.000001}
            step="any"
            disabled={disabled}
            className="h-9 w-full min-w-[5rem] max-w-[7rem] ml-auto text-right font-mono"
            value={line.requestedQty}
            onChange={(e) => {
              const requested = e.target.value;
              const prevReq = Number(line.requestedQty) || 0;
              const prevIss = Number(line.issuedQty) || 0;
              updateLine(line.productId, {
                requestedQty: requested,
                issuedQty: prevIss === prevReq ? requested : line.issuedQty,
              });
            }}
          />
        ),
      },
      {
        id: 'issued',
        header: 'Issued',
        align: 'right',
        cellClassName: 'align-top',
        cell: (line) => {
          const overStock = issuedExceedsAvailable(lineBaseIssued(line), line.availableQty);
          const extra = issuedExceedsRequested(lineBaseRequested(line), lineBaseIssued(line));
          const short = issueShortage(lineBaseRequested(line), lineBaseIssued(line));
          const factor = Number(line.conversionFactor) || 1;
          const shortInUom = factor > 0 ? short / factor : short;
          return (
            <div className="space-y-1">
              <Input
                ref={(el) => {
                  if (el) qtyRefs.current.set(line.productId, el);
                  else qtyRefs.current.delete(line.productId);
                }}
                type="number"
                min={0}
                step="any"
                disabled={disabled}
                className={`h-9 w-full min-w-[5rem] max-w-[7rem] ml-auto text-right font-mono ${
                  overStock ? 'border-red-400 bg-red-50' : ''
                }`}
                value={line.issuedQty}
                onChange={(e) => updateLine(line.productId, { issuedQty: e.target.value })}
                onKeyDown={(e) => handleQtyKeyDown(e, line.productId)}
              />
              {overStock && (
                <p className="text-[11px] text-red-700">Exceeds free qty</p>
              )}
              {!overStock && extra && <p className="text-[11px] text-red-700">Over request</p>}
              {!overStock && short > 0 && (
                <p className="text-[11px] text-amber-700">
                  Short {formatQtyWithUom(shortInUom, line.uomName)}
                </p>
              )}
            </div>
          );
        },
      },
      {
        id: 'uom',
        header: 'UoM',
        cellClassName: 'align-top min-w-[8rem]',
        cell: (line) => {
          const prefetchedUoms = mapApiUomsToPrefetched(line.uoms);
          return (
            <UomSelector
              productId={line.productId}
              baseCost={0}
              selectedUomId={line.selectedUomId}
              prefetchedUoms={prefetchedUoms.length > 0 ? prefetchedUoms : undefined}
              disabled={disabled}
              onChange={({ uomId, conversionFactor: cf, uomName }) => {
                updateLine(line.productId, {
                  requestedQty: convertPoLineQuantityForUomChange(
                    line.requestedQty,
                    line.conversionFactor,
                    cf,
                  ),
                  issuedQty: convertPoLineQuantityForUomChange(
                    line.issuedQty,
                    line.conversionFactor,
                    cf,
                  ),
                  selectedUomId: uomId,
                  conversionFactor: cf,
                  uomName: uomId ? uomName : '',
                });
              }}
              className="w-full min-w-[7rem] px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white h-9"
            />
          );
        },
      },
      {
        id: 'actions',
        header: '',
        align: 'right',
        cell: (line) => (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-gray-400 hover:text-red-600"
            onClick={() => removeLine(line.productId)}
            disabled={disabled}
          >
            Remove
          </Button>
        ),
      },
    ];
  }, [disabled, lines]);

  const searchDisabled = disabled || (warehouseMode && !storeLocationId);

  return (
    <div className="space-y-4">
      <div>
        <Label className="text-sm font-medium text-gray-700">Search product</Label>
        {warehouseMode ? (
          <EnterpriseProductSearch
            mode="warehouse"
            storeLocationId={storeLocationId}
            storeLabel={storeLabel}
            onProductSelect={handleWarehouseSelect}
            disabled={searchDisabled}
            inputRef={searchInputRef}
            className="mt-1"
            placeholder="Search product… name, SKU, barcode, lot"
          />
        ) : (
          <EnterpriseProductSearch
            mode="procurement"
            onProductSelect={handleProcurementSelect}
            disabled={searchDisabled}
            inputRef={searchInputRef}
            className="mt-1"
            placeholder="Search product… name, SKU, barcode"
          />
        )}
        <p className="text-[10px] text-gray-400 mt-1">
          ↑↓ navigate · Enter adds line immediately · Esc removes focus. Source warehouse stock only
          (zero, expired, and blocked lots hidden).
        </p>
      </div>

      <DataTable
        columns={columns}
        data={lines}
        getRowKey={(line) => line.productId}
        stickyHeader
        emptyMessage="Search and press Enter to add products to this request."
        className="shadow-none border rounded-lg"
      />
    </div>
  );
}
