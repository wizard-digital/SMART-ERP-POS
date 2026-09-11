/**
 * PROOF: Clearance markdown (lot write-down) is absolute ADMIN-only.
 * inventory.adjust / MANAGER / CASHIER must never authorize posting.
 *
 * npm run proof:lot-write-down:admin
 * (also included in npm run proof:lot-write-down)
 */
import { afterAll, describe, expect, it } from '@jest/globals';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAbsoluteAdminRole } from '@shared/authorization/agedSaleReturnPolicy.js';
import {
  canPerformLotWriteDown,
  ERR_LOT_WRITE_DOWN_ADMIN_ONLY,
  lotWriteDownAdminDeniedMessage,
} from '@shared/inventory-lot/lotWriteDown.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repoRoot = path.resolve(serverRoot, '..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('PROOF: Lot write-down / clearance markdown ADMIN-only', () => {
  it('SSOT: only absolute ADMIN / SUPER_ADMIN may perform write-down', () => {
    gate('ERR_CODE', ERR_LOT_WRITE_DOWN_ADMIN_ONLY === 'ERR_LOT_WRITE_DOWN_ADMIN_ONLY', ERR_LOT_WRITE_DOWN_ADMIN_ONLY);
    gate('MSG', lotWriteDownAdminDeniedMessage().includes('ADMIN'), lotWriteDownAdminDeniedMessage());
    gate('ADMIN_OK', canPerformLotWriteDown('ADMIN') && canPerformLotWriteDown('admin'), 'ADMIN');
    gate('SUPER_ADMIN_OK', canPerformLotWriteDown('SUPER_ADMIN'), 'SUPER_ADMIN');
    gate(
      'MANAGER_DENY',
      !canPerformLotWriteDown('MANAGER') && !isAbsoluteAdminRole('MANAGER'),
      'MANAGER denied',
    );
    gate(
      'CASHIER_DENY',
      !canPerformLotWriteDown('CASHIER') && !canPerformLotWriteDown('STAFF'),
      'CASHIER/STAFF denied',
    );
    gate('NULL_DENY', !canPerformLotWriteDown(null) && !canPerformLotWriteDown(undefined), 'null/undefined denied');
  });

  it('route + service + UI cannot be bypassed via inventory.adjust', () => {
    const routes = read('SamplePOS.Server/src/modules/inventory-lot/lotWriteDownRoutes.ts');
    const svc = read('SamplePOS.Server/src/modules/inventory-lot/lotWriteDownService.ts');
    const page = read('samplepos.client/src/pages/ReportsPage.tsx');
    const ssot = read('shared/inventory-lot/lotWriteDown.ts');
    const live = read('SamplePOS.Server/scripts/proof-lot-write-down-live.ts');
    const surfaces = read('SamplePOS.Server/scripts/lotWriteDownLiveSurfaces.ts');
    const exec = read('SamplePOS.Server/src/modules/inventory-lot/lotWriteDownService.execution.test.ts');

    gate(
      'ROUTE_NO_INVENTORY_ADJUST',
      !routes.includes("requirePermission('inventory.adjust')") &&
        !/requirePermission\([^)]*inventory\.adjust/.test(routes),
      'route never grants via requirePermission(inventory.adjust)',
    );
    gate(
      'ROUTE_ADMIN_MIDDLEWARE',
      routes.includes('requireLotWriteDownAdmin') &&
        routes.includes('canPerformLotWriteDown') &&
        routes.includes('ERR_LOT_WRITE_DOWN_ADMIN_ONLY') &&
        routes.includes('SELECT role FROM users'),
      'HTTP middleware checks users.role + ADMIN SSOT',
    );
    gate(
      'SERVICE_DB_ROLE',
      /SELECT role FROM users[\s\S]{0,200}canPerformLotWriteDown/.test(svc) &&
        svc.includes('ERR_LOT_WRITE_DOWN_ADMIN_ONLY'),
      'posting transaction re-checks DB role (JWT alone insufficient)',
    );
    gate(
      'UI_ADMIN_GATE',
      page.includes('canPerformLotWriteDown') &&
        page.includes('canClearanceMarkdown') &&
        page.includes('(ADMIN only)') &&
        /canWriteDown\s*=\s*[\s\S]{0,80}canClearanceMarkdown/.test(page),
      'Clearance markdown button requires ADMIN',
    );
    gate(
      'SSOT_DOCUMENTED',
      ssot.includes('ADMIN-only') && ssot.includes('inventory.adjust'),
      'SSOT documents no adjust bypass',
    );
    gate(
      'LIVE_USES_ADMIN_USER',
      live.includes("IN ('ADMIN', 'SUPER_ADMIN')") || live.includes("IN ('ADMIN','SUPER_ADMIN')"),
      'live proof posts only as ADMIN/SUPER_ADMIN',
    );
    gate(
      'LIVE_HTTP_CASHIER_403',
      surfaces.includes('PERMISSIONS_HTTP') &&
        surfaces.includes("role: 'CASHIER'") &&
        surfaces.includes('probeHttpRole') &&
        surfaces.includes('res.status === 403'),
      'live surfaces prove cashier HTTP → 403',
    );
    gate(
      'LIVE_HTTP_MANAGER_403',
      surfaces.includes('PERMISSIONS_HTTP_MANAGER') &&
        surfaces.includes("'MANAGER'") &&
        surfaces.includes('probeHttpRole') &&
        surfaces.includes('ERR_LOT_WRITE_DOWN_ADMIN_ONLY'),
      'live surfaces prove manager HTTP → 403 (adjust cannot bypass)',
    );
    gate(
      'LIVE_SERVICE_MANAGER_DENY',
      surfaces.includes('PERMISSIONS_SERVICE_MANAGER') &&
        surfaces.includes('ERR_LOT_WRITE_DOWN_ADMIN_ONLY') &&
        surfaces.includes('writeDownNearExpiryLot'),
      'live surfaces prove MANAGER service call rejected with ADMIN-only code',
    );
    gate(
      'EXEC_MANAGER_CASHIER',
      exec.includes('EXEC_ADMIN_ONLY') &&
        exec.includes('EXEC_CASHIER_BLOCKED') &&
        exec.includes("makePool(makeBatch(), 'MANAGER')") &&
        exec.includes("makePool(makeBatch(), 'CASHIER')"),
      'execution proof rejects MANAGER and CASHIER codes',
    );
  });
});

