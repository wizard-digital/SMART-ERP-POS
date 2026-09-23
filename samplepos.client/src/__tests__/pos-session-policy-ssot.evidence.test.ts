/**
 * Proof: registers + POS session policy share one SSOT.
 * Run: npx vitest run src/__tests__/pos-session-policy-ssot.evidence.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  POS_SESSION_POLICIES,
  POS_SESSION_POLICY_DEFINITIONS,
  getPosSessionPolicyDefinition,
  parsePosSessionPolicy,
  posSessionAllowsJoin,
  posSessionRequiresCashierOwnSession,
  posSessionRequiresOpenSession,
  posSessionRequiresParticipantToSell,
  posSessionResolvesAnyOpen,
} from '@shared/pos/posSessionPolicySsot';

const root = resolve(__dirname, '..');

function readSrc(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('POS session policy SSOT', () => {
  it('defines four policies with one definition each and no overlapping sell rules', () => {
    expect(POS_SESSION_POLICY_DEFINITIONS.map((d) => d.value)).toEqual([...POS_SESSION_POLICIES]);
    expect(posSessionRequiresOpenSession('DISABLED')).toBe(false);
    expect(posSessionRequiresCashierOwnSession('PER_CASHIER_SESSION')).toBe(true);
    expect(posSessionRequiresParticipantToSell('PER_COUNTER_SHARED_SESSION')).toBe(true);
    expect(posSessionRequiresParticipantToSell('GLOBAL_STORE_SESSION')).toBe(false);
    expect(posSessionResolvesAnyOpen('GLOBAL_STORE_SESSION')).toBe(true);
    expect(posSessionAllowsJoin('PER_COUNTER_SHARED_SESSION')).toBe(true);
    expect(posSessionAllowsJoin('GLOBAL_STORE_SESSION')).toBe(true);
    expect(posSessionAllowsJoin('PER_CASHIER_SESSION')).toBe(false);
    expect(parsePosSessionPolicy('nope')).toBe('DISABLED');
    expect(
      getPosSessionPolicyDefinition('PER_CASHIER_SESSION').howRegistersWork.some((l) =>
        /only one cashier can use a register/i.test(l),
      ),
    ).toBe(true);
    expect(
      getPosSessionPolicyDefinition('PER_COUNTER_SHARED_SESSION').howRegistersWork.some((l) =>
        /join that open session/i.test(l),
      ),
    ).toBe(true);
  });

  it('SQL CHECK lists the same four policy values as SSOT', () => {
    const sql = readFileSync(
      resolve(__dirname, '../../../shared/sql/620_pos_session_policy_ssot.sql'),
      'utf8',
    );
    for (const policy of POS_SESSION_POLICIES) {
      expect(sql).toContain(`'${policy}'`);
    }
  });

  it('settings UI reads policy copy from SSOT, not hardcoded per-cashier bullets', () => {
    const tab = readSrc('pages/settings/tabs/SystemSettingsTab.tsx');
    expect(tab).toContain('POS_SESSION_POLICY_DEFINITIONS');
    expect(tab).toContain('getPosSessionPolicyDefinition');
    expect(tab).toContain('policyDef.registerSubtitle');
    expect(tab).not.toContain('You need one register per cashier working simultaneously');
    expect(tab).not.toContain('Only one cashier can use a register at a time');
  });

  it('open dialog and POS overlay follow join vs own-session from SSOT', () => {
    const open = readSrc('components/cash-register/OpenRegisterDialog.tsx');
    expect(open).toContain('posSessionAllowsJoin');
    expect(open).toContain('Join Session');
    expect(open).toContain('isOnSelectedSession');
    expect(open).toContain('policyDef.cashierPromptAction');
    const indicator = readSrc('components/cash-register/RegisterStatusIndicator.tsx');
    expect(indicator).toContain('cashierPromptAction');
    expect(indicator).toContain('isSessionOwner');
    const pos = readSrc('pages/pos/POSPage.tsx');
    expect(pos).toContain('posSessionRequiresOpenSession');
    expect(pos).toContain('sessionPolicyDef.cashierPromptTitle');
    expect(pos).not.toContain('All sales will be linked to your session');
    expect(pos).toContain('(!hasOpenRegister || isSessionError)');
    expect(pos).toContain('Could not verify register session');
  });
});
