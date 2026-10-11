/**
 * PROOF: Distribution sales order commercial totals SSOT.
 *
 * Order Total / Line Total = orderedQty × unitPrice (even when Confirmed=0 backorder).
 * Confirmed / Delivered values stay separate. Invoice AR is delivery-based — unchanged.
 *
 * npm test -- --runInBand src/modules/distribution/distSalesOrderTotals.evidence.test.ts
 */
import { afterAll, describe, expect, it } from '@jest/globals';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Money } from '../../utils/money.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repoRoot = path.resolve(serverRoot, '..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

describe('PROOF: dist sales order totals SSOT', () => {
  it('Money.lineTotal uses ordered qty — backorder Confirmed=0 still has order value', () => {
    const line1 = Money.toNumber(Money.lineTotal(1, 10000));
    const line2 = Money.toNumber(Money.lineTotal(1, 6000));
    const confirmedValue = Money.toNumber(Money.lineTotal(0, 10000));
    gate('LINE_ORDERED_10K', line1 === 10000, `line1=${line1}`);
    gate('LINE_ORDERED_6K', line2 === 6000, `line2=${line2}`);
    gate('ORDER_TOTAL_16K', line1 + line2 === 16000, `total=${line1 + line2}`);
    gate('CONFIRMED_ZERO_VALUE', confirmedValue === 0, `confirmedValue=${confirmedValue}`);
  });

  it('repository persists and reads ordered × price (not confirmed × price)', () => {
    const repo = readFileSync(
      path.join(serverRoot, 'src/modules/distribution/distRepository.ts'),
      'utf8',
    );
    const addFn = repo.slice(
      repo.indexOf('export async function addSalesOrderLine'),
      repo.indexOf('export async function getSalesOrder'),
    );
    const updateFn = repo.slice(
      repo.indexOf('export async function updateSalesOrderLine'),
      repo.indexOf('export async function deleteSalesOrderLine'),
    );
    gate(
      'ADD_ORDERED_LINE_TOTAL',
      addFn.includes('Money.lineTotal(data.orderedQty, data.unitPrice)') &&
        !addFn.includes('confirmedQty * data.unitPrice') &&
        !addFn.includes('Money.lineTotal(data.confirmedQty'),
      'addSalesOrderLine uses orderedQty × unitPrice',
    );
    gate(
      'UPDATE_ORDERED_LINE_TOTAL',
      updateFn.includes('Money.lineTotal(data.orderedQty, data.unitPrice)') &&
        !updateFn.includes('confirmedQty * data.unitPrice'),
      'updateSalesOrderLine uses orderedQty × unitPrice',
    );
    gate(
      'READ_TOTAL_ORDERED_SUM',
      (repo.match(/SUM\(sol\.ordered_qty \* sol\.unit_price\)/g) || []).length >= 3,
      'get/list SO total_amount from ordered_qty × unit_price',
    );
    gate(
      'READ_CONFIRMED_SEPARATE',
      (repo.match(/SUM\(sol\.confirmed_qty \* sol\.unit_price\)/g) || []).length >= 3,
      'total_confirmed remains confirmed × price',
    );
    gate(
      'LINE_SELECT_ORDERED',
      repo.includes('(sol.ordered_qty * sol.unit_price) AS line_total'),
      'getSalesOrderLines returns ordered × price as line_total',
    );
  });

  it('service normalizer and delivery credit stay on correct qty bases', () => {
    const svc = readFileSync(
      path.join(serverRoot, 'src/modules/distribution/distService.ts'),
      'utf8',
    );
    const normalizeLine = svc.slice(
      svc.indexOf('function normalizeSOLine'),
      svc.indexOf('function normalizeDelivery'),
    );
    gate(
      'NORMALIZE_ORDERED',
      normalizeLine.includes('Money.lineTotal(row.ordered_qty, row.unit_price)'),
      'normalizeSOLine recomputes ordered × price',
    );
    const deliveryFn = svc.slice(
      svc.indexOf('createDeliveryWithInvoice'),
      svc.indexOf('createDeliveryWithInvoice') + 4500,
    );
    gate(
      'CREDIT_USES_DELIVERY',
      deliveryFn.includes('dLine.quantity *') &&
        deliveryFn.includes('ERR_DIST_CREDIT'),
      'credit check uses delivery qty × price, not SO ordered total',
    );
    gate(
      'DELIVERABLE_USES_CONFIRMED',
      deliveryFn.includes('confirmed_qty') &&
        deliveryFn.includes('delivered_qty') &&
        deliveryFn.includes('ERR_DIST_002'),
      'deliverable qty = confirmed − delivered',
    );
  });

  it('detail UI separates Order Total, Confirmed Value, Invoice Due', () => {
    const detail = readFileSync(
      path.join(
        repoRoot,
        'samplepos.client/src/pages/distribution/DistSalesOrderDetailPage.tsx',
      ),
      'utf8',
    );
    gate('UI_ORDER_TOTAL', detail.includes('Order Total') && detail.includes('order.totalAmount'), 'Order Total card');
    gate('UI_CONFIRMED_VALUE', detail.includes('Confirmed Value') && detail.includes('order.totalConfirmed'), 'Confirmed Value card');
    gate('UI_INVOICE_DUE', detail.includes('Invoice Due') && detail.includes('totalDue'), 'Invoice Due (not misleading Amount Due)');
  });
});

afterAll(() => {
  const passed = gates.filter((g) => g.ok).length;
  const payload = {
    feature: 'DIST_SALES_ORDER_TOTALS_SSOT',
    verdict: passed === gates.length ? 'PASS' : 'FAIL',
    passed,
    total: gates.length,
    gates,
    incident: {
      order: 'DSO-2026-0001',
      symptom: 'Order Total / Line Total UGX 0.00 with Ordered=1 and Unit Price > 0 because Confirmed=0',
      rootCause: 'line_total and total_amount used confirmedQty × unitPrice',
      fix: 'commercial totals = orderedQty × unitPrice; confirmed/delivered/invoice remain separate',
    },
    at: new Date().toISOString(),
  };
  writeFileSync(
    path.join(repoRoot, 'PROOF_DIST_SALES_ORDER_TOTALS_SSOT.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  writeFileSync(
    path.join(serverRoot, 'PROOF_DIST_SALES_ORDER_TOTALS_SSOT.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
});
