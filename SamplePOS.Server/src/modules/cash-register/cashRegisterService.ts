/**
 * Cash Register Service
 *
 * Business logic for cash register management.
 * Integrates with existing AccountingCore for GL entries.
 *
 * INTEGRATION POINTS:
 * - Uses AccountingCore for variance GL entries (cash overages/shortages)
 * - Links sales to cash movements via reference_type='SALE'
 * - Maintains audit trail through cash_movements table
 *
 * NO CODE DUPLICATION:
 * - Reuses existing accounting infrastructure
 * - Does not create parallel balance tracking
 * - Session expected_closing derived from movements (single source of truth)
 */

import { pool as globalPool } from '../../db/pool.js';
import { Pool, PoolClient } from 'pg';
import { UnitOfWork } from '../../db/unitOfWork.js';
import {
    cashRegisterRepository,
    CashRegister,
    CashRegisterSession,
    CashMovement,
    CreateRegisterData,
    OpenSessionData,
    CloseSessionData,
    RecordMovementData,
    MovementType,
    SessionStatus,
    PaymentSummary,
    DenominationBreakdown,
    CashReconciliation,
    ZReportRecord,
} from './cashRegisterRepository.js';
import { AccountingCore, JournalLine } from '../../services/accountingCore.js';
import logger from '../../utils/logger.js';
import Decimal from 'decimal.js';
import { getBusinessDate } from '../../utils/dateRange.js';
import { ValidationError } from '../../middleware/errorHandler.js';
import * as arPaymentService from '../ar-payments/arPaymentService.js';
import * as openItemEngine from '../ar-payments/openItemAllocationEngine.js';
import {
    parsePosSessionPolicy,
    posSessionAllowsJoin,
    type PosSessionPolicy,
} from '@shared/pos/posSessionPolicySsot.js';
import { resolveCurrentSession } from '@shared/pos/posSessionEnforcement.js';

// =============================================================================
// ACCOUNT CODES (from Chart of Accounts)
// =============================================================================

const ACCOUNT_CODES = {
    CASH: '1010', // Cash Drawer (till)
    PETTY_CASH: '1012', // Petty Cash float (Phase 1D — was wrongly 1015)
    UNDEPOSITED_FUNDS: '1015', // Receipt clearing only
    CHECKING_ACCOUNT: '1030', // Bank Checking Account
    ACCOUNTS_RECEIVABLE: '1200', // Customer receivables
    CASH_OVERAGE: '4900', // Other Income - Cash Overage
    OTHER_INCOME: '4200', // Other Income (misc cash in)
    CASH_SHORTAGE: '6850', // Operating Expense - Cash Shortage
    GENERAL_EXPENSE: '6900', // General Expense (misc)
} as const;

// =============================================================================
// ERROR CLASSES
// =============================================================================

export class CashRegisterError extends Error {
    constructor(
        message: string,
        public readonly code: string
    ) {
        super(message);
        this.name = 'CashRegisterError';
    }
}

export class RegisterNotFoundError extends CashRegisterError {
    constructor(registerId: string) {
        super(`Register not found: ${registerId}`, 'REGISTER_NOT_FOUND');
    }
}

export class SessionNotFoundError extends CashRegisterError {
    constructor(sessionId: string) {
        super(`Session not found: ${sessionId}`, 'SESSION_NOT_FOUND');
    }
}

export class RegisterBusyError extends CashRegisterError {
    constructor(registerId: string, sessionNumber: string) {
        super(`Register already has an open session: ${sessionNumber}`, 'REGISTER_BUSY');
    }
}

export class UserAlreadyHasSessionError extends CashRegisterError {
    constructor(sessionNumber: string, registerName: string) {
        super(
            `User already has an open session: ${sessionNumber} on ${registerName}`,
            'USER_HAS_SESSION'
        );
    }
}

export class SessionNotOpenError extends CashRegisterError {
    constructor(sessionId: string, status: string) {
        super(`Cannot perform operation on ${status} session: ${sessionId}`, 'SESSION_NOT_OPEN');
    }
}

export class SessionNotClosedError extends CashRegisterError {
    constructor(sessionId: string, status: string) {
        super(
            `Cannot reconcile ${status} session: ${sessionId}. Session must be CLOSED.`,
            'SESSION_NOT_CLOSED'
        );
    }
}

function isPgUniqueViolation(error: unknown): boolean {
    return (error as { code?: string }).code === '23505';
}

function isOneOpenSessionConstraint(error: unknown): boolean {
    const constraint = String((error as { constraint?: string }).constraint || '');
    const detail = String((error as { detail?: string }).detail || '');
    const message = error instanceof Error ? error.message : String(error);
    return /uq_cash_register_one_open_session|register_id/i.test(`${constraint} ${detail} ${message}`);
}

async function attachToExistingRegisterSession(
    client: PoolClient,
    existing: CashRegisterSession,
    data: OpenSessionData,
    policy: PosSessionPolicy
): Promise<CashRegisterSession> {
    if (existing.userId === data.userId) {
        await cashRegisterRepository.ensureSessionParticipant(client, existing.id, data.userId);
        logger.info('Auto-resuming existing session for same user', {
            sessionId: existing.id,
            sessionNumber: existing.sessionNumber,
            registerId: data.registerId,
            userId: data.userId,
        });
        return existing;
    }
    if (posSessionAllowsJoin(policy)) {
        const ownedElsewhere = await cashRegisterRepository.getUserOpenSession(client, data.userId);
        if (ownedElsewhere) {
            throw new UserAlreadyHasSessionError(
                ownedElsewhere.sessionNumber,
                ownedElsewhere.registerName || 'Unknown Register'
            );
        }
        await cashRegisterRepository.ensureSessionParticipant(client, existing.id, data.userId);
        logger.info('Joined existing register session', {
            sessionId: existing.id,
            sessionNumber: existing.sessionNumber,
            registerId: data.registerId,
            userId: data.userId,
            policy,
        });
        return existing;
    }
    throw new RegisterBusyError(data.registerId, existing.sessionNumber);
}

// =============================================================================
// SERVICE
// =============================================================================

