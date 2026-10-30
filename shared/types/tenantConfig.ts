/**
 * Tenant Configuration — shared between backend and frontend.
 *
 * This is the public-facing config that the frontend fetches on load.
 * It is NOT the full Tenant row from the master DB; it only contains
 * what the UI needs for branding, currency, and feature flags.
 */

export interface TenantCurrencyConfig {
  code: string;       // 'UGX', 'USD', 'KES', etc.
  symbol: string;     // 'UGX', '$', 'KSh', etc.
  name: string;       // 'Ugandan Shillings'
  decimals: number;   // Display decimal places (e.g., 2)
  thousandsSeparator: string;
  decimalSeparator: string;
  symbolPosition: 'before' | 'after';
}

export interface TenantBrandingConfig {
  companyName: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  logoUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  footerText: string;
}

export interface TenantLocaleConfig {
  country: string;    // ISO 3166-1 alpha-2 (e.g., 'UG')
  timezone: string;   // IANA timezone (e.g., 'Africa/Kampala')
  dateFormat: string;  // e.g., 'YYYY-MM-DD'
  timeFormat: string;  // e.g., 'HH:mm'
}

export interface TenantTaxConfig {
  enabled: boolean;
  defaultRate: number;
  name: string;       // 'VAT', 'GST', etc.
  inclusive: boolean;
}

export interface TenantFeatureFlags {
  pharmacy_mode: boolean;
  restaurant_mode: boolean;
  /** Runtime SSOT is system_settings.sales_targets_enabled (not this public config blob). */
  sales_targets: boolean;
  offline_pos: boolean;
  credit_sales: boolean;
  quotations: boolean;
  purchase_orders: boolean;
  multi_currency: boolean;
  barcode_scanner: boolean;
  [key: string]: boolean;  // Allow custom feature flags
}

export interface TenantConfig {
  tenantId: string;
  slug: string;
  name: string;
  plan: string;                // FREE | STARTER | PROFESSIONAL | ENTERPRISE
  planFeatures: string[];      // Module-level features derived from PLAN_LIMITS
  currency: TenantCurrencyConfig;
  branding: TenantBrandingConfig;
  locale: TenantLocaleConfig;
  tax: TenantTaxConfig;
  features: TenantFeatureFlags;
}
