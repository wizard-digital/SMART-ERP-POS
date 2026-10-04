export type SalesTargetStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'ACTIVE'
  | 'CLOSED'
  | 'CANCELLED';

export type SalesTargetPeriodType =
  | 'WEEKLY'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'YEARLY'
  | 'CUSTOM';

export type SalesTargetScope = 'INDIVIDUAL' | 'GENERAL' | 'TEAM';

export interface SalesTargetTeamRow {
  id: string;
  name: string;
  isActive: boolean;
  memberIds: string[];
  memberNames: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SalesTargetRow {
  id: string;
  scope: SalesTargetScope;
  salespersonId: string | null;
  salespersonName: string | null;
  teamId: string | null;
  teamName: string | null;
  periodType: SalesTargetPeriodType;
  periodStart: string;
  periodEnd: string;
  targetAmount: number;
  status: SalesTargetStatus;
  createdBy: string;
  createdByName: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  amendmentReason: string | null;
  cancelReason: string | null;
  notes: string | null;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface SalesTargetAchievement {
  targetId: string;
  scope: SalesTargetScope;
  salespersonId: string | null;
  teamId: string | null;
  periodStart: string;
  periodEnd: string;
  targetAmount: number;
  /** Net excl-VAT achievement = eligibleSalesRevenue - refundsExclVat */
  achievedAmount: number;
  remainingAmount: number;
  achievementPercent: number;
  eligibleSalesRevenue: number;
  eligibleSalesCount: number;
  refundsExclVat: number;
  refundCount: number;
  contributorCount: number;
  revenueBasis: 'subtotal_minus_discount_excl_vat';
  refundBasis: 'sale_refunds_scaled_to_pretax_sale_revenue';
  notes: string[];
}

export interface AchievementBreakdown {
  achievement: SalesTargetAchievement;
  sales: Array<{
    saleId: string;
    saleNumber: string;
    saleDate: string;
    status: string;
    revenueExclVat: number;
    idempotencyKey: string | null;
  }>;
  refunds: Array<{
    refundId: string;
    refundNumber: string;
    refundDate: string;
    saleId: string;
    saleNumber: string;
    refundGross: number;
    refundExclVat: number;
  }>;
}