export const cashRegisterService = {
    // ===========================================================================
    // REGISTER MANAGEMENT
    // ===========================================================================

    /**
     * Get all registers
     */
    async getAllRegisters(dbPool?: Pool): Promise<CashRegister[]> {
        return cashRegisterRepository.getAllRegisters(dbPool || globalPool);
    },

    /**
     * Get active registers
     */
    async getActiveRegisters(dbPool?: Pool): Promise<CashRegister[]> {
        return cashRegisterRepository.getActiveRegisters(dbPool || globalPool);
    },

    /**
     * Get register by ID
     */
    async getRegisterById(id: string, dbPool?: Pool): Promise<CashRegister | null> {
        return cashRegisterRepository.getRegisterById(dbPool || globalPool, id);
    },

    /**
     * Create a new register
     */
    async createRegister(
        data: CreateRegisterData,
        userId: string,
        dbPool?: Pool
    ): Promise<CashRegister> {
        const pool = dbPool || globalPool;
        const register = await cashRegisterRepository.createRegister(pool, data);

        logger.info('Cash register created', {
            registerId: register.id,
            name: register.name,
            createdBy: userId,
        });

        return register;
    },

    /**
     * Update a register
     */
    async updateRegister(
        id: string,
        data: Partial<CreateRegisterData & { isActive: boolean }>,
        userId: string,
        dbPool?: Pool
    ): Promise<CashRegister | null> {
        const pool = dbPool || globalPool;
        if (data.isActive === false) {
            const open = await cashRegisterRepository.getOpenSession(pool, id);
            if (open) {
                const existing = await cashRegisterRepository.getRegisterById(pool, id);
                throw new CashRegisterError(
                    `Cannot deactivate ${existing?.name || 'register'} while session ${open.sessionNumber} is open. Close the session first.`,
                    'REGISTER_HAS_OPEN_SESSION'
                );
            }
        }
        const register = await cashRegisterRepository.updateRegister(pool, id, data);

        if (register) {
            logger.info('Cash register updated', {
                registerId: id,
                updates: data,
                updatedBy: userId,
            });
        }

        return register;
    },

    /**
     * Get active registers with current session status
     * Shows which registers are available, occupied, and by whom
     */
    async getRegistersWithStatus(dbPool?: Pool) {
        return cashRegisterRepository.getRegistersWithSessionStatus(dbPool || globalPool);
    },

    // ===========================================================================
    // SESSION MANAGEMENT
    // ===========================================================================

    /**
     * Open a new register session (or join an existing one when policy allows).
     *
     * Always: one OPEN session per physical register.
     * PER_CASHIER: one open session per cashier; cannot join another cashier's drawer.
     * PER_COUNTER / GLOBAL: join the register's open session instead of creating a second float.
     */
    async openSession(data: OpenSessionData, dbPool?: Pool): Promise<CashRegisterSession> {
        const pool = dbPool || globalPool;
        const register = await cashRegisterRepository.getRegisterById(pool, data.registerId);
        if (!register) {
            throw new RegisterNotFoundError(data.registerId);
        }
        if (!register.isActive) {
            throw new CashRegisterError(`Register ${register.name} is not active`, 'REGISTER_INACTIVE');
        }

        const session = await UnitOfWork.run<CashRegisterSession>(pool, async (client) => {
            const policy = parsePosSessionPolicy(
                await cashRegisterRepository.getPosSessionPolicy(client)
            );
            const existingRegisterSession = await cashRegisterRepository.getOpenSession(
                client,
                data.registerId,
                { forUpdate: true }
            );
            if (existingRegisterSession) {
                return attachToExistingRegisterSession(client, existingRegisterSession, data, policy);
            }

            const existingUserSession = await cashRegisterRepository.getUserOpenSession(
                client,
                data.userId
            );
            if (existingUserSession) {
                throw new UserAlreadyHasSessionError(
                    existingUserSession.sessionNumber,
                    existingUserSession.registerName || 'Unknown Register'
                );
            }

            try {
                const opened = await cashRegisterRepository.openSession(client, data);
                await cashRegisterRepository.ensureSessionParticipant(client, opened.id, data.userId);
                logger.info('Cash register session opened', {
                    sessionId: opened.id,
                    sessionNumber: opened.sessionNumber,
                    registerId: data.registerId,
                    userId: data.userId,
                    openingFloat: data.openingFloat,
                    policy,
                });
                return opened;
            } catch (error: unknown) {
                if (isPgUniqueViolation(error) && isOneOpenSessionConstraint(error)) {
                    const raced = await cashRegisterRepository.getOpenSession(client, data.registerId);
                    if (raced) {
                        return attachToExistingRegisterSession(client, raced, data, policy);
                    }
                }
                throw error;
            }
        });

        return session;
    },

    /**
     * Session this cashier should sell against, according to POS session policy.
     */
    async getCurrentSessionForUser(
        userId: string,
        dbPool?: Pool | PoolClient
    ): Promise<{ session: CashRegisterSession | null; posSessionPolicy: PosSessionPolicy }> {
        const pool = dbPool || globalPool;
        const posSessionPolicy = parsePosSessionPolicy(
            await cashRegisterRepository.getPosSessionPolicy(pool)
        );
        const owned = await cashRegisterRepository.getUserOpenSession(pool, userId);
        let joined: CashRegisterSession | null = null;
        let openSessions: CashRegisterSession[] = [];
        if (posSessionAllowsJoin(posSessionPolicy)) {
            joined = await cashRegisterRepository.getJoinedOpenSession(pool, userId);
            openSessions = await cashRegisterRepository.listOpenSessions(pool);
        }
        const resolved = resolveCurrentSession({
            policy: posSessionPolicy,
            owned,
            joined,
            openSessions,
        });
        if (resolved.persistJoin && resolved.session) {
            await cashRegisterRepository.ensureSessionParticipant(
                pool,
                resolved.session.id,
                userId
            );
        }
        return { session: resolved.session, posSessionPolicy };
    },

    /**
     * Get current open session for a user
     */
    async getUserOpenSession(userId: string, dbPool?: Pool): Promise<CashRegisterSession | null> {
        return cashRegisterRepository.getUserOpenSession(dbPool || globalPool, userId);
    },

    /**
     * Get open session for a register
     */
    async getRegisterOpenSession(
        registerId: string,
        dbPool?: Pool
    ): Promise<CashRegisterSession | null> {
        return cashRegisterRepository.getOpenSession(dbPool || globalPool, registerId);
    },

    /**
     * Get session by ID
     */
    async getSessionById(sessionId: string, dbPool?: Pool): Promise<CashRegisterSession | null> {
        return cashRegisterRepository.getSessionById(dbPool || globalPool, sessionId);
    },

    /**
     * Close a register session
     *
     * Business Rules:
     * - Session must exist and be OPEN
     * - Variance is calculated and recorded
     * - If variance exists, create GL entries for overage/shortage
     */
    async closeSession(
        data: CloseSessionData,
        userId: string,
        dbPool?: Pool
    ): Promise<CashRegisterSession> {
        const pool = dbPool || globalPool;
        // Validate + close in one atomic transaction
        const { closedSession, variance } = await UnitOfWork.run<{
            closedSession: CashRegisterSession;
            variance: Decimal;
        }>(pool, async (client) => {
            // Get and validate session inside transaction
            const session = await cashRegisterRepository.getSessionById(client, data.sessionId);
            if (!session) {
                throw new SessionNotFoundError(data.sessionId);
            }
            if (session.status !== 'OPEN') {
                throw new SessionNotOpenError(data.sessionId, session.status);
            }
            // Ownership check: only the session owner can close their session
            // Admins/managers must use forceCloseSession instead
            if (session.userId !== userId) {
                throw new CashRegisterError(
                    'Cannot close another user\'s session. Use force-close for admin override.',
                    'SESSION_OWNERSHIP_VIOLATION'
                );
            }

            const expected = await cashRegisterRepository.calculateExpectedClosing(client, data.sessionId);
            const pendingVariance = new Decimal(data.actualClosing).minus(expected);
            if (pendingVariance.abs().greaterThan('0.01') && !data.varianceReason?.trim()) {
                throw new CashRegisterError(
                    'Reason for variance is required when counted cash does not match expected till cash.',
                    'VARIANCE_REASON_REQUIRED'
                );
            }

            // Close the session (calculateExpectedClosing + UPDATE atomic)
            const closed = await cashRegisterRepository.closeSession(client, data);
            const v = new Decimal(closed.variance || 0);

            return { closedSession: closed, variance: v };
        });

        // Create GL entry AFTER commit (AccountingCore manages its own transaction)
        const VARIANCE_THRESHOLD = new Decimal('0.01');
        if (variance.abs().greaterThan(VARIANCE_THRESHOLD)) {
            await this.createVarianceGLEntry(closedSession, variance, userId, pool);
        }

        logger.info('Cash register session closed', {
            sessionId: closedSession.id,
            sessionNumber: closedSession.sessionNumber,
            expectedClosing: closedSession.expectedClosing,
            actualClosing: closedSession.actualClosing,
            variance: closedSession.variance,
            closedBy: userId,
        });

        return closedSession;
    },

    /**
     * Create GL entry for cash variance (overage or shortage)
     *
     * Integrates with existing AccountingCore:
     * - Cash Overage: DR Cash (1010), CR Other Income (4900)
     * - Cash Shortage: DR Cash Shortage Expense (6850), CR Cash (1010)
     *
     * NOTE: AccountingCore manages its own transaction, so this is called
     * after the session close transaction has committed.
     */
    async createVarianceGLEntry(
        session: CashRegisterSession,
        variance: Decimal,
        userId: string,
        dbPool?: Pool
    ): Promise<void> {
        const today = getBusinessDate();
        const idempotencyKey = `CASH_VAR_${session.id}`;
        const absVariance = variance.abs().toNumber();

        const lines: JournalLine[] = [];

        if (variance.greaterThan(0)) {
            // Cash OVERAGE - More cash than expected
            // DR Cash (Asset ↑), CR Other Income (Revenue ↑)
            lines.push({
                accountCode: ACCOUNT_CODES.CASH,
                description: `Cash overage - Session ${session.sessionNumber}`,
                debitAmount: absVariance,
                creditAmount: 0,
                entityType: 'CASH_SESSION',
                entityId: session.id,
            });
            lines.push({
                accountCode: ACCOUNT_CODES.CASH_OVERAGE,
                description: `Cash overage - Session ${session.sessionNumber}`,
                debitAmount: 0,
                creditAmount: absVariance,
                entityType: 'CASH_SESSION',
                entityId: session.id,
            });
        } else {
            // Cash SHORTAGE - Less cash than expected
            // DR Cash Shortage Expense (Expense ↑), CR Cash (Asset ↓)
            lines.push({
                accountCode: ACCOUNT_CODES.CASH_SHORTAGE,
                description: `Cash shortage - Session ${session.sessionNumber}`,
                debitAmount: absVariance,
                creditAmount: 0,
                entityType: 'CASH_SESSION',
                entityId: session.id,
            });
            lines.push({
                accountCode: ACCOUNT_CODES.CASH,
                description: `Cash shortage - Session ${session.sessionNumber}`,
                debitAmount: 0,
                creditAmount: absVariance,
                entityType: 'CASH_SESSION',
                entityId: session.id,
            });
        }

        try {
            await AccountingCore.createJournalEntry(
                {
                    entryDate: today,
                    description: `Cash variance - Session ${session.sessionNumber}`,
                    referenceType: 'CASH_SESSION',
                    referenceId: session.id,
                    referenceNumber: session.sessionNumber,
                    lines,
                    userId,
                    idempotencyKey,
                    source: 'CASH_VARIANCE' as const,
                },
                dbPool
            );

            logger.info('Cash variance GL entry created', {
                sessionId: session.id,
                sessionNumber: session.sessionNumber,
                variance: variance.toNumber(),
                type: variance.greaterThan(0) ? 'OVERAGE' : 'SHORTAGE',
            });
        } catch (error: unknown) {
            // If idempotency conflict, entry already exists (safe to ignore)
            if (
                error instanceof Error &&
                (error instanceof Error ? error.message : String(error)).includes('IDEMPOTENCY_CONFLICT')
            ) {
                logger.warn('Variance GL entry already exists', { sessionId: session.id });
                return;
            }
            throw error;
        }
    },

    /**
     * Force-close a stale/abandoned session (admin/manager only)
     *
     * Used when a cashier left without closing their session, blocking the register.
     * Sets actual_closing = expected_closing (assumes expected amounts).
     * Logged as administrative action for audit trail.
     */
    async forceCloseSession(
        sessionId: string,
        closedByUserId: string,
        dbPool?: Pool
    ): Promise<CashRegisterSession> {
        const pool = dbPool || globalPool;
        // Validate session outside txn (read-only)
        const session = await cashRegisterRepository.getSessionById(pool, sessionId);
        if (!session) {
            throw new SessionNotFoundError(sessionId);
        }
        if (session.status !== 'OPEN') {
            throw new SessionNotOpenError(sessionId, session.status);
        }

        // Calculate expected closing from movements INSIDE the transaction
        // so force-close sets actualClosing = expectedClosing → variance = 0
        const closedSession = await UnitOfWork.run<CashRegisterSession>(pool, async (client) => {
            const calculatedExpected = await cashRegisterRepository.calculateExpectedClosing(
                client,
                sessionId
            );
            return cashRegisterRepository.closeSession(client, {
                sessionId,
                actualClosing: calculatedExpected,
                varianceReason: undefined,
                notes: `Force-closed by administrator. Original cashier: ${session.userName || session.userId}`,
            });
        });

        logger.warn('Cash register session FORCE-CLOSED by admin', {
            sessionId: closedSession.id,
            sessionNumber: closedSession.sessionNumber,
            originalUserId: session.userId,
            originalUserName: session.userName,
            closedByUserId,
            expectedClosing: closedSession.expectedClosing,
        });

        return closedSession;
    },

    /**
     * Create GL entry for cash movement (cash in/out)
     *
     * ACCOUNTING ENTRIES BY TYPE:
     *
     * CASH_IN_FLOAT: Float received from petty cash
     *   DR Cash Drawer (1010), CR Petty Cash (1012)
     *   No P&L impact - transfer between cash locations
     *
     * CASH_IN_OTHER: Miscellaneous income
     *   DR Cash (1010), CR Other Income (4200)
     *   P&L impact - revenue
     *
     * CASH_OUT_BANK: Bank deposit
     *   DR Checking Account (1030), CR Cash (1010)
     *   No P&L impact - transfer between cash locations
     *
     * CASH_OUT_EXPENSE: Petty cash expense — credits 1012, never the till 1010
     *   DR General Expense (6900), CR Petty Cash (1012)
     *   P&L impact - expense. Does NOT change expected till cash.
     *
     * CASH_OUT_OTHER: Other drawer withdrawal
     *   DR General Expense (6900), CR Cash Drawer (1010)
     *   P&L impact - expense
     *
     * NOTE: CASH_IN_PAYMENT posts AR + 1010 in recordTillArPayment (TILL_RECEIPT).
     *       Do not post a second journal here.
     * NOTE: SALE and REFUND are NOT posted here - handled by sales GL posting.
     * NOTE: FLOAT_ADJUSTMENT is NOT posted - it's the opening float.
     * NOTE: 1015 Undeposited Funds is NEVER used for petty/float or till AR.
     */
    async createMovementGLEntry(
        movement: CashMovement,
        session: CashRegisterSession,
        userId: string,
        dbPool?: Pool
    ): Promise<void> {
        const today = getBusinessDate();
        const idempotencyKey = `CASH_MOV_${movement.id}`;
        const amount = new Decimal(movement.amount).toNumber();

        let lines: JournalLine[] = [];
        let description = '';

        switch (movement.movementType) {
            case 'CASH_IN_OTHER':
                // Miscellaneous income
                description = `Cash income - ${movement.reason || 'Other'}`;
                lines = [
                    {
                        accountCode: ACCOUNT_CODES.CASH,
                        description,
                        debitAmount: amount,
                        creditAmount: 0,
                        entityType: 'CASH_MOVEMENT',
                        entityId: movement.id,
                    },
                    {
                        accountCode: ACCOUNT_CODES.OTHER_INCOME,
                        description,
                        debitAmount: 0,
                        creditAmount: amount,
                        entityType: 'CASH_MOVEMENT',
                        entityId: movement.id,
                    },
                ];
                break;

            case 'CASH_OUT_BANK':
            case 'CASH_IN_FLOAT': {
                // Phase 1C: liquidity moves go through Treasury Document when enabled
                const { isTreasuryDocumentEnabled } = await import('../treasury/treasurySettings.js');
                const { createTreasuryTransfer } = await import('../treasury/treasuryTransferService.js');
                const treasuryOn = await isTreasuryDocumentEnabled(dbPool || globalPool);

                if (treasuryOn && movement.movementType === 'CASH_OUT_BANK') {
                    description = `Bank deposit - ${movement.reason || 'Daily deposit'}`;
                    await createTreasuryTransfer(dbPool || globalPool, {
                        transactionDate: today,
                        fromAccountCode: ACCOUNT_CODES.CASH,
                        toAccountCode: ACCOUNT_CODES.CHECKING_ACCOUNT,
                        amount,
                        memo: description,
                        documentType: 'CASH_WITHDRAWAL',
                        sourceSessionMovementId: movement.id,
                        createdBy: userId,
                        postImmediately: true,
                    });
                    logger.info('Cash movement posted via Treasury Transfer', {
                        movementId: movement.id,
                        movementType: movement.movementType,
                        amount,
                    });
                    return;
                }

                if (treasuryOn && movement.movementType === 'CASH_IN_FLOAT') {
                    description = `Float received - Session ${session.sessionNumber}`;
                    await createTreasuryTransfer(dbPool || globalPool, {
                        transactionDate: today,
                        fromAccountCode: ACCOUNT_CODES.PETTY_CASH, // 1012
                        toAccountCode: ACCOUNT_CODES.CASH,
                        amount,
                        memo: description,
                        documentType: 'TREASURY_TRANSFER',
                        sourceSessionMovementId: movement.id,
                        createdBy: userId,
                        postImmediately: true,
                    });
                    logger.info('Cash movement posted via Treasury Transfer', {
                        movementId: movement.id,
                        movementType: movement.movementType,
                        amount,
                    });
                    return;
                }

                if (movement.movementType === 'CASH_OUT_BANK') {
                    description = `Bank deposit - ${movement.reason || 'Daily deposit'}`;
                    lines = [
                        {
                            accountCode: ACCOUNT_CODES.CHECKING_ACCOUNT,
                            description,
                            debitAmount: amount,
                            creditAmount: 0,
                            entityType: 'CASH_MOVEMENT',
                            entityId: movement.id,
                        },
                        {
                            accountCode: ACCOUNT_CODES.CASH,
                            description,
                            debitAmount: 0,
                            creditAmount: amount,
                            entityType: 'CASH_MOVEMENT',
                            entityId: movement.id,
                        },
                    ];
                } else {
                    description = `Float received - Session ${session.sessionNumber}`;
                    lines = [
                        {
                            accountCode: ACCOUNT_CODES.CASH,
                            description,
                            debitAmount: amount,
                            creditAmount: 0,
                            entityType: 'CASH_MOVEMENT',
                            entityId: movement.id,
                        },
                        {
                            accountCode: ACCOUNT_CODES.PETTY_CASH,
                            description,
                            debitAmount: 0,
                            creditAmount: amount,
                            entityType: 'CASH_MOVEMENT',
                            entityId: movement.id,
                        },
                    ];
                }
                break;
            }

            case 'CASH_OUT_EXPENSE': {
                const { isTreasuryDocumentEnabled } = await import('../treasury/treasurySettings.js');
                const treasuryOn = await isTreasuryDocumentEnabled(dbPool || globalPool);
                description = `Petty cash expense - ${movement.reason || 'Misc'}`;

                if (treasuryOn) {
                    const { createPettyCashDocument } = await import('../treasury/pettyCashService.js');
                    await createPettyCashDocument(dbPool || globalPool, {
                        transactionDate: today,
                        operation: 'EXPENSE',
                        amount,
                        contraAccountCode: ACCOUNT_CODES.GENERAL_EXPENSE,
                        memo: description,
                        sourceSessionMovementId: movement.id,
                        createdBy: userId,
                        postImmediately: true,
                    });
                    logger.info('Petty cash expense posted via Treasury Document', {
                        movementId: movement.id,
                        amount,
                    });
                    return;
                }

                // Flag-off: petty expense still credits 1012 (petty), never till 1010
                lines = [
                    {
                        accountCode: ACCOUNT_CODES.GENERAL_EXPENSE,
                        description,
                        debitAmount: amount,
                        creditAmount: 0,
                        entityType: 'CASH_MOVEMENT',
                        entityId: movement.id,
                    },
                    {
                        accountCode: ACCOUNT_CODES.PETTY_CASH,
                        description,
                        debitAmount: 0,
                        creditAmount: amount,
                        entityType: 'CASH_MOVEMENT',
                        entityId: movement.id,
                    },
                ];
                break;
            }

            case 'CASH_OUT_OTHER':
                // Drawer withdrawal (not petty cash fund)
                description = `Cash withdrawal - ${movement.reason || 'Other'}`;
                lines = [
                    {
                        accountCode: ACCOUNT_CODES.GENERAL_EXPENSE,
                        description,
                        debitAmount: amount,
                        creditAmount: 0,
                        entityType: 'CASH_MOVEMENT',
                        entityId: movement.id,
                    },
                    {
                        accountCode: ACCOUNT_CODES.CASH,
                        description,
                        debitAmount: 0,
                        creditAmount: amount,
                        entityType: 'CASH_MOVEMENT',
                        entityId: movement.id,
                    },
                ];
                break;

            default:
                // CASH_IN_PAYMENT, SALE, REFUND, FLOAT_ADJUSTMENT, legacy types
                // These are posted by their respective workflows or don't need GL posting
                logger.debug('Movement type does not require direct GL posting', {
                    movementId: movement.id,
                    movementType: movement.movementType,
                });
                return;
        }

        try {
            const postingSource =
                movement.movementType === 'CASH_OUT_BANK' || movement.movementType === 'CASH_IN_FLOAT'
                    ? ('TREASURY_TRANSFER' as const)
                    : ('EXPENSE_PAYMENT' as const);

            await AccountingCore.createJournalEntry(
                {
                    entryDate: today,
                    description,
                    referenceType: 'CASH_MOVEMENT',
                    referenceId: movement.id,
                    referenceNumber: session.sessionNumber,
                    lines,
                    userId,
                    idempotencyKey,
                    source: postingSource,
                },
                dbPool
            );

            logger.info('Cash movement GL entry created', {
                movementId: movement.id,
                movementType: movement.movementType,
                amount,
                sessionNumber: session.sessionNumber,
            });
        } catch (error: unknown) {
            // If idempotency conflict, entry already exists (safe to ignore)
            if (
                error instanceof Error &&
                (error instanceof Error ? error.message : String(error)).includes('IDEMPOTENCY_CONFLICT')
            ) {
                logger.warn('Movement GL entry already exists', { movementId: movement.id });
                return;
            }
            throw error;
        }
    },

    /**
     * Reconcile a closed session (manager approval)
     *
     * Business Rules:
     * - Session must be CLOSED (not OPEN or already RECONCILED)
     * - Only managers/admins should call this (enforced at route level)
     * - Creates a reconciliation audit entry in cash_register_reconciliations
     */
    async reconcileSession(
        sessionId: string,
        reconciledBy: string,
        dbPool?: Pool
    ): Promise<CashRegisterSession> {
        const pool = dbPool || globalPool;
        const session = await cashRegisterRepository.getSessionById(pool, sessionId);
        if (!session) {
            throw new SessionNotFoundError(sessionId);
        }
        if (session.status !== 'CLOSED') {
            throw new SessionNotClosedError(sessionId, session.status);
        }

        // Create reconciliation audit entry
        await cashRegisterRepository.createReconciliation(pool, {
            sessionId,
            reconciledBy,
            expectedAmount: session.expectedClosing ?? 0,
            countedAmount: session.actualClosing ?? 0,
            variance: session.variance ?? 0,
            reason: session.varianceReason ?? undefined,
            denominationBreakdown: session.denominationBreakdown ?? undefined,
        });

        const reconciledSession = await cashRegisterRepository.reconcileSession(
            pool,
            sessionId,
            reconciledBy
        );

        logger.info('Cash register session reconciled', {
            sessionId,
            sessionNumber: reconciledSession.sessionNumber,
            reconciledBy,
        });

        return reconciledSession;
    },

    /**
     * Get sessions with filters
     */
    async getSessions(
        filters: {
            registerId?: string;
            userId?: string;
            status?: SessionStatus;
            startDate?: string;
            endDate?: string;
            limit?: number;
            offset?: number;
        },
        dbPool?: Pool
    ): Promise<{ sessions: CashRegisterSession[]; total: number }> {
        return cashRegisterRepository.getSessions(dbPool || globalPool, filters);
    },

    /**
     * Get session summary
     */
    async getSessionSummary(sessionId: string, dbPool?: Pool) {
        return cashRegisterRepository.getSessionSummary(dbPool || globalPool, sessionId);
    },

    // ===========================================================================
    // CASH MOVEMENT OPERATIONS
    // ===========================================================================

    /**
     * Record a cash movement (cash in/out)
     *
     * Business Rules:
     * - Session must be OPEN
     * - CASH_OUT may require approval (enforced at route level)
     * - Movements with reference link to source transaction
     * - Posts to GL for movements that require accounting (CASH_OUT_BANK, CASH_OUT_EXPENSE, etc.)
     * - Offline dedup: if clientUuid provided and already exists, returns existing movement
     */
    async recordMovement(data: RecordMovementData, dbPool?: Pool): Promise<CashMovement> {
        const pool = dbPool || globalPool;
        // Offline dedup: if clientUuid provided, check if already processed
        if (data.clientUuid) {
            const existing = await cashRegisterRepository.getMovementByClientUuid(pool, data.clientUuid);
            if (existing) {
                logger.info('Duplicate movement detected (offline dedup)', {
                    clientUuid: data.clientUuid,
                    existingMovementId: existing.id,
                });
                return existing;
            }
        }

        if (data.movementType === 'CASH_IN_PAYMENT') {
            return this.recordTillArPayment(data, pool);
        }

        // Validate session exists and is open
        const session = await cashRegisterRepository.getSessionById(pool, data.sessionId);
        if (!session) {
            throw new SessionNotFoundError(data.sessionId);
        }
        if (session.status !== 'OPEN') {
            throw new SessionNotOpenError(data.sessionId, session.status);
        }

        const movement = await cashRegisterRepository.recordMovement(pool, data);

        // Post to GL for applicable movement types
        // This is called after movement is saved (idempotency key prevents duplicates)
        await this.createMovementGLEntry(movement, session, data.userId, pool);

        logger.info('Cash movement recorded', {
            movementId: movement.id,
            sessionId: data.sessionId,
            type: data.movementType,
            amount: data.amount,
            reason: data.reason,
            userId: data.userId,
        });

        return movement;
    },

    /**
     * POS till collection of customer AR — one event, one GL, one drawer movement.
     *
     * SSOT:
     *   DR 1010 Cash Drawer (TILL_RECEIPT)
     *   CR 1200 Accounts Receivable (allocated to the selected invoice)
     *   cash_movements CASH_IN_PAYMENT with reference AR_PAYMENT
     *
     * Must not debit 1015 (would duplicate undeposited + till cash).
     * Must not post createMovementGLEntry (would duplicate 1010).
     */
    async recordTillArPayment(data: RecordMovementData, dbPool?: Pool): Promise<CashMovement> {
        const pool = dbPool || globalPool;
        const customerId = data.customerId?.trim();
        const invoiceId = data.invoiceId?.trim();
        if (!customerId) {
            throw new ValidationError(
                'Customer Payment requires a customer. Select the customer whose invoice is being paid.',
            );
        }
        if (!invoiceId) {
            throw new ValidationError(
                'Customer Payment requires an open invoice. This is not a free-text till note.',
            );
        }
        const amount = new Decimal(data.amount);
        if (!amount.greaterThan(0)) {
            throw new ValidationError('Payment amount must be greater than zero');
        }

        return UnitOfWork.run(pool, async (client) => {
            const session = await cashRegisterRepository.getSessionById(client, data.sessionId);
            if (!session) {
                throw new SessionNotFoundError(data.sessionId);
            }
            if (session.status !== 'OPEN') {
                throw new SessionNotOpenError(data.sessionId, session.status);
            }

            const openBalance = await openItemEngine.getInvoiceOpenBalance(client, invoiceId);
            if (openBalance.lessThanOrEqualTo(0.009)) {
                throw new ValidationError('Selected invoice has no outstanding balance.');
            }
            if (amount.greaterThan(openBalance.plus(0.009))) {
                throw new ValidationError(
                    `Amount ${amount.toFixed(2)} exceeds invoice outstanding ${openBalance.toFixed(2)}.`,
                );
            }

            const invRow = await client.query<{
                invoice_number: string;
                customer_id: string;
            }>(
                `SELECT invoice_number, customer_id FROM invoices WHERE id = $1`,
                [invoiceId],
            );
            const invoice = invRow.rows[0];
            if (!invoice) {
                throw new ValidationError('Invoice not found');
            }
            if (invoice.customer_id !== customerId) {
                throw new ValidationError('Invoice does not belong to the selected customer.');
            }

            const paymentDate = getBusinessDate();
            const arResult = await arPaymentService.createCustomerPayment(client, {
                customerId,
                amount: amount.toNumber(),
                paymentDate,
                paymentMethod: 'CASH',
                reference: data.reason?.trim() || invoice.invoice_number,
                notes: `Till collection session ${session.sessionNumber}`,
                createdById: data.userId,
                autoAllocate: false,
                allocationType: 'MANUAL',
                allocations: [{ invoiceId, amount: amount.toNumber() }],
                fundsAccountCode: '1010',
            });

            const payment = arResult.payment;
            if (!payment) {
                throw new ValidationError('AR payment was not created');
            }

            const reason =
                data.reason?.trim() ||
                `${arResult.customerName} ${invoice.invoice_number} ${payment.paymentNumber}`;

            const movement = await cashRegisterRepository.recordMovement(client, {
                sessionId: data.sessionId,
                userId: data.userId,
                movementType: 'CASH_IN_PAYMENT',
                amount: amount.toNumber(),
                reason,
                referenceType: 'AR_PAYMENT',
                referenceId: payment.id,
                paymentMethod: 'CASH',
                clientUuid: data.clientUuid,
                metadata: {
                    customerId,
                    invoiceId,
                    invoiceNumber: invoice.invoice_number,
                    paymentNumber: payment.paymentNumber,
                    arPaymentId: payment.id,
                    fundsAccountCode: '1010',
                },
            });

            logger.info('Till AR collection posted', {
                movementId: movement.id,
                sessionId: data.sessionId,
                arPaymentId: payment.id,
                paymentNumber: payment.paymentNumber,
                customerId,
                invoiceId,
                amount: amount.toNumber(),
                gl: 'DR 1010 CR 1200 TILL_RECEIPT',
            });

            return movement;
        });
    },

    /**
     * Record a sale's cash payment
     * Called from salesService when payment method is CASH
     *
     * NOTE: This creates the link between sales and cash register tracking
     */
    async recordSaleMovement(
        sessionId: string,
        saleId: string,
        cashAmount: number,
        userId: string,
        dbPool?: Pool
    ): Promise<CashMovement> {
        return this.recordMovement(
            {
                sessionId,
                userId,
                movementType: 'SALE',
                amount: cashAmount,
                reason: 'Cash sale',
                referenceType: 'SALE',
                referenceId: saleId,
            },
            dbPool
        );
    },

    /**
     * Record a refund
     */
    async recordRefundMovement(
        sessionId: string,
        saleId: string,
        refundAmount: number,
        userId: string,
        reason: string,
        dbPool?: Pool
    ): Promise<CashMovement> {
        return this.recordMovement(
            {
                sessionId,
                userId,
                movementType: 'REFUND',
                amount: refundAmount,
                reason,
                referenceType: 'REFUND',
                referenceId: saleId,
            },
            dbPool
        );
    },

    /**
     * Get movements for a session
     */
    async getSessionMovements(sessionId: string, dbPool?: Pool): Promise<CashMovement[]> {
        return cashRegisterRepository.getSessionMovements(dbPool || globalPool, sessionId);
    },

    // ===========================================================================
    // REPORTS (QuickBooks/Odoo Standard)
    // ===========================================================================

    /**
     * Generate X-Report (interim report - does not close session)
     *
     * QuickBooks/Odoo standard: Shows current session totals without closing
     */
    async generateXReport(sessionId: string, dbPool?: Pool): Promise<XReportData> {
        const pool = dbPool || globalPool;
        const session = await cashRegisterRepository.getSessionById(pool, sessionId);
        if (!session) {
            throw new SessionNotFoundError(sessionId);
        }
        if (session.status !== 'OPEN') {
            throw new SessionNotOpenError(sessionId, session.status);
        }

        const summary = await this.getSessionSummary(sessionId, pool);
        if (!summary) {
            throw new SessionNotFoundError(sessionId);
        }

        // Calculate expected closing from movements
        const expectedClosing = await cashRegisterRepository.calculateExpectedClosing(pool, sessionId);

        // Calculate payment summary
        const paymentSummary = await cashRegisterRepository.calculatePaymentSummary(pool, sessionId);

        return {
            reportType: 'X-REPORT',
            sessionNumber: session.sessionNumber,
            registerName: session.registerName || 'Unknown',
            cashierName: session.userName || 'Unknown',
            openedAt: session.openedAt,
            reportGeneratedAt: new Date(),
            openingFloat: session.openingFloat,
            expectedClosing,
            totalCashIn: summary.summary.totalCashIn,
            totalCashOut: summary.summary.totalCashOut,
            totalSales: summary.summary.totalSales,
            totalRefunds: summary.summary.totalRefunds,
            netCashFlow: expectedClosing - session.openingFloat,
            transactionCount: summary.summary.movementCount,
            paymentSummary,
            movements: summary.movements,
            // X-Report specific: session remains OPEN
            sessionStatus: 'OPEN',
            // Detailed breakdown by movement type
            breakdown: summary.summary.breakdown,
        };
    },

    /**
     * Generate Z-Report (end of day report - closes session)
     *
     * QuickBooks/Odoo standard: Final report that closes the session
     * Must provide actual closing amount for variance calculation
     * Enterprise: Persists Z-report to z_reports table for reprint/audit
     */
    async generateZReport(
        sessionId: string,
        actualClosing: number,
        denominationBreakdown?: DenominationBreakdown,
        varianceReason?: string,
        userId?: string,
        dbPool?: Pool
    ): Promise<ZReportData> {
        const pool = dbPool || globalPool;
        const effectiveUserId = userId || 'system';

        // First close the session
        const closedSession = await this.closeSession(
            {
                sessionId,
                actualClosing,
                denominationBreakdown,
                varianceReason,
            },
            effectiveUserId,
            pool
        );

        const summary = await this.getSessionSummary(sessionId, pool);

        const reportData: ZReportData = {
            reportType: 'Z-REPORT',
            sessionNumber: closedSession.sessionNumber,
            registerName: closedSession.registerName || 'Unknown',
            cashierName: closedSession.userName || 'Unknown',
            openedAt: closedSession.openedAt,
            closedAt: closedSession.closedAt!,
            reportGeneratedAt: new Date(),
            openingFloat: closedSession.openingFloat,
            expectedClosing: closedSession.expectedClosing!,
            actualClosing: closedSession.actualClosing!,
            variance: closedSession.variance!,
            varianceReason: closedSession.varianceReason,
            totalCashIn: summary?.summary.totalCashIn || 0,
            totalCashOut: summary?.summary.totalCashOut || 0,
            totalSales: summary?.summary.totalSales || 0,
            totalRefunds: summary?.summary.totalRefunds || 0,
            netCashFlow: (closedSession.expectedClosing || 0) - closedSession.openingFloat,
            transactionCount: summary?.summary.movementCount || 0,
            paymentSummary: closedSession.paymentSummary,
            denominationBreakdown: closedSession.denominationBreakdown,
            // Z-Report specific: session is now CLOSED
            sessionStatus: 'CLOSED',
            varianceApprovalRequired:
                Math.abs(closedSession.variance || 0) > closedSession.varianceThreshold,
            // Detailed breakdown by movement type
            breakdown: summary?.summary.breakdown || {
                cashInFloat: 0,
                cashInPayment: 0,
                cashInOther: 0,
                cashOutBank: 0,
                cashOutExpense: 0,
                cashOutOther: 0,
            },
        };

        // Persist Z-Report for reprint/audit
        try {
            const stored = await cashRegisterRepository.saveZReport(pool, {
                sessionId,
                registerName: reportData.registerName,
                cashierName: reportData.cashierName,
                cashierId: closedSession.userId,
                openedAt: reportData.openedAt,
                closedAt: reportData.closedAt,
                openingFloat: reportData.openingFloat,
                expectedClosing: reportData.expectedClosing,
                actualClosing: reportData.actualClosing,
                variance: reportData.variance,
                varianceReason: reportData.varianceReason,
                totalSales: reportData.totalSales,
                totalRefunds: reportData.totalRefunds,
                totalCashIn: reportData.totalCashIn,
                totalCashOut: reportData.totalCashOut,
                netCashFlow: reportData.netCashFlow,
                transactionCount: reportData.transactionCount,
                paymentSummary: reportData.paymentSummary,
                denominationBreakdown: reportData.denominationBreakdown,
                movementBreakdown: reportData.breakdown as unknown as Record<string, number>,
                generatedBy: effectiveUserId,
            });
            logger.info('Z-Report persisted', {
                reportNumber: stored.reportNumber,
                sessionId,
                sessionNumber: closedSession.sessionNumber,
            });
            // Attach report number to response
            (reportData as ZReportData & { reportNumber?: string }).reportNumber = stored.reportNumber;
        } catch (error: unknown) {
            // If the Z-report already exists for this session, log and continue
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes('duplicate key') || msg.includes('unique constraint')) {
                logger.warn('Z-Report already exists for session', { sessionId });
            } else {
                logger.error('Failed to persist Z-Report', { sessionId, error: msg });
            }
        }

        return reportData;
    },

    /**
     * Approve variance (manager only)
     *
     * QuickBooks/Odoo standard: Significant variances need manager approval
     */
    async approveVariance(
        sessionId: string,
        approverId: string,
        approvalNotes?: string,
        dbPool?: Pool
    ): Promise<CashRegisterSession> {
        const pool = dbPool || globalPool;
        const session = await cashRegisterRepository.getSessionById(pool, sessionId);
        if (!session) {
            throw new SessionNotFoundError(sessionId);
        }
        if (session.status !== 'CLOSED') {
            throw new SessionNotClosedError(sessionId, session.status);
        }

        // Update session with approval
        const result = await pool.query(
            `
      UPDATE cash_register_sessions
      SET 
        variance_approved_by = $2,
        variance_approved_at = NOW(),
        notes = COALESCE(notes, '') || $3
      WHERE id = $1
      RETURNING *
    `,
            [sessionId, approverId, approvalNotes ? `\n[Variance Approved: ${approvalNotes}]` : '']
        );

        logger.info('Cash variance approved', {
            sessionId,
            sessionNumber: session.sessionNumber,
            variance: session.variance,
            approvedBy: approverId,
        });

        return result.rows[0];
    },

    // ===========================================================================
    // RECONCILIATION HISTORY (Enterprise Upgrade 1)
    // ===========================================================================

    /**
     * Get reconciliation audit trail for a session
     */
    async getSessionReconciliations(sessionId: string, dbPool?: Pool): Promise<CashReconciliation[]> {
        return cashRegisterRepository.getSessionReconciliations(dbPool || globalPool, sessionId);
    },

    // ===========================================================================
    // Z-REPORT RETRIEVAL (Enterprise Upgrade 3)
    // ===========================================================================

    /**
     * Get stored Z-Report by session ID (for reprint)
     */
    async getStoredZReport(sessionId: string, dbPool?: Pool): Promise<ZReportRecord | null> {
        return cashRegisterRepository.getZReportBySessionId(dbPool || globalPool, sessionId);
    },

    /**
     * Get Z-Report history with filters
     */
    async getZReportHistory(
        filters?: {
            startDate?: string;
            endDate?: string;
            registerId?: string;
            limit?: number;
            offset?: number;
        },
        dbPool?: Pool
    ): Promise<{ reports: ZReportRecord[]; total: number }> {
        return cashRegisterRepository.getZReports(dbPool || globalPool, filters);
    },
};

