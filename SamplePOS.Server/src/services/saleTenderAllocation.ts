/**
 * Sale tender → liquidity GL allocation (pure, no I/O, integer minor units).
 *
 * WHY: a split-tender sale (e.g. CASH 20,000 + MOBILE_MONEY 15,000 + CARD 5,000) used to be posted with ONE
 * debit of the whole total to the account of the HEADER payment method, so 1040/1020/1030 under-stated and
 * 1010 over-stated, and the bank mirror (which requires the SALE journal to debit that method's account)
 * skipped the other tenders. The journal must instead carry one liquidity debit per tender account.
 *
 * Rules (deterministic, total-preserving):
 *   - method → account:  CASH 1010 · CARD 1020 · MOBILE_MONEY/AIRTEL_MONEY 1040 · BANK_TRANSFER 1030
 *   - target = what the journal must debit in total (sale total, or amountPaid on a part-paid CREDIT sale)
 *   - non-cash tenders are assigned first, in line order, each capped at the amount still unassigned
 *   - CASH absorbs the remainder (customer change is always handed back in cash, so a cash line that exceeds
 *     what is due is clipped to what is due); cash never exceeds its own tendered amount
 *   - any amount the lines cannot cover (should not happen) is returned as `shortfallCents` so the caller
 *     assigns it to the header method's account — the allocation always sums exactly to the target
 *   - DEPOSIT / unknown methods make the allocation `null` → caller keeps the legacy single-account path
 *     (deposit application has its own journal; it is deliberately not touched here)
 *   - CREDIT lines are the unpaid part and are ignored (the caller already books AR for it)
 */

export const TENDER_LIQUIDITY_ACCOUNT: Readonly<Record<string, string>> = Object.freeze({
  CASH: '1010',
  CARD: '1020',
  MOBILE_MONEY: '1040',
  AIRTEL_MONEY: '1040',
  BANK_TRANSFER: '1030',
});

export interface TenderLine {
  paymentMethod: string;
  amount: number | string;
}

export interface TenderAllocationItem {
  accountCode: string;
  amountCents: number;
  /** Methods that contributed, in first-seen order (audit / description only). */
  methods: string[];
}

export interface TenderAllocation {
  items: TenderAllocationItem[];
  allocatedCents: number;
  shortfallCents: number;
}

const toCents = (v: number | string): number => Math.round(Number(v) * 100);

export function liquidityAccountForMethod(method: string): string | null {
  return TENDER_LIQUIDITY_ACCOUNT[method] ?? null;
}

export function allocateTenderToLiquidity(
  targetAmount: number,
  lines: readonly TenderLine[] | undefined | null,
): TenderAllocation | null {
  if (!lines || lines.length === 0) return null;
  const tender = lines.filter((l) => l.paymentMethod !== 'CREDIT');
  if (tender.length === 0) return null;
  if (tender.some((l) => liquidityAccountForMethod(l.paymentMethod) === null)) return null; // DEPOSIT / unknown
  if (tender.some((l) => !Number.isFinite(Number(l.amount)) || Number(l.amount) < 0)) return null;

  const target = toCents(targetAmount);
  if (target <= 0) return { items: [], allocatedCents: 0, shortfallCents: 0 };

  let remaining = target;
  const byAccount = new Map<string, TenderAllocationItem>();
  const add = (method: string, cents: number) => {
    if (cents <= 0) return;
    const code = liquidityAccountForMethod(method)!;
    const it = byAccount.get(code) ?? { accountCode: code, amountCents: 0, methods: [] };
    it.amountCents += cents;
    if (!it.methods.includes(method)) it.methods.push(method);
    byAccount.set(code, it);
  };

  // 1) non-cash tenders, in line order, capped at what is still due
  for (const l of tender) {
    if (l.paymentMethod === 'CASH') continue;
    const take = Math.min(toCents(l.amount), remaining);
    add(l.paymentMethod, take);
    remaining -= take;
  }
  // 2) cash absorbs the remainder (change is returned in cash, so cash is clipped to what is due)
  const cashTendered = tender.filter((l) => l.paymentMethod === 'CASH').reduce((s, l) => s + toCents(l.amount), 0);
  const cashTake = Math.min(cashTendered, remaining);
  add('CASH', cashTake);
  remaining -= cashTake;

  const items = [...byAccount.values()];
  return { items, allocatedCents: target - remaining, shortfallCents: remaining };
}
