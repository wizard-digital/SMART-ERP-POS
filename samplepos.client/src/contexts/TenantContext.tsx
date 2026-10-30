/**
 * TenantContext — provides tenant config (branding, currency, features)
 * to the entire frontend. Fetches from GET /api/tenant/config on mount.
 *
 * This runs BEFORE auth, so the login page can already display the
 * correct company name, logo, and currency.
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import type { TenantConfig } from '../../../shared/types/tenantConfig';
import { api } from '../utils/api';
import { applyCurrencyConfig } from '../utils/currency';

interface TenantContextValue {
  config: TenantConfig;
  loading: boolean;
  error: string | null;
}

/** Hardcoded defaults used until the API responds */
const DEFAULT_CONFIG: TenantConfig = {
  tenantId: 'default',
  slug: 'default',
  name: 'SMART ERP',
  plan: 'ENTERPRISE',
  planFeatures: ['pos', 'inventory', 'customers', 'basic_reports', 'reports', 'invoices', 'expenses', 'hr', 'accounting', 'purchase_orders', 'edge_sync', 'api_access', 'custom_domain', 'priority_support'],
  currency: {
    code: 'UGX',
    symbol: 'UGX',
    name: 'Ugandan Shillings',
    decimals: 2,
    thousandsSeparator: ',',
    decimalSeparator: '.',
    symbolPosition: 'before',
  },
  branding: {
    companyName: 'SMART ERP',
    companyAddress: '',
    companyPhone: '',
    companyEmail: '',
    logoUrl: null,
    primaryColor: '#2563eb',
    secondaryColor: '#10b981',
    footerText: 'Thank you for your business!',
  },
  locale: {
    country: 'UG',
    timezone: 'Africa/Kampala',
    dateFormat: 'YYYY-MM-DD',
    timeFormat: 'HH:mm',
  },
  tax: {
    enabled: true,
    defaultRate: 18,
    name: 'VAT',
    inclusive: false,
  },
  features: {
    pharmacy_mode: false,
    restaurant_mode: false,
    sales_targets: false,
    offline_pos: true,
    credit_sales: true,
    quotations: true,
    purchase_orders: true,
    multi_currency: false,
    barcode_scanner: true,
  },
};

const TenantContext = createContext<TenantContextValue>({
  config: DEFAULT_CONFIG,
  loading: true,
  error: null,
});

export function TenantProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<TenantConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchConfig() {
      try {
        const res = await api.tenant.getConfig();
        if (!cancelled && res.data?.success && res.data.data) {
          const tenantConfig = res.data.data as TenantConfig;
          setConfig(tenantConfig);
          // Push currency config to the formatting module
          applyCurrencyConfig(tenantConfig.currency);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Failed to load tenant config';
          setError(message);
          // Keep defaults — the app still works
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchConfig();
    return () => { cancelled = true; };
  }, []);

  return (
    <TenantContext.Provider value={{ config, loading, error }}>
      {children}
    </TenantContext.Provider>
  );
}

/** Access tenant config from any component */
export function useTenant(): TenantContextValue {
  return useContext(TenantContext);
}

/** Shortcut: check if a feature flag is enabled */
export function useFeatureFlag(flag: keyof TenantConfig['features']): boolean {
  const { config } = useContext(TenantContext);
  return config.features[flag] ?? false;
}
