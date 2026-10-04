import { useQuery } from '@tanstack/react-query';
import { api } from '../utils/api';

export const salesTargetsEnabledQueryKey = ['sales-targets', 'enabled'] as const;

/**
 * Tenant flag: sales_targets_enabled via GET /api/sales-targets/enabled
 * Default off — tenants opt in under Settings → System.
 */
export function useSalesTargetsEnabled() {
  return useQuery({
    queryKey: salesTargetsEnabledQueryKey,
    queryFn: async () => {
      const res = await api.salesTargets.getEnabled();
      return Boolean(res.data?.data?.enabled);
    },
    staleTime: 30_000,
    retry: false,
  });
}
