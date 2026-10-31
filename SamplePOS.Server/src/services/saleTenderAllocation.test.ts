import { describe, it, expect } from '@jest/globals';
import { allocateTenderToLiquidity } from './saleTenderAllocation.js';

const sum = (a: NonNullable<ReturnType<typeof allocateTenderToLiquidity>>) => a.items.reduce((s, i) => s + i.amountCents, 0);

describe('allocateTenderToLiquidity', () => {
  it('no lines / only CREDIT / DEPOSIT / unknown → null (legacy single-account path)', () => {
    expect(allocateTenderToLiquidity(100, undefined)).toBeNull();
    expect(allocateTenderToLiquidity(100, [])).toBeNull();
    expect(allocateTenderToLiquidity(100, [{ paymentMethod: 'CREDIT', amount: 100 }])).toBeNull();
    expect(allocateTenderToLiquidity(100, [{ paymentMethod: 'DEPOSIT', amount: 100 }, { paymentMethod: 'CASH', amount: 5 }])).toBeNull();
    expect(allocateTenderToLiquidity(100, [{ paymentMethod: 'CHEQUE', amount: 100 }])).toBeNull();
    expect(allocateTenderToLiquidity(100, [{ paymentMethod: 'GIFT', amount: 100 }])).toBeNull();
    expect(allocateTenderToLiquidity(100, [{ paymentMethod: 'CASH', amount: -1 }])).toBeNull();
  });

  it('maps each method to its account and keeps total exact', () => {
    const a = allocateTenderToLiquidity(40000, [
      { paymentMethod: 'CASH', amount: 10000 },
      { paymentMethod: 'CARD', amount: 10000 },
      { paymentMethod: 'MOBILE_MONEY', amount: 10000 },
      { paymentMethod: 'BANK_TRANSFER', amount: 10000 },
    ])!;
    expect(Object.fromEntries(a.items.map((i) => [i.accountCode, i.amountCents / 100]))).toEqual({
      '1010': 10000, '1020': 10000, '1040': 10000, '1030': 10000,
    });
    expect(a.shortfallCents).toBe(0);
  });

  it('MOBILE_MONEY and AIRTEL_MONEY merge on 1040; methods recorded', () => {
    const a = allocateTenderToLiquidity(30, [
      { paymentMethod: 'MOBILE_MONEY', amount: 10 },
      { paymentMethod: 'AIRTEL_MONEY', amount: 20 },
    ])!;
    expect(a.items).toEqual([{ accountCode: '1040', amountCents: 3000, methods: ['MOBILE_MONEY', 'AIRTEL_MONEY'] }]);
  });

  it('cash change is clipped; over-tendered non-cash is capped at what is due', () => {
    const a = allocateTenderToLiquidity(100, [{ paymentMethod: 'MOBILE_MONEY', amount: 30 }, { paymentMethod: 'CASH', amount: 200 }])!;
    expect(a.items.find((i) => i.accountCode === '1010')!.amountCents).toBe(7000);
    const b = allocateTenderToLiquidity(100, [{ paymentMethod: 'CARD', amount: 150 }])!;
    expect(b.items).toEqual([{ accountCode: '1020', amountCents: 10000, methods: ['CARD'] }]);
  });

  it('under-covered target reports the shortfall (caller assigns it to the header account)', () => {
    const a = allocateTenderToLiquidity(100, [{ paymentMethod: 'CASH', amount: 60 }])!;
    expect(a.shortfallCents).toBe(4000);
    expect(sum(a) + a.shortfallCents).toBe(10000);
  });

  it('PROPERTY: allocated + shortfall == target for 2,000 random tender sets; never negative; float-safe', () => {
    const methods = ['CASH', 'CARD', 'MOBILE_MONEY', 'AIRTEL_MONEY', 'BANK_TRANSFER'];
    let seed = 42;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let n = 0; n < 2000; n++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => ({
        paymentMethod: methods[Math.floor(rnd() * methods.length)],
        amount: Math.round(rnd() * 5_000_000) / 100 + 0.1 + 0.2 - 0.3, // float noise
      }));
      const target = Math.round(rnd() * 8_000_000) / 100;
      const a = allocateTenderToLiquidity(target, lines)!;
      expect(a.allocatedCents + a.shortfallCents).toBe(Math.round(target * 100));
      expect(sum(a)).toBe(a.allocatedCents);
      expect(a.items.every((i) => i.amountCents > 0)).toBe(true);
    }
  });
});
