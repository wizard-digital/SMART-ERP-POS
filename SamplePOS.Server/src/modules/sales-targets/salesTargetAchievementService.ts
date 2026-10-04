import type { Pool, PoolClient } from 'pg';
import { Money } from '../../utils/money.js';
import { salesTargetRepository } from './salesTargetRepository.js';
import type {
  AchievementBreakdown,
  SalesTargetAchievement,
  SalesTargetRow,
} from './salesTargetTypes.js';

type Db = Pool | PoolClient;

/** Bank-grade 2dp — reuse Money SSOT (no ad-hoc Math.round). */
function round2(n: number): number {
  return Money.toNumber(Money.round(n, 2));
}

export async function resolveCashierFilter(
  db: Db,
  target: SalesTargetRow,
): Promise<'ALL' | string[]> {
  if (target.scope === 'GENERAL') return 'ALL';
  if (target.scope === 'TEAM') {
    if (!target.teamId) return [];
    return salesTargetRepository.listTeamMemberIds(db, target.teamId);
  }
  return target.salespersonId ? [target.salespersonId] : [];
}

/**
 * Centralized Sales Targets achievement SSOT.
 * INDIVIDUAL / TEAM / GENERAL — same revenue basis; contributor set differs.
 * Never accepts client-supplied achievement amounts.
 */
export async function calculateTargetAchievement(
  db: Db,
  target: SalesTargetRow,
): Promise<SalesTargetAchievement> {
  const cashierFilter = await resolveCashierFilter(db, target);
  const totals = await salesTargetRepository.computeAchievementTotals(
    db,
    cashierFilter,
    target.periodStart,
    target.periodEnd,
  );

  const achievedAmount = round2(totals.eligibleSalesRevenue - totals.refundsExclVat);
  const remainingAmount = round2(Math.max(target.targetAmount - achievedAmount, 0));
  const achievementPercent =
    target.targetAmount > 0
      ? round2((achievedAmount / target.targetAmount) * 100)
      : 0;

  const contributorCount =
    cashierFilter === 'ALL' ? -1 : cashierFilter.length;

  const notes: string[] = [
    `Scope=${target.scope}.`,
    'Revenue = sales.subtotal − sales.discount_amount (VAT excluded).',
    'Refunds = COMPLETED sale_refunds scaled to pretax sale revenue (line_gross basis).',
    'Eligible sale statuses: COMPLETED, PARTIALLY_RETURNED, VOIDED_BY_RETURN (VOID excluded).',
    'VOIDED_BY_RETURN is included so sale revenue and refunds net correctly by event date.',
    target.scope === 'GENERAL'
      ? 'GENERAL: all cashiers’ posted sales in the period contribute.'
      : target.scope === 'TEAM'
        ? 'TEAM: only named team members’ posted sales contribute.'
        : 'INDIVIDUAL: only the assigned salesperson’s posted sales contribute.',
    'Invoice credit notes are out of scope for v1.',
  ];

  return {
    targetId: target.id,
    scope: target.scope,
    salespersonId: target.salespersonId,
    teamId: target.teamId,
    periodStart: target.periodStart,
    periodEnd: target.periodEnd,
    targetAmount: round2(target.targetAmount),
    achievedAmount,
    remainingAmount,
    achievementPercent,
    eligibleSalesRevenue: totals.eligibleSalesRevenue,
    eligibleSalesCount: totals.eligibleSalesCount,
    refundsExclVat: totals.refundsExclVat,
    refundCount: totals.refundCount,
    contributorCount,
    revenueBasis: 'subtotal_minus_discount_excl_vat',
    refundBasis: 'sale_refunds_scaled_to_pretax_sale_revenue',
    notes,
  };
}

export async function getTargetAchievementBreakdown(
  db: Db,
  target: SalesTargetRow,
): Promise<AchievementBreakdown> {
  const cashierFilter = await resolveCashierFilter(db, target);
  const [achievement, sales, refunds] = await Promise.all([
    calculateTargetAchievement(db, target),
    salesTargetRepository.listAchievementSales(
      db,
      cashierFilter,
      target.periodStart,
      target.periodEnd,
    ),
    salesTargetRepository.listAchievementRefunds(
      db,
      cashierFilter,
      target.periodStart,
      target.periodEnd,
    ),
  ]);

  return { achievement, sales, refunds };
}

/**
 * Pure helper for unit tests — mirrors SQL revenue basis.
 */
export function computeNetAchievementFromParts(input: {
  sales: Array<{ subtotal: number; discountAmount: number; status: string }>;
  refunds: Array<{
    totalAmount: number;
    lineGross: number;
    saleSubtotal: number;
    saleDiscount: number;
    saleTotalAmount: number;
    saleTaxAmount: number;
    refundStatus: string;
  }>;
}): { eligibleSalesRevenue: number; refundsExclVat: number; achievedAmount: number } {
  const eligible = input.sales.filter((s) =>
    ['COMPLETED', 'PARTIALLY_RETURNED', 'VOIDED_BY_RETURN'].includes(s.status),
  );
  const eligibleSalesRevenue = round2(
    eligible.reduce((sum, s) => sum + Math.max(s.subtotal - s.discountAmount, 0), 0),
  );

  let refundsExclVat = 0;
  for (const r of input.refunds) {
    if (r.refundStatus !== 'COMPLETED') continue;
    const pretax = Math.max(r.saleSubtotal - r.saleDiscount, 0);
    if (r.lineGross > 0) {
      refundsExclVat += (r.totalAmount * pretax) / r.lineGross;
    } else if (r.saleTotalAmount > 0) {
      refundsExclVat +=
        (r.totalAmount * Math.max(r.saleTotalAmount - r.saleTaxAmount, 0)) / r.saleTotalAmount;
    }
  }
  refundsExclVat = round2(refundsExclVat);
  return {
    eligibleSalesRevenue,
    refundsExclVat,
    achievedAmount: round2(eligibleSalesRevenue - refundsExclVat),
  };
}
