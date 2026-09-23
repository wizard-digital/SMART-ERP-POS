import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { useState } from "react";
import { useCreateGoodsReceipt } from "@/hooks/useGoodsReceipts";
import { Loader2, Trash2, Plus } from "lucide-react";
import Decimal from "decimal.js";
import type { ApiResponse } from "@/types/api";
import { AxiosError } from "axios";
import { getBusinessDate } from "@/utils/businessDate";
import { UomSelector } from "./UomSelector";
import {
  SupplierSelector,
  NotesField,
  BusinessRulesInfo,
  GOODS_RECEIPT_RULES,
  ProcurementProductSearch,
  ModalContainer,
  type ProcurementProduct,
} from "./shared";
import { QuickCreateProductModal } from "./shared/QuickCreateProductModal";
import { useSubmitOnEnter } from "../../hooks/useSubmitOnEnter";
import { GrFefoExpiryWarning } from "./GrFefoExpiryWarning";

interface ManualGRItem {
  productId: string;
  productName: string;
  receivedQuantity: number;
  unitCost: number;
  productCostPrice: number;
  batchNumber?: string;
  expiryDate?: string;
  trackExpiry?: boolean;
  selectedUomId?: string | null;
  conversionFactor?: string;
}

interface ManualGRModalProps {
  open: boolean;
  onClose: () => void;
}

function procurementBestCost(product: ProcurementProduct): number {
  if (product.supplierLastPrice && product.supplierLastPrice > 0) {
    return product.supplierLastPrice;
  }
  if (product.lastCost > 0) return product.lastCost;
  return product.costPrice;
}