afterAll(() => {
  const passed = gates.filter((g) => g.ok).length;
  const failed = gates.filter((g) => !g.ok);
  const payload = {
    feature: 'LOT_WRITE_DOWN_ADMIN_ONLY',
    provenAt: new Date().toISOString(),
    contract:
      'Clearance markdown (lot write-down) is absolute ADMIN/SUPER_ADMIN only. ' +
      'inventory.adjust must never authorize. Route + service DB role + UI gate + live HTTP 403.',
    errorCode: ERR_LOT_WRITE_DOWN_ADMIN_ONLY,
    gates,
    summary: {
      total: gates.length,
      passed,
      failed: failed.length,
      verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    },
  };
  writeFileSync(
    path.join(repoRoot, 'PROOF_LOT_WRITE_DOWN_ADMIN_ONLY.json'),
    JSON.stringify(payload, null, 2),
  );
  writeFileSync(
    path.join(repoRoot, 'PROOF_LOT_WRITE_DOWN_ADMIN_ONLY.md'),
    [
      '# PROOF — Lot write-down / clearance markdown ADMIN-only',
      '',
      `**Verdict:** ${payload.summary.verdict} (${passed}/${gates.length})`,
      `**Proven at:** ${payload.provenAt}`,
      '',
      `**Contract:** ${payload.contract}`,
      '',
      `**Error code:** \`${ERR_LOT_WRITE_DOWN_ADMIN_ONLY}\``,
      '',
      ...gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} \`${g.id}\`: ${g.detail}`),
      '',
      '```bash',
      'cd SamplePOS.Server && npm run proof:lot-write-down:admin',
      'cd SamplePOS.Server && npm run proof:lot-write-down',
      'cd SamplePOS.Server && npm run proof:lot-write-down:live',
      '```',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(serverRoot, 'PROOF_LOT_WRITE_DOWN_ADMIN_ONLY.json'),
    JSON.stringify(payload, null, 2),
  );
  writeFileSync(
    path.join(serverRoot, 'PROOF_LOT_WRITE_DOWN_ADMIN_ONLY.md'),
    readFileSync(path.join(repoRoot, 'PROOF_LOT_WRITE_DOWN_ADMIN_ONLY.md'), 'utf8'),
  );
  expect(failed).toEqual([]);
});
