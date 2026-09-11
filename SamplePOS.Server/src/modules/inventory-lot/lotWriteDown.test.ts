/**
 * Near-expiry lot write-down — eligibility + coupling (no DB).
 */
import {
  assertWriteDownBandMatchesLotPolicy,
  canPerformLotWriteDown,
  evaluateLotWriteDownGate,
  isNearExpiryWriteDownBand,
  LOT_WRITE_DOWN_EXPENSE_ACCOUNT,
  LOT_WRITE_DOWN_MAX_DAYS,
  LOT_WRITE_DOWN_REFERENCE_TYPE,
} from '@shared/inventory-lot/lotWriteDown.js';
import { classifyExpiryUrgency } from '@shared/reports/expiringItemsSsot.js';

const biz = '2026-09-10' as const;

function base(over: Partial<Parameters<typeof evaluateLotWriteDownGate>[0]> = {}) {
  return evaluateLotWriteDownGate({
    status: 'ACTIVE',
    expiryDate: '2026-09-15',
    remainingQuantity: 10,
    carryingUnitCost: 10000,
    originalUnitCost: 10000,
    newUnitCost: 6000,
    minDaysBeforeExpirySale: 0,
    businessDate: biz,
    ...over,
  });
}

describe('lot write-down eligibility SSOT', () => {
  it('clearance markdown is absolute ADMIN only — no manager/cashier bypass', () => {
    expect(canPerformLotWriteDown('ADMIN')).toBe(true);
    expect(canPerformLotWriteDown('admin')).toBe(true);
    expect(canPerformLotWriteDown('SUPER_ADMIN')).toBe(true);
    expect(canPerformLotWriteDown('MANAGER')).toBe(false);
    expect(canPerformLotWriteDown('CASHIER')).toBe(false);
    expect(canPerformLotWriteDown('STAFF')).toBe(false);
    expect(canPerformLotWriteDown(null)).toBe(false);
  });

  it('clearance window is 1–60 days; Critical KPI band stays 7', () => {
    expect(assertWriteDownBandMatchesLotPolicy()).toBe(true);
    expect(LOT_WRITE_DOWN_MAX_DAYS).toBe(60);
    expect(isNearExpiryWriteDownBand(1)).toBe(true);
    expect(isNearExpiryWriteDownBand(7)).toBe(true);
    expect(isNearExpiryWriteDownBand(30)).toBe(true);
    expect(isNearExpiryWriteDownBand(60)).toBe(true);
    expect(isNearExpiryWriteDownBand(61)).toBe(false);
    expect(classifyExpiryUrgency(8)).toBe('warning');
  });

  it('accepts still-sellable critical lot and computes markdown amount', () => {
    const g = base();
    expect(g.ok).toBe(true);
    if (g.ok) {
      expect(g.daysUntilExpiry).toBe(5);
      expect(g.writeDownAmount).toBe(40000);
      expect(g.quantity).toBe(10);
    }
  });

  it('accepts warning and 60-day lots (below original via markdown, not till below cost)', () => {
    const warn = base({ expiryDate: '2026-09-30' });
    expect(warn.ok).toBe(true);
    if (warn.ok) expect(warn.daysUntilExpiry).toBe(20);
    const at60 = base({ expiryDate: '2026-11-09' });
    expect(at60.ok).toBe(true);
    if (at60.ok) expect(at60.daysUntilExpiry).toBe(60);
  });

  it('rejects damaged/quarantined, expired, no-expiry, beyond-60, min-days, and till-below-new-cost mistakes', () => {
    expect(base({ status: 'QUARANTINED' }).ok).toBe(false);
    expect(base({ status: 'EXPIRED' }).ok).toBe(false);
    expect(base({ expiryDate: null }).ok).toBe(false);
    expect(base({ expiryDate: '2026-09-10' }).ok).toBe(false);
    const beyond = base({ expiryDate: '2026-11-10' });
    expect(beyond.ok).toBe(false);
    if (!beyond.ok) expect(beyond.reason).toBe('NOT_CRITICAL');
    expect(base({ minDaysBeforeExpirySale: 10 }).ok).toBe(false);
    expect(base({ newUnitCost: 10000 }).ok).toBe(false);
    expect(base({ newUnitCost: 0 }).ok).toBe(false);
    expect(base({ newUnitCost: 0.001 }).ok).toBe(false);
    expect(base({ newUnitCost: 11000 }).ok).toBe(false);
    const floor = base({ newUnitCost: 0.001 });
    expect(floor.ok).toBe(false);
    if (!floor.ok) expect(floor.reason).toBe('BELOW_FLOOR');
  });

  it('uses dedicated 5140 / LOT_WRITE_DOWN — not disposal accounts', () => {
    expect(LOT_WRITE_DOWN_EXPENSE_ACCOUNT).toBe('5140');
    expect(LOT_WRITE_DOWN_REFERENCE_TYPE).toBe('LOT_WRITE_DOWN');
  });
});
