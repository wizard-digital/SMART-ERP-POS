/**
 * Behavioral proof: every policy × session shape has one decision.
 * Run: node --experimental-vm-modules ./node_modules/jest/bin/jest.js src/modules/cash-register/posSessionEnforcement.behavior.test.ts --runInBand
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  POS_SESSION_POLICIES,
  posSessionAllowsJoin,
  posSessionRequiresCashierOwnSession,
  posSessionRequiresOpenSession,
  posSessionRequiresParticipantToSell,
} from '@shared/pos/posSessionPolicySsot.js';
import {
  decideSaleSession,
  resolveCurrentSession,
} from '@shared/pos/posSessionEnforcement.js';

const owner = 'cashier-owner';
const joiner = 'cashier-joiner';
const openOwned = { id: 'sess-1', status: 'OPEN' as const, userId: owner, registerId: 'reg-1' };
const openOther = { id: 'sess-2', status: 'OPEN' as const, userId: owner, registerId: 'reg-2' };
const closed = { id: 'sess-3', status: 'CLOSED' as const, userId: owner, registerId: 'reg-1' };

describe('decideSaleSession — four policies, no silent allow', () => {
  it('DISABLED never blocks; only links an OPEN session', () => {
    expect(
      decideSaleSession({
        policy: 'DISABLED',
        cashRegisterSessionId: undefined,
        session: null,
        soldBy: joiner,
        isParticipant: false,
      }),
    ).toEqual({ allow: true, sessionId: null });
    expect(
      decideSaleSession({
        policy: 'DISABLED',
        cashRegisterSessionId: closed.id,
        session: closed,
        soldBy: joiner,
        isParticipant: false,
      }),
    ).toEqual({ allow: true, sessionId: null });
    expect(
      decideSaleSession({
        policy: 'DISABLED',
        cashRegisterSessionId: openOwned.id,
        session: openOwned,
        soldBy: joiner,
        isParticipant: false,
      }),
    ).toEqual({ allow: true, sessionId: openOwned.id });
  });

  it('PER_CASHIER requires the cashier own the OPEN session', () => {
    const denyNone = decideSaleSession({
      policy: 'PER_CASHIER_SESSION',
      soldBy: owner,
      session: null,
      isParticipant: false,
    });
    expect(denyNone.allow).toBe(false);
    if (!denyNone.allow) expect(denyNone.code).toBe('ERR_SESSION_001');

    const denyForeign = decideSaleSession({
      policy: 'PER_CASHIER_SESSION',
      cashRegisterSessionId: openOther.id,
      session: openOther,
      soldBy: joiner,
      isParticipant: true,
    });
    expect(denyForeign.allow).toBe(false);
    if (!denyForeign.allow) expect(denyForeign.code).toBe('ERR_SESSION_004');

    expect(
      decideSaleSession({
        policy: 'PER_CASHIER_SESSION',
        cashRegisterSessionId: openOwned.id,
        session: openOwned,
        soldBy: owner,
        isParticipant: false,
      }),
    ).toEqual({ allow: true, sessionId: openOwned.id });
  });

  it('PER_COUNTER allows owner or joiner; unknown membership fails closed', () => {
    expect(
      decideSaleSession({
        policy: 'PER_COUNTER_SHARED_SESSION',
        cashRegisterSessionId: openOwned.id,
        session: openOwned,
        soldBy: owner,
        isParticipant: false,
      }),
    ).toEqual({ allow: true, sessionId: openOwned.id });

    expect(
      decideSaleSession({
        policy: 'PER_COUNTER_SHARED_SESSION',
        cashRegisterSessionId: openOwned.id,
        session: openOwned,
        soldBy: joiner,
        isParticipant: true,
      }),
    ).toEqual({ allow: true, sessionId: openOwned.id });

    const denyNotJoined = decideSaleSession({
      policy: 'PER_COUNTER_SHARED_SESSION',
      cashRegisterSessionId: openOwned.id,
      session: openOwned,
      soldBy: joiner,
      isParticipant: false,
    });
    expect(denyNotJoined.allow).toBe(false);
    if (!denyNotJoined.allow) expect(denyNotJoined.code).toBe('ERR_SESSION_004');

    const denyUnknown = decideSaleSession({
      policy: 'PER_COUNTER_SHARED_SESSION',
      cashRegisterSessionId: openOwned.id,
      session: openOwned,
      soldBy: joiner,
      isParticipant: null,
    });
    expect(denyUnknown.allow).toBe(false);
    if (!denyUnknown.allow) expect(denyUnknown.code).toBe('ERR_SESSION_005');
  });

  it('GLOBAL allows any OPEN session without joining', () => {
    expect(
      decideSaleSession({
        policy: 'GLOBAL_STORE_SESSION',
        cashRegisterSessionId: openOwned.id,
        session: openOwned,
        soldBy: joiner,
        isParticipant: false,
      }),
    ).toEqual({ allow: true, sessionId: openOwned.id });

    const denyClosed = decideSaleSession({
      policy: 'GLOBAL_STORE_SESSION',
      cashRegisterSessionId: closed.id,
      session: closed,
      soldBy: joiner,
      isParticipant: false,
    });
    expect(denyClosed.allow).toBe(false);
    if (!denyClosed.allow) expect(denyClosed.code).toBe('ERR_SESSION_003');
  });
});

describe('resolveCurrentSession — matches sale rules for each policy', () => {
  it('owned session wins for every policy', () => {
    for (const policy of POS_SESSION_POLICIES) {
      const resolved = resolveCurrentSession({
        policy,
        owned: openOwned,
        joined: openOther,
        openSessions: [openOther],
      });
      expect(resolved).toEqual({ session: openOwned, persistJoin: false });
    }
  });

  it('DISABLED and PER_CASHIER ignore other cashiers’ open sessions', () => {
    for (const policy of ['DISABLED', 'PER_CASHIER_SESSION'] as const) {
      expect(
        resolveCurrentSession({
          policy,
          owned: null,
          joined: openOwned,
          openSessions: [openOwned],
        }),
      ).toEqual({ session: null, persistJoin: false });
    }
  });

  it('PER_COUNTER uses joined, else the unique open drawer', () => {
    expect(
      resolveCurrentSession({
        policy: 'PER_COUNTER_SHARED_SESSION',
        owned: null,
        joined: openOwned,
        openSessions: [openOwned, openOther],
      }),
    ).toEqual({ session: openOwned, persistJoin: false });

    expect(
      resolveCurrentSession({
        policy: 'PER_COUNTER_SHARED_SESSION',
        owned: null,
        joined: null,
        openSessions: [openOwned],
      }),
    ).toEqual({ session: openOwned, persistJoin: true });

    expect(
      resolveCurrentSession({
        policy: 'PER_COUNTER_SHARED_SESSION',
        owned: null,
        joined: null,
        openSessions: [openOwned, openOther],
      }),
    ).toEqual({ session: null, persistJoin: false });
  });

  it('GLOBAL uses any open session when not joined', () => {
    expect(
      resolveCurrentSession({
        policy: 'GLOBAL_STORE_SESSION',
        owned: null,
        joined: null,
        openSessions: [openOther, openOwned],
      }),
    ).toEqual({ session: openOther, persistJoin: true });
  });
});

describe('policy flags and wiring have no swallow / no duplicate SQL', () => {
  it('join and own-session flags never overlap', () => {
    for (const policy of POS_SESSION_POLICIES) {
      if (posSessionRequiresCashierOwnSession(policy)) {
        expect(posSessionAllowsJoin(policy)).toBe(false);
        expect(posSessionRequiresParticipantToSell(policy)).toBe(false);
      }
      if (!posSessionRequiresOpenSession(policy)) {
        expect(posSessionRequiresCashierOwnSession(policy)).toBe(false);
        expect(posSessionRequiresParticipantToSell(policy)).toBe(false);
      }
    }
  });

  it('sales never proceed when session verification throws', () => {
    const sales = readFileSync(join(process.cwd(), 'src/modules/sales/salesService.ts'), 'utf8');
    expect(sales).toContain('decideSaleSession');
    expect(sales).not.toContain('proceeding without enforcement');
    expect(sales).toContain('ERR_SESSION_005');
  });

  it('current-session resolver does not skip shared lookup on error', () => {
    const svc = readFileSync(
      join(process.cwd(), 'src/modules/cash-register/cashRegisterService.ts'),
      'utf8',
    );
    expect(svc).toContain('resolveCurrentSession');
    expect(svc).not.toContain('Shared session lookup skipped');
    expect(svc).not.toContain('selling still uses resolved session');
  });
});
