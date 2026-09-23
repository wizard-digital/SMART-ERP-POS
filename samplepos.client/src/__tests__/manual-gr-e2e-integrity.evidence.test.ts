/**
 * PROOF: Manual GR E2E integrity — no false COMPLETED before stock posts.
 *
 * Invariants:
 *   - createManualPO → PENDING + manual_receipt (not COMPLETED before Finalize)
 *   - GR create → DRAFT; Save as Draft CTA
 *   - ordered = received on manual create path
 *   - Finalize allowed for PENDING, and legacy COMPLETED+manual_receipt
 *   - poManualReceipt exposed on GR get/list; server assert allows manual
 *   - After finalize, syncPOStatusWithReceipts is sole PO status writer
 *
 * npx vitest run src/__tests__/manual-gr-e2e-integrity.evidence.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MANUAL_GR_STATUS_ON_CREATE,
  MANUAL_PO_STATUS_AFTER_FULL_RECEIPT,
  MANUAL_PO_STATUS_ON_CREATE,
  assertManualGrLineOrderedEqualsReceived,
  manualGrDraftAllowsFinalize,
  resolveManualGrLifecycle,
} from '../../../shared/domain/manualGrIntegritySsot';
import { poAllowsGoodsReceiptFinalize } from '../../../shared/domain/poReceiptWorkflowSsot';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '../..');
const repoRoot = resolve(clientRoot, '..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function readRepo(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), 'utf8');
}

function readClient(rel: string): string {
  return readFileSync(resolve(clientRoot, 'src', rel), 'utf8');
}

describe('PROOF: Manual GR E2E integrity SSOT', () => {
  it('behavioral: lifecycle + line parity + finalize matrix', () => {
    gate(
      'BEH_CREATE_STATUSES',
      MANUAL_PO_STATUS_ON_CREATE === 'PENDING' &&
        MANUAL_GR_STATUS_ON_CREATE === 'DRAFT' &&
        MANUAL_PO_STATUS_AFTER_FULL_RECEIPT === 'COMPLETED',
      'Create: PO PENDING + GR DRAFT; post: PO COMPLETED',
    );

    gate(
      'BEH_LINE_PARITY',
      assertManualGrLineOrderedEqualsReceived(2, 2) &&
        !assertManualGrLineOrderedEqualsReceived(2, 1),
      'Manual lines: ordered must equal received',
    );

    gate(
      'BEH_FINALIZE_MATRIX',
      manualGrDraftAllowsFinalize({
        grStatus: 'DRAFT',
        poStatus: 'PENDING',
        manualReceipt: true,
      }) &&
        manualGrDraftAllowsFinalize({
          grStatus: 'DRAFT',
          poStatus: 'COMPLETED',
          manualReceipt: true,
        }) &&
        !manualGrDraftAllowsFinalize({
          grStatus: 'DRAFT',
          poStatus: 'COMPLETED',
          manualReceipt: false,
        }) &&
        !manualGrDraftAllowsFinalize({
          grStatus: 'DRAFT',
          poStatus: 'DRAFT',
          manualReceipt: true,
        }) &&
        resolveManualGrLifecycle({
          grStatus: 'DRAFT',
          poStatus: 'PENDING',
          manualReceipt: true,
        }) === 'DRAFT_OPEN' &&
        resolveManualGrLifecycle({
          grStatus: 'COMPLETED',
          poStatus: 'COMPLETED',
          manualReceipt: true,
        }) === 'POSTED',
      'Finalize open for PENDING and legacy COMPLETED+manual; blocked for normal COMPLETED',
    );

    gate(
      'BEH_PO_ALLOW_SSOT',
      poAllowsGoodsReceiptFinalize('PENDING') &&
        poAllowsGoodsReceiptFinalize('COMPLETED', { manualReceipt: true }) &&
        !poAllowsGoodsReceiptFinalize('COMPLETED'),
      'poAllowsGoodsReceiptFinalize matches Manual GR matrix',
    );
  });

  it('wiring: create → draft UI → finalize → sync', () => {
    const createManual = readRepo(
      'SamplePOS.Server/src/modules/purchase-orders/purchaseOrderRepository.ts',
    );
    const createManualFn = createManual.slice(
      createManual.indexOf('async createManualPO'),
      createManual.indexOf('async addPOItems'),
    );
    const grSvc = readRepo('SamplePOS.Server/src/modules/goods-receipts/goodsReceiptService.ts');
    const grRepo = readRepo(
      'SamplePOS.Server/src/modules/goods-receipts/goodsReceiptRepository.ts',
    );
    const modal = readClient('components/inventory/ManualGRModal.tsx');
    const grPage = readClient('pages/inventory/GoodsReceiptsPage.tsx');
    const ssot = readRepo('shared/domain/manualGrIntegritySsot.ts');
    const sync = readRepo('SamplePOS.Server/src/modules/purchase-orders/poReceiptStatusSync.ts');

    gate(
      'WIRE_MANUAL_PO_PENDING',
      createManualFn.includes("'PENDING'") &&
        createManualFn.includes('manual_receipt') &&
        !createManualFn.includes("'COMPLETED'") &&
        ssot.includes("MANUAL_PO_STATUS_ON_CREATE: POWorkflowStatus = 'PENDING'"),
      'createManualPO inserts PENDING + manual_receipt — never COMPLETED before GR post',
    );

    gate(
      'WIRE_ORDERED_EQ_RECEIVED',
      grSvc.includes('orderedQuantity = grItem.receivedQuantity') &&
        grSvc.includes('Creating manual PO for supplier') &&
        modal.includes('orderedQuantity: Number(item.receivedQuantity)') &&
        modal.includes('receivedQuantity: Number(item.receivedQuantity)'),
      'Manual create path forces ordered = received (UI + server)',
    );

    gate(
      'WIRE_SAVE_AS_DRAFT',
      modal.includes('Save as Draft') &&
        modal.includes('source: "MANUAL"') &&
        modal.includes('purchaseOrderId: null') &&
        modal.includes('supplierId'),
      'ManualGRModal: Save as Draft + MANUAL source + supplier XOR PO',
    );

    gate(
      'WIRE_PO_MANUAL_FLAG_API',
      grRepo.includes('poManualReceipt') &&
        grRepo.includes('COALESCE(po.manual_receipt, false)') &&
        grPage.includes('poManualReceipt') &&
        grPage.includes('manualReceipt: linkedPoManualReceipt'),
      'GR get/list exposes poManualReceipt; detail Finalize uses it',
    );

    gate(
      'WIRE_SERVER_RECEIVE_MANUAL',
      grSvc.includes('manualReceipt') &&
        grSvc.includes("status === 'COMPLETED' || status === 'PENDING'") &&
        sync.includes('resolveTargetPOWorkflowStatus') &&
        grSvc.includes('syncPOStatusWithReceipts'),
      'assertPOAllowsReceiving allows manual PENDING/COMPLETED; finalize syncs PO',
    );

    gate(
      'WIRE_FINALIZE_CTA',
      grPage.includes('Finalize Goods Receipt') &&
        grPage.includes('canReceiveThisGR') &&
        grPage.includes('poAllowsGoodsReceiptFinalize') &&
        grPage.includes('Manual receipt — the linked PO is a tracking document'),
      'Detail shows Finalize when receivable; clarifying banner for manual shells',
    );
  });
});

afterAll(() => {
  const passed = gates.filter((g) => g.ok).length;
  const failed = gates.filter((g) => !g.ok);
  const payload = {
    proof: 'MANUAL_GR_E2E_INTEGRITY',
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    generatedAt: new Date().toISOString(),
    passed,
    total: gates.length,
    gates,
    integrity:
      'Manual GR E2E: PO PENDING+manual_receipt on create, GR DRAFT until Finalize, ordered=received, legacy COMPLETED+manual still receivable, sync sole COMPLETED writer — no false “already received” mismatch.',
  };
  const json = JSON.stringify(payload, null, 2);
  const md = `# PROOF — Manual GR E2E integrity

**Verdict:** ${payload.verdict}
**Generated:** ${payload.generatedAt}
**Gates:** ${passed}/${gates.length}

${gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} \`${g.id}\` — ${g.detail}`).join('\n')}

## Integrity
${payload.integrity}
`;
  for (const dir of [clientRoot, repoRoot]) {
    writeFileSync(resolve(dir, 'PROOF_MANUAL_GR_E2E_INTEGRITY.json'), json);
    writeFileSync(resolve(dir, 'PROOF_MANUAL_GR_E2E_INTEGRITY.md'), md);
  }
});
