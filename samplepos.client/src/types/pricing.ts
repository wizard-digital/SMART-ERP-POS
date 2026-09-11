/**
 * Pricing Module Types
 * TypeScript interfaces for price rules, categories, and price calculation
 */

// ============================================================================
// Product Category
// ============================================================================

export interface ProductCategory {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProductCategoryInput {
  name: string;
  description?: string;
}

export interface UpdateProductCategoryInput {
  name?: string;
  description?: string | null;
  isActive?: boolean;
}

// ============================================================================
// Customer Group (read-only for dropdowns)
// ============================================================================

export interface CustomerGroupOption {
  id: string;
  name: string;
  description: string | null;
  discountPercentage: number;
  isActive: boolean;
}

// ============================================================================
// Price Group (controls pricing MODE for a customer)
// ============================================================================

export type PricingMode = 'STANDARD' | 'AT_COST';

export interface PriceGroup {
  id: string;
  name: string;
  pricingMode: PricingMode;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePriceGroupInput {
  name: string;
  pricingMode: PricingMode;
  description?: string;
}

export interface UpdatePriceGroupInput {
  name?: string;
  pricingMode?: PricingMode;
  description?: string | null;
  isActive?: boolean;
}

// ============================================================================
// Price Rule
// ============================================================================

export type PriceRuleType = 'multiplier' | 'discount' | 'fixed';

export interface PriceRule {
  id: string;
  customerGroupId: string;
  customerGroupName?: string;
  name: string | null;
  ruleType: PriceRuleType;
  value: number;
  categoryId: string | null;
  categoryName?: string | null;
  productId: string | null;
  productName?: string | null;
  minQuantity: number;
  validFrom: string | null;
  validUntil: string | null;
  priority: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePriceRuleInput {
  customerGroupId: string;
  name?: string;
  ruleType: PriceRuleType;
  value: number;
  categoryId?: string | null;
  productId?: string | null;
  minQuantity?: number;
  validFrom?: string;
  validUntil?: string;
  priority?: number;
}

export interface UpdatePriceRuleInput {
  name?: string | null;
  ruleType?: PriceRuleType;
  value?: number;
  categoryId?: string | null;
  productId?: string | null;
  minQuantity?: number;
  validFrom?: string | null;
  validUntil?: string | null;
  priority?: number;
  isActive?: boolean;
}

// ============================================================================
// Price Calculation
// ============================================================================

export interface AtCostLayerPrice {
  baseQuantity: number;
  unitCostPerBase: number;
  totalCost: number;
}

export interface ResolvedPrice {
  finalPrice: number;
  basePrice: number;
  discount: number;
  atCostLayers?: AtCostLayerPrice[];
  /** FEFO allocated carrying per base unit — POS walk-in floor after lot write-down. */
  allocatedCostPerBase?: number;
  allocatedLayers?: AtCostLayerPrice[];
  appliedRule: {
    ruleId: string | null;
    ruleName: string | null;
    ruleType: PriceRuleType | null;
    ruleValue: number | null;
    scope: 'tier' | 'product' | 'category' | 'global' | 'group_discount' | 'formula' | 'base' | 'at_cost';
  };
}

export interface PriceCalculationRequest {
  productId: string;
  customerId?: string;
  customerGroupId?: string;
  quantity?: number;
}

export interface BulkPriceCalculationRequest {
  items: Array<{ productId: string; quantity?: number }>;
  customerId?: string;
  customerGroupId?: string;
}

export interface BulkPriceResult extends ResolvedPrice {
  productId: string;
  quantity: number;
}

// ============================================================================
// List / Filter
// ============================================================================

export interface PriceRuleFilters {
  page?: number;
  limit?: number;
  customerGroupId?: string;
  categoryId?: string;
  productId?: string;
  ruleType?: PriceRuleType;
  isActive?: boolean;
}

export interface CategoryFilters {
  page?: number;
  limit?: number;
  search?: string;
  isActive?: boolean;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