// =============================================================================
// REPORT INTERFACES
// =============================================================================

// Movement type breakdown for detailed accounting
export interface MovementBreakdown {
    cashInFloat: number; // Float received (petty cash)
    cashInPayment: number; // Customer payments/debt collections
    cashInOther: number; // Other cash receipts
    cashOutBank: number; // Bank deposits
    cashOutExpense: number; // Petty expenses
    cashOutOther: number; // Other cash disbursements
}

export interface XReportData {
    reportType: 'X-REPORT';
    sessionNumber: string;
    registerName: string;
    cashierName: string;
    openedAt: Date;
    reportGeneratedAt: Date;
    openingFloat: number;
    expectedClosing: number;
    totalCashIn: number;
    totalCashOut: number;
    totalSales: number;
    totalRefunds: number;
    netCashFlow: number;
    transactionCount: number;
    paymentSummary: PaymentSummary | null;
    movements: CashMovement[];
    sessionStatus: 'OPEN';
    // NEW: Detailed breakdown by movement type
    breakdown: MovementBreakdown;
}

export interface ZReportData {
    reportType: 'Z-REPORT';
    sessionNumber: string;
    registerName: string;
    cashierName: string;
    openedAt: Date;
    closedAt: Date;
    reportGeneratedAt: Date;
    openingFloat: number;
    expectedClosing: number;
    actualClosing: number;
    variance: number;
    varianceReason: string | null;
    totalCashIn: number;
    totalCashOut: number;
    totalSales: number;
    totalRefunds: number;
    netCashFlow: number;
    transactionCount: number;
    paymentSummary: PaymentSummary | null;
    denominationBreakdown: DenominationBreakdown | null;
    sessionStatus: 'CLOSED';
    varianceApprovalRequired: boolean;
    // NEW: Detailed breakdown by movement type
    breakdown: MovementBreakdown;
}
