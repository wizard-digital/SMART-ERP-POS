// Reusable Product Form used across ProductsPage and ManualGRModal
import { useMemo } from 'react';
import CategoryCombobox from './CategoryCombobox';
import { buildPurchaseUomOptions } from '@/validation/product';
import {
  productFormSectionVisibility,
  serviceInventoryClearsForm,
  showRestaurantKitchenCatalogFields,
} from '@shared/utils/productTypeRules';
import { describeProductTaxLiability } from '@shared/utils/receiptPrintDisplay';
import { useRestaurantEnabled } from '@/hooks/useRestaurantEnabled';

/**
 * SAP/Odoo formula preview: safely evaluates the pricing formula in the browser
 * so the user sees what selling price would result BEFORE saving.
 * Variables match pricingService.evaluateFormula: cost, lastCost, sellingPrice, quantity, Math.
 */
function evalFormulaPreview(formula: string, costPrice: number): number | null {
  if (!formula.trim() || costPrice <= 0) return null;
  try {
     
    const fn = new Function('cost', 'lastCost', 'sellingPrice', 'quantity', 'Math',
      `return (${formula});`);
    const result = fn(costPrice, costPrice, 0, 1, Math);
    if (typeof result === 'number' && isFinite(result) && result > 0) return result;
    return null;
  } catch {
    return null;
  }
}

export interface ProductFormValues {
  name: string;
  sku: string;
  barcode: string;
  description: string;
  category: string;
  /** inventory = stocked SKU; consumable = stocked; service = no parent stock (pair with recipe for prepared food) */
  productType: 'inventory' | 'consumable' | 'service';
  genericName: string;
  costPrice: string;
  sellingPrice: string;
  costingMethod: string; // 'FIFO' | 'AVCO' | 'STANDARD'
  isTaxable: boolean;
  taxRate: string;
  pricingFormula: string;
  autoUpdatePrice: boolean;
  reorderLevel: string;
  trackExpiry: boolean;
  minDaysBeforeExpirySale: string;
  isActive: boolean;
  /** When restaurant module is on: show this product on Restaurant POS */
  availableInRestaurant: boolean;
  /** Kitchen finished / semi-finished food (cook-to-stock) */
  isPreparedFood: boolean;
  /** Buffet cover / plate capacity menu product */
  isBuffetCover: boolean;
  // Procurement fields (Part 9)
  preferredSupplierId: string;
  supplierProductCode: string;
  purchaseUomId: string;
  leadTimeDays: string;
  reorderQuantity: string;
}

export type ProductFormField = keyof ProductFormValues;

export interface ProductFormProps {
  values: ProductFormValues;
  onChange: (field: ProductFormField, value: string | boolean) => void;
  validationErrors?: Partial<Record<ProductFormField, string>>;
  disabled?: boolean;
  /** Supplier list for the Procurement tab dropdown (if not provided, tab is hidden) */
  suppliers?: Array<{ id: string; name: string }>;
  /** Master UoMs (fallback for quick-create bootstrap flow) */
  masterUoms?: Array<{ id: string; name: string; symbol?: string | null }>;
  /** Product UoMs already configured on this item — SSOT for Purchase UoM on edit */
  configuredProductUoms?: Array<{ id: string; name: string; symbol?: string | null }>;
  /** When true, Purchase UoM may only be chosen from configuredProductUoms */
  restrictPurchaseUomToConfigured?: boolean;
  /** Last purchase price (read-only, populated from DB) */
  lastPurchasePrice?: string;
  /**
   * Enterprise tax mappings for this product (Tax Engine).
   * Mapping wins over the Taxable checkbox at sale time.
   */
  taxMappings?: Array<{ code?: string | null; name?: string | null; rate?: number | null }> | null;
  /** Loading mappings indicator */
  taxMappingsLoading?: boolean;
  taxInclusivePricing?: boolean;
}

