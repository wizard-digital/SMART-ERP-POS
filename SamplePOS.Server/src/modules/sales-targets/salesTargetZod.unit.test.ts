import { describe, expect, it } from '@jest/globals';
import {
  AmendSalesTargetSchema,
  CreateSalesTargetSchema,
  UpdateDraftSalesTargetSchema,
} from '@shared/zod/salesTarget.js';

describe('sales target zod', () => {
  it('accepts a valid create payload and rejects tenant mass-assignment fields', () => {
    const ok = CreateSalesTargetSchema.safeParse({
      salespersonId: '11111111-1111-1111-1111-111111111111',
      periodType: 'MONTHLY',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      targetAmount: 1000,
      submit: true,
    });
    expect(ok.success).toBe(true);

    const bad = CreateSalesTargetSchema.safeParse({
      salespersonId: '11111111-1111-1111-1111-111111111111',
      periodType: 'MONTHLY',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      targetAmount: 1000,
      tenantId: 'evil',
      status: 'ACTIVE',
      achievedAmount: 999,
    });
    expect(bad.success).toBe(false);
  });

  it('requires rowVersion for draft update and amendment reason for amend', () => {
    const draft = UpdateDraftSalesTargetSchema.safeParse({
      targetAmount: 500,
      rowVersion: 1,
    });
    expect(draft.success).toBe(true);

    const amendMissingReason = AmendSalesTargetSchema.safeParse({
      targetAmount: 500,
      rowVersion: 2,
    });
    expect(amendMissingReason.success).toBe(false);
  });

  it('rejects inverted period dates', () => {
    const bad = CreateSalesTargetSchema.safeParse({
      salespersonId: '11111111-1111-1111-1111-111111111111',
      periodType: 'CUSTOM',
      periodStart: '2026-10-31',
      periodEnd: '2026-10-01',
      targetAmount: 100,
    });
    expect(bad.success).toBe(false);
  });

  it('accepts GENERAL and TEAM scopes with correct shape', () => {
    const general = CreateSalesTargetSchema.safeParse({
      scope: 'GENERAL',
      periodType: 'MONTHLY',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      targetAmount: 50000,
    });
    expect(general.success).toBe(true);

    const team = CreateSalesTargetSchema.safeParse({
      scope: 'TEAM',
      teamId: '22222222-2222-2222-2222-222222222222',
      periodType: 'MONTHLY',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      targetAmount: 20000,
    });
    expect(team.success).toBe(true);

    const teamMissing = CreateSalesTargetSchema.safeParse({
      scope: 'TEAM',
      periodType: 'MONTHLY',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      targetAmount: 20000,
    });
    expect(teamMissing.success).toBe(false);
  });
});
