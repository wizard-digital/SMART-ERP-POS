import type { Pool, PoolClient } from 'pg';
import { BUSINESS_TIMEZONE, toUtcRange } from '../../utils/dateRange.js';
import { Money } from '../../utils/money.js';
import type {
  SalesTargetPeriodType,
  SalesTargetRow,
  SalesTargetScope,
  SalesTargetStatus,
  SalesTargetTeamRow,
} from './salesTargetTypes.js';

type Db = Pool | PoolClient;

/** Bank-grade 2dp — same Money SSOT as achievement service (no ad-hoc Math.round). */
function money(n: unknown): number {
  if (n == null || n === '') return 0;
  if (typeof n === 'number' || typeof n === 'string') {
    return Money.toNumber(Money.round(n, 2));
  }
  // pg may return Decimal-like / stringable values
  return Money.toNumber(Money.round(String(n), 2));
}

function mapRow(r: Record<string, unknown>): SalesTargetRow {
  return {
    id: String(r.id),
    scope: String(r.scope || 'INDIVIDUAL') as SalesTargetScope,
    salespersonId: r.salesperson_id != null ? String(r.salesperson_id) : null,
    salespersonName: r.salesperson_name != null ? String(r.salesperson_name) : null,
    teamId: r.team_id != null ? String(r.team_id) : null,
    teamName: r.team_name != null ? String(r.team_name) : null,
    periodType: String(r.period_type) as SalesTargetPeriodType,
    periodStart: String(r.period_start).slice(0, 10),
    periodEnd: String(r.period_end).slice(0, 10),
    targetAmount: money(r.target_amount),
    status: String(r.status) as SalesTargetStatus,
    createdBy: String(r.created_by),
    createdByName: r.created_by_name != null ? String(r.created_by_name) : null,
    approvedBy: r.approved_by != null ? String(r.approved_by) : null,
    approvedByName: r.approved_by_name != null ? String(r.approved_by_name) : null,
    approvedAt: r.approved_at != null ? String(r.approved_at) : null,
    closedBy: r.closed_by != null ? String(r.closed_by) : null,
    closedAt: r.closed_at != null ? String(r.closed_at) : null,
    cancelledBy: r.cancelled_by != null ? String(r.cancelled_by) : null,
    cancelledAt: r.cancelled_at != null ? String(r.cancelled_at) : null,
    amendmentReason: r.amendment_reason != null ? String(r.amendment_reason) : null,
    cancelReason: r.cancel_reason != null ? String(r.cancel_reason) : null,
    notes: r.notes != null ? String(r.notes) : null,
    rowVersion: Number(r.row_version),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

const SELECT_TARGET = `
  SELECT
    t.id,
    t.scope,
    t.salesperson_id,
    COALESCE(sp.full_name, sp.email) AS salesperson_name,
    t.team_id,
    tm.name AS team_name,
    t.period_type,
    t.period_start::text AS period_start,
    t.period_end::text AS period_end,
    t.target_amount,
    t.status,
    t.created_by,
    COALESCE(cb.full_name, cb.email) AS created_by_name,
    t.approved_by,
    COALESCE(ab.full_name, ab.email) AS approved_by_name,
    t.approved_at,
    t.closed_by,
    t.closed_at,
    t.cancelled_by,
    t.cancelled_at,
    t.amendment_reason,
    t.cancel_reason,
    t.notes,
    t.row_version,
    t.created_at,
    t.updated_at
  FROM sales_targets t
  LEFT JOIN users sp ON sp.id = t.salesperson_id
  LEFT JOIN sales_target_teams tm ON tm.id = t.team_id
  LEFT JOIN users cb ON cb.id = t.created_by
  LEFT JOIN users ab ON ab.id = t.approved_by
`;

export const salesTargetRepository = {
  async userExists(db: Db, userId: string): Promise<boolean> {
    const res = await db.query(`SELECT 1 FROM users WHERE id = $1 LIMIT 1`, [userId]);
    return res.rows.length > 0;
  },

  async findById(db: Db, id: string): Promise<SalesTargetRow | null> {
    const res = await db.query(`${SELECT_TARGET} WHERE t.id = $1`, [id]);
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  },

  async findByIdForUpdate(db: PoolClient, id: string): Promise<SalesTargetRow | null> {
    const locked = await db.query(
      `SELECT id FROM sales_targets WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!locked.rows[0]) return null;
    return this.findById(db, id);
  },

  async list(
    db: Db,
    filters: {
      status?: SalesTargetStatus;
      scope?: SalesTargetScope;
      salespersonId?: string;
      teamId?: string;
      periodStart?: string;
      periodEnd?: string;
      /** Cashier visibility: own INDIVIDUAL + TEAM membership + GENERAL */
      visibleToUserId?: string;
      restrictToSalespersonId?: string;
      page: number;
      limit: number;
    },
  ): Promise<{ rows: SalesTargetRow[]; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (filters.visibleToUserId) {
      where.push(`(
        (t.scope = 'INDIVIDUAL' AND t.salesperson_id = $${i})
        OR t.scope = 'GENERAL'
        OR (t.scope = 'TEAM' AND EXISTS (
          SELECT 1 FROM sales_target_team_members m
          WHERE m.team_id = t.team_id AND m.user_id = $${i}
        ))
      )`);
      values.push(filters.visibleToUserId);
      i++;
    } else if (filters.restrictToSalespersonId) {
      where.push(`t.salesperson_id = $${i++}`);
      values.push(filters.restrictToSalespersonId);
    }
    if (filters.salespersonId) {
      where.push(`t.salesperson_id = $${i++}`);
      values.push(filters.salespersonId);
    }
    if (filters.teamId) {
      where.push(`t.team_id = $${i++}`);
      values.push(filters.teamId);
    }
    if (filters.scope) {
      where.push(`t.scope = $${i++}`);
      values.push(filters.scope);
    }
    if (filters.status) {
      where.push(`t.status = $${i++}`);
      values.push(filters.status);
    }
    if (filters.periodStart) {
      where.push(`t.period_end >= $${i++}::date`);
      values.push(filters.periodStart);
    }
    if (filters.periodEnd) {
      where.push(`t.period_start <= $${i++}::date`);
      values.push(filters.periodEnd);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM sales_targets t ${whereSql}`,
      values,
    );
    const total = Number(countRes.rows[0]?.total ?? 0);

    const offset = (filters.page - 1) * filters.limit;
    const listRes = await db.query(
      `${SELECT_TARGET}
       ${whereSql}
       ORDER BY t.period_start DESC, t.created_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      [...values, filters.limit, offset],
    );

    return { rows: listRes.rows.map(mapRow), total };
  },

  /**
   * Live targets (PENDING_APPROVAL / ACTIVE) whose period overlaps [start, end]
   * within the same scope key (salesperson / team / GENERAL).
   */
  async findOverlappingLive(
    db: Db,
    opts: {
      scope: SalesTargetScope;
      salespersonId?: string | null;
      teamId?: string | null;
      periodStart: string;
      periodEnd: string;
      excludeId?: string;
    },
  ): Promise<SalesTargetRow[]> {
    const values: unknown[] = [opts.periodStart, opts.periodEnd];
    let keySql = '';
    if (opts.scope === 'INDIVIDUAL') {
      values.push(opts.salespersonId);
      keySql = `AND t.scope = 'INDIVIDUAL' AND t.salesperson_id = $3`;
    } else if (opts.scope === 'TEAM') {
      values.push(opts.teamId);
      keySql = `AND t.scope = 'TEAM' AND t.team_id = $3`;
    } else {
      keySql = `AND t.scope = 'GENERAL'`;
    }
    let excludeSql = '';
    if (opts.excludeId) {
      values.push(opts.excludeId);
      excludeSql = `AND t.id <> $${values.length}`;
    }
    const lockRes = await db.query(
      `SELECT id FROM sales_targets t
       WHERE t.status IN ('PENDING_APPROVAL', 'ACTIVE')
         AND t.period_start <= $2::date
         AND t.period_end >= $1::date
         ${keySql}
         ${excludeSql}
       FOR UPDATE`,
      values,
    );
    if (lockRes.rows.length === 0) return [];
    const ids = lockRes.rows.map((r) => String(r.id));
    const res = await db.query(`${SELECT_TARGET} WHERE t.id = ANY($1::uuid[])`, [ids]);
    return res.rows.map(mapRow);
  },

  async insert(
    db: Db,
    data: {
      scope: SalesTargetScope;
      salespersonId?: string | null;
      teamId?: string | null;
      periodType: SalesTargetPeriodType;
      periodStart: string;
      periodEnd: string;
      targetAmount: number;
      status: SalesTargetStatus;
      createdBy: string;
      notes?: string | null;
    },
  ): Promise<SalesTargetRow> {
    const res = await db.query(
      `INSERT INTO sales_targets (
         scope, salesperson_id, team_id, period_type, period_start, period_end,
         target_amount, status, created_by, notes
       ) VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10)
       RETURNING id`,
      [
        data.scope,
        data.salespersonId ?? null,
        data.teamId ?? null,
        data.periodType,
        data.periodStart,
        data.periodEnd,
        data.targetAmount,
        data.status,
        data.createdBy,
        data.notes ?? null,
      ],
    );
    const created = await this.findById(db, String(res.rows[0].id));
    if (!created) throw new Error('Failed to load created sales target');
    return created;
  },

  async listTeamMemberIds(db: Db, teamId: string): Promise<string[]> {
    const res = await db.query(
      `SELECT user_id::text AS user_id FROM sales_target_team_members WHERE team_id = $1`,
      [teamId],
    );
    return res.rows.map((r) => String(r.user_id));
  },

  async isTeamMember(db: Db, teamId: string, userId: string): Promise<boolean> {
    const res = await db.query(
      `SELECT 1 FROM sales_target_team_members WHERE team_id = $1 AND user_id = $2 LIMIT 1`,
      [teamId, userId],
    );
    return res.rows.length > 0;
  },

  async listTeams(db: Db): Promise<SalesTargetTeamRow[]> {
    const teams = await db.query(
      `SELECT id, name, is_active, created_by, created_at, updated_at
       FROM sales_target_teams
       ORDER BY name ASC`,
    );
    const out: SalesTargetTeamRow[] = [];
    for (const t of teams.rows) {
      const members = await db.query(
        `SELECT m.user_id::text AS user_id,
                COALESCE(u.full_name, u.email) AS user_name
         FROM sales_target_team_members m
         LEFT JOIN users u ON u.id = m.user_id
         WHERE m.team_id = $1
         ORDER BY user_name ASC`,
        [t.id],
      );
      out.push({
        id: String(t.id),
        name: String(t.name),
        isActive: Boolean(t.is_active),
        memberIds: members.rows.map((r) => String(r.user_id)),
        memberNames: members.rows.map((r) => String(r.user_name || r.user_id)),
        createdBy: String(t.created_by),
        createdAt: String(t.created_at),
        updatedAt: String(t.updated_at),
      });
    }
    return out;
  },

  async createTeam(
    db: Db,
    data: { name: string; memberIds: string[]; createdBy: string },
  ): Promise<SalesTargetTeamRow> {
    const res = await db.query(
      `INSERT INTO sales_target_teams (name, created_by)
       VALUES (btrim($1), $2)
       RETURNING id`,
      [data.name, data.createdBy],
    );
    const teamId = String(res.rows[0].id);
    for (const uid of data.memberIds) {
      await db.query(
        `INSERT INTO sales_target_team_members (team_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [teamId, uid],
      );
    }
    const listed = await this.listTeams(db);
    const created = listed.find((t) => t.id === teamId);
    if (!created) throw new Error('Failed to load created team');
    return created;
  },

  async updateTeam(
    db: Db,
    teamId: string,
    patch: { name?: string; memberIds?: string[]; isActive?: boolean },
  ): Promise<SalesTargetTeamRow | null> {
    const exists = await db.query(`SELECT id FROM sales_target_teams WHERE id = $1`, [teamId]);
    if (!exists.rows[0]) return null;
    if (patch.name !== undefined || patch.isActive !== undefined) {
      await db.query(
        `UPDATE sales_target_teams SET
           name = COALESCE(btrim($2), name),
           is_active = COALESCE($3, is_active),
           updated_at = NOW()
         WHERE id = $1`,
        [teamId, patch.name ?? null, patch.isActive ?? null],
      );
    }
    if (patch.memberIds) {
      await db.query(`DELETE FROM sales_target_team_members WHERE team_id = $1`, [teamId]);
      for (const uid of patch.memberIds) {
        await db.query(
          `INSERT INTO sales_target_team_members (team_id, user_id) VALUES ($1, $2)`,
          [teamId, uid],
        );
      }
    }
    const listed = await this.listTeams(db);
    return listed.find((t) => t.id === teamId) ?? null;
  },

  async updateDraft(
    db: Db,
    id: string,
    rowVersion: number,
    patch: {
      salespersonId?: string;
      periodType?: SalesTargetPeriodType;
      periodStart?: string;
      periodEnd?: string;
      targetAmount?: number;
      notes?: string | null;
    },
  ): Promise<SalesTargetRow | null> {
    const res = await db.query(
      `UPDATE sales_targets SET
         salesperson_id = COALESCE($3, salesperson_id),
         period_type = COALESCE($4, period_type),
         period_start = COALESCE($5::date, period_start),
         period_end = COALESCE($6::date, period_end),
         target_amount = COALESCE($7, target_amount),
         notes = CASE WHEN $8::boolean THEN $9 ELSE notes END,
         row_version = row_version + 1,
         updated_at = NOW()
       WHERE id = $1
         AND row_version = $2
         AND status = 'DRAFT'
       RETURNING id`,
      [
        id,
        rowVersion,
        patch.salespersonId ?? null,
        patch.periodType ?? null,
        patch.periodStart ?? null,
        patch.periodEnd ?? null,
        patch.targetAmount ?? null,
        patch.notes !== undefined,
        patch.notes ?? null,
      ],
    );
    if (!res.rows[0]) return null;
    return this.findById(db, id);
  },

  async updateStatus(
    db: Db,
    id: string,
    rowVersion: number,
    expectedStatus: SalesTargetStatus | SalesTargetStatus[],
    next: {
      status: SalesTargetStatus;
      approvedBy?: string | null;
      approvedAt?: boolean;
      closedBy?: string | null;
      closedAt?: boolean;
      cancelledBy?: string | null;
      cancelledAt?: boolean;
      amendmentReason?: string | null;
      cancelReason?: string | null;
      targetAmount?: number;
      periodStart?: string;
      periodEnd?: string;
    },
  ): Promise<SalesTargetRow | null> {
    const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    const res = await db.query(
      `UPDATE sales_targets SET
         status = $3,
         approved_by = CASE WHEN $4::boolean THEN $5 ELSE approved_by END,
         approved_at = CASE WHEN $6::boolean THEN NOW() ELSE approved_at END,
         closed_by = CASE WHEN $7::boolean THEN $8 ELSE closed_by END,
         closed_at = CASE WHEN $9::boolean THEN NOW() ELSE closed_at END,
         cancelled_by = CASE WHEN $10::boolean THEN $11 ELSE cancelled_by END,
         cancelled_at = CASE WHEN $12::boolean THEN NOW() ELSE cancelled_at END,
         amendment_reason = CASE WHEN $13::boolean THEN $14 ELSE amendment_reason END,
         cancel_reason = CASE WHEN $15::boolean THEN $16 ELSE cancel_reason END,
         target_amount = COALESCE($17, target_amount),
         period_start = COALESCE($18::date, period_start),
         period_end = COALESCE($19::date, period_end),
         row_version = row_version + 1,
         updated_at = NOW()
       WHERE id = $1
         AND row_version = $2
         AND status = ANY($20::text[])
       RETURNING id`,
      [
        id,
        rowVersion,
        next.status,
        next.approvedBy !== undefined,
        next.approvedBy ?? null,
        next.approvedAt === true,
        next.closedBy !== undefined,
        next.closedBy ?? null,
        next.closedAt === true,
        next.cancelledBy !== undefined,
        next.cancelledBy ?? null,
        next.cancelledAt === true,
        next.amendmentReason !== undefined,
        next.amendmentReason ?? null,
        next.cancelReason !== undefined,
        next.cancelReason ?? null,
        next.targetAmount ?? null,
        next.periodStart ?? null,
        next.periodEnd ?? null,
        statuses,
      ],
    );
    if (!res.rows[0]) return null;
    return this.findById(db, id);
  },

  /**
   * Authoritative achievement aggregates for one salesperson + period.
   * Sales revenue: subtotal - discount_amount (excl VAT).
   * Refunds: COMPLETED sale_refunds scaled to pretax sale revenue via line gross.
   * VOID excluded; VOIDED_BY_RETURN included so sale+refund nets correctly by event date.
   */
  /**
   * @param cashierFilter 'ALL' = GENERAL (any cashier); string[] = INDIVIDUAL/TEAM
   */
  async computeAchievementTotals(
    db: Db,
    cashierFilter: 'ALL' | string[],
    periodStart: string,
    periodEnd: string,
  ): Promise<{
    eligibleSalesRevenue: number;
    eligibleSalesCount: number;
    refundsExclVat: number;
    refundCount: number;
  }> {
    if (cashierFilter !== 'ALL' && cashierFilter.length === 0) {
      return {
        eligibleSalesRevenue: 0,
        eligibleSalesCount: 0,
        refundsExclVat: 0,
        refundCount: 0,
      };
    }

    // sale_date is timestamptz — bound with business-calendar UTC range (Kampala SSOT).
    // refund_date is DATE (business calendar) — compare as calendar dates.
    const { startUtc, endUtc } = toUtcRange(periodStart, periodEnd, BUSINESS_TIMEZONE);
    const salesParams =
      cashierFilter === 'ALL'
        ? [startUtc, endUtc]
        : [startUtc, endUtc, cashierFilter];
    // Param positions differ when cashier filter present — keep stable $1/$2 range + optional $3
    const salesRes = await db.query(
      `SELECT
         COALESCE(SUM(GREATEST(s.subtotal - s.discount_amount, 0)), 0) AS revenue,
         COUNT(*)::int AS cnt
       FROM sales s
       WHERE s.sale_date >= $1::timestamptz
         AND s.sale_date < $2::timestamptz
         AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'VOIDED_BY_RETURN')
         ${cashierFilter === 'ALL' ? '' : 'AND s.cashier_id = ANY($3::uuid[])'}`,
      salesParams,
    );

    const refundParams =
      cashierFilter === 'ALL'
        ? [periodStart, periodEnd]
        : [periodStart, periodEnd, cashierFilter];
    const refundRes = await db.query(
      `SELECT
         COALESCE(SUM(
           CASE
             WHEN lg.line_gross > 0 THEN
               r.total_amount * GREATEST(s.subtotal - s.discount_amount, 0) / lg.line_gross
             WHEN s.total_amount > 0 THEN
               r.total_amount * GREATEST(s.total_amount - COALESCE(s.tax_amount, 0), 0) / s.total_amount
             ELSE 0
           END
         ), 0) AS refunds_excl,
         COUNT(*)::int AS cnt
       FROM sale_refunds r
       INNER JOIN sales s ON s.id = r.sale_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(si.total_price), 0) AS line_gross
         FROM sale_items si
         WHERE si.sale_id = s.id
       ) lg ON TRUE
       WHERE r.status = 'COMPLETED'
         AND r.refund_date >= $1::date
         AND r.refund_date <= $2::date
         ${cashierFilter === 'ALL' ? '' : 'AND s.cashier_id = ANY($3::uuid[])'}`,
      refundParams,
    );

    return {
      eligibleSalesRevenue: money(salesRes.rows[0]?.revenue),
      eligibleSalesCount: Number(salesRes.rows[0]?.cnt ?? 0),
      refundsExclVat: money(refundRes.rows[0]?.refunds_excl),
      refundCount: Number(refundRes.rows[0]?.cnt ?? 0),
    };
  },

  async listAchievementSales(
    db: Db,
    cashierFilter: 'ALL' | string[],
    periodStart: string,
    periodEnd: string,
  ): Promise<
    Array<{
      saleId: string;
      saleNumber: string;
      saleDate: string;
      status: string;
      revenueExclVat: number;
      idempotencyKey: string | null;
    }>
  > {
    if (cashierFilter !== 'ALL' && cashierFilter.length === 0) return [];
    const { startUtc, endUtc } = toUtcRange(periodStart, periodEnd, BUSINESS_TIMEZONE);
    const params =
      cashierFilter === 'ALL'
        ? [startUtc, endUtc]
        : [startUtc, endUtc, cashierFilter];
    const res = await db.query(
      `SELECT
         s.id AS sale_id,
         s.sale_number,
         (s.sale_date AT TIME ZONE 'Africa/Kampala')::date::text AS sale_date,
         s.status::text AS status,
         GREATEST(s.subtotal - s.discount_amount, 0) AS revenue_excl_vat,
         s.idempotency_key
       FROM sales s
       WHERE s.sale_date >= $1::timestamptz
         AND s.sale_date < $2::timestamptz
         AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'VOIDED_BY_RETURN')
         ${cashierFilter === 'ALL' ? '' : 'AND s.cashier_id = ANY($3::uuid[])'}
       ORDER BY s.sale_date ASC, s.sale_number ASC`,
      params,
    );
    return res.rows.map((r) => ({
      saleId: String(r.sale_id),
      saleNumber: String(r.sale_number),
      saleDate: String(r.sale_date).slice(0, 10),
      status: String(r.status),
      revenueExclVat: money(r.revenue_excl_vat),
      idempotencyKey: r.idempotency_key != null ? String(r.idempotency_key) : null,
    }));
  },

  async listAchievementRefunds(
    db: Db,
    cashierFilter: 'ALL' | string[],
    periodStart: string,
    periodEnd: string,
  ): Promise<
    Array<{
      refundId: string;
      refundNumber: string;
      refundDate: string;
      saleId: string;
      saleNumber: string;
      refundGross: number;
      refundExclVat: number;
    }>
  > {
    if (cashierFilter !== 'ALL' && cashierFilter.length === 0) return [];
    const params =
      cashierFilter === 'ALL'
        ? [periodStart, periodEnd]
        : [periodStart, periodEnd, cashierFilter];
    const res = await db.query(
      `SELECT
         r.id AS refund_id,
         r.refund_number,
         r.refund_date::text AS refund_date,
         s.id AS sale_id,
         s.sale_number,
         r.total_amount AS refund_gross,
         CASE
           WHEN lg.line_gross > 0 THEN
             r.total_amount * GREATEST(s.subtotal - s.discount_amount, 0) / lg.line_gross
           WHEN s.total_amount > 0 THEN
             r.total_amount * GREATEST(s.total_amount - COALESCE(s.tax_amount, 0), 0) / s.total_amount
           ELSE 0
         END AS refund_excl_vat
       FROM sale_refunds r
       INNER JOIN sales s ON s.id = r.sale_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(si.total_price), 0) AS line_gross
         FROM sale_items si
         WHERE si.sale_id = s.id
       ) lg ON TRUE
       WHERE r.status = 'COMPLETED'
         AND r.refund_date >= $1::date
         AND r.refund_date <= $2::date
         ${cashierFilter === 'ALL' ? '' : 'AND s.cashier_id = ANY($3::uuid[])'}
       ORDER BY r.refund_date ASC, r.refund_number ASC`,
      params,
    );
    return res.rows.map((r) => ({
      refundId: String(r.refund_id),
      refundNumber: String(r.refund_number),
      refundDate: String(r.refund_date).slice(0, 10),
      saleId: String(r.sale_id),
      saleNumber: String(r.sale_number),
      refundGross: money(r.refund_gross),
      refundExclVat: money(r.refund_excl_vat),
    }));
  },

  /**
   * GL net sales (4000 CR − 4010 DR) for optional reconciliation note.
   * Not cashier-scoped (GL lines are not attributed to cashier).
   */
  async glNetSalesForPeriod(
    db: Db,
    periodStart: string,
    periodEnd: string,
  ): Promise<{ sales4000: number; returns4010: number; net: number } | null> {
    try {
      const res = await db.query(
        `SELECT
           COALESCE((
             SELECT SUM(le."CreditAmount")
             FROM ledger_transactions lt
             JOIN ledger_entries le ON le."TransactionId" = lt."Id"
             JOIN accounts a ON a."Id" = le."AccountId"
             WHERE a."AccountCode" = '4000'
               AND lt."Status" = 'POSTED'
               AND lt."IsReversed" = false
               AND lt."TransactionDate" >= $1::date
               AND lt."TransactionDate" <= $2::date
           ), 0) AS sales_4000,
           COALESCE((
             SELECT SUM(le."DebitAmount")
             FROM ledger_transactions lt
             JOIN ledger_entries le ON le."TransactionId" = lt."Id"
             JOIN accounts a ON a."Id" = le."AccountId"
             WHERE a."AccountCode" = '4010'
               AND lt."Status" = 'POSTED'
               AND lt."IsReversed" = false
               AND lt."TransactionDate" >= $1::date
               AND lt."TransactionDate" <= $2::date
           ), 0) AS returns_4010`,
        [periodStart, periodEnd],
      );
      const sales4000 = money(res.rows[0]?.sales_4000);
      const returns4010 = money(res.rows[0]?.returns_4010);
      return { sales4000, returns4010, net: money(sales4000 - returns4010) };
    } catch {
      return null;
    }
  },
};
