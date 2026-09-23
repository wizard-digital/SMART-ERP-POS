/**
 * PROOF: GR reverse journey — cross-surface contracts (operator path).
 *
 * Locks the failures that slipped past piece-wise proofs:
 * 1. Paid / consumed stock → reverse blocked
 * 2. Full reverse → PO DRAFT; list heal must NOT yank PENDING after resubmit
 * 3. Reversed GR UI → historical posting copy; no Return / Reassign
 * 4. Uninvoiced / full reverse → never Create Credit Note (even if sibling bill linked)
 * 5. SCN bill lookup → this GR only (no PurchaseOrderId sibling fallback)
 * 6. Inventory More menu → unique section keys (no duplicate `operations`)
 *
 * Emits: PROOF_GR_REVERSE_JOURNEY_SSOT.json / .md
 * Run: npm run proof:gr-reverse-journey-ssot
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planSupplierBillsForGrFullReverse,
  isFullReceiptReverseReason,
} from '@shared/domain/grFullReverseSsot';
import {
  canCreateSupplierCreditNoteFromReturn,
  isSupplierReturnNeedsAttention,
  isUninvoicedReceiptReversal,
  resolveSupplierReturnActionStatus,
} from '@shared/domain/supplierReturnWorklist';
import {
  resolveTargetPOWorkflowStatus,
  isPOFullyReversedProgress,
  poAllowsGoodsReceiptFinalize,
} from '@shared/domain/poReceiptWorkflowSsot';
import {
  canCreateSupplierBillFromGr,
  resolveGrBillingLane,
} from '@shared/domain/grBillingStatusSsot';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function exists(rel: string): boolean {
  return existsSync(path.join(repoRoot, rel));
}

describe('PROOF: GR reverse journey SSOT (cross-surface)', () => {
  it('shared contract files exist', () => {
    for (const rel of [
      'shared/domain/grFullReverseSsot.ts',
      'shared/domain/poReceiptWorkflowSsot.ts',
      'shared/domain/grBillingStatusSsot.ts',
      'shared/domain/supplierReturnWorklist.ts',
      'SamplePOS.Server/src/modules/purchase-orders/poReceiptStatusSync.ts',
      'SamplePOS.Server/src/modules/return-grn/returnGrnService.ts',
      'samplepos.client/src/pages/inventory/GoodsReceiptsPage.tsx',
      'samplepos.client/src/components/inventory/GrReceiptStatusBadge.tsx',
      'samplepos.client/src/components/InventoryLayout.tsx',
    ]) {
      gate(`FILE_${rel.replace(/[\\/.]/g, '_')}`, exists(rel), rel);
    }
  });

  it('behavioral: reverse eligibility + PO cycle + SCN fork', () => {
    const unpaid = planSupplierBillsForGrFullReverse([
      {
        id: '1',
        invoiceNumber: 'SBILL-U',
        documentType: 'SUPPLIER_INVOICE',
        amountPaid: 0,
        totalAmount: 100,
        outstandingBalance: 100,
      },
    ]);
    gate(
      'BEH_UNPAID_BILL_CANCEL_OK',
      unpaid.toCancel.length === 1 && unpaid.blockers.length === 0,
      'unpaid linked bill may auto-cancel on full reverse',
    );

    const paid = planSupplierBillsForGrFullReverse([
      {
        id: '2',
        invoiceNumber: 'SBILL-P',
        documentType: 'SUPPLIER_INVOICE',
        amountPaid: 50,
        totalAmount: 100,
        outstandingBalance: 50,
        status: 'PARTIALLY_PAID',
      },
    ]);
    gate(
      'BEH_PAID_BILL_BLOCKS_REVERSE',
      paid.toCancel.length === 0 && paid.blockers.some((b) => /payments applied/i.test(b)),
      'paid/partial bill blocks full reverse — no silent unallocate',
    );

    gate(
      'BEH_PO_REVERSE_TO_DRAFT',
      resolveTargetPOWorkflowStatus('COMPLETED', {
        fullyReceived: false,
        fullyReversed: true,
      }) === 'DRAFT' &&
        resolveTargetPOWorkflowStatus('PENDING', {
          fullyReceived: false,
          fullyReversed: true,
        }) === null &&
        resolveTargetPOWorkflowStatus('DRAFT', {
          fullyReceived: false,
          fullyReversed: true,
        }) === null,
      'COMPLETED→DRAFT on reverse; PENDING not yanked (resubmit sticks)',
    );

    gate(
      'BEH_PO_FULLY_REVERSED_PROGRESS',
      isPOFullyReversedProgress({
        completedGrCount: 1,
        netReceivedQtyTotal: 0,
        openQtyTotal: 24,
        orderedQtyTotal: 24,
      }),
      'net≈0 with GR history detects full reverse',
    );

    gate(
      'BEH_FINALIZE_ONLY_PENDING_PO',
      poAllowsGoodsReceiptFinalize('PENDING') &&
        !poAllowsGoodsReceiptFinalize('DRAFT') &&
        !poAllowsGoodsReceiptFinalize('COMPLETED') &&
        !poAllowsGoodsReceiptFinalize('CANCELLED') &&
        poAllowsGoodsReceiptFinalize('COMPLETED', { manualReceipt: true }) &&
        !poAllowsGoodsReceiptFinalize('DRAFT', { manualReceipt: true }),
      'Finalize GR when PO is PENDING; Manual GR COMPLETED+manual_receipt also allowed',
    );

    gate(
      'BEH_REVERSED_GR_NOT_BILLABLE',
      resolveGrBillingLane({
        receiptStatus: 'COMPLETED',
        isReversed: true,
        supplierBillNumber: 'SBILL-SIBLING',
      }) === 'REVERSED' &&
        !canCreateSupplierBillFromGr({
          receiptStatus: 'COMPLETED',
          isReversed: true,
          supplierBillNumber: 'SBILL-SIBLING',
        }),
      'reversed GR never billable even with sibling bill number',
    );

    const reverseWithSiblingBill = {
      status: 'POSTED' as const,
      hasCreditNote: false,
      hasSupplierBill: true,
      reason: '[Uninvoiced reversal] operator reverse',
    };
    gate(
      'BEH_FULL_REVERSE_NO_SCN_BUTTON',
      isUninvoicedReceiptReversal(reverseWithSiblingBill) &&
        isFullReceiptReverseReason(reverseWithSiblingBill.reason) &&
        resolveSupplierReturnActionStatus(reverseWithSiblingBill) === 'COMPLETE' &&
        !canCreateSupplierCreditNoteFromReturn(reverseWithSiblingBill) &&
        !isSupplierReturnNeedsAttention(reverseWithSiblingBill),
      'full/uninvoiced reverse: Done — never Create Credit Note despite sibling bill flag',
    );

    const normalInvoicedReturn = {
      status: 'POSTED' as const,
      hasCreditNote: false,
      hasSupplierBill: true,
      reason: 'Damaged goods',
    };
    gate(
      'BEH_INVOICED_RETURN_STILL_NEED_SCN',
      resolveSupplierReturnActionStatus(normalInvoicedReturn) === 'NEED_SCN' &&
        canCreateSupplierCreditNoteFromReturn(normalInvoicedReturn),
      'normal invoiced return still offers SCN',
    );
  });

  it('wiring: UI + server enforce the same journey contracts', () => {
    const grPage = read('samplepos.client/src/pages/inventory/GoodsReceiptsPage.tsx');
    const receiptBadge = read('samplepos.client/src/components/inventory/GrReceiptStatusBadge.tsx');
    const sync = read('SamplePOS.Server/src/modules/purchase-orders/poReceiptStatusSync.ts');
    const poSvc = read('SamplePOS.Server/src/modules/purchase-orders/purchaseOrderService.ts');
    const returnSvc = read('SamplePOS.Server/src/modules/return-grn/returnGrnService.ts');
    const eligibility = read(
      'SamplePOS.Server/src/modules/corrections/correctionEligibilityService.ts',
    );
    const grFullSsot = read('shared/domain/grFullReverseSsot.ts');
    const invLayout = read('samplepos.client/src/components/InventoryLayout.tsx');
    const poWorkflow = read('shared/domain/poReceiptWorkflowSsot.ts');
    const returnWorklist = read('shared/domain/supplierReturnWorklist.ts');
    const billVal = read(
      'SamplePOS.Server/src/modules/supplier-payments/supplierInvoiceGrnValidation.ts',
    );
    const grRepo = read('SamplePOS.Server/src/modules/goods-receipts/goodsReceiptRepository.ts');
    const returnRepo = read('SamplePOS.Server/src/modules/return-grn/returnGrnRepository.ts');

    gate(
      'WIRE_REVERSED_GR_UI',
      grPage.includes('Originally posted (now reversed') &&
        grPage.includes('!isGrReversed') &&
        grPage.includes('Return to Supplier') &&
        grPage.includes('Reassign supplier') &&
        receiptBadge.includes('isReversed') &&
        receiptBadge.includes('Reversed'),
      'reversed detail: historical posting + Completed/Reversed badge; actions gated',
    );

    gate(
      'WIRE_HEAL_NOT_PENDING',
      sync.includes("po.status = 'COMPLETED'") &&
        !sync.includes("po.status IN ('PENDING', 'COMPLETED')") &&
        sync.includes('forceDraftIfFullyReversed') &&
        sync.includes('cancelDraftGRsForPurchaseOrder') &&
        poSvc.includes('do not sync status here') &&
        poWorkflow.includes('poAllowsGoodsReceiptFinalize'),
      'list heal COMPLETED only; getPOById read-only; return/reverse force draft',
    );

    gate(
      'WIRE_BILL_DIRECT_GR_ONLY',
      !grRepo.includes('si."PurchaseOrderId" = gr.purchase_order_id') &&
        !returnRepo.includes('si."PurchaseOrderId" = g.purchase_order_id') &&
        billVal.includes('reversed_by_return_grn_id') &&
        billVal.includes('return_grn_lines') &&
        grPage.includes('hasSupplierBill: !!r.hasSupplierBill'),
      'bill/SCN attribution is this-GR only; billable qty nets returns; reversed blocked',
    );

    gate(
      'WIRE_FINALIZE_REQUIRES_PENDING_PO',
      grPage.includes('poAllowsGoodsReceiptFinalize') &&
        grPage.includes('submit and send') &&
        grPage.includes('poManualReceipt') &&
        grPage.includes('manualReceipt: linkedPoManualReceipt') &&
        poWorkflow.includes('manualReceipt') &&
        read('SamplePOS.Server/src/modules/goods-receipts/goodsReceiptService.ts').includes(
          'manualReceipt',
        ) &&
        read('SamplePOS.Server/src/modules/goods-receipts/goodsReceiptRepository.ts').includes(
          'poManualReceipt',
        ),
      'UI + server: Finalize needs PENDING PO, except Manual GR COMPLETED+manual_receipt shell',
    );

    gate(
      'WIRE_PO_DELETE_AFTER_REVERSE',
      read('SamplePOS.Server/src/modules/goods-receipts/goodsReceiptRepository.ts').includes(
        'countActiveGoodsReceiptsBlockingPoClose',
      ) &&
        read('SamplePOS.Server/src/modules/purchase-orders/purchaseOrderRepository.ts').includes(
          'countActiveGoodsReceiptsBlockingPoClose',
        ) &&
        read('SamplePOS.Server/src/modules/purchase-orders/purchaseOrderService.ts').includes(
          'countActiveGoodsReceiptsBlockingPoClose',
        ) &&
        !read('SamplePOS.Server/src/modules/purchase-orders/purchaseOrderRepository.ts').includes(
          'Delete goods receipts first',
        ),
      'Draft PO delete/cancel allowed when only reversed/cancelled GRs remain (audit kept)',
    );

    gate(
      'WIRE_SCN_FULL_REVERSE_BLOCK',
      returnSvc.includes('ERR_SCN_FULL_REVERSE') &&
        returnSvc.includes('isFullReceiptReverseReason') &&
        returnSvc.includes('reversed_by_return_grn_id') &&
        !returnSvc.includes('si."PurchaseOrderId"') &&
        returnSvc.includes('Never fall back to PurchaseOrderId') &&
        returnWorklist.includes('isSupplierReturnScnBlocked') &&
        returnWorklist.includes('canCreateSupplierCreditNoteFromReturn') &&
        grPage.includes('if (isGrReversed) return false') &&
        grPage.includes('Reversal complete — no credit note needed'),
      'server + UI block SCN on full reverse / reversed GR',
    );

    gate(
      'WIRE_PAID_AND_CONSUMED_BLOCK',
      grFullSsot.includes('payments applied') &&
        eligibility.includes('getConsumedBatchesForGrn') &&
        eligibility.includes('sold or consumed') &&
        eligibility.includes('planSupplierBillsForGrFullReverse'),
      'eligibility shares paid-bill + consumed-stock reverse blocks',
    );

    gate(
      'WIRE_MORE_NAV_UNIQUE_KEYS',
      invLayout.includes("group: 'overflow'") &&
        !invLayout.includes("group: 'operations' as const"),
      'overflow primary tabs use distinct key from More→operations group',
    );
  });

  it('related proof scripts are registered (journey suite is runnable)', () => {
    const pkg = read('package.json');
    for (const s of [
      'proof:gr-reverse-journey-ssot',
      'proof:po-receipt-workflow-ssot',
      'proof:procurement-integration-ssot',
      'proof:gr-full-reverse:live',
    ]) {
      gate(`SCRIPT_${s.replace(/:/g, '_')}`, pkg.includes(`"${s}"`), s);
    }
  });
});

afterAll(() => {
  const pass = gates.filter((g) => g.ok).length;
  const fail = gates.filter((g) => !g.ok).length;
  const verdict = fail === 0 ? 'PASS' : 'FAIL';
  const at = new Date().toISOString();
  const evidence = {
    at,
    feature: 'GR_REVERSE_JOURNEY_SSOT',
    summary: { pass, fail, total: gates.length, verdict },
    scope:
      'Cross-surface GR reverse: paid/consumed block, PO Draft then Pending sticks, reversed UI, no SCN on full reverse, no sibling bill lookup, unique More nav keys',
    sharedModules: [
      'shared/domain/grFullReverseSsot.ts',
      'shared/domain/poReceiptWorkflowSsot.ts',
      'shared/domain/grBillingStatusSsot.ts',
      'shared/domain/supplierReturnWorklist.ts',
    ],
    gates,
  };
  writeFileSync(
    path.join(repoRoot, 'PROOF_GR_REVERSE_JOURNEY_SSOT.json'),
    JSON.stringify(evidence, null, 2),
  );
  writeFileSync(
    path.join(repoRoot, 'PROOF_GR_REVERSE_JOURNEY_SSOT.md'),
    `# PROOF — GR reverse journey SSOT

**Generated:** ${at}  
**Verdict:** **${verdict}** (${pass}/${gates.length})  
**Scope:** ${evidence.scope}

## Gates
${gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} \`${g.id}\` — ${g.detail}`).join('\n')}
`,
  );
});
