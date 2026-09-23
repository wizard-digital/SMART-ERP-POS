/**
 * POS session enforcement — behavioral SSOT.
 *
 * decideSaleSession: can this sale post?
 * resolveCurrentSession: which session does this cashier sell against?
 *
 * I/O stays in the register service. Do not re-implement these branches
 * in sales, offline sync, or the POS overlay.
 */

import {
  posSessionAllowsJoin,
  posSessionRequiresCashierOwnSession,
  posSessionRequiresOpenSession,
  posSessionRequiresParticipantToSell,
  posSessionResolvesAnyOpen,
  type PosSessionPolicy,
} from './posSessionPolicySsot.js';

export interface SessionRef {
  id: string;
  status: string;
  userId: string;
  registerId?: string;
}

export type SaleSessionDenyCode =
  | 'ERR_SESSION_001'
  | 'ERR_SESSION_002'
  | 'ERR_SESSION_003'
  | 'ERR_SESSION_004'
  | 'ERR_SESSION_005';

export type SaleSessionDecision =
  | { allow: true; sessionId: string | null }
  | { allow: false; code: SaleSessionDenyCode; message: string };

export function decideSaleSession(input: {
  policy: PosSessionPolicy;
  cashRegisterSessionId?: string | null;
  session: SessionRef | null;
  soldBy: string;
  /** true = joined; false = not joined; null = membership could not be read */
  isParticipant: boolean | null;
}): SaleSessionDecision {
  const { policy, cashRegisterSessionId, session, soldBy, isParticipant } = input;

  if (!posSessionRequiresOpenSession(policy)) {
    if (cashRegisterSessionId && session?.status === 'OPEN') {
      return { allow: true, sessionId: cashRegisterSessionId };
    }
    return { allow: true, sessionId: null };
  }

  if (!cashRegisterSessionId) {
    return {
      allow: false,
      code: 'ERR_SESSION_001',
      message: 'POS session is required. Please open a cash register session before making sales.',
    };
  }

  if (!session) {
    return {
      allow: false,
      code: 'ERR_SESSION_002',
      message: 'Invalid cash register session. The session does not exist.',
    };
  }

  if (session.status !== 'OPEN') {
    return {
      allow: false,
      code: 'ERR_SESSION_003',
      message: `Cash register session is ${session.status}. Only OPEN sessions can process sales.`,
    };
  }

  if (posSessionRequiresCashierOwnSession(policy) && session.userId !== soldBy) {
    return {
      allow: false,
      code: 'ERR_SESSION_004',
      message:
        'This session belongs to a different cashier. Per-cashier policy requires your own session.',
    };
  }

  if (posSessionRequiresParticipantToSell(policy) && session.userId !== soldBy) {
    if (isParticipant === true) {
      return { allow: true, sessionId: cashRegisterSessionId };
    }
    if (isParticipant === null) {
      return {
        allow: false,
        code: 'ERR_SESSION_005',
        message: 'Could not verify register session membership. Sale was not posted.',
      };
    }
    return {
      allow: false,
      code: 'ERR_SESSION_004',
      message: 'Join this counter before selling. Per-counter policy uses one shared session per drawer.',
    };
  }

  return { allow: true, sessionId: cashRegisterSessionId };
}

export function resolveCurrentSession<T extends { id: string }>(input: {
  policy: PosSessionPolicy;
  owned: T | null;
  joined: T | null;
  openSessions: T[];
}): { session: T | null; persistJoin: boolean } {
  const { policy, owned, joined, openSessions } = input;

  if (owned) {
    return { session: owned, persistJoin: false };
  }

  if (posSessionRequiresCashierOwnSession(policy) || policy === 'DISABLED') {
    return { session: null, persistJoin: false };
  }

  if (joined) {
    return { session: joined, persistJoin: false };
  }

  if (posSessionResolvesAnyOpen(policy) && openSessions.length > 0) {
    return { session: openSessions[0], persistJoin: true };
  }

  if (posSessionAllowsJoin(policy) && openSessions.length === 1) {
    return { session: openSessions[0], persistJoin: true };
  }

  return { session: null, persistJoin: false };
}