export default function ManualGRModal({ open, onClose }: ManualGRModalProps) {
  const [selectedItems, setSelectedItems] = useState<ManualGRItem[]>([]);
  const [notes, setNotes] = useState("");
  const [supplierId, setSupplierId] = useState<string>("");
  const [showCreateProductModal, setShowCreateProductModal] = useState(false);

  const createGRMutation = useCreateGoodsReceipt();

  const handleAddProduct = (product: ProcurementProduct) => {
    if (selectedItems.some((item) => item.productId === product.id)) {
      return;
    }

    const costPrice = procurementBestCost(product);
    const purchaseUomId =
      product.effectivePurchaseUomId || product.purchaseUomId || null;

    const newItem: ManualGRItem = {
      productId: product.id,
      productName: product.name,
      receivedQuantity: 1,
      unitCost: Number(costPrice),
      productCostPrice: Number(costPrice),
      batchNumber: "",
      expiryDate: "",
      trackExpiry: product.trackExpiry,
      selectedUomId: purchaseUomId,
    };

    setSelectedItems((prev) => [...prev, newItem]);
  };

  const handleQuickCreateProduct = (product: {
    id: string;
    name: string;
    costPrice: number;
    trackExpiry: boolean;
    purchaseUomId: string | null;
  }) => {
    if (selectedItems.some((item) => item.productId === product.id)) {
      setShowCreateProductModal(false);
      return;
    }

    const newItem: ManualGRItem = {
      productId: product.id,
      productName: product.name,
      receivedQuantity: 1,
      unitCost: product.costPrice,
      productCostPrice: product.costPrice,
      batchNumber: "",
      expiryDate: "",
      trackExpiry: product.trackExpiry,
      selectedUomId: product.purchaseUomId,
    };
    setSelectedItems((prev) => [...prev, newItem]);
    setShowCreateProductModal(false);
  };

  const updateItem = (index: number, field: keyof ManualGRItem, value: ManualGRItem[keyof ManualGRItem]) => {
    setSelectedItems((prev) =>
      prev.map((item, i) =>
        i === index ? { ...item, [field]: value } : item
      )
    );
  };

  const removeItem = (index: number) => {
    setSelectedItems((prev) => prev.filter((_, i) => i !== index));
  };

  const calculateVariance = (item: ManualGRItem) => {
    if (item.productCostPrice === 0) return { percent: 0, color: "text-gray-600" };

    const current = new Decimal(item.unitCost);
    const baseline = new Decimal(item.productCostPrice);
    const diff = current.minus(baseline);
    const percent = diff.div(baseline).times(100);

    if (percent.gt(0)) {
      return { percent: percent.toNumber(), color: "text-red-600", prefix: "+" };
    } else if (percent.lt(0)) {
      return { percent: percent.toNumber(), color: "text-green-600", prefix: "" };
    }
    return { percent: 0, color: "text-gray-600", prefix: "" };
  };

  const hasValidationErrors = () => {
    return selectedItems.some((item) => {
      if (item.receivedQuantity <= 0) return true;
      if (item.unitCost < 0) return true;

      if (item.trackExpiry) {
        if (!item.expiryDate || item.expiryDate.trim() === "") {
          return true;
        }
        if (item.expiryDate && item.expiryDate <= getBusinessDate()) return true;
      }

      return false;
    });
  };

  const handleSubmit = async () => {
    if (!supplierId) {
      return;
    }

    if (selectedItems.length === 0) {
      return;
    }

    if (hasValidationErrors()) {
      return;
    }

    try {
      const user = JSON.parse(localStorage.getItem("user") || "{}") as { id?: string };

      const payload = {
        supplierId,
        purchaseOrderId: null,
        receiptDate: getBusinessDate(),
        receivedBy: user.id,
        notes: notes || null,
        source: "MANUAL",
        items: selectedItems.map((item) => ({
          poItemId: undefined,
          productId: String(item.productId),
          productName: item.productName,
          orderedQuantity: Number(item.receivedQuantity),
          receivedQuantity: Number(item.receivedQuantity),
          unitCost: Number(item.unitCost),
          uomId: item.selectedUomId || undefined,
          batchNumber: item.batchNumber || undefined,
          expiryDate: item.expiryDate && item.expiryDate.trim() !== "" ? item.expiryDate : undefined,
        })),
      };

      await createGRMutation.mutateAsync(payload);

      setSupplierId("");
      setSelectedItems([]);
      setNotes("");

      onClose();
    } catch (err: unknown) {
      const axiosErr = err as AxiosError<ApiResponse>;
      console.error("Failed to create goods receipt:", axiosErr?.response?.data?.error || axiosErr.message);
    }
  };

  const hasUnsavedData = selectedItems.length > 0 || supplierId || notes.trim() !== "";

  const handleCloseAttempt = () => {
    if (hasUnsavedData) {
      const confirmed = window.confirm(
        "You have unsaved changes. Are you sure you want to close?"
      );
      if (confirmed) {
        setSupplierId("");
        setSelectedItems([]);
        setNotes("");
        onClose();
      }
    } else {
      onClose();
    }
  };

  useSubmitOnEnter(open && !showCreateProductModal, !createGRMutation.isPending && !!supplierId && selectedItems.length > 0, handleSubmit);

  if (!open) return null;

  return (
    <>
      <ModalContainer
        onClose={handleCloseAttempt}
        title="Manual Goods Receipt"
        subtitle="Record received goods without a purchase order. Add existing or new products."
        width="full"
        guardLabel="Manual Goods Receipt"
        footer={
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={handleCloseAttempt}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={!supplierId || selectedItems.length === 0 || hasValidationErrors() || createGRMutation.isPending}
            >
              {createGRMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save as Draft"
              )}
            </Button>
          </div>
        }
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <p className="text-xs text-gray-500 flex-1">
            Record received goods without a purchase order. Business rules apply to all lines.
          </p>
          <BusinessRulesInfo rules={GOODS_RECEIPT_RULES} title="Goods Receipt Rules" />
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <SupplierSelector
              value={supplierId}
              onChange={setSupplierId}
              className="md:col-span-1"
            />
            <NotesField
              value={notes}
              onChange={setNotes}
              placeholder="Optional notes..."
              className="md:col-span-2"
            />
          </div>

          <div className="border-t pt-4">
            <div className="flex items-center gap-2 mb-3">
              <ProcurementProductSearch
                supplierId={supplierId || undefined}
                onProductSelect={handleAddProduct}
                placeholder={
                  supplierId
                    ? undefined
                    : "Search products by name, SKU, or barcode..."
                }
                className="flex-1"
                disabled={!supplierId}
              />
              <Button type="button" variant="outline" onClick={() => setShowCreateProductModal(true)}>
                <Plus className="w-4 h-4 mr-2" /> New Product
              </Button>
            </div>
            {!supplierId && (
              <p className="text-xs text-amber-700">
                Select a supplier first to search products with supplier pricing hints.
              </p>
            )}
          </div>

          <div className="border-t pt-4">
            <h4 className="font-medium text-gray-900 mb-3">Selected Items</h4>
            {selectedItems.length === 0 ? (
              <div className="text-sm text-gray-500">No items added yet.</div>
            ) : (
              <div className="space-y-3">
                {selectedItems.map((item, idx) => {
                  const variance = calculateVariance(item);
                  return (
                    <div key={idx} className="p-3 border rounded-lg grid grid-cols-1 md:grid-cols-6 gap-3 items-center">
                      <div className="md:col-span-2">
                        <div className="text-sm font-medium flex items-center gap-2">
                          <span>{item.productName}</span>
                          <UomSelector
                            productId={item.productId}
                            baseCost={item.productCostPrice}
                            selectedUomId={item.selectedUomId}
                            onChange={(params) => {
                              updateItem(idx, "unitCost", parseFloat(params.newCost));
                              updateItem(idx, "selectedUomId", params.uomId);
                              updateItem(idx, "conversionFactor", params.conversionFactor);
                            }}
                            className="text-xs"
                          />
                        </div>
                      </div>
                      <div>
                        <label htmlFor={`qty-${idx}`} className="block text-xs text-gray-600 mb-1">Qty</label>
                        <input
                          id={`qty-${idx}`}
                          type="number"
                          min={0}
                          className="w-full px-2 py-1.5 border rounded"
                          value={item.receivedQuantity}
                          onChange={(e) => updateItem(idx, "receivedQuantity", Number(e.target.value))}
                          placeholder="0"
                        />
                      </div>
                      <div>
                        <label htmlFor={`unitcost-${idx}`} className="block text-xs text-gray-600 mb-1">Unit Cost</label>
                        <input
                          id={`unitcost-${idx}`}
                          type="number"
                          min={0}
                          step="1"
                          className="w-full px-2 py-1.5 border rounded"
                          value={item.unitCost}
                          onChange={(e) => updateItem(idx, "unitCost", Number(e.target.value))}
                          placeholder="0.00"
                        />
                        <div className={`text-xs mt-1 ${variance.color}`}>
                          {variance.prefix}
                          {Number.isFinite(variance.percent) ? variance.percent.toFixed(1) : 0}% vs cost
                        </div>
                      </div>
                      <div>
                        <label htmlFor={`batch-${idx}`} className="block text-xs text-gray-600 mb-1">Batch</label>
                        <input
                          id={`batch-${idx}`}
                          type="text"
                          className="w-full px-2 py-1.5 border rounded"
                          value={item.batchNumber || ""}
                          onChange={(e) => updateItem(idx, "batchNumber", e.target.value)}
                          placeholder="Batch number"
                        />
                      </div>
                      {item.trackExpiry && (
                        <div>
                          <label htmlFor={`expiry-${idx}`} className="block text-xs text-gray-600 mb-1">Expiry</label>
                          <DatePicker
                            value={item.expiryDate || ''}
                            onChange={(date) => updateItem(idx, "expiryDate", date)}
                            placeholder="Expiry date"
                            minDate={new Date()}
                          />
                        </div>
                      )}
                      {item.trackExpiry && item.expiryDate && (
                        <GrFefoExpiryWarning
                          productId={item.productId}
                          expiryDate={item.expiryDate}
                          unitCost={item.unitCost}
                        />
                      )}
                      <div className="flex justify-end">
                        <Button type="button" variant="ghost" size="icon" onClick={() => removeItem(idx)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </ModalContainer>

      {showCreateProductModal && (
        <QuickCreateProductModal
          onClose={() => setShowCreateProductModal(false)}
          onCreated={handleQuickCreateProduct}
          preferredSupplierId={supplierId || undefined}
        />
      )}
    </>
  );
}
