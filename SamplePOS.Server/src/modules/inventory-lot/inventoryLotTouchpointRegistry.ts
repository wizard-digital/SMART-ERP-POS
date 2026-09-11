/**
 * Canonical ADR-002 §11 touchpoint registry — used by architecture proof tests.
 * Update status when migrating paths; do not delete rows (audit trail).
 */
export type TouchpointStatus =
  | 'MIGRATED'
  | 'PARTIAL'
  | 'EXCEPTION'
  | 'DEFERRED'
  | 'NOT_STARTED';

export interface LotTouchpoint {
  id: string;
  workflow: string;
  entryFile: string;
  targetGateway: string;
  status: TouchpointStatus;
  proof: string;
  notes?: string;
}

/** Approved write-gateway module — sole mutator for lot attributes */
export const LOT_WRITE_GATEWAY = 'SamplePOS.Server/src/modules/inventory-lot/';

export {
  ARCHITECTURAL_AUXILIARY_ALLOWLIST,
  PENDING_ARCHITECTURAL_DEBT,
  DOCUMENTED_LEGACY_WRITE_EXCEPTIONS,
  isAuxiliaryPath,
} from './inventoryLotArchitecturalPolicy.js';

/** Certification exit criteria — all must be true for Inventory Lot Foundation CERTIFIED */
export const INVENTORY_LOT_CERTIFICATION_EXIT = {
  touchpointsMigratedPercent: 100,
  pendingArchitecturalDebt: 0,
  orphanProjections: 0,
  expiryDriftRows: 0,
  negativeQuantities: 0,
  duplicateExpiryLogic: 0,
  duplicateFefoLogic: 0,
  directInventoryWrites: 0,
  architecturalRuleViolations: 0,
  proofGatesPass: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] as const,
} as const;

export const LOT_TOUCHPOINT_REGISTRY: LotTouchpoint[] = [
  { id: 'W01', workflow: 'Goods Receipt finalize', entryFile: 'goodsReceiptService.ts', targetGateway: 'receiveLot', status: 'MIGRATED', proof: 'phase6StructuralProof L02' },
  { id: 'W02', workflow: 'Opening balance / CSV import', entryFile: 'goodsReceiptService.ts', targetGateway: 'receiveOpeningLot', status: 'MIGRATED', proof: 'phase6StructuralProof L02' },
  { id: 'W03', workflow: 'Batch expiry edit (API)', entryFile: 'inventoryRoutes.ts', targetGateway: 'correctLotAttributes', status: 'MIGRATED', proof: 'correctLotExpiry import' },
  { id: 'W04', workflow: 'Warehouse adjustment lot link', entryFile: 'warehouseAdjustmentService.ts', targetGateway: 'ensureProjectionFromMaster', status: 'MIGRATED', proof: 'phase6StructuralProof Step 6' },
  { id: 'W05', workflow: 'Warehouse GRN segment projection', entryFile: 'warehouseInventoryRepository.ts', targetGateway: 'postgresLotRepository.upsertProjection', status: 'MIGRATED', proof: 'phase6StructuralProof Step 7' },
  { id: 'W06', workflow: 'Sales return (multistore)', entryFile: 'warehouseReturnInventoryService.ts', targetGateway: 'returnLot', status: 'MIGRATED', proof: 'phase6StructuralProof Step 6' },
  { id: 'W07', workflow: 'Customer return (legacy)', entryFile: 'customerReturnInventory.ts', targetGateway: 'returnLot', status: 'MIGRATED', proof: 'phase6StructuralProof Step 7' },
  { id: 'W08', workflow: 'Expiry automation status', entryFile: 'expiryAutomationService.ts', targetGateway: 'transitionLotStatus', status: 'MIGRATED', proof: 'expiryAutomationService.ts' },
  { id: 'W09', workflow: 'FEFO deduction (DN/dist/quote)', entryFile: 'fefoDeduction.ts', targetGateway: 'consumeLot', status: 'MIGRATED', proof: 'fefoDeduction.test.ts' },
  { id: 'W10', workflow: 'POS sale (legacy single-store)', entryFile: 'salesService.ts', targetGateway: 'consumeLot', status: 'MIGRATED', proof: 'phase6StructuralProof Step 9' },
  { id: 'W11', workflow: 'POS sale (multistore)', entryFile: 'warehouseSaleDeductionService.ts', targetGateway: 'consumeLot', status: 'MIGRATED', proof: 'phase6StructuralProof Step 10' },
  { id: 'W12', workflow: 'Sale refund restore', entryFile: 'salesService.ts', targetGateway: 'returnLot', status: 'MIGRATED', proof: 'phase6StructuralProof Step 9' },
  { id: 'W13', workflow: 'Sale void restore (legacy)', entryFile: 'salesService.ts', targetGateway: 'returnLot', status: 'MIGRATED', proof: 'phase6StructuralProof Step 9' },
  { id: 'W14', workflow: 'COGS / issue preview FEFO load', entryFile: 'atCostIssuePrice.ts', targetGateway: 'postgresLotSelector', status: 'MIGRATED', proof: 'phase6StructuralProof Step 8' },
  { id: 'W15', workflow: 'Multistore allocation read', entryFile: 'posAllocationLockRepository.ts', targetGateway: 'inventory_batches master join', status: 'MIGRATED', proof: 'phase6StructuralProof Step 10' },
  { id: 'W16', workflow: 'Reports days-until-expiry', entryFile: 'reportsRepository.ts', targetGateway: 'computeDaysUntilExpiry', status: 'MIGRATED', proof: 'phase6StructuralProof Step 10' },
  { id: 'W17', workflow: 'Client GR expiry gate', entryFile: 'grExpiryGate.ts', targetGateway: 'shared/inventory-lot/lotRules', status: 'MIGRATED', proof: 'grExpiryGate.spec.ts' },
  { id: 'W18', workflow: 'Store transfer', entryFile: 'storeTransferService.ts', targetGateway: 'transferLot', status: 'DEFERRED', proof: 'ADR §13.5', notes: 'Not implemented' },
  { id: 'W19', workflow: 'Return GRN', entryFile: 'returnGrnService.ts', targetGateway: 'consumeLot', status: 'MIGRATED', proof: 'warehouseSupplierReturnDeductionService → lotService.consumeLot' },
  { id: 'W20', workflow: 'Supplier return deduction', entryFile: 'warehouseSupplierReturnDeductionService.ts', targetGateway: 'consumeLot', status: 'MIGRATED', proof: 'warehouseSupplierReturnDeductionService.ts' },
  { id: 'W21', workflow: 'Multistore void restore', entryFile: 'warehouseSaleVoidRestoreService.ts', targetGateway: 'returnLot', status: 'MIGRATED', proof: 'warehouseSaleVoidRestoreService.test.ts' },
  { id: 'W22', workflow: 'Manufacturing', entryFile: '—', targetGateway: 'consumeLot/receiveLot', status: 'DEFERRED', proof: 'ADR §13.5' },
  { id: 'W23', workflow: 'Partial soft quarantine (lot split)', entryFile: 'softQuarantineService.ts / inventoryService.ts', targetGateway: 'splitLot → applySoftQuarantine', status: 'MIGRATED', proof: 'PROOF_QUARANTINE_LIFECYCLE_E2E + lotService.splitLot' },
  { id: 'W24', workflow: 'Near-expiry lot write-down', entryFile: 'lotWriteDownService.ts', targetGateway: 'writeDownNearExpiryLot', status: 'MIGRATED', proof: 'PROOF_LOT_WRITE_DOWN' },
];
