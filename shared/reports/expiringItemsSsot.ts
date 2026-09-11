/**
 * Expiring items / shelf-life SSOT — urgency bands for register UI, PDF, and summary.
 * Value at risk = remaining qty × unit cost (inventory cost, not retail).
 *
 * Invariant: for any row set, summarizeExpiringItems(band counts)
 * === filterExpiringRowsByBand(rows, band).length (same classifier: days → band).
 */

export type ExpiryUrgency = 'expired' | 'critical' | 'warning' | 'watch';

export type ExpiringItemLike = {
  daysUntilExpiry: number;
  quantityRemaining: number;
  potentialLoss: number;
  urgency?: string | null;
};

export function classifyExpiryUrgency(daysUntilExpiry: number): ExpiryUrgency {
  const d = Number(daysUntilExpiry);
  if (!Number.isFinite(d) || d <= 0) return 'expired';
  if (d <= 7) return 'critical';
  if (d <= 30) return 'warning';
  return 'watch';
}

export function expiryUrgencyLabel(band: ExpiryUrgency): string {
  switch (band) {
    case 'expired':
      return 'Expired';
    case 'critical':
      return 'Critical (≤7d)';
    case 'warning':
      return 'Warning (≤30d)';
    default:
      return 'Watch';
  }
}

/** UI/PDF label for the active band filter chip. */
export function expiringBandFilterLabel(filter: ExpiryBandFilter): string {
  return filter === 'all' ? 'All at risk' : expiryUrgencyLabel(filter);
}

/** PDF subtitle suffix when a KPI band filter is active. */
export function expiringPdfFilterSubtitle(filter: ExpiryBandFilter, daysAhead: number): string {
  if (filter === 'all') {
    return `Shelf-life register — expired + expiring within ${daysAhead} days (business date)`;
  }
  return `Shelf-life register — ${expiryUrgencyLabel(filter)} only · horizon ${daysAhead} days`;
}

/**
 * Band for a register row. Days until expiry are authoritative
 * (same path as summarize + repository). Urgency string is fallback only.
 */
export function resolveExpiryRowBand(row: {
  urgency?: string | null;
  daysUntilExpiry?: number | null;
}): ExpiryUrgency {
  if (row.daysUntilExpiry != null) {
    const d = Number(row.daysUntilExpiry);
    if (Number.isFinite(d)) return classifyExpiryUrgency(d);
  }
  const raw = String(row.urgency || '').toLowerCase();
  if (raw === 'expired' || raw === 'critical' || raw === 'warning' || raw === 'watch') {
    return raw;
  }
  return 'watch';
}

export type ExpiryBandFilter = 'all' | ExpiryUrgency;

/** Filter register rows to match KPI card selection. */
export function filterExpiringRowsByBand<
  T extends { urgency?: string | null; daysUntilExpiry?: number | null },
>(rows: T[], filter: ExpiryBandFilter): T[] {
  if (!filter || filter === 'all') return rows;
  return rows.filter((row) => resolveExpiryRowBand(row) === filter);
}

/** Searchable fields for shelf-life / AI expiry registers (product · SKU · batch). */
export type ExpiringItemSearchable = {
  productName?: string | null;
  sku?: string | null;
  batchNumber?: string | null;
  /** Category Intelligence alias */
  batch_number?: string | null;
};

/**
 * Smart find: match product name, SKU, or batch (case-insensitive substring).
 * Empty query → all rows. Day-0 / expired rows remain searchable like any other band.
 */
export function matchesExpiringItemSearch(
  row: ExpiringItemSearchable,
  query: string | null | undefined,
): boolean {
  const q = String(query ?? '')
    .trim()
    .toLowerCase()
    .replace(/,/g, '');
  if (!q) return true;
  const hay = [
    row.productName,
    row.sku,
    row.batchNumber,
    row.batch_number,
  ]
    .map((v) => String(v ?? '').toLowerCase())
    .join(' ');
  return hay.includes(q) || q.split(/\s+/).every((token) => token && hay.includes(token));
}

export function filterExpiringRowsBySearch<T extends ExpiringItemSearchable>(
  rows: T[],
  query: string | null | undefined,
): T[] {
  const q = String(query ?? '').trim();
  if (!q) return rows;
  return rows.filter((row) => matchesExpiringItemSearch(row, q));
}