export default function ProductForm({
  values,
  onChange,
  validationErrors = {},
  disabled = false,
  suppliers,
  masterUoms,
  configuredProductUoms,
  restrictPurchaseUomToConfigured = false,
  lastPurchasePrice,
  taxMappings = null,
  taxMappingsLoading = false,
  taxInclusivePricing = false,
}: ProductFormProps) {
  const { data: restaurantEnabled = false } = useRestaurantEnabled();
  const showKitchenCatalog = showRestaurantKitchenCatalogFields(restaurantEnabled);
  const isService = values.productType === 'service';
  const sections = productFormSectionVisibility(values.productType);
  const inventoryDisabled = disabled || isService;
  const costNum = parseFloat(values.costPrice) || 0;
  const sellNum = parseFloat(values.sellingPrice) || 0;
  const formulaPreviewPrice = useMemo(
    () => values.autoUpdatePrice ? evalFormulaPreview(values.pricingFormula, costNum) : null,
    [values.pricingFormula, values.autoUpdatePrice, costNum]
  );
  const marginPct =
    costNum > 0 && Number.isFinite(sellNum)
      ? (((sellNum - costNum) / costNum) * 100).toFixed(1)
      : null;
  const sellingPriceHint = [
    formulaPreviewPrice != null
      ? `Formula preview: ${formulaPreviewPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
      : null,
    marginPct != null ? `Margin ${marginPct}%` : null,
  ]
    .filter(Boolean)
    .join(' · ') || undefined;

  const taxLiability = describeProductTaxLiability({
    isTaxable: values.isTaxable,
    taxRate: parseFloat(values.taxRate) || 0,
    mappings: taxMappings,
    taxInclusive: taxInclusivePricing,
  });
  const vatLiableHint = taxMappingsLoading
    ? 'Checking tax mappings…'
    : `${taxLiability.headline}. ${taxLiability.detail}`;

  const typeHint =
    isService
      ? 'No parent stock — link a recipe for ingredients'
      : values.productType === 'consumable'
        ? 'Stocked, then typically expensed when used'
        : 'Selling deducts this product\'s own stock';

  const purchaseUomOptions = useMemo(
    () =>
      buildPurchaseUomOptions({
        restrictToConfigured: restrictPurchaseUomToConfigured,
        configuredProductUoms,
        masterUoms,
        currentPurchaseUomId: values.purchaseUomId,
      }),
    [restrictPurchaseUomToConfigured, configuredProductUoms, masterUoms, values.purchaseUomId],
  );

  const handleProductTypeChange = (next: 'inventory' | 'consumable' | 'service') => {
    onChange('productType', next);
    if (next === 'service') {
      const clears = serviceInventoryClearsForm();
      onChange('trackExpiry', clears.trackExpiry);
      onChange('minDaysBeforeExpirySale', clears.minDaysBeforeExpirySale);
      onChange('reorderLevel', clears.reorderLevel);
      onChange('reorderQuantity', clears.reorderQuantity);
      onChange('preferredSupplierId', clears.preferredSupplierId);
      onChange('supplierProductCode', clears.supplierProductCode);
      onChange('purchaseUomId', clears.purchaseUomId);
      onChange('leadTimeDays', clears.leadTimeDays);
      onChange('autoUpdatePrice', clears.autoUpdatePrice);
      onChange('isPreparedFood', false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Basic Information */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="md:col-span-2">
          <label htmlFor="product-name" className="block text-sm font-medium text-gray-700 mb-1">
            Product name <span className="text-red-500">*</span>
          </label>
          <input
            id="product-name"
            type="text"
            value={values.name}
            onChange={(e) => onChange("name", e.target.value)}
            disabled={disabled}
            className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${validationErrors.name ? "border-red-500" : "border-gray-300"
              }`}
            placeholder="Product name"
          />
          {validationErrors.name && (
            <p className="text-sm text-red-600 mt-1">{validationErrors.name}</p>
          )}
        </div>

        <div>
          <label htmlFor="product-sku" className="block text-sm font-medium text-gray-700 mb-1">
            SKU <span className="text-red-500">*</span>
          </label>
          <input
            id="product-sku"
            type="text"
            value={values.sku}
            onChange={(e) => onChange("sku", e.target.value)}
            disabled={disabled}
            className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${validationErrors.sku ? "border-red-500" : "border-gray-300"
              }`}
            placeholder="PRD-XXX"
          />
          {validationErrors.sku && (
            <p className="text-sm text-red-600 mt-1">{validationErrors.sku}</p>
          )}
        </div>

        <div>
          <label htmlFor="product-barcode" className="block text-sm font-medium text-gray-700 mb-1">
            Barcode
          </label>
          <input
            id="product-barcode"
            type="text"
            value={values.barcode}
            onChange={(e) => onChange("barcode", e.target.value)}
            disabled={disabled}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="Barcode"
          />
        </div>

        <div>
          <label
            htmlFor="product-category"
            className="block text-sm font-medium text-gray-700 mb-1"
            title="Search existing or type to create"
          >
            Category
          </label>
          <CategoryCombobox
            value={values.category}
            onChange={(val) => onChange("category", val)}
            disabled={disabled}
          />
        </div>

        <div>
          <label
            htmlFor="product-type"
            className="block text-sm font-medium text-gray-700 mb-1"
            title={typeHint}
          >
            Type
          </label>
          <select
            id="product-type"
            value={values.productType || 'inventory'}
            onChange={(e) =>
              handleProductTypeChange(e.target.value as 'inventory' | 'consumable' | 'service')
            }
            disabled={disabled}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="inventory">Inventory</option>
            <option value="consumable">Consumable</option>
            <option value="service">Service</option>
          </select>
        </div>

        <div>
          <label
            htmlFor="generic-name"
            className="block text-sm font-medium text-gray-700 mb-1"
            title="Common name for search grouping"
          >
            Generic name
          </label>
          <input
            id="generic-name"
            type="text"
            value={values.genericName}
            onChange={(e) => onChange("genericName", e.target.value)}
            disabled={disabled}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="Generic name"
          />
        </div>

        <div className="md:col-span-2">
          <label htmlFor="product-description" className="block text-sm font-medium text-gray-700 mb-1">
            Description
          </label>
          <textarea
            id="product-description"
            value={values.description}
            onChange={(e) => onChange("description", e.target.value)}
            disabled={disabled}
            rows={2}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="Description"
          />
        </div>
      </div>

      {/* Pricing */}
      <div className="border-t pt-4">
        <h4 className="font-medium text-gray-900 mb-3">Pricing</h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label htmlFor="cost-price" className="block text-sm font-medium text-gray-700 mb-1">
              Cost <span className="text-red-500">*</span>
            </label>
            <input
              id="cost-price"
              type="number"
              step="1"
              value={values.costPrice}
              onChange={(e) => onChange('costPrice', e.target.value)}
              disabled={disabled}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="0.00"
            />
          </div>

          <div>
            <label
              htmlFor="selling-price"
              className="block text-sm font-medium text-gray-700 mb-1"
              title={sellingPriceHint}
            >
              Selling <span className="text-red-500">*</span>
            </label>
            <input
              id="selling-price"
              type="number"
              step="1"
              value={values.sellingPrice}
              onChange={(e) => onChange('sellingPrice', e.target.value)}
              disabled={disabled}
              className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                validationErrors.sellingPrice ? 'border-red-500' : 'border-gray-300'
              }`}
              placeholder="0.00"
            />
            {validationErrors.sellingPrice && (
              <p className="text-sm text-red-600 mt-1">{validationErrors.sellingPrice}</p>
            )}
          </div>

          <div>
            <label
              htmlFor="costing-method"
              className="block text-sm font-medium text-gray-700 mb-1"
              title={
                isService
                  ? 'Not used for service dishes — COGS comes from recipe ingredients'
                  : 'FIFO / AVCO / Standard valuation'
              }
            >
              Costing
            </label>
            <select
              id="costing-method"
              value={values.costingMethod}
              onChange={(e) => onChange("costingMethod", e.target.value)}
              disabled={inventoryDisabled}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50 disabled:text-gray-500"
            >
              <option value="FIFO">FIFO</option>
              <option value="AVCO">AVCO</option>
              <option value="STANDARD">Standard</option>
            </select>
          </div>
        </div>

        {/* Tax — liability toggle; explanation on hover only */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <label
            htmlFor="is-taxable"
            className="inline-flex items-center gap-2 text-sm text-gray-700"
            title={vatLiableHint}
          >
            <input
              id="is-taxable"
              type="checkbox"
              checked={values.isTaxable}
              onChange={(e) => onChange("isTaxable", e.target.checked)}
              disabled={disabled}
              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
            />
            VAT liable
          </label>
          {values.isTaxable && (
            <div className="flex items-center gap-2">
              <label
                htmlFor="tax-rate"
                className="text-sm text-gray-700 whitespace-nowrap"
                title="Fallback rate when no Tax Engine product mapping exists"
              >
                Rate % <span className="text-red-500">*</span>
              </label>
              <input
                id="tax-rate"
                type="number"
                step="1"
                min="0"
                max="100"
                value={values.taxRate}
                onChange={(e) => onChange('taxRate', e.target.value)}
                disabled={disabled}
                className={`w-24 px-2 py-1.5 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                  validationErrors.taxRate ? 'border-red-500' : 'border-gray-300'
                }`}
                placeholder="18"
              />
              {validationErrors.taxRate && (
                <p className="text-sm text-red-600">{validationErrors.taxRate}</p>
              )}
            </div>
          )}
        </div>

        {/* Pricing Formula & Auto-Update — stocked products only */}
        {sections.showPricingFormula && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <div>
            <label
              htmlFor="pricing-formula"
              className="block text-sm font-medium text-gray-700 mb-1"
              title="Variables: cost, lastCost, Math"
            >
              Formula
            </label>
            <input
              id="pricing-formula"
              type="text"
              value={values.pricingFormula}
              onChange={(e) => onChange("pricingFormula", e.target.value)}
              disabled={disabled}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="cost * 1.20"
            />
          </div>

          <div className="flex items-center gap-2 pt-6 md:pt-7">
            <input
              id="auto-update-price"
              type="checkbox"
              checked={values.autoUpdatePrice}
              onChange={(e) => onChange("autoUpdatePrice", e.target.checked)}
              disabled={disabled}
              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
            />
            <label
              htmlFor="auto-update-price"
              className="text-sm text-gray-700"
              title="Recalculate selling price when cost changes"
            >
              Auto-update price
            </label>
          </div>
        </div>
        )}
      </div>

      {/* Stock / availability */}
      <div className="border-t pt-4">
        <h4 className="font-medium text-gray-900 mb-3">
          {isService ? 'Availability' : 'Stock'}
        </h4>
        {isService ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label
              htmlFor="is-active"
              className="inline-flex items-center gap-2 text-sm text-gray-700"
              title="Inactive products are hidden from sales"
            >
              <input
                id="is-active"
                type="checkbox"
                checked={values.isActive}
                onChange={(e) => onChange("isActive", e.target.checked)}
                disabled={disabled}
                className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
              Active
            </label>
            {restaurantEnabled && (
              <label
                htmlFor="available-in-restaurant"
                className="inline-flex items-center gap-2 text-sm text-gray-700"
                title="Show on Restaurant POS"
              >
                <input
                  id="available-in-restaurant"
                  type="checkbox"
                  checked={values.availableInRestaurant !== false}
                  onChange={(e) => onChange('availableInRestaurant', e.target.checked)}
                  disabled={disabled}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                Restaurant
              </label>
            )}
            {showKitchenCatalog && (
              <label
                htmlFor="is-buffet-cover-svc"
                className="inline-flex items-center gap-2 text-sm text-gray-700"
                title="Sold as covers against an open buffet session"
              >
                <input
                  id="is-buffet-cover-svc"
                  type="checkbox"
                  checked={Boolean(values.isBuffetCover)}
                  onChange={(e) => onChange('isBuffetCover', e.target.checked)}
                  disabled={disabled}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                Buffet cover
              </label>
            )}
          </div>
        ) : (
        <>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label
              htmlFor="reorder-level"
              className="block text-sm font-medium text-gray-700 mb-1"
              title="Alert when stock reaches this level"
            >
              Reorder level
            </label>
            <input
              id="reorder-level"
              type="number"
              step="1"
              value={values.reorderLevel}
              onChange={(e) => onChange("reorderLevel", e.target.value)}
              disabled={disabled}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="10"
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-6 md:pt-7 md:col-span-2">
            <label
              htmlFor="track-expiry"
              className="inline-flex items-center gap-2 text-sm text-gray-700"
              title="Require expiry on receiving; FEFO allocations"
            >
              <input
                id="track-expiry"
                type="checkbox"
                checked={values.trackExpiry}
                onChange={(e) => onChange("trackExpiry", e.target.checked)}
                disabled={disabled}
                className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
              Track expiry
            </label>
            <label
              htmlFor="is-active"
              className="inline-flex items-center gap-2 text-sm text-gray-700"
              title="Inactive products are hidden from sales and inventory ops"
            >
              <input
                id="is-active"
                type="checkbox"
                checked={values.isActive}
                onChange={(e) => onChange("isActive", e.target.checked)}
                disabled={disabled}
                className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
              Active
            </label>
            {restaurantEnabled && (
              <label
                htmlFor="available-in-restaurant-inv"
                className="inline-flex items-center gap-2 text-sm text-gray-700"
                title="Show on Restaurant POS (needs a category)"
              >
                <input
                  id="available-in-restaurant-inv"
                  type="checkbox"
                  checked={values.availableInRestaurant !== false}
                  onChange={(e) => onChange('availableInRestaurant', e.target.checked)}
                  disabled={disabled}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                Restaurant
              </label>
            )}
            {showKitchenCatalog && sections.showPreparedFood && (
              <label
                htmlFor="is-prepared-food"
                className="inline-flex items-center gap-2 text-sm text-gray-700"
                title="Kitchen finished goods; pair with On production recipe"
              >
                <input
                  id="is-prepared-food"
                  type="checkbox"
                  checked={Boolean(values.isPreparedFood)}
                  onChange={(e) => onChange('isPreparedFood', e.target.checked)}
                  disabled={disabled}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                Prepared food
              </label>
            )}
            {showKitchenCatalog && (
              <label
                htmlFor="is-buffet-cover-inv"
                className="inline-flex items-center gap-2 text-sm text-gray-700"
                title="Requires an open buffet session"
              >
                <input
                  id="is-buffet-cover-inv"
                  type="checkbox"
                  checked={Boolean(values.isBuffetCover)}
                  onChange={(e) => onChange('isBuffetCover', e.target.checked)}
                  disabled={disabled}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                Buffet cover
              </label>
            )}
          </div>
        </div>

        {values.trackExpiry && (
          <div className="mt-3 flex items-center gap-3">
            <label
              htmlFor="min-days-expiry"
              className="text-sm text-gray-700 whitespace-nowrap"
              title="0 disables. Batches closer than this cannot be sold."
            >
              Min days to sell
            </label>
            <input
              id="min-days-expiry"
              type="number"
              min="0"
              step="1"
              value={values.minDaysBeforeExpirySale}
              onChange={(e) => onChange("minDaysBeforeExpirySale", e.target.value)}
              disabled={disabled}
              className="w-24 px-2 py-1.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="90"
            />
          </div>
        )}
        </>
        )}
      </div>

      {/* Procurement — stocked products only */}
      {suppliers && sections.showProcurement && (
        <div className="border-t pt-4">
          <h4 className="font-medium text-gray-900 mb-3">Procurement</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="preferred-supplier"
                className="block text-sm font-medium text-gray-700 mb-1"
                title="Pre-selected when creating POs for this product"
              >
                Preferred supplier
              </label>
              <select
                id="preferred-supplier"
                value={values.preferredSupplierId}
                onChange={(e) => onChange("preferredSupplierId", e.target.value)}
                disabled={disabled}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="">None</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="supplier-product-code"
                className="block text-sm font-medium text-gray-700 mb-1"
                title="Supplier catalog code — searchable on POs"
              >
                Supplier code
              </label>
              <input
                id="supplier-product-code"
                type="text"
                value={values.supplierProductCode}
                onChange={(e) => onChange("supplierProductCode", e.target.value)}
                disabled={disabled}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Supplier code"
                maxLength={100}
              />
            </div>

            <div>
              <label
                htmlFor="purchase-uom"
                className="block text-sm font-medium text-gray-700 mb-1"
                title={
                  restrictPurchaseUomToConfigured
                    ? 'Must match a unit configured under Units'
                    : 'Default unit for purchasing'
                }
              >
                Purchase UoM
              </label>
              {purchaseUomOptions.length > 0 ? (
                <select
                  id="purchase-uom"
                  value={values.purchaseUomId}
                  onChange={(e) => onChange("purchaseUomId", e.target.value)}
                  disabled={disabled}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">Base unit</option>
                  {purchaseUomOptions.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}{u.symbol ? ` (${u.symbol})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="purchase-uom"
                  type="text"
                  value=""
                  readOnly
                  disabled
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-500"
                  placeholder={restrictPurchaseUomToConfigured ? 'Add units first' : 'No UoMs'}
                />
              )}
            </div>

            <div>
              <label
                htmlFor="lead-time-days"
                className="block text-sm font-medium text-gray-700 mb-1"
                title="Average delivery time from supplier"
              >
                Lead time (days)
              </label>
              <input
                id="lead-time-days"
                type="number"
                min="0"
                step="1"
                value={values.leadTimeDays}
                onChange={(e) => onChange("leadTimeDays", e.target.value)}
                disabled={disabled}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="0"
              />
            </div>

            <div>
              <label
                htmlFor="reorder-quantity"
                className="block text-sm font-medium text-gray-700 mb-1"
                title="Suggested qty when stock drops below reorder level"
              >
                Reorder qty
              </label>
              <input
                id="reorder-quantity"
                type="number"
                min="0"
                step="1"
                value={values.reorderQuantity}
                onChange={(e) => onChange("reorderQuantity", e.target.value)}
                disabled={disabled}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="0"
              />
            </div>

            {lastPurchasePrice != null && lastPurchasePrice !== '' && (
              <div>
                <label
                  htmlFor="last-purchase-price"
                  className="block text-sm font-medium text-gray-700 mb-1"
                  title="From latest goods receipt"
                >
                  Last purchase
                </label>
                <input
                  id="last-purchase-price"
                  type="text"
                  value={lastPurchasePrice}
                  readOnly
                  disabled
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-600"
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
