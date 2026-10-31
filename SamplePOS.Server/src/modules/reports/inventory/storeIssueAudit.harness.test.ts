/**
 * HANDLER PROOF: generateStoreIssueAudit is invoked — not a grep.
 *
 * UNION rows are mapped, reverse-rate KPIs stay period-wide when the movement
 * filter is REVERSE, inverted dates swap, and LIKE wildcards are escaped.
 *
 * Run: node --experimental-vm-modules ./node_modules/jest/bin/jest.js src/modules/reports/inventory/storeIssueAudit.harness.test.ts --no-coverage --forceExit
 */
import { describe, it, expect } from '@jest/globals';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { generateStoreIssueAudit } from './storeIssueAuditService.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

const evidence: Array<{ name: string; ok: true; detail: Record<string, unknown> }> = [];

function prove(name: string, detail: Record<string, unknown>): void {
  evidence.push({ name, ok: true, detail });
}

const ISSUE_ROW = {
  document_id: 'd1',
  document_number: 'GI-2026-00001',
  posting_date: '2026-10-15',
  status: 'REVERSED',
  issued_to: 'KITCHEN',
  store_name: 'MAIN',
  product_id: 'p1',
  product_name: 'Flour',
  sku: 'FL-1',
  quantity_base: 10,
  uom_name: 'KG',
  conversion_factor: 1,
  amount: 5000,
  movement_type: 'GOODS_ISSUE',
  posted_by_name: 'Ann',
  reversed_by_name: 'Ben',
  reversal_reason: null,
};

const REVERSE_ROW = {
  ...ISSUE_ROW,
  posting_date: '2026-10-16',
  movement_type: 'GOODS_ISSUE_REVERSAL',
  reversal_reason: 'Wrong qty',
};

function poolWithRows(
  rows: unknown[],
  opts?: { restaurantEnabled?: boolean },
): Pool & { calls: Array<{ sql: string; params: unknown[] }> } {
  const restaurantEnabled = opts?.restaurantEnabled !== false;
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    calls,
    query: async (...args: unknown[]) => {
      const sql = String(args[0] ?? '');
      const params = Array.isArray(args[1]) ? (args[1] as unknown[]) : [];
      calls.push({ sql, params });
      if (sql.includes('current_database')) {
        return { rows: [{ db: 'test' }] };
      }
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ exists: 1 }] };
      }
      if (sql.includes('restaurant_mode_enabled')) {
        return { rows: [{ enabled: restaurantEnabled }] };
      }
      if (sql.includes('information_schema.tables')) {
        return { rows: [{ exists: 1 }] };
      }
      return { rows };
    },
  };
  return pool as unknown as Pool & { calls: Array<{ sql: string; params: unknown[] }> };
}

describe('generateStoreIssueAudit handler (executed)', () => {
  it('maps UNION rows and keeps reverse-rate on the full period when filtering REVERSE', async () => {
    const pool = poolWithRows([ISSUE_ROW, REVERSE_ROW]);
    const report = await generateStoreIssueAudit(pool, {
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      movement: 'REVERSE',
    });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].movementType).toBe('GOODS_ISSUE_REVERSAL');
    expect(report.rows[0].reversalReason).toBe('Wrong qty');
    expect(report.rows[0].uomName).toBe('KG');
    expect(report.totals.issuedAmount).toBe(5000);
    expect(report.totals.reversedAmount).toBe(5000);
    expect(report.totals.reverseRate).toBe(1);
    expect(report.movement).toBe('GOODS_ISSUE_REVERSAL');
    prove('filter-reverse-keeps-period-kpis', {
      visibleRows: report.rows.length,
      visibleType: report.rows[0].movementType,
      issuedAmount: report.totals.issuedAmount,
      reversedAmount: report.totals.reversedAmount,
      reverseRate: report.totals.reverseRate,
    });
  });

  it('swaps inverted dates before querying', async () => {
    const pool = poolWithRows([]);
    const report = await generateStoreIssueAudit(pool, {
      startDate: '2026-10-31',
      endDate: '2026-10-01',
    });
    expect(report.startDate).toBe('2026-10-01');
    expect(report.endDate).toBe('2026-10-31');
    const auditCall = pool.calls.find((c) => c.sql.includes('UNION ALL'));
    expect(auditCall?.params[0]).toBe('2026-10-01');
    expect(auditCall?.params[1]).toBe('2026-10-31');
    prove('inverted-dates-swapped', {
      startDate: report.startDate,
      endDate: report.endDate,
      sqlStart: auditCall?.params[0],
      sqlEnd: auditCall?.params[1],
    });
  });

  it('refuses the audit when restaurant mode is off', async () => {
    const pool = poolWithRows([], { restaurantEnabled: false });
    await expect(
      generateStoreIssueAudit(pool, { startDate: '2026-10-01', endDate: '2026-10-31' }),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/restaurant mode/i),
    });
    expect(pool.calls.some((c) => c.sql.includes('UNION ALL'))).toBe(false);
    prove('restaurant-off-audit-forbidden', { statusCode: 403, sqlRan: false });
  });

  it('escapes LIKE wildcards in search and returns the raw search string', async () => {
    const pool = poolWithRows([]);
    const report = await generateStoreIssueAudit(pool, {
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      search: 'GI_1%',
    });
    expect(report.search).toBe('GI_1%');
    const auditCall = pool.calls.find((c) => c.sql.includes('UNION ALL'));
    expect(auditCall?.params[2]).toBe('GI\\_1\\%');
    prove('like-wildcards-escaped', {
      returnedSearch: report.search,
      sqlSearch: auditCall?.params[2],
    });
  });

  it('writes executed handler evidence', () => {
    expect(evidence.length).toBe(4);
    const payload = {
      title: 'PROOF_STORE_ISSUE_AUDIT_HANDLER',
      runAt: new Date().toISOString(),
      verdict: 'PASS',
      exercised: 'generateStoreIssueAudit',
      checks: evidence,
    };
    const json = JSON.stringify(payload, null, 2);
    writeFileSync(path.join(repoRoot, 'PROOF_STORE_ISSUE_AUDIT_HANDLER.json'), json);
    writeFileSync(
      path.join(repoRoot, 'SamplePOS.Server/PROOF_STORE_ISSUE_AUDIT_HANDLER.json'),
      json,
    );
  });
});
