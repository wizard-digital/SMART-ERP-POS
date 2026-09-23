/**
 * Cash Register Repository
 * 
 * Database operations for cash register management.
 * Follows existing repository patterns - raw SQL only, no ORM.
 */

import { Pool, PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { getBusinessYear } from '../../utils/dateRange.js';
import {
  parsePosSessionPolicy,
  type PosSessionPolicy,
} from '@shared/pos/posSessionPolicySsot.js';

export class ParticipantsSchemaMissingError extends Error {
  readonly code = 'PARTICIPANTS_SCHEMA_MISSING';
  constructor() {
    super(
      'cash_register_session_participants is missing. Apply migration 620_pos_session_policy_ssot.sql.'
    );
    this.name = 'ParticipantsSchemaMissingError';
  }
}

function rethrowUndefinedTable(error: unknown): never {
  if ((error as { code?: string }).code === '42P01') {
    throw new ParticipantsSchemaMissingError();
  }
  throw error;
}

// =============================================================================
// INTERFACES
// =============================================================================

export interface CashRegister {
  id: string;
  name: string;
  location: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type SessionStatus = 'OPEN' | 'CLOSED' | 'RECONCILED';

// Denomination breakdown (QuickBooks/Odoo standard)
export interface DenominationBreakdown {
  [denomination: string]: number; // e.g., "50000": 5, "20000": 10, "10000": 20
}

// Payment summary by method
export interface PaymentSummary {
  CASH?: number;
  CARD?: number;
  MOBILE_MONEY?: number;
  CREDIT?: number;
  OTHER?: number;
}

export interface CashRegisterSession {
  id: string;
  registerId: string;
  registerName?: string;
  userId: string;
  userName?: string;
  sessionNumber: string;
  status: SessionStatus;
  openingFloat: number;
  expectedClosing: number | null;
  actualClosing: number | null;
  variance: number | null;
  varianceReason: string | null;
  openedAt: Date;
  closedAt: Date | null;
  reconciledAt: Date | null;
  reconciledBy: string | null;
  notes: string | null;
  // ERP-standard additions
  blindCountEnabled: boolean;
  denominationBreakdown: DenominationBreakdown | null;
  paymentSummary: PaymentSummary | null;
  varianceApprovedBy: string | null;
  varianceApprovedAt: Date | null;
  varianceThreshold: number;
}

export type MovementType =
  | 'CASH_IN'              // Legacy: Generic cash in (deprecated)
  | 'CASH_IN_FLOAT'        // Float received (not revenue)
  | 'CASH_IN_PAYMENT'      // Customer invoice/debt payment (AR reduction)
  | 'CASH_IN_OTHER'        // Other cash income
  | 'CASH_OUT'             // Legacy: Generic cash out (deprecated)
  | 'CASH_OUT_BANK'        // Bank deposit
  | 'CASH_OUT_EXPENSE'     // Petty cash expense
  | 'CASH_OUT_OTHER'       // Other cash withdrawal
  | 'SALE'                 // POS sale cash payment
  | 'REFUND'               // Customer refund
  | 'FLOAT_ADJUSTMENT';    // Opening float

export type PaymentMethod = 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'CREDIT' | 'OTHER';

export interface CashMovement {
  id: string;
  sessionId: string;
  userId: string;
  userName?: string;
  movementType: MovementType;
  amount: number;
  reason: string | null;
  referenceType: string | null;
  referenceId: string | null;
  approvedBy: string | null;
  approvedByName?: string;
  paymentMethod: PaymentMethod | null;
  createdAt: Date;
}

export interface CreateRegisterData {
  name: string;
  location?: string;
}

export interface OpenSessionData {
  registerId: string;
  userId: string;
  openingFloat: number;
  blindCountEnabled?: boolean; // QuickBooks/Odoo: hide expected from cashier
  varianceThreshold?: number;  // Auto-approve variances below this amount
}

export interface CloseSessionData {
  sessionId: string;
  actualClosing: number;
  varianceReason?: string;
  notes?: string;
  denominationBreakdown?: DenominationBreakdown; // Cash counted by denomination
}

export interface RecordMovementData {
  sessionId: string;
  userId: string;
  movementType: MovementType;
  amount: number;
  reason?: string;
  referenceType?: string;
  referenceId?: string;
  approvedBy?: string;
  paymentMethod?: PaymentMethod; // Track payment method for sales
  metadata?: Record<string, unknown>; // Flexible JSONB for expense_type, receipt_number, etc.
  clientUuid?: string; // Offline deduplication UUID
  /** Required for CASH_IN_PAYMENT — real customer, not free text. */
  customerId?: string;
  /** Required for CASH_IN_PAYMENT — open invoice being collected. */
  invoiceId?: string;
}

/** Movement types that increase expected till cash. */
export const TILL_INFLOW_TYPES: MovementType[] = [
  'CASH_IN',
  'CASH_IN_FLOAT',
  'CASH_IN_PAYMENT',
  'CASH_IN_OTHER',
  'SALE',
  'FLOAT_ADJUSTMENT',
];

/** Movement types that decrease expected till cash. Petty CASH_OUT_EXPENSE is excluded (1012, not 1010). */
export const TILL_OUTFLOW_TYPES: MovementType[] = [
  'CASH_OUT',
  'CASH_OUT_BANK',
  'CASH_OUT_OTHER',
  'REFUND',
];

/** Till cash-out line on the close dialog (refunds shown separately). */
export const TILL_CASH_OUT_TYPES: MovementType[] = [
  'CASH_OUT',
  'CASH_OUT_BANK',
  'CASH_OUT_OTHER',
];

// Enterprise: Reconciliation audit trail
export interface CashReconciliation {
  id: string;
  sessionId: string;
  reconciledBy: string;
  reconciledByName?: string;
  expectedAmount: number;
  countedAmount: number;
  variance: number;
  variancePercent: number;
  approved: boolean;
  approvedBy: string | null;
  approvedByName?: string;
  approvedAt: Date | null;
  reason: string | null;
  notes: string | null;
  denominationBreakdown: DenominationBreakdown | null;
  createdAt: Date;
}

// Enterprise: Persistent Z-Report
export interface ZReportRecord {
  id: string;
  sessionId: string;
  reportNumber: string;
  registerName: string;
  cashierName: string;
  cashierId: string;
  openedAt: Date;
  closedAt: Date;
  openingFloat: number;
  expectedClosing: number;
  actualClosing: number;
  variance: number;
  varianceReason: string | null;
  totalSales: number;
  totalRefunds: number;
  totalCashIn: number;
  totalCashOut: number;
  netCashFlow: number;
  transactionCount: number;
  paymentSummary: PaymentSummary | null;
  denominationBreakdown: DenominationBreakdown | null;
  movementBreakdown: Record<string, number> | null;
  generatedBy: string;
  generatedAt: Date;
}

// =============================================================================
// REGISTER OPERATIONS
// =============================================================================

export const cashRegisterRepository = {
  /**
   * Get all cash registers
   */
  async getAllRegisters(pool: Pool | PoolClient): Promise<CashRegister[]> {
    const result = await pool.query(`
      SELECT 
        id,
        name,
        location,
        is_active as "isActive",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM cash_registers
      ORDER BY name
    `);
    return result.rows;
  },

  /**
   * Get active registers only
   */
  async getActiveRegisters(pool: Pool | PoolClient): Promise<CashRegister[]> {
    const result = await pool.query(`
      SELECT 
        id,
        name,
        location,
        is_active as "isActive",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM cash_registers
      WHERE is_active = true
      ORDER BY name
    `);
    return result.rows;
  },

  /**
   * Get all registers with current open session info (if any)
   * Used by the Open Register dialog to show availability
   */
  async getRegistersWithSessionStatus(pool: Pool | PoolClient): Promise<Array<CashRegister & {
    currentSessionId: string | null;
    currentSessionNumber: string | null;
    currentSessionUserId: string | null;
    currentSessionUserName: string | null;
    currentSessionOpenedAt: string | null;
  }>> {
    const result = await pool.query(`
      SELECT 
        r.id,
        r.name,
        r.location,
        r.is_active as "isActive",
        r.created_at as "createdAt",
        r.updated_at as "updatedAt",
        s.id as "currentSessionId",
        s.session_number as "currentSessionNumber",
        s.user_id as "currentSessionUserId",
        u.full_name as "currentSessionUserName",
        s.opened_at as "currentSessionOpenedAt"
      FROM cash_registers r
      LEFT JOIN LATERAL (
        SELECT id, session_number, user_id, opened_at
        FROM cash_register_sessions
        WHERE register_id = r.id AND status = 'OPEN'
        ORDER BY opened_at DESC
        LIMIT 1
      ) s ON true
      LEFT JOIN users u ON u.id = s.user_id
      WHERE r.is_active = true
      ORDER BY r.name
    `);
    return result.rows;
  },

  /**
   * Get register by ID
   */
  async getRegisterById(pool: Pool | PoolClient, id: string): Promise<CashRegister | null> {
    const result = await pool.query(`
      SELECT 
        id,
        name,
        location,
        is_active as "isActive",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM cash_registers
      WHERE id = $1
    `, [id]);
    return result.rows[0] || null;
  },

  /**
   * Create a new register
   */
  async createRegister(pool: Pool | PoolClient, data: CreateRegisterData): Promise<CashRegister> {
    const result = await pool.query(`
      INSERT INTO cash_registers (name, location)
      VALUES ($1, $2)
      RETURNING 
        id,
        name,
        location,
        is_active as "isActive",
        created_at as "createdAt",
        updated_at as "updatedAt"
    `, [data.name, data.location || null]);
    return result.rows[0];
  },

  /**
   * Update a register
   */
  async updateRegister(
    pool: Pool | PoolClient,
    id: string,
    data: Partial<CreateRegisterData & { isActive: boolean }>
  ): Promise<CashRegister | null> {
    const updates: string[] = [];
    const values: (string | boolean | null)[] = [];
    let paramIndex = 1;

    if (data.name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(data.name);
    }
    if (data.location !== undefined) {
      updates.push(`location = $${paramIndex++}`);
      values.push(data.location);
    }
    if (data.isActive !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(data.isActive);
    }

    if (updates.length === 0) return null;

    updates.push(`updated_at = NOW()`);
    values.push(id);

    const result = await pool.query(`
      UPDATE cash_registers
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING 
        id,
        name,
        location,
        is_active as "isActive",
        created_at as "createdAt",
        updated_at as "updatedAt"
    `, values);
    return result.rows[0] || null;
  },

  // ===========================================================================
  // SESSION OPERATIONS
  // ===========================================================================

  /**
   * Generate next session number (REG-YYYY-NNNN format)
   */
  async generateSessionNumber(pool: Pool | PoolClient): Promise<string> {
    const year = getBusinessYear();
    const result = await pool.query(`
      SELECT session_number FROM cash_register_sessions
      WHERE session_number LIKE $1
      ORDER BY session_number DESC
      LIMIT 1
    `, [`REG-${year}-%`]);

    if (result.rows.length === 0) {
      return `REG-${year}-0001`;
    }

    const lastNumber = result.rows[0].session_number;
    const sequence = parseInt(lastNumber.split('-')[2]) + 1;
    return `REG-${year}-${sequence.toString().padStart(4, '0')}`;
  },

  /**
   * Check if register has an open session
   */
  async getOpenSession(
    pool: Pool | PoolClient,
    registerId: string,
    options?: { forUpdate?: boolean }
  ): Promise<CashRegisterSession | null> {
    const lock = options?.forUpdate ? ' FOR UPDATE OF s' : '';
    const result = await pool.query(`
      SELECT 
        s.id,
        s.register_id as "registerId",
        r.name as "registerName",
        s.user_id as "userId",
        u.full_name as "userName",
        s.session_number as "sessionNumber",
        s.status,
        s.opening_float as "openingFloat",
        s.expected_closing as "expectedClosing",
        s.actual_closing as "actualClosing",
        s.variance,
        s.variance_reason as "varianceReason",
        s.opened_at as "openedAt",
        s.closed_at as "closedAt",
        s.reconciled_at as "reconciledAt",
        s.reconciled_by as "reconciledBy",
        s.notes
      FROM cash_register_sessions s
      JOIN cash_registers r ON r.id = s.register_id
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.register_id = $1 AND s.status = 'OPEN'
      ORDER BY s.opened_at DESC
      LIMIT 1${lock}
    `, [registerId]);
    return result.rows[0] || null;
  },

  /**
   * Get open session for a user (across all registers)
   */
  async getUserOpenSession(pool: Pool | PoolClient, userId: string): Promise<CashRegisterSession | null> {
    const result = await pool.query(`
      SELECT 
        s.id,
        s.register_id as "registerId",
        r.name as "registerName",
        s.user_id as "userId",
        u.full_name as "userName",
        s.session_number as "sessionNumber",
        s.status,
        s.opening_float as "openingFloat",
        s.expected_closing as "expectedClosing",
        s.actual_closing as "actualClosing",
        s.variance,
        s.variance_reason as "varianceReason",
        s.opened_at as "openedAt",
        s.closed_at as "closedAt",
        s.reconciled_at as "reconciledAt",
        s.reconciled_by as "reconciledBy",
        s.notes
      FROM cash_register_sessions s
      JOIN cash_registers r ON r.id = s.register_id
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.user_id = $1 AND s.status = 'OPEN'
      ORDER BY s.opened_at DESC
      LIMIT 1
    `, [userId]);
    return result.rows[0] || null;
  },

  /**
   * Whether this user is on the session (owner is also a participant after open/join).
   * Missing participants table throws ParticipantsSchemaMissingError (fail closed).
   */
  async isSessionParticipant(
    pool: Pool | PoolClient,
    sessionId: string,
    userId: string
  ): Promise<boolean> {
    try {
      const result = await pool.query(
        `SELECT 1 FROM cash_register_session_participants
         WHERE session_id = $1 AND user_id = $2 LIMIT 1`,
        [sessionId, userId]
      );
      return result.rows.length > 0;
    } catch (error: unknown) {
      rethrowUndefinedTable(error);
    }
  },

  async getPosSessionPolicy(pool: Pool | PoolClient): Promise<PosSessionPolicy> {
    const result = await pool.query<{ pos_session_policy: string | null }>(
      `SELECT pos_session_policy FROM system_settings LIMIT 1`
    );
    return parsePosSessionPolicy(result.rows[0]?.pos_session_policy);
  },

  async listOpenSessions(pool: Pool | PoolClient): Promise<CashRegisterSession[]> {
    const result = await pool.query(`
      SELECT
        s.id,
        s.register_id as "registerId",
        r.name as "registerName",
        s.user_id as "userId",
        u.full_name as "userName",
        s.session_number as "sessionNumber",
        s.status,
        s.opening_float as "openingFloat",
        s.expected_closing as "expectedClosing",
        s.actual_closing as "actualClosing",
        s.variance,
        s.variance_reason as "varianceReason",
        s.opened_at as "openedAt",
        s.closed_at as "closedAt",
        s.reconciled_at as "reconciledAt",
        s.reconciled_by as "reconciledBy",
        s.notes
      FROM cash_register_sessions s
      JOIN cash_registers r ON r.id = s.register_id
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.status = 'OPEN' AND r.is_active = true
      ORDER BY s.opened_at DESC
    `);
    return result.rows;
  },

  async getJoinedOpenSession(pool: Pool | PoolClient, userId: string): Promise<CashRegisterSession | null> {
    try {
      const result = await pool.query(`
        SELECT
          s.id,
          s.register_id as "registerId",
          r.name as "registerName",
          s.user_id as "userId",
          u.full_name as "userName",
          s.session_number as "sessionNumber",
          s.status,
          s.opening_float as "openingFloat",
          s.expected_closing as "expectedClosing",
          s.actual_closing as "actualClosing",
          s.variance,
          s.variance_reason as "varianceReason",
          s.opened_at as "openedAt",
          s.closed_at as "closedAt",
          s.reconciled_at as "reconciledAt",
          s.reconciled_by as "reconciledBy",
          s.notes
        FROM cash_register_session_participants p
        JOIN cash_register_sessions s ON s.id = p.session_id
        JOIN cash_registers r ON r.id = s.register_id
        LEFT JOIN users u ON u.id = s.user_id
        WHERE p.user_id = $1 AND s.status = 'OPEN'
        ORDER BY p.joined_at DESC
        LIMIT 1
      `, [userId]);
      return result.rows[0] || null;
    } catch (error: unknown) {
      rethrowUndefinedTable(error);
    }
  },

  async ensureSessionParticipant(
    pool: Pool | PoolClient,
    sessionId: string,
    userId: string
  ): Promise<void> {
    try {
      await pool.query(
        `DELETE FROM cash_register_session_participants WHERE user_id = $1 AND session_id <> $2`,
        [userId, sessionId]
      );
      await pool.query(
        `INSERT INTO cash_register_session_participants (session_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (session_id, user_id) DO NOTHING`,
        [sessionId, userId]
      );
    } catch (error: unknown) {
      rethrowUndefinedTable(error);
    }
  },

  async clearSessionParticipants(pool: Pool | PoolClient, sessionId: string): Promise<void> {
    try {
      await pool.query(
        `DELETE FROM cash_register_session_participants WHERE session_id = $1`,
        [sessionId]
      );
    } catch (error: unknown) {
      rethrowUndefinedTable(error);
    }
  },

  /**
   * Open a new session
   */
  async openSession(pool: Pool | PoolClient, data: OpenSessionData): Promise<CashRegisterSession> {
    const sessionNumber = await this.generateSessionNumber(pool);

    const result = await pool.query(`
      INSERT INTO cash_register_sessions (
        register_id, user_id, session_number, status, 
        opening_float, blind_count_enabled, variance_threshold, opened_at
      )
      VALUES ($1, $2, $3, 'OPEN', $4, $5, $6, NOW())
      RETURNING 
        id,
        register_id as "registerId",
        user_id as "userId",
        session_number as "sessionNumber",
        status,
        opening_float as "openingFloat",
        expected_closing as "expectedClosing",
        actual_closing as "actualClosing",
        variance,
        variance_reason as "varianceReason",
        opened_at as "openedAt",
        closed_at as "closedAt",
        reconciled_at as "reconciledAt",
        reconciled_by as "reconciledBy",
        notes,
        blind_count_enabled as "blindCountEnabled",
        denomination_breakdown as "denominationBreakdown",
        payment_summary as "paymentSummary",
        variance_approved_by as "varianceApprovedBy",
        variance_approved_at as "varianceApprovedAt",
        variance_threshold as "varianceThreshold"
    `, [
      data.registerId,
      data.userId,
      sessionNumber,
      data.openingFloat,
      data.blindCountEnabled ?? false,
      data.varianceThreshold ?? 0
    ]);

    // Record opening float as initial cash movement
    await this.recordMovement(pool, {
      sessionId: result.rows[0].id,
      userId: data.userId,
      movementType: 'FLOAT_ADJUSTMENT',
      amount: data.openingFloat,
      reason: 'Opening float'
    });

    return result.rows[0];
  },

  /**
   * Get session by ID with full details
   */
  async getSessionById(pool: Pool | PoolClient, sessionId: string): Promise<CashRegisterSession | null> {
    const result = await pool.query(`
      SELECT 
        s.id,
        s.register_id as "registerId",
        r.name as "registerName",
        s.user_id as "userId",
        u.full_name as "userName",
        s.session_number as "sessionNumber",
        s.status,
        s.opening_float as "openingFloat",
        s.expected_closing as "expectedClosing",
        s.actual_closing as "actualClosing",
        s.variance,
        s.variance_reason as "varianceReason",
        s.opened_at as "openedAt",
        s.closed_at as "closedAt",
        s.reconciled_at as "reconciledAt",
        s.reconciled_by as "reconciledBy",
        s.notes,
        s.blind_count_enabled as "blindCountEnabled",
        s.denomination_breakdown as "denominationBreakdown",
        s.payment_summary as "paymentSummary",
        s.variance_approved_by as "varianceApprovedBy",
        s.variance_approved_at as "varianceApprovedAt",
        s.variance_threshold as "varianceThreshold"
      FROM cash_register_sessions s
      JOIN cash_registers r ON r.id = s.register_id
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.id = $1
    `, [sessionId]);
    return result.rows[0] || null;
  },

  /**
   * Calculate expected closing based on movements
   * Handles ALL movement types (legacy + specific enterprise subtypes)
   */
  async calculateExpectedClosing(pool: Pool | PoolClient, sessionId: string): Promise<number> {
    const result = await pool.query(`
      SELECT 
        COALESCE(SUM(
          CASE 
            WHEN movement_type IN (
              'CASH_IN', 'CASH_IN_FLOAT', 'CASH_IN_PAYMENT', 'CASH_IN_OTHER',
              'SALE', 'FLOAT_ADJUSTMENT'
            ) THEN amount
            WHEN movement_type IN (
              'CASH_OUT', 'CASH_OUT_BANK', 'CASH_OUT_OTHER',
              'REFUND'
            ) THEN -amount
            ELSE 0
          END
        ), 0) as expected
      FROM cash_movements
      WHERE session_id = $1
    `, [sessionId]);
    return parseFloat(result.rows[0].expected || '0');
  },

  /**
   * Close a session
   */
  async closeSession(
    pool: Pool | PoolClient,
    data: CloseSessionData
  ): Promise<CashRegisterSession> {
    // Calculate expected closing
    const expectedClosing = await this.calculateExpectedClosing(pool, data.sessionId);
    const variance = new Decimal(data.actualClosing).minus(expectedClosing).toNumber();

    // Calculate payment summary from movements
    const paymentSummary = await this.calculatePaymentSummary(pool, data.sessionId);

    const result = await pool.query(`
      UPDATE cash_register_sessions
      SET 
        status = 'CLOSED',
        version = version + 1,
        expected_closing = $2,
        actual_closing = $3,
        variance = $4,
        variance_reason = $5,
        notes = $6,
        denomination_breakdown = $7,
        payment_summary = $8,
        closed_at = NOW()
      WHERE id = $1
      RETURNING 
        id,
        register_id as "registerId",
        user_id as "userId",
        session_number as "sessionNumber",
        status,
        opening_float as "openingFloat",
        expected_closing as "expectedClosing",
        actual_closing as "actualClosing",
        variance,
        variance_reason as "varianceReason",
        opened_at as "openedAt",
        closed_at as "closedAt",
        reconciled_at as "reconciledAt",
        reconciled_by as "reconciledBy",
        notes,
        blind_count_enabled as "blindCountEnabled",
        denomination_breakdown as "denominationBreakdown",
        payment_summary as "paymentSummary",
        variance_approved_by as "varianceApprovedBy",
        variance_approved_at as "varianceApprovedAt",
        variance_threshold as "varianceThreshold",
        version
    `, [
      data.sessionId,
      expectedClosing,
      data.actualClosing,
      variance,
      data.varianceReason || null,
      data.notes || null,
      data.denominationBreakdown ? JSON.stringify(data.denominationBreakdown) : null,
      paymentSummary ? JSON.stringify(paymentSummary) : null
    ]);

    await this.clearSessionParticipants(pool, data.sessionId);

    return result.rows[0];
  },

  /**
   * Calculate payment summary by payment method
   */
  async calculatePaymentSummary(pool: Pool | PoolClient, sessionId: string): Promise<PaymentSummary> {
    const result = await pool.query(`
      SELECT 
        COALESCE(payment_method, 'CASH') as method,
        SUM(CASE 
          WHEN movement_type IN (
            'SALE', 'CASH_IN', 'CASH_IN_FLOAT', 'CASH_IN_PAYMENT', 'CASH_IN_OTHER'
          ) THEN amount
          WHEN movement_type IN (
            'REFUND', 'CASH_OUT', 'CASH_OUT_BANK', 'CASH_OUT_OTHER'
          ) THEN -amount
          ELSE 0
        END) as total
      FROM cash_movements
      WHERE session_id = $1 AND movement_type != 'FLOAT_ADJUSTMENT'
      GROUP BY payment_method
    `, [sessionId]);

    const summary: PaymentSummary = {};
    for (const row of result.rows) {
      summary[row.method as keyof PaymentSummary] = parseFloat(row.total);
    }
    return summary;
  },

  /**
   * Reconcile a session (manager approval)
   */
  async reconcileSession(
    pool: Pool | PoolClient,
    sessionId: string,
    reconciledBy: string
  ): Promise<CashRegisterSession> {
    const result = await pool.query(`
      UPDATE cash_register_sessions
      SET 
        status = 'RECONCILED',
        version = version + 1,
        reconciled_at = NOW(),
        reconciled_by = $2
      WHERE id = $1 AND status = 'CLOSED'
      RETURNING 
        id,
        register_id as "registerId",
        user_id as "userId",
        session_number as "sessionNumber",
        status,
        opening_float as "openingFloat",
        expected_closing as "expectedClosing",
        actual_closing as "actualClosing",
        variance,
        variance_reason as "varianceReason",
        opened_at as "openedAt",
        closed_at as "closedAt",
        reconciled_at as "reconciledAt",
        reconciled_by as "reconciledBy",
        notes,
        blind_count_enabled as "blindCountEnabled",
        denomination_breakdown as "denominationBreakdown",
        payment_summary as "paymentSummary",
        variance_approved_by as "varianceApprovedBy",
        variance_approved_at as "varianceApprovedAt",
        variance_threshold as "varianceThreshold",
        version
    `, [sessionId, reconciledBy]);

    return result.rows[0];
  },

  /**
   * Get sessions with filters
   */
  async getSessions(
    pool: Pool | PoolClient,
    filters: {
      registerId?: string;
      userId?: string;
      status?: SessionStatus;
      startDate?: string;
      endDate?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<{ sessions: CashRegisterSession[]; total: number }> {
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    let paramIndex = 1;

    if (filters.registerId) {
      conditions.push(`s.register_id = $${paramIndex++}`);
      values.push(filters.registerId);
    }
    if (filters.userId) {
      conditions.push(`s.user_id = $${paramIndex++}`);
      values.push(filters.userId);
    }
    if (filters.status) {
      conditions.push(`s.status = $${paramIndex++}`);
      values.push(filters.status);
    }
    if (filters.startDate) {
      conditions.push(`s.opened_at >= $${paramIndex++}`);
      values.push(filters.startDate);
    }
    if (filters.endDate) {
      conditions.push(`s.opened_at <= $${paramIndex++}`);
      values.push(filters.endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count total
    const countResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM cash_register_sessions s
      ${whereClause}
    `, values);

    // Get paginated results
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;

    const result = await pool.query(`
      SELECT 
        s.id,
        s.register_id as "registerId",
        r.name as "registerName",
        s.user_id as "userId",
        u.full_name as "userName",
        s.session_number as "sessionNumber",
        s.status,
        s.opening_float as "openingFloat",
        s.expected_closing as "expectedClosing",
        s.actual_closing as "actualClosing",
        s.variance,
        s.variance_reason as "varianceReason",
        s.opened_at as "openedAt",
        s.closed_at as "closedAt",
        s.reconciled_at as "reconciledAt",
        s.reconciled_by as "reconciledBy",
        s.notes
      FROM cash_register_sessions s
      JOIN cash_registers r ON r.id = s.register_id
      LEFT JOIN users u ON u.id = s.user_id
      ${whereClause}
      ORDER BY s.opened_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `, [...values, limit, offset]);

    return {
      sessions: result.rows,
      total: parseInt(countResult.rows[0].total)
    };
  },

  // ===========================================================================
  // CASH MOVEMENT OPERATIONS
  // ===========================================================================

  /**
   * Record a cash movement (with optional metadata + offline UUID)
   */
  async recordMovement(pool: Pool | PoolClient, data: RecordMovementData): Promise<CashMovement> {
    const result = await pool.query(`
      INSERT INTO cash_movements (
        session_id, user_id, movement_type, amount,
        reason, reference_type, reference_id, approved_by, payment_method,
        metadata, client_uuid
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING 
        id,
        session_id as "sessionId",
        user_id as "userId",
        movement_type as "movementType",
        amount,
        reason,
        reference_type as "referenceType",
        reference_id as "referenceId",
        approved_by as "approvedBy",
        payment_method as "paymentMethod",
        metadata,
        client_uuid as "clientUuid",
        sync_status as "syncStatus",
        created_at as "createdAt"
    `, [
      data.sessionId,
      data.userId,
      data.movementType,
      data.amount,
      data.reason || null,
      data.referenceType || null,
      data.referenceId || null,
      data.approvedBy || null,
      data.paymentMethod || null,
      data.metadata ? JSON.stringify(data.metadata) : null,
      data.clientUuid || null
    ]);

    return result.rows[0];
  },

  /**
   * Get movements for a session
   */
  async getSessionMovements(pool: Pool | PoolClient, sessionId: string): Promise<CashMovement[]> {
    const result = await pool.query(`
      SELECT 
        m.id,
        m.session_id as "sessionId",
        m.user_id as "userId",
        u.full_name as "userName",
        m.movement_type as "movementType",
        m.amount,
        m.reason,
        m.reference_type as "referenceType",
        m.reference_id as "referenceId",
        m.approved_by as "approvedBy",
        a.full_name as "approvedByName",
        m.payment_method as "paymentMethod",
        m.metadata,
        m.client_uuid as "clientUuid",
        m.sync_status as "syncStatus",
        m.created_at as "createdAt"
      FROM cash_movements m
      LEFT JOIN users u ON u.id = m.user_id
      LEFT JOIN users a ON a.id = m.approved_by
      WHERE m.session_id = $1
      ORDER BY m.created_at ASC
    `, [sessionId]);

    return result.rows;
  },

  /**
   * Get session summary (for closing/reconciliation)
   */
  async getSessionSummary(pool: Pool | PoolClient, sessionId: string): Promise<{
    session: CashRegisterSession;
    movements: CashMovement[];
    summary: {
      openingFloat: number;
      totalCashIn: number;
      totalCashOut: number;
      totalSales: number;
      totalRefunds: number;
      expectedClosing: number;
      actualClosing: number | null;
      variance: number | null;
      movementCount: number;
      // Detailed breakdown by category
      breakdown: {
        cashInFloat: number;
        cashInPayment: number;
        cashInOther: number;
        cashOutBank: number;
        cashOutExpense: number;
        cashOutOther: number;
      };
    };
  } | null> {
    const session = await this.getSessionById(pool, sessionId);
    if (!session) return null;

    const movements = await this.getSessionMovements(pool, sessionId);

    // Calculate summary with detailed breakdown
    const summaryResult = await pool.query(`
      SELECT 
        COALESCE(SUM(CASE WHEN movement_type = 'FLOAT_ADJUSTMENT' THEN amount ELSE 0 END), 0) as opening_float,
        -- Legacy CASH_IN + new specific types
        COALESCE(SUM(CASE WHEN movement_type IN ('CASH_IN', 'CASH_IN_FLOAT', 'CASH_IN_PAYMENT', 'CASH_IN_OTHER') THEN amount ELSE 0 END), 0) as total_cash_in,
        COALESCE(SUM(CASE WHEN movement_type IN ('CASH_OUT', 'CASH_OUT_BANK', 'CASH_OUT_OTHER') THEN amount ELSE 0 END), 0) as total_cash_out,
        COALESCE(SUM(CASE WHEN movement_type = 'SALE' THEN amount ELSE 0 END), 0) as total_sales,
        COALESCE(SUM(CASE WHEN movement_type = 'REFUND' THEN amount ELSE 0 END), 0) as total_refunds,
        -- Detailed breakdown
        COALESCE(SUM(CASE WHEN movement_type = 'CASH_IN_FLOAT' THEN amount ELSE 0 END), 0) as cash_in_float,
        COALESCE(SUM(CASE WHEN movement_type = 'CASH_IN_PAYMENT' THEN amount ELSE 0 END), 0) as cash_in_payment,
        COALESCE(SUM(CASE WHEN movement_type = 'CASH_IN_OTHER' THEN amount ELSE 0 END), 0) as cash_in_other,
        COALESCE(SUM(CASE WHEN movement_type = 'CASH_OUT_BANK' THEN amount ELSE 0 END), 0) as cash_out_bank,
        COALESCE(SUM(CASE WHEN movement_type = 'CASH_OUT_EXPENSE' THEN amount ELSE 0 END), 0) as cash_out_expense,
        COALESCE(SUM(CASE WHEN movement_type = 'CASH_OUT_OTHER' THEN amount ELSE 0 END), 0) as cash_out_other,
        COUNT(*) as movement_count
      FROM cash_movements
      WHERE session_id = $1
    `, [sessionId]);

    const s = summaryResult.rows[0];
    const expectedClosing = new Decimal(s.opening_float)
      .plus(s.total_cash_in)
      .plus(s.total_sales)
      .minus(s.total_cash_out)
      .minus(s.total_refunds)
      .toNumber();

    return {
      session,
      movements,
      summary: {
        openingFloat: parseFloat(s.opening_float),
        totalCashIn: parseFloat(s.total_cash_in),
        totalCashOut: parseFloat(s.total_cash_out),
        totalSales: parseFloat(s.total_sales),
        totalRefunds: parseFloat(s.total_refunds),
        expectedClosing,
        actualClosing: session.actualClosing,
        variance: session.variance,
        movementCount: parseInt(s.movement_count),
        breakdown: {
          cashInFloat: parseFloat(s.cash_in_float),
          cashInPayment: parseFloat(s.cash_in_payment),
          cashInOther: parseFloat(s.cash_in_other),
          cashOutBank: parseFloat(s.cash_out_bank),
          cashOutExpense: parseFloat(s.cash_out_expense),
          cashOutOther: parseFloat(s.cash_out_other),
        }
      }
    };
  },

  // ===========================================================================
  // RECONCILIATION OPERATIONS (Enterprise Upgrade 1)
  // ===========================================================================

  /**
   * Record a reconciliation attempt
   */
  async createReconciliation(
    pool: Pool | PoolClient,
    data: {
      sessionId: string;
      reconciledBy: string;
      expectedAmount: number;
      countedAmount: number;
      variance: number;
      reason?: string;
      notes?: string;
      denominationBreakdown?: DenominationBreakdown;
    }
  ): Promise<CashReconciliation> {
    const result = await pool.query(`
      INSERT INTO cash_register_reconciliations (
        session_id, reconciled_by, expected_amount, counted_amount,
        variance, reason, notes, denomination_breakdown
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING
        id,
        session_id AS "sessionId",
        reconciled_by AS "reconciledBy",
        expected_amount AS "expectedAmount",
        counted_amount AS "countedAmount",
        variance,
        CASE WHEN expected_amount = 0 THEN 0 ELSE (variance / expected_amount * 100) END AS "variancePercent",
        approved,
        approved_by AS "approvedBy",
        approved_at AS "approvedAt",
        reason,
        notes,
        denomination_breakdown AS "denominationBreakdown",
        created_at AS "createdAt"
    `, [
      data.sessionId,
      data.reconciledBy,
      data.expectedAmount,
      data.countedAmount,
      data.variance,
      data.reason || null,
      data.notes || null,
      data.denominationBreakdown ? JSON.stringify(data.denominationBreakdown) : null
    ]);
    return result.rows[0];
  },

  /**
   * Approve a reconciliation
   */
  async approveReconciliation(
    pool: Pool | PoolClient,
    reconciliationId: string,
    approvedBy: string
  ): Promise<CashReconciliation> {
    const result = await pool.query(`
      UPDATE cash_register_reconciliations
      SET approved = true, approved_by = $2, approved_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        session_id AS "sessionId",
        reconciled_by AS "reconciledBy",
        expected_amount AS "expectedAmount",
        counted_amount AS "countedAmount",
        variance,
        CASE WHEN expected_amount = 0 THEN 0 ELSE (variance / expected_amount * 100) END AS "variancePercent",
        approved,
        approved_by AS "approvedBy",
        approved_at AS "approvedAt",
        reason,
        notes,
        denomination_breakdown AS "denominationBreakdown",
        created_at AS "createdAt"
    `, [reconciliationId, approvedBy]);
    return result.rows[0];
  },

  /**
   * Get reconciliation history for a session
   */
  async getSessionReconciliations(
    pool: Pool | PoolClient,
    sessionId: string
  ): Promise<CashReconciliation[]> {
    const result = await pool.query(`
      SELECT
        r.id,
        r.session_id AS "sessionId",
        r.reconciled_by AS "reconciledBy",
        u.full_name AS "reconciledByName",
        r.expected_amount AS "expectedAmount",
        r.counted_amount AS "countedAmount",
        r.variance,
        CASE WHEN r.expected_amount = 0 THEN 0 ELSE (r.variance / r.expected_amount * 100) END AS "variancePercent",
        r.approved,
        r.approved_by AS "approvedBy",
        a.full_name AS "approvedByName",
        r.approved_at AS "approvedAt",
        r.reason,
        r.notes,
        r.denomination_breakdown AS "denominationBreakdown",
        r.created_at AS "createdAt"
      FROM cash_register_reconciliations r
      LEFT JOIN users u ON u.id = r.reconciled_by
      LEFT JOIN users a ON a.id = r.approved_by
      WHERE r.session_id = $1
      ORDER BY r.created_at DESC
    `, [sessionId]);
    return result.rows;
  },

  // ===========================================================================
  // Z-REPORT STORAGE (Enterprise Upgrade 3)
  // ===========================================================================

  /**
   * Save a Z-Report permanently
   */
  async saveZReport(
    pool: Pool | PoolClient,
    data: Omit<ZReportRecord, 'id' | 'reportNumber' | 'generatedAt'>
  ): Promise<ZReportRecord> {
    // Generate Z-report number in service layer (replaces fn_next_z_report_number())
    const year = getBusinessYear();
    const prefix = `ZRPT-${year}-`;
    const seqResult = await pool.query(
      `SELECT COALESCE(MAX(CAST(SPLIT_PART(report_number, '-', 3) AS INTEGER)), 0) + 1 AS next_num
       FROM z_reports WHERE report_number LIKE $1`,
      [`${prefix}%`]
    );
    const reportNumber = `${prefix}${String(seqResult.rows[0].next_num).padStart(4, '0')}`;

    const result = await pool.query(`
      INSERT INTO z_reports (
        session_id, report_number, register_name, cashier_name, cashier_id,
        opened_at, closed_at, opening_float, expected_closing, actual_closing,
        variance, variance_reason, total_sales, total_refunds,
        total_cash_in, total_cash_out, net_cash_flow, transaction_count,
        payment_summary, denomination_breakdown, movement_breakdown, generated_by
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17, $18,
        $19, $20, $21, $22
      )
      RETURNING
        id,
        session_id AS "sessionId",
        report_number AS "reportNumber",
        register_name AS "registerName",
        cashier_name AS "cashierName",
        cashier_id AS "cashierId",
        opened_at AS "openedAt",
        closed_at AS "closedAt",
        opening_float AS "openingFloat",
        expected_closing AS "expectedClosing",
        actual_closing AS "actualClosing",
        variance,
        variance_reason AS "varianceReason",
        total_sales AS "totalSales",
        total_refunds AS "totalRefunds",
        total_cash_in AS "totalCashIn",
        total_cash_out AS "totalCashOut",
        net_cash_flow AS "netCashFlow",
        transaction_count AS "transactionCount",
        payment_summary AS "paymentSummary",
        denomination_breakdown AS "denominationBreakdown",
        movement_breakdown AS "movementBreakdown",
        generated_by AS "generatedBy",
        generated_at AS "generatedAt"
    `, [
      data.sessionId, reportNumber, data.registerName, data.cashierName, data.cashierId,
      data.openedAt, data.closedAt, data.openingFloat, data.expectedClosing, data.actualClosing,
      data.variance, data.varianceReason, data.totalSales, data.totalRefunds,
      data.totalCashIn, data.totalCashOut, data.netCashFlow, data.transactionCount,
      data.paymentSummary ? JSON.stringify(data.paymentSummary) : null,
      data.denominationBreakdown ? JSON.stringify(data.denominationBreakdown) : null,
      data.movementBreakdown ? JSON.stringify(data.movementBreakdown) : null,
      data.generatedBy
    ]);
    return result.rows[0];
  },

  /**
   * Get Z-Report by session ID
   */
  async getZReportBySessionId(
    pool: Pool | PoolClient,
    sessionId: string
  ): Promise<ZReportRecord | null> {
    const result = await pool.query(`
      SELECT
        id,
        session_id AS "sessionId",
        report_number AS "reportNumber",
        register_name AS "registerName",
        cashier_name AS "cashierName",
        cashier_id AS "cashierId",
        opened_at AS "openedAt",
        closed_at AS "closedAt",
        opening_float AS "openingFloat",
        expected_closing AS "expectedClosing",
        actual_closing AS "actualClosing",
        variance,
        variance_reason AS "varianceReason",
        total_sales AS "totalSales",
        total_refunds AS "totalRefunds",
        total_cash_in AS "totalCashIn",
        total_cash_out AS "totalCashOut",
        net_cash_flow AS "netCashFlow",
        transaction_count AS "transactionCount",
        payment_summary AS "paymentSummary",
        denomination_breakdown AS "denominationBreakdown",
        movement_breakdown AS "movementBreakdown",
        generated_by AS "generatedBy",
        generated_at AS "generatedAt"
      FROM z_reports
      WHERE session_id = $1
      ORDER BY generated_at DESC
      LIMIT 1
    `, [sessionId]);
    return result.rows[0] || null;
  },

  /**
   * Get Z-Reports with date range filter (for register or all)
   */
  async getZReports(
    pool: Pool | PoolClient,
    filters?: { startDate?: string; endDate?: string; registerId?: string; limit?: number; offset?: number }
  ): Promise<{ reports: ZReportRecord[]; total: number }> {
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    let paramIndex = 1;

    if (filters?.startDate) {
      conditions.push(`z.generated_at >= $${paramIndex++}`);
      values.push(filters.startDate);
    }
    if (filters?.endDate) {
      conditions.push(`z.generated_at <= $${paramIndex++}`);
      values.push(filters.endDate);
    }
    if (filters?.registerId) {
      conditions.push(`s.register_id = $${paramIndex++}`);
      values.push(filters.registerId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters?.limit || 50;
    const offset = filters?.offset || 0;

    const [countResult, dataResult] = await Promise.all([
      pool.query(`
        SELECT COUNT(*) AS total
        FROM z_reports z
        JOIN cash_register_sessions s ON s.id = z.session_id
        ${whereClause}
      `, values),
      pool.query(`
        SELECT
          z.id,
          z.session_id AS "sessionId",
          z.report_number AS "reportNumber",
          z.register_name AS "registerName",
          z.cashier_name AS "cashierName",
          z.cashier_id AS "cashierId",
          z.opened_at AS "openedAt",
          z.closed_at AS "closedAt",
          z.opening_float AS "openingFloat",
          z.expected_closing AS "expectedClosing",
          z.actual_closing AS "actualClosing",
          z.variance,
          z.variance_reason AS "varianceReason",
          z.total_sales AS "totalSales",
          z.total_refunds AS "totalRefunds",
          z.total_cash_in AS "totalCashIn",
          z.total_cash_out AS "totalCashOut",
          z.net_cash_flow AS "netCashFlow",
          z.transaction_count AS "transactionCount",
          z.payment_summary AS "paymentSummary",
          z.denomination_breakdown AS "denominationBreakdown",
          z.movement_breakdown AS "movementBreakdown",
          z.generated_by AS "generatedBy",
          z.generated_at AS "generatedAt"
        FROM z_reports z
        JOIN cash_register_sessions s ON s.id = z.session_id
        ${whereClause}
        ORDER BY z.generated_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex}
      `, [...values, limit, offset])
    ]);

    return {
      reports: dataResult.rows,
      total: parseInt(countResult.rows[0].total, 10)
    };
  },

  // ===========================================================================
  // OFFLINE SAFETY (Enterprise Upgrade 4)
  // ===========================================================================

  /**
   * Check if a movement already exists by clientUuid (offline dedup)
   */
  async getMovementByClientUuid(
    pool: Pool | PoolClient,
    clientUuid: string
  ): Promise<CashMovement | null> {
    const result = await pool.query(`
      SELECT
        id,
        session_id AS "sessionId",
        user_id AS "userId",
        movement_type AS "movementType",
        amount,
        reason,
        reference_type AS "referenceType",
        reference_id AS "referenceId",
        approved_by AS "approvedBy",
        payment_method AS "paymentMethod",
        metadata,
        client_uuid AS "clientUuid",
        sync_status AS "syncStatus",
        created_at AS "createdAt"
      FROM cash_movements
      WHERE client_uuid = $1
    `, [clientUuid]);
    return result.rows[0] || null;
  }
};
