import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../utils/api';
import type { StoreLocation } from '../../../shared/types/warehouseNetwork';
import type { StoreTransfer } from '../../../shared/types/storeTransfer';
import type { TransferWorkflowCapabilities } from '../../../shared/types/transferWorkflow';

export const warehouseKeys = {
  all: ['warehouse'] as const,
  stores: () => [...warehouseKeys.all, 'stores'] as const,
  transfers: () => [...warehouseKeys.all, 'transfers'] as const,
  transfer: (id: string) => [...warehouseKeys.transfers(), id] as const,
  transferCapabilities: () => [...warehouseKeys.all, 'transfer-capabilities'] as const,
  distribution: (productId: string) => [...warehouseKeys.all, 'distribution', productId] as const,
  stockByStore: (storeId: string) => [...warehouseKeys.all, 'stock', storeId] as const,
  storeLots: (storeId: string) => [...warehouseKeys.all, 'lots', storeId] as const,
};

export function useStoreLocations(enabled = true) {
  return useQuery({
    queryKey: warehouseKeys.stores(),
    queryFn: async () => {
      const res = await api.warehouse.storeLocations.list();
      return (res.data?.data ?? []) as StoreLocation[];
    },
    enabled,
  });
}

export function useEnsureDefaultStores() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.warehouse.storeLocations.ensureDefaults(),
    onSuccess: () => qc.invalidateQueries({ queryKey: warehouseKeys.stores() }),
  });
}

export function useCreateStoreLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      code: string;
      name: string;
      storeType: StoreLocation['storeType'];
      isDefaultReceiving?: boolean;
      isPosSelling?: boolean;
    }) => api.warehouse.storeLocations.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: warehouseKeys.stores() }),
  });
}

export function useUpdateStoreLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Partial<StoreLocation>) =>
      api.warehouse.storeLocations.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: warehouseKeys.stores() }),
  });
}

export function useTransferWorkflowCapabilities(enabled = true) {
  return useQuery({
    queryKey: warehouseKeys.transferCapabilities(),
    queryFn: async () => {
      const res = await api.warehouse.storeTransfers.workflowCapabilities();
      return (res.data?.data ?? null) as TransferWorkflowCapabilities | null;
    },
    enabled,
    staleTime: 30_000,
  });
}

export function useStoreTransfers(enabled = true) {
  return useQuery({
    queryKey: warehouseKeys.transfers(),
    queryFn: async () => {
      const res = await api.warehouse.storeTransfers.list();
      return (res.data?.data ?? []) as StoreTransfer[];
    },
    enabled,
  });
}

export function useStoreTransfer(id: string) {
  return useQuery({
    queryKey: warehouseKeys.transfer(id),
    queryFn: async () => {
      const res = await api.warehouse.storeTransfers.getById(id);
      return res.data?.data as StoreTransfer;
    },
    enabled: !!id,
  });
}

export function useCreateStoreTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      destinationStoreId?: string;
      notes?: string | null;
      overrideReason?: string | null;
      overrideComments?: string | null;
      assortmentExpansions?: Array<{ productId: string; expandPermanently: boolean }>;
      lines: Array<{ productLotId: string; quantity: number }>;
    }) => api.warehouse.storeTransfers.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: warehouseKeys.transfers() }),
  });
}

export function usePreviewTransferAssortment() {
  return useMutation({
    mutationFn: (data: {
      destinationStoreId: string;
      lines: Array<{ productLotId: string; quantity: number }>;
    }) => api.warehouse.storeTransfers.previewAssortment(data),
  });
}

export function useApproveStoreTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      lines,
    }: {
      id: string;
      lines?: Array<{ lineId: string; quantity: number; comment?: string | null }>;
    }) => api.warehouse.storeTransfers.approve(id, lines ? { lines } : undefined),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: warehouseKeys.transfers() });
      qc.invalidateQueries({ queryKey: warehouseKeys.transfer(id) });
    },
  });
}

export function useSaveTransferApprovalDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      lines,
    }: {
      id: string;
      lines?: Array<{ lineId: string; quantity: number; comment?: string | null }>;
    }) => api.warehouse.storeTransfers.saveApprovalDraft(id, lines ? { lines } : undefined),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: warehouseKeys.transfers() });
      qc.invalidateQueries({ queryKey: warehouseKeys.transfer(id) });
    },
  });
}

export function useDispatchStoreTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      lines,
    }: {
      id: string;
      lines?: Array<{ lineId: string; quantity: number; comment?: string | null }>;
    }) => api.warehouse.storeTransfers.dispatch(id, lines ? { lines } : undefined),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: warehouseKeys.transfers() });
      qc.invalidateQueries({ queryKey: warehouseKeys.transfer(id) });
    },
  });
}

export function useReceiveStoreTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      lines,
    }: {
      id: string;
      lines?: Array<{ lineId: string; quantity: number; comment?: string | null }>;
    }) => api.warehouse.storeTransfers.receive(id, lines ? { lines } : undefined),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: warehouseKeys.transfers() });
      qc.invalidateQueries({ queryKey: warehouseKeys.transfer(id) });
    },
  });
}

export function useCancelStoreTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string | null }) =>
      api.warehouse.storeTransfers.cancel(id, reason != null ? { reason } : undefined),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: warehouseKeys.transfers() });
      qc.invalidateQueries({ queryKey: warehouseKeys.transfer(id) });
    },
  });
}

export function useCompleteStoreTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      lines,
    }: {
      id: string;
      lines?: Array<{ lineId: string; quantity: number; comment?: string | null }>;
    }) => api.warehouse.storeTransfers.complete(id, lines ? { lines } : undefined),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: warehouseKeys.transfers() });
      qc.invalidateQueries({ queryKey: warehouseKeys.transfer(id) });
    },
  });
}

export function useProductStoreDistribution(productId: string, enabled: boolean) {
  return useQuery({
    queryKey: warehouseKeys.distribution(productId),
    queryFn: async () => {
      const res = await api.warehouse.productStoreDistribution(productId);
      return res.data?.data ?? [];
    },
    enabled: enabled && !!productId,
  });
}

export function useStockLevelsByStore(storeLocationId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: warehouseKeys.stockByStore(storeLocationId ?? 'none'),
    queryFn: async () => {
      const res = await api.inventory.stockLevels(storeLocationId ?? undefined);
      return res.data?.data ?? [];
    },
    enabled: enabled && !!storeLocationId,
  });
}

export interface WarehouseLotRow {
  productLotId: string;
  inventoryBatchId?: string | null;
  lotNumber: string;
  productId: string;
  productName: string;
  availableQuantity: number;
  expiryDate: string | null;
}

export function useStoreLotsAtStore(storeLocationId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: warehouseKeys.storeLots(storeLocationId ?? 'none'),
    queryFn: async () => {
      const res = await api.warehouse.storeLots(storeLocationId!);
      return (res.data?.data ?? []) as WarehouseLotRow[];
    },
    enabled: enabled && !!storeLocationId,
  });
}