/** Band then search — same order as Expiring Items + Category Expiry UI. */
export function filterExpiringRegisterRows<
  T extends ExpiringItemSearchable & {
    urgency?: string | null;
    daysUntilExpiry?: number | null;
  },
>(rows: T[], band: ExpiryBandFilter, query?: string | null): T[] {
  return filterExpiringRowsBySearch(filterExpiringRowsByBand(rows, band), query);
}

export function summarizeExpiringItems(rows: ExpiringItemLike[]): {
  totalItems: number;
  totalQuantityAtRisk: number;
  totalPotentialLoss: number;
  expiredCount: number;
  criticalCount: number;
  warningCount: number;
  watchCount: number;
  expiredValue: number;
  criticalValue: number;
} {
  let totalQuantityAtRisk = 0;
  let totalPotentialLoss = 0;
  let expiredCount = 0;
  let criticalCount = 0;
  let warningCount = 0;
  let watchCount = 0;
  let expiredValue = 0;
  let criticalValue = 0;

  for (const row of rows) {
    const qty = Number(row.quantityRemaining) || 0;
    const loss = Number(row.potentialLoss) || 0;
    totalQuantityAtRisk += qty;
    totalPotentialLoss += loss;
    const band = resolveExpiryRowBand(row);
    if (band === 'expired') {
      expiredCount += 1;
      expiredValue += loss;
    } else if (band === 'critical') {
      criticalCount += 1;
      criticalValue += loss;
    } else if (band === 'warning') {
      warningCount += 1;
    } else {
      watchCount += 1;
    }
  }

  return {
    totalItems: rows.length,
    totalQuantityAtRisk: Math.round(totalQuantityAtRisk * 1000) / 1000,
    totalPotentialLoss: Math.round(totalPotentialLoss * 100) / 100,
    expiredCount,
    criticalCount,
    warningCount,
    watchCount,
    expiredValue: Math.round(expiredValue * 100) / 100,
    criticalValue: Math.round(criticalValue * 100) / 100,
  };
}

/** Prove KPI card numbers === filtered register length (and value cards). */
export function assertExpiringKpiFilterConsistency(rows: ExpiringItemLike[]): {
  ok: boolean;
  detail: string;
  summary: ReturnType<typeof summarizeExpiringItems>;
  filtered: Record<ExpiryUrgency | 'all', number>;
  valueCheck: { expired: number; critical: number };
} {
  const summary = summarizeExpiringItems(rows);
  const filtered = {
    all: filterExpiringRowsByBand(rows, 'all').length,
    expired: filterExpiringRowsByBand(rows, 'expired').length,
    critical: filterExpiringRowsByBand(rows, 'critical').length,
    warning: filterExpiringRowsByBand(rows, 'warning').length,
    watch: filterExpiringRowsByBand(rows, 'watch').length,
  };
  const expiredVal = Math.round(
    filterExpiringRowsByBand(rows, 'expired').reduce((s, r) => s + Number(r.potentialLoss || 0), 0) * 100,
  ) / 100;
  const criticalVal = Math.round(
    filterExpiringRowsByBand(rows, 'critical').reduce((s, r) => s + Number(r.potentialLoss || 0), 0) * 100,
  ) / 100;

  const countOk =
    filtered.all === summary.totalItems &&
    filtered.expired === summary.expiredCount &&
    filtered.critical === summary.criticalCount &&
    filtered.warning === summary.warningCount &&
    filtered.watch === summary.watchCount;
  const valueOk = expiredVal === summary.expiredValue && criticalVal === summary.criticalValue;
  const partitionOk =
    filtered.expired + filtered.critical + filtered.warning + filtered.watch === filtered.all;

  const ok = countOk && valueOk && partitionOk;
  const detail = ok
    ? `KPI↔list match: all=${filtered.all} expired=${filtered.expired} critical=${filtered.critical} warn=${filtered.warning} watch=${filtered.watch}; values expired=${expiredVal} critical=${criticalVal}`
    : `KPI↔list MISMATCH counts=${JSON.stringify(filtered)} vs summary counts expired=${summary.expiredCount}/${summary.criticalCount}/${summary.warningCount}/${summary.watchCount} values ${expiredVal}/${criticalVal} vs ${summary.expiredValue}/${summary.criticalValue}`;

  return {
    ok,
    detail,
    summary,
    filtered,
    valueCheck: { expired: expiredVal, critical: criticalVal },
  };
}
