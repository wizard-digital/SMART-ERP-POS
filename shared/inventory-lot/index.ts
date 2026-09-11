export * from './lotTypes.js';
export * from './lotInvariants.js';
export * from './lotPolicy.js';
export * from './lotRules.js';
export * from './lotValidation.js';
export * from './lotStatus.js';
export * from './lotCalculator.js';
export * from './lotEvents.js';
export * from './lotAudit.js';
export * from './lotSelection.js';
export * from './lotWriteDown.js';
export * from './fefoEngine.js';
export * from './fifoEngine.js';
export * from './lotRepository.js';
export * from './lotService.js';

import type { SelectionPolicy } from './lotTypes.js';
import type { ILotSelectionPolicy, LotSelectionRequest, LotSelectionResult } from './lotSelection.js';
import { fefoSelectionPolicy } from './fefoEngine.js';
import { fifoSelectionPolicy } from './fifoEngine.js';
import { emptySelectionResult } from './lotSelection.js';

const POLICIES: Record<SelectionPolicy, ILotSelectionPolicy | undefined> = {
  FEFO: fefoSelectionPolicy,
  FIFO: fifoSelectionPolicy,
  LIFO: undefined,
  MANUAL: undefined,
};

/** Resolve selection policy implementation */
export function selectLots(request: LotSelectionRequest): LotSelectionResult {
  if (request.policy === 'MANUAL' && request.specificLotId) {
    return fefoSelectionPolicy.select(request);
  }
  const impl = POLICIES[request.policy];
  if (!impl) return emptySelectionResult(request.policy, request.quantity);
  return impl.select(request);
}
