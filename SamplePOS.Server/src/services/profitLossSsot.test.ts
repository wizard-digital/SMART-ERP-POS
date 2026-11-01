/**
 * P&L SSOT — pure classification + rollup (mirrors migration 539 / Odoo-SAP-QB shape).
 * No DB required.
 */
import { describe, expect, it } from '@jest/globals';
import { classifyFinancialPnlSection } from '@shared/reporting/reportingInvariants.js';

export type PlAccount = {
  code: string;
  type: 'REVENUE' | 'EXPENSE' | 'ASSET' | 'LIABILITY';
  debit: number;
  credit: number;
};

export type PlSection = 'REVENUE' | 'COST_OF_GOODS_SOLD' | 'OPERATING_EXPENSES';

/** Same precedence as fn_get_profit_loss after 644 (5210 is OpEx, not COGS). */
export function classifySection(code: string, type: string): PlSection {
  return classifyFinancialPnlSection(code, type);
}

export function displayAmount(code: string, type: string, debit: number, credit: number): number {
  if (code.startsWith('4') || type === 'REVENUE') return credit - debit;
  return debit - credit;
}

/** Broken pre-539 OpEx predicate (double-counts 5xxx EXPENSE) */
export function isOpexBroken(code: string, type: string): boolean {
  return code.startsWith('6') || type === 'EXPENSE';
}

/** Fixed 644 OpEx predicate (5210 is OpEx; other 5xxx stay COGS). */
export function isOpexFixed(code: string, type: string): boolean {
  if (code === '5210') return true;
  if (code.startsWith('4') || code.startsWith('5')) return false;
  return code.startsWith('6') || code.startsWith('7') || type === 'EXPENSE';
}

export function summarize(
  accounts: PlAccount[],
  opexPred: (code: string, type: string) => boolean,
) {
  let revenue = 0;
  let cogs = 0;
  let opex = 0;
  for (const a of accounts) {
    if (a.code.startsWith('4') || a.type === 'REVENUE') {
      revenue += a.credit - a.debit;
    }
    if (a.code.startsWith('5') && a.code !== '5210') {
      cogs += a.debit - a.credit;
    }
    if (opexPred(a.code, a.type)) {
      opex += a.debit - a.credit;
    }
  }
  const grossProfit = revenue - cogs;
  const netIncome = grossProfit - opex;
  const grossMarginPercent = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
  const netMarginPercent = revenue > 0 ? (netIncome / revenue) * 100 : 0;
  return { revenue, cogs, opex, grossProfit, netIncome, grossMarginPercent, netMarginPercent };
}

export function rollupFromSections(accounts: PlAccount[]) {
  let revenue = 0;
  let cogs = 0;
  let opex = 0;
  for (const a of accounts) {
    const section = classifySection(a.code, a.type);
    const amt = displayAmount(a.code, a.type, a.debit, a.credit);
    if (section === 'REVENUE') revenue += amt;
    else if (section === 'COST_OF_GOODS_SOLD') cogs += amt;
    else opex += amt;
  }
  return { revenue, cogs, opex, netIncome: revenue - cogs - opex };
}

/** UI contract helper — what the page must display */
export function pickNetProfit(summary: {
  netIncome?: number;
  netProfit?: number;
}): number {
  return Number(summary.netIncome ?? summary.netProfit ?? 0);
}

export function pickExpenses(summary: {
  totalOperatingExpenses?: number;
  totalExpenses?: number;
}): number {
  return Number(summary.totalOperatingExpenses ?? summary.totalExpenses ?? 0);
}

/** User-reported July scenario (UGX) */
const JULY_ACCOUNTS: PlAccount[] = [
  { code: '4000', type: 'REVENUE', debit: 0, credit: 450_542 },
  { code: '5000', type: 'EXPENSE', debit: 3_860, credit: 0 }, // COGS typed EXPENSE
];

describe('P&L SSOT classification (migration 539)', () => {
  it('classifies 5000 EXPENSE as COGS not OpEx', () => {
    expect(classifySection('5000', 'EXPENSE')).toBe('COST_OF_GOODS_SOLD');
    expect(classifySection('6000', 'EXPENSE')).toBe('OPERATING_EXPENSES');
    expect(classifySection('4000', 'REVENUE')).toBe('REVENUE');
  });

  it('classifies 5210 Bad Debt as OpEx so ERP P&L matches reports P&L', () => {
    expect(classifySection('5210', 'EXPENSE')).toBe('OPERATING_EXPENSES');
    expect(isOpexFixed('5210', 'EXPENSE')).toBe(true);
    expect(isOpexFixed('5000', 'EXPENSE')).toBe(false);
  });

  it('reproduces the broken Net Profit / margin symptom (pre-fix OpEx + wrong UI field)', () => {
    const broken = summarize(JULY_ACCOUNTS, isOpexBroken);
    // COGS counted twice → net understated
    expect(broken.revenue).toBe(450_542);
    expect(broken.cogs).toBe(3_860);
    expect(broken.opex).toBe(3_860);
    expect(broken.grossProfit).toBe(446_682);
    expect(broken.netIncome).toBe(442_822);
    expect(broken.grossMarginPercent).toBeCloseTo(99.143, 2);
    expect(broken.netMarginPercent).toBeCloseTo(98.286, 2);

    // UI bug: read netProfit while API only sent netIncome → display 0 with real margin
    const apiShape = {
      netIncome: broken.netIncome,
      netMarginPercent: broken.netMarginPercent,
    };
    const wrongUiNet = Number((apiShape as { netProfit?: number }).netProfit || 0);
    expect(wrongUiNet).toBe(0);
    expect(apiShape.netMarginPercent).toBeCloseTo(98.286, 2);
  });

  it('fixed OpEx + correct field pick yields Gross ≈ Net when OpEx is 0', () => {
    const fixed = summarize(JULY_ACCOUNTS, isOpexFixed);
    expect(fixed.opex).toBe(0);
    expect(fixed.grossProfit).toBe(446_682);
    expect(fixed.netIncome).toBe(446_682);
    expect(fixed.netMarginPercent).toBeCloseTo(fixed.grossMarginPercent, 5);

    const uiNet = pickNetProfit({ netIncome: fixed.netIncome });
    const uiExp = pickExpenses({ totalOperatingExpenses: fixed.opex });
    expect(uiNet).toBe(446_682);
    expect(uiExp).toBe(0);
  });

  it('summary and section rollup stay consistent (verify SSOT)', () => {
    const accounts: PlAccount[] = [
      ...JULY_ACCOUNTS,
      { code: '6100', type: 'EXPENSE', debit: 10_000, credit: 0 },
    ];
    const summary = summarize(accounts, isOpexFixed);
    const rollup = rollupFromSections(accounts);
    expect(rollup.revenue).toBe(summary.revenue);
    expect(rollup.cogs).toBe(summary.cogs);
    expect(rollup.opex).toBe(summary.opex);
    expect(Math.abs(rollup.netIncome - summary.netIncome)).toBeLessThan(0.01);
  });

  it('API alias contract: netProfit mirrors netIncome', () => {
    const summary = {
      netIncome: 446_682,
      netProfit: 446_682,
      totalOperatingExpenses: 0,
      totalExpenses: 0,
    };
    expect(pickNetProfit(summary)).toBe(446_682);
    expect(pickExpenses(summary)).toBe(0);
  });
});
