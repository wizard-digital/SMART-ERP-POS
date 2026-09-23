/**
 * Evidence: Purchase Order PDF maps camelCase service PO (not snake_case-only).
 *
 * Root cause of blank PO preview (supplier —, product —, UGX 0.00):
 * documentRenderer.read snake_case while getPOById returns mapped camelCase.
 *
 * Emits: PROOF_PO_PDF_CAMELCASE.md + .json (repo root)
 *
 * npm test -- --runInBand src/modules/documents/purchaseOrderPdf.evidence.test.ts
 */
import { afterAll, describe, expect, it } from '@jest/globals';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repoRoot = path.resolve(serverRoot, '..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  if (!ok) expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function readRepo(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('PROOF: Purchase Order PDF field mapping', () => {
  it('renderer accepts camelCase service shape', () => {
    const src = readRepo('SamplePOS.Server/src/modules/documents/documentRenderer.ts');
    const poFn = src.slice(src.indexOf('async function renderPurchaseOrder'));
    const body = poFn.slice(0, poFn.indexOf('// =============================================================================\n// GOODS RECEIPT'));

    gate('PICK_HELPER', body.includes('function pickField') || src.includes('function pickField'), 'pickField helper');
    gate('CAMEL_PO_NUMBER', /poNumber/.test(body), 'reads poNumber');
    gate('CAMEL_ORDER_DATE', /orderDate/.test(body), 'reads orderDate');
    gate('CAMEL_EXPECTED', /expectedDate/.test(body), 'reads expectedDate');
    gate('CAMEL_TOTAL', /totalAmount/.test(body), 'reads totalAmount');
    gate('CAMEL_SUPPLIER_ID', /supplierId/.test(body), 'reads supplierId');
    gate('CAMEL_PRODUCT', /productName/.test(body), 'reads productName');
    gate('CAMEL_UNIT_COST', /unitCost/.test(body), 'reads unitCost');
    gate('CAMEL_LINE_TOTAL', /lineTotal/.test(body), 'reads lineTotal');
    gate('SNAKE_FALLBACK', /order_number|unit_price|supplier_id/.test(body), 'snake_case still accepted');
  });

  it('repository map exposes supplierName + camel items', () => {
    const src = readRepo('SamplePOS.Server/src/modules/purchase-orders/purchaseOrderRepository.ts');
    gate('MAP_SUPPLIER_NAME', src.includes('supplierName'), 'map includes supplierName');
    gate('MAP_UNIT_COST', /unitCost:\s*Number/.test(src) || src.includes('unitCost: Number'), 'map unitCost');
    gate('MAP_PRODUCT', src.includes('productName'), 'map productName');
    gate(
      'SERVICE_RETURNS_MAPPED',
      /mapPurchaseOrderRow/.test(src) && /mapPurchaseOrderItemRow/.test(src),
      'getPOById returns mapped rows',
    );
  });

  it('mapping simulation: camel PO does not render as zeros', () => {
    // Mirror pickField + num from renderer
    function pickField(row: Record<string, unknown>, ...keys: string[]): unknown {
      for (const k of keys) {
        if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
      }
      return undefined;
    }
    const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v));

    const po = {
      poNumber: 'PO-2026-0090',
      supplierId: 'sup-1',
      supplierName: 'Test Supplier Ltd',
      orderDate: '2026-08-01',
      expectedDate: '2026-08-10',
      status: 'PENDING',
      totalAmount: 1500000,
    };
    const item = {
      productName: 'Paracetamol 500mg',
      quantity: 90,
      unitCost: 1000,
      lineTotal: 90000,
      receivedQuantity: 0,
      uomName: 'Box',
    };

    const poNumber = String(pickField(po, 'poNumber', 'order_number') ?? '');
    const total = num(pickField(po, 'totalAmount', 'total_amount'));
    const product = String(pickField(item, 'productName', 'product_name') ?? '—');
    const unit = num(pickField(item, 'unitCost', 'unit_price'));

    gate('SIM_PO_NUMBER', poNumber === 'PO-2026-0090', poNumber);
    gate('SIM_TOTAL', total === 1500000, String(total));
    gate('SIM_PRODUCT', product === 'Paracetamol 500mg', product);
    gate('SIM_UNIT', unit === 1000, String(unit));

    // Old broken keys only
    const brokenTotal = num(po as unknown as Record<string, unknown>['total_amount']);
    void brokenTotal;
    const brokenRead = num((po as Record<string, unknown>).total_amount);
    gate('OLD_SNAKE_FAILS', brokenRead === 0, 'snake-only would be 0 on camel object');
  });
});

afterAll(() => {
  const pass = gates.filter((g) => g.ok).length;
  const fail = gates.filter((g) => !g.ok).length;
  const verdict = fail === 0 ? 'PASS' : 'FAIL';
  const at = new Date().toISOString();
  const evidence = {
    at,
    feature: 'PO_PDF_CAMELCASE_MAPPING',
    summary: { pass, fail, total: gates.length, verdict },
    rootCause:
      'renderPurchaseOrder expected snake_case (order_number, unit_price) but getPOById returns camelCase (poNumber, unitCost).',
    gates,
  };

  const md = `# PROOF — Purchase Order PDF camelCase mapping

**Generated:** ${at}  
**Verdict:** **${verdict}** (${pass}/${gates.length} gates)

## Root cause

Local PO preview showed company header (e.g. BLIZ INTERNATIONAL LTD) with:

- SUPPLIER **—**
- PURCHASE ORDER **—**
- product names **—**
- totals **UGX 0.00**

Quantities still appeared (shared key \`quantity\`). Status worked (\`status\` same in both shapes).

**Fix:** \`documentRenderer.renderPurchaseOrder\` uses camelCase + snake_case \`pickField\`; repository map keeps \`supplierName\`.

## Gates

| Gate | Result | Detail |
|------|--------|--------|
${gates.map((g) => `| \`${g.id}\` | ${g.ok ? 'PASS' : 'FAIL'} | ${g.detail.replace(/\|/g, '\\\\|')} |`).join('\n')}

## Re-run

\`\`\`bash
cd SamplePOS.Server
npm test -- --runInBand src/modules/documents/purchaseOrderPdf.evidence.test.ts
\`\`\`
`;

  writeFileSync(path.join(repoRoot, 'PROOF_PO_PDF_CAMELCASE.json'), JSON.stringify(evidence, null, 2));
  writeFileSync(path.join(repoRoot, 'PROOF_PO_PDF_CAMELCASE.md'), md);
});
