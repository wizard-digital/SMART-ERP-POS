/**
 * Product history running balance — pure SSOT.
 *
 * Must key balances by original event index (not date|type|qty). Two sale lines
 * on the same SALE at the same second with the same qty would otherwise collide
 * and both paint the final balance (the AMSTEL double-line screenshot bug).
 */

export type HistoryBalanceInput = {
  eventDate: string;
  quantityChange: number;
  unitCost?: number | null;
  totalCost?: number | null;
  lineTotal?: number | null;
};

export type HistoryBalanceFields = {
  runningQuantity: number;
  runningValuation: number;
  averageCost: number;
};

export type HistorySummaryTotals = {
  totalInQuantity: number;
  totalOutQuantity: number;
  netQuantityChange: number;
  totalInValue: number;
  totalOutValue: number;
  currentValuation: number | undefined;
  firstMovementDate: string | undefined;
  lastMovementDate: string | undefined;
};

function toNum(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Compute forward running qty/valuation in time order, then map balances back
 * onto the caller's array order (typically newest-first for the UI).
 */
export function applyProductHistoryRunningBalances<T extends HistoryBalanceInput>(
  items: T[],
  opts?: { fallbackUnitCost?: number | null },
): { items: Array<T & HistoryBalanceFields>; summary: HistorySummaryTotals } {
  const fallbackUnitCost = toNum(opts?.fallbackUnitCost);

  const indexed = items.map((item, originalIndex) => ({ item, originalIndex }));
  // Ascending time; same-second ties keep caller order via originalIndex so
  // balances stay unique (stable Map-by-date|type|qty was the screenshot bug).
  indexed.sort((a, b) => {
    const dt =
      new Date(a.item.eventDate).getTime() - new Date(b.item.eventDate).getTime();
    if (dt !== 0) return dt;
    return a.originalIndex - b.originalIndex;
  });

  let runningQty = 0;
  let totalCostAccumulated = 0;
  const balanceByOriginalIndex = new Map<number, HistoryBalanceFields>();

  for (const { item, originalIndex } of indexed) {
    const qtyChange = toNum(item.quantityChange);
    runningQty += qtyChange;

    if (qtyChange > 0) {
      const addedCost =
        item.totalCost != null && Number.isFinite(item.totalCost)
          ? Number(item.totalCost)
          : qtyChange * (item.unitCost != null ? Number(item.unitCost) : fallbackUnitCost);
      totalCostAccumulated += addedCost;
    } else if (qtyChange < 0) {
      const qtyBefore = runningQty - qtyChange;
      const avgCost = qtyBefore > 0 ? totalCostAccumulated / qtyBefore : 0;
      totalCostAccumulated -= avgCost * Math.abs(qtyChange);
    }

    const averageCost = runningQty > 0 ? totalCostAccumulated / runningQty : 0;
    balanceByOriginalIndex.set(originalIndex, {
      runningQuantity: runningQty,
      runningValuation: totalCostAccumulated,
      averageCost,
    });
  }

  const withBalance = items.map((item, originalIndex) => {
    const bal = balanceByOriginalIndex.get(originalIndex)!;
    return { ...item, ...bal };
  });

  let totalInQuantity = 0;
  let totalOutQuantity = 0;
  let netQuantityChange = 0;
  let totalInValue = 0;
  let totalOutValue = 0;
  for (const item of indexed.map((x) => x.item)) {
    const qty = toNum(item.quantityChange);
    netQuantityChange += qty;
    if (qty > 0) {
      totalInQuantity += qty;
      totalInValue +=
        item.totalCost != null && Number.isFinite(item.totalCost)
          ? Number(item.totalCost)
          : 0;
    } else if (qty < 0) {
      totalOutQuantity += Math.abs(qty);
      totalOutValue +=
        item.lineTotal != null && Number.isFinite(item.lineTotal)
          ? Number(item.lineTotal)
          : 0;
    }
  }

  const asc = indexed.map((x) => x.item);
  const lastBal =
    indexed.length > 0
      ? balanceByOriginalIndex.get(indexed[indexed.length - 1].originalIndex)
      : undefined;

  return {
    items: withBalance,
    summary: {
      firstMovementDate: asc.length > 0 ? asc[0].eventDate : undefined,
      lastMovementDate: asc.length > 0 ? asc[asc.length - 1].eventDate : undefined,
      totalInQuantity,
      totalOutQuantity,
      netQuantityChange,
      totalInValue,
      totalOutValue,
      currentValuation: lastBal?.runningValuation,
    },
  };
}
