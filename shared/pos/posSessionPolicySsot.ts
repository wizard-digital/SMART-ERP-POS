/**
 * POS cash-register session policy — single source of truth.
 *
 * Settings copy, open/join/close, GET /sessions/current, and sale enforcement
 * must all read this module. Do not duplicate policy strings or “how registers
 * work” bullets in the UI.
 *
 * Physical drawer invariant (always, every policy):
 *   one OPEN cash_register_sessions row per register.
 * Policy only answers: must a cashier have a session to sell, and whose session.
 */

export const POS_SESSION_POLICIES = [
  'DISABLED',
  'PER_CASHIER_SESSION',
  'PER_COUNTER_SHARED_SESSION',
  'GLOBAL_STORE_SESSION',
] as const;

export type PosSessionPolicy = (typeof POS_SESSION_POLICIES)[number];

/** localStorage key used by POS + Settings so policy changes apply without a reload. */
export const POS_SESSION_POLICY_STORAGE_KEY = 'pos_session_policy';

export function isPosSessionPolicy(value: unknown): value is PosSessionPolicy {
  return typeof value === 'string' && (POS_SESSION_POLICIES as readonly string[]).includes(value);
}

/** Unknown / missing DB values fail closed to DISABLED (sales not blocked). */
export function parsePosSessionPolicy(value: unknown): PosSessionPolicy {
  return isPosSessionPolicy(value) ? value : 'DISABLED';
}

export function posSessionRequiresOpenSession(policy: PosSessionPolicy): boolean {
  return policy !== 'DISABLED';
}

export function posSessionRequiresCashierOwnSession(policy: PosSessionPolicy): boolean {
  return policy === 'PER_CASHIER_SESSION';
}

export function posSessionAllowsJoin(policy: PosSessionPolicy): boolean {
  return policy === 'PER_COUNTER_SHARED_SESSION' || policy === 'GLOBAL_STORE_SESSION';
}

/** Current session may be any OPEN session in the store (not a specific counter). */
export function posSessionResolvesAnyOpen(policy: PosSessionPolicy): boolean {
  return policy === 'GLOBAL_STORE_SESSION';
}

/**
 * Per-counter shared: cashier must own or have joined that drawer.
 * Global store may sell against any OPEN session without joining first.
 */
export function posSessionRequiresParticipantToSell(policy: PosSessionPolicy): boolean {
  return policy === 'PER_COUNTER_SHARED_SESSION';
}

export interface PosSessionPolicyDefinition {
  value: PosSessionPolicy;
  label: string;
  description: string;
  registerSubtitle: string;
  howRegistersWork: string[];
  cashierPromptTitle: string;
  cashierPromptBody: string;
  cashierPromptAction: string;
}

export const POS_SESSION_POLICY_DEFINITIONS: readonly PosSessionPolicyDefinition[] = [
  {
    value: 'DISABLED',
    label: 'Disabled',
    description:
      'No session enforcement. Cashiers can process sales without opening a register session. Opening a register is still optional for till tracking.',
    registerSubtitle:
      'Registers are optional till drawers. Sales are not blocked when no session is open.',
    howRegistersWork: [
      'Each register is a physical cash drawer',
      'A register still cannot have two open sessions at once (one drawer, one float)',
      'Sales do not require an open session',
      'If a session is opened, cash in/out and close still post against that drawer',
      'Deactivated registers are hidden from cashiers; history is kept',
    ],
    cashierPromptTitle: 'Cash register optional',
    cashierPromptBody: 'Session policy is disabled. You can sell without opening a register.',
    cashierPromptAction: 'Open cash register',
  },
  {
    value: 'PER_CASHIER_SESSION',
    label: 'Per Cashier',
    description:
      'Each cashier must open their own session on a register. Sales are only allowed under that cashier’s own open session.',
    registerSubtitle:
      'You need one active register per cashier working at the same time.',
    howRegistersWork: [
      'Each register is a physical cash drawer',
      'Only one cashier can use a register at a time',
      'Each cashier can have only one open session across all registers',
      'If every register is occupied, another cashier cannot start until a session is closed',
      'Deactivated registers are hidden from cashiers; history is kept',
    ],
    cashierPromptTitle: 'Cash register required',
    cashierPromptBody:
      'Open your own register session before selling. Sales are linked to you for end-of-day cash count.',
    cashierPromptAction: 'Open cash register',
  },
  {
    value: 'PER_COUNTER_SHARED_SESSION',
    label: 'Per Counter (Shared)',
    description:
      'One session per register, shared by cashiers. Any cashier can sell on a register that is already open. Join that counter — do not open a second float.',
    registerSubtitle:
      'You need one active register per counter (drawer), not per cashier.',
    howRegistersWork: [
      'Each register is a physical cash drawer with at most one open session',
      'The first cashier opens the counter (counts the float)',
      'Other cashiers join that open session and sell against the same drawer',
      'Expected cash is one till for everyone on that counter',
      'Only the session owner (or a manager force-close) closes the drawer',
      'Deactivated registers are hidden from cashiers; history is kept',
    ],
    cashierPromptTitle: 'Join or open a counter',
    cashierPromptBody:
      'This store uses one session per cash drawer. Open a free register or join a counter that is already open.',
    cashierPromptAction: 'Open or join register',
  },
  {
    value: 'GLOBAL_STORE_SESSION',
    label: 'Global Store',
    description:
      'Any open session in the store works. Minimal enforcement — typical for a single-register shop.',
    registerSubtitle:
      'Usually one active register for the shop. Any open session can take sales.',
    howRegistersWork: [
      'Each register is still one physical drawer (one open session per register)',
      'Sales need some open session in the store — not necessarily one you opened',
      'If a session is already open, cashiers can sell without opening another',
      'Close still belongs to the session owner (or manager force-close)',
      'Deactivated registers are hidden from cashiers; history is kept',
    ],
    cashierPromptTitle: 'A register session is required',
    cashierPromptBody:
      'Someone must have an open register in this store. Open one if none is open, or continue on the existing session.',
    cashierPromptAction: 'Open cash register',
  },
] as const;

export function getPosSessionPolicyDefinition(policy: PosSessionPolicy): PosSessionPolicyDefinition {
  const found = POS_SESSION_POLICY_DEFINITIONS.find((d) => d.value === policy);
  return found ?? POS_SESSION_POLICY_DEFINITIONS[0];
}
