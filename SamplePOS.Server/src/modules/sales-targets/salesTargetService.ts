import type { Pool, PoolClient } from 'pg';
import { BusinessError } from '../../middleware/errorHandler.js';
import { getBusinessDate } from '../../utils/dateRange.js';
import { createAuditEntry } from '../audit/auditRepository.js';
import {
  calculateTargetAchievement,
  getTargetAchievementBreakdown,
} from './salesTargetAchievementService.js';
import { salesTargetRepository } from './salesTargetRepository.js';
import type {
  AchievementBreakdown,
  SalesTargetAchievement,
  SalesTargetPeriodType,
  SalesTargetRow,
  SalesTargetScope,
  SalesTargetStatus,
  SalesTargetTeamRow,
} from './salesTargetTypes.js';

export interface ActorContext {
  userId: string;
  userName?: string | null;
  userRole?: string | null;
  permissionKeys: string[];
  ipAddress?: string | null;
  userAgent?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
}

function hasPerm(actor: ActorContext, key: string): boolean {
  return actor.permissionKeys.includes(key);
}

function canManageAll(actor: ActorContext): boolean {
  return hasPerm(actor, 'targets.manage');
}

function canApprove(actor: ActorContext): boolean {
  return hasPerm(actor, 'targets.approve');
}

function canReadAll(actor: ActorContext): boolean {
  return hasPerm(actor, 'targets.manage') || hasPerm(actor, 'targets.approve');
}

/** Tenant ADMIN may self-approve (sole operator). Managers keep SoD. */
function isTenantAdmin(actor: ActorContext): boolean {
  const role = String(actor.userRole || '').toUpperCase();
  return role === 'ADMIN' || role === 'SUPER_ADMIN';
}

async function assertCanViewTarget(
  db: Pool | PoolClient,
  actor: ActorContext,
  target: SalesTargetRow,
): Promise<void> {
  if (canReadAll(actor)) return;
  if (!hasPerm(actor, 'targets.read')) {
    throw new BusinessError('Not authorized to view this sales target', 'ERR_TARGETS_FORBIDDEN', {
      targetId: target.id,
    });
  }
  if (target.scope === 'GENERAL') return;
  if (target.scope === 'INDIVIDUAL' && target.salespersonId === actor.userId) return;
  if (
    target.scope === 'TEAM' &&
    target.teamId &&
    (await salesTargetRepository.isTeamMember(db, target.teamId, actor.userId))
  ) {
    return;
  }
  throw new BusinessError('Not authorized to view this sales target', 'ERR_TARGETS_FORBIDDEN', {
    targetId: target.id,
  });
}

async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

async function audit(
  db: Pool | PoolClient,
  actor: ActorContext,
  action: 'CREATE' | 'UPDATE' | 'APPROVE' | 'CANCEL' | 'STATUS_CHANGE',
  target: SalesTargetRow,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await createAuditEntry(db, {
      // audit_log CHECK may not yet list SALES_TARGET on all tenants; SYSTEM + details is durable.
      entityType: 'SYSTEM',
      entityId: target.id,
      action,
      actionDetails: details
        ? JSON.stringify({ entity: 'SALES_TARGET', ...details })
        : JSON.stringify({ entity: 'SALES_TARGET', action }),
      userId: actor.userId,
      userName: actor.userName ?? undefined,
      userRole: actor.userRole ?? undefined,
      newValues: {
        status: target.status,
        salespersonId: target.salespersonId,
        targetAmount: target.targetAmount,
        periodStart: target.periodStart,
        periodEnd: target.periodEnd,
        rowVersion: target.rowVersion,
      },
      ipAddress: actor.ipAddress ?? undefined,
      userAgent: actor.userAgent ?? undefined,
      sessionId: actor.sessionId ?? undefined,
      requestId: actor.requestId ?? undefined,
      category: 'FINANCIAL',
      severity: 'INFO',
    });
  } catch {
    // non-fatal
  }
}

/** Serialize overlap checks per scope key — prevents concurrent duplicate live targets. */
async function lockScopeKey(
  db: Pool | PoolClient,
  opts: {
    scope: SalesTargetScope;
    salespersonId?: string | null;
    teamId?: string | null;
  },
): Promise<void> {
  const key =
    opts.scope === 'INDIVIDUAL'
      ? `sales_target:INDIVIDUAL:${opts.salespersonId || ''}`
      : opts.scope === 'TEAM'
        ? `sales_target:TEAM:${opts.teamId || ''}`
        : 'sales_target:GENERAL';
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [key]);
}

async function assertNoLiveOverlap(
  db: Pool | PoolClient,
  opts: {
    scope: SalesTargetScope;
    salespersonId?: string | null;
    teamId?: string | null;
    periodStart: string;
    periodEnd: string;
    excludeId?: string;
  },
): Promise<void> {
  await lockScopeKey(db, opts);
  const overlaps = await salesTargetRepository.findOverlappingLive(db, opts);
  if (overlaps.length > 0) {
    throw new BusinessError(
      'An active or pending target already overlaps this scope and period',
      'ERR_TARGETS_OVERLAP',
      {
        scope: opts.scope,
        salespersonId: opts.salespersonId,
        teamId: opts.teamId,
        periodStart: opts.periodStart,
        periodEnd: opts.periodEnd,
        conflictingTargetIds: overlaps.map((t) => t.id),
      },
    );
  }
}

function dedupeIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => String(id)))];
}

function concurrencyFail(): never {
  throw new BusinessError(
    'Target was modified by another user. Refresh and retry.',
    'ERR_TARGETS_CONFLICT',
  );
}

export const salesTargetService = {
  async create(
    pool: Pool,
    actor: ActorContext,
    input: {
      scope?: SalesTargetScope;
      salespersonId?: string | null;
      teamId?: string | null;
      periodType: SalesTargetPeriodType;
      periodStart: string;
      periodEnd: string;
      targetAmount: number;
      notes?: string | null;
      submit?: boolean;
    },
  ): Promise<SalesTargetRow> {
    if (!canManageAll(actor)) {
      throw new BusinessError('targets.manage required', 'ERR_TARGETS_FORBIDDEN');
    }

    const scope: SalesTargetScope = input.scope || 'INDIVIDUAL';

    return withTx(pool, async (client) => {
      if (scope === 'INDIVIDUAL') {
        if (!input.salespersonId) {
          throw new BusinessError('salespersonId required', 'ERR_TARGETS_SALESPERSON');
        }
        const exists = await salesTargetRepository.userExists(client, input.salespersonId);
        if (!exists) {
          throw new BusinessError('Salesperson not found in this tenant', 'ERR_TARGETS_SALESPERSON', {
            salespersonId: input.salespersonId,
          });
        }
      }
      if (scope === 'TEAM') {
        if (!input.teamId) {
          throw new BusinessError('teamId required for TEAM scope', 'ERR_TARGETS_TEAM');
        }
        const teamOk = await client.query(
          `SELECT is_active FROM sales_target_teams WHERE id = $1`,
          [input.teamId],
        );
        if (!teamOk.rows[0]) {
          throw new BusinessError('Team not found', 'ERR_TARGETS_TEAM', { teamId: input.teamId });
        }
        if (!teamOk.rows[0].is_active) {
          throw new BusinessError('Team is inactive', 'ERR_TARGETS_TEAM_INACTIVE', {
            teamId: input.teamId,
          });
        }
        const members = await salesTargetRepository.listTeamMemberIds(client, input.teamId);
        if (members.length === 0) {
          throw new BusinessError('Team has no members', 'ERR_TARGETS_TEAM_EMPTY', {
            teamId: input.teamId,
          });
        }
      }
      if (scope === 'GENERAL' && (input.salespersonId || input.teamId)) {
        throw new BusinessError(
          'GENERAL scope must not set salespersonId or teamId',
          'ERR_TARGETS_SCOPE_SHAPE',
        );
      }

      const status: SalesTargetStatus = input.submit ? 'PENDING_APPROVAL' : 'DRAFT';
      if (status === 'PENDING_APPROVAL') {
        await assertNoLiveOverlap(client, {
          scope,
          salespersonId: input.salespersonId,
          teamId: input.teamId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
        });
      }

      return salesTargetRepository.insert(client, {
        scope,
        salespersonId: scope === 'INDIVIDUAL' ? input.salespersonId : null,
        teamId: scope === 'TEAM' ? input.teamId : null,
        periodType: input.periodType,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        targetAmount: input.targetAmount,
        status,
        createdBy: actor.userId,
        notes: input.notes,
      });
    }).then(async (created) => {
      await audit(pool, actor, 'CREATE', created, {
        submitted: Boolean(input.submit),
        status: created.status,
        scope: created.scope,
      });
      return created;
    });
  },

  async list(
    pool: Pool,
    actor: ActorContext,
    query: {
      status?: SalesTargetStatus;
      scope?: SalesTargetScope;
      salespersonId?: string;
      teamId?: string;
      periodStart?: string;
      periodEnd?: string;
      page: number;
      limit: number;
    },
  ): Promise<{ rows: SalesTargetRow[]; total: number; page: number; limit: number }> {
    if (!hasPerm(actor, 'targets.read') && !canManageAll(actor) && !canApprove(actor)) {
      throw new BusinessError('targets.read required', 'ERR_TARGETS_FORBIDDEN');
    }

    if (!canReadAll(actor) && query.salespersonId && query.salespersonId !== actor.userId) {
      throw new BusinessError('Not authorized to list other salespeople targets', 'ERR_TARGETS_FORBIDDEN');
    }

    const result = await salesTargetRepository.list(pool, {
      ...query,
      visibleToUserId: canReadAll(actor) ? undefined : actor.userId,
    });
    return { ...result, page: query.page, limit: query.limit };
  },

  async getById(pool: Pool, actor: ActorContext, id: string): Promise<SalesTargetRow> {
    const target = await salesTargetRepository.findById(pool, id);
    if (!target) {
      throw new BusinessError('Sales target not found', 'ERR_TARGETS_NOT_FOUND', { id });
    }
    await assertCanViewTarget(pool, actor, target);
    return target;
  },

  async listTeams(pool: Pool, actor: ActorContext): Promise<SalesTargetTeamRow[]> {
    if (!hasPerm(actor, 'targets.read') && !canManageAll(actor) && !canApprove(actor)) {
      throw new BusinessError('targets.read required', 'ERR_TARGETS_FORBIDDEN');
    }
    return salesTargetRepository.listTeams(pool);
  },

  async createTeam(
    pool: Pool,
    actor: ActorContext,
    input: { name: string; memberIds: string[] },
  ): Promise<SalesTargetTeamRow> {
    if (!canManageAll(actor)) {
      throw new BusinessError('targets.manage required', 'ERR_TARGETS_FORBIDDEN');
    }
    const name = input.name.trim();
    const memberIds = dedupeIds(input.memberIds);
    if (!name || memberIds.length === 0) {
      throw new BusinessError('Team name and members required', 'ERR_TARGETS_TEAM');
    }
    for (const uid of memberIds) {
      if (!(await salesTargetRepository.userExists(pool, uid))) {
        throw new BusinessError('Team member not found', 'ERR_TARGETS_SALESPERSON', {
          salespersonId: uid,
        });
      }
    }
    try {
      return await salesTargetRepository.createTeam(pool, {
        name,
        memberIds,
        createdBy: actor.userId,
      });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === '23505') {
        throw new BusinessError('A team with this name already exists', 'ERR_TARGETS_TEAM_DUP');
      }
      throw err;
    }
  },

  async updateTeam(
    pool: Pool,
    actor: ActorContext,
    teamId: string,
    input: { name?: string; memberIds?: string[]; isActive?: boolean },
  ): Promise<SalesTargetTeamRow> {
    if (!canManageAll(actor)) {
      throw new BusinessError('targets.manage required', 'ERR_TARGETS_FORBIDDEN');
    }
    const patch = {
      ...input,
      name: input.name !== undefined ? input.name.trim() : undefined,
      memberIds: input.memberIds ? dedupeIds(input.memberIds) : undefined,
    };
    if (patch.memberIds) {
      if (patch.memberIds.length === 0) {
        throw new BusinessError('Team must keep at least one member', 'ERR_TARGETS_TEAM_EMPTY');
      }
      for (const uid of patch.memberIds) {
        if (!(await salesTargetRepository.userExists(pool, uid))) {
          throw new BusinessError('Team member not found', 'ERR_TARGETS_SALESPERSON', {
            salespersonId: uid,
          });
        }
      }
    }
    try {
      const updated = await salesTargetRepository.updateTeam(pool, teamId, patch);
      if (!updated) {
        throw new BusinessError('Team not found', 'ERR_TARGETS_TEAM', { teamId });
      }
      return updated;
    } catch (err) {
      if (err instanceof BusinessError) throw err;
      const code = (err as { code?: string })?.code;
      if (code === '23505') {
        throw new BusinessError('A team with this name already exists', 'ERR_TARGETS_TEAM_DUP');
      }
      throw err;
    }
  },

  async updateDraft(
    pool: Pool,
    actor: ActorContext,
    id: string,
    input: {
      salespersonId?: string;
      periodType?: SalesTargetPeriodType;
      periodStart?: string;
      periodEnd?: string;
      targetAmount?: number;
      notes?: string | null;
      rowVersion: number;
    },
  ): Promise<SalesTargetRow> {
    if (!canManageAll(actor)) {
      throw new BusinessError('targets.manage required', 'ERR_TARGETS_FORBIDDEN');
    }

    return withTx(pool, async (client) => {
      const existing = await salesTargetRepository.findByIdForUpdate(client, id);
      if (!existing) {
        throw new BusinessError('Sales target not found', 'ERR_TARGETS_NOT_FOUND', { id });
      }
      if (existing.status !== 'DRAFT') {
        throw new BusinessError('Only DRAFT targets can be edited', 'ERR_TARGETS_INVALID_STATUS', {
          status: existing.status,
        });
      }
      if (existing.rowVersion !== input.rowVersion) concurrencyFail();

      if (input.salespersonId) {
        const exists = await salesTargetRepository.userExists(client, input.salespersonId);
        if (!exists) {
          throw new BusinessError('Salesperson not found in this tenant', 'ERR_TARGETS_SALESPERSON');
        }
      }

      const updated = await salesTargetRepository.updateDraft(client, id, input.rowVersion, input);
      if (!updated) concurrencyFail();
      return updated;
    }).then(async (updated) => {
      await audit(pool, actor, 'UPDATE', updated);
      return updated;
    });
  },

  async submit(pool: Pool, actor: ActorContext, id: string, rowVersion: number): Promise<SalesTargetRow> {
    if (!canManageAll(actor)) {
      throw new BusinessError('targets.manage required', 'ERR_TARGETS_FORBIDDEN');
    }

    return withTx(pool, async (client) => {
      const existing = await salesTargetRepository.findByIdForUpdate(client, id);
      if (!existing) {
        throw new BusinessError('Sales target not found', 'ERR_TARGETS_NOT_FOUND', { id });
      }
      if (existing.status !== 'DRAFT') {
        throw new BusinessError('Only DRAFT targets can be submitted', 'ERR_TARGETS_INVALID_STATUS');
      }
      if (existing.rowVersion !== rowVersion) concurrencyFail();

      await assertNoLiveOverlap(client, {
        scope: existing.scope,
        salespersonId: existing.salespersonId,
        teamId: existing.teamId,
        periodStart: existing.periodStart,
        periodEnd: existing.periodEnd,
        excludeId: existing.id,
      });

      const updated = await salesTargetRepository.updateStatus(client, id, rowVersion, 'DRAFT', {
        status: 'PENDING_APPROVAL',
      });
      if (!updated) concurrencyFail();
      return updated;
    }).then(async (updated) => {
      await audit(pool, actor, 'STATUS_CHANGE', updated, { to: 'PENDING_APPROVAL' });
      return updated;
    });
  },

  async approve(pool: Pool, actor: ActorContext, id: string, rowVersion: number): Promise<SalesTargetRow> {
    if (!canApprove(actor)) {
      throw new BusinessError('targets.approve required', 'ERR_TARGETS_FORBIDDEN');
    }

    return withTx(pool, async (client) => {
      const existing = await salesTargetRepository.findByIdForUpdate(client, id);
      if (!existing) {
        throw new BusinessError('Sales target not found', 'ERR_TARGETS_NOT_FOUND', { id });
      }
      if (existing.status !== 'PENDING_APPROVAL') {
        throw new BusinessError('Only PENDING_APPROVAL targets can be approved', 'ERR_TARGETS_INVALID_STATUS');
      }
      if (existing.rowVersion !== rowVersion) concurrencyFail();
      // SoD: non-admin creators cannot approve their own draft. ADMIN/SUPER_ADMIN may
      // (single-operator tenants — matches absolute-admin expectation elsewhere).
      if (existing.createdBy === actor.userId && !isTenantAdmin(actor)) {
        throw new BusinessError(
          'Creator cannot approve their own target',
          'ERR_TARGETS_SELF_APPROVE',
        );
      }

      await assertNoLiveOverlap(client, {
        scope: existing.scope,
        salespersonId: existing.salespersonId,
        teamId: existing.teamId,
        periodStart: existing.periodStart,
        periodEnd: existing.periodEnd,
        excludeId: existing.id,
      });

      const updated = await salesTargetRepository.updateStatus(
        client,
        id,
        rowVersion,
        'PENDING_APPROVAL',
        {
          status: 'ACTIVE',
          approvedBy: actor.userId,
          approvedAt: true,
        },
      );
      if (!updated) concurrencyFail();
      return updated;
    }).then(async (updated) => {
      await audit(pool, actor, 'APPROVE', updated);
      return updated;
    });
  },

  async amend(
    pool: Pool,
    actor: ActorContext,
    id: string,
    input: {
      targetAmount: number;
      periodStart?: string;
      periodEnd?: string;
      amendmentReason: string;
      rowVersion: number;
    },
  ): Promise<SalesTargetRow> {
    if (!canManageAll(actor) && !canApprove(actor)) {
      throw new BusinessError('targets.manage or targets.approve required', 'ERR_TARGETS_FORBIDDEN');
    }

    return withTx(pool, async (client) => {
      const existing = await salesTargetRepository.findByIdForUpdate(client, id);
      if (!existing) {
        throw new BusinessError('Sales target not found', 'ERR_TARGETS_NOT_FOUND', { id });
      }
      if (existing.status !== 'ACTIVE') {
        throw new BusinessError('Only ACTIVE targets can be amended', 'ERR_TARGETS_INVALID_STATUS');
      }
      if (existing.rowVersion !== input.rowVersion) concurrencyFail();

      const nextStart = input.periodStart ?? existing.periodStart;
      const nextEnd = input.periodEnd ?? existing.periodEnd;
      if (nextEnd < nextStart) {
        throw new BusinessError('periodEnd must be on or after periodStart', 'ERR_TARGETS_PERIOD');
      }

      await assertNoLiveOverlap(client, {
        scope: existing.scope,
        salespersonId: existing.salespersonId,
        teamId: existing.teamId,
        periodStart: nextStart,
        periodEnd: nextEnd,
        excludeId: existing.id,
      });

      const updated = await salesTargetRepository.updateStatus(client, id, input.rowVersion, 'ACTIVE', {
        status: 'ACTIVE',
        targetAmount: input.targetAmount,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        amendmentReason: input.amendmentReason,
      });
      if (!updated) concurrencyFail();
      return updated;
    }).then(async (updated) => {
      await audit(pool, actor, 'UPDATE', updated, {
        reason: input.amendmentReason,
        amended: true,
      });
      return updated;
    });
  },

  async cancel(
    pool: Pool,
    actor: ActorContext,
    id: string,
    input: { reason: string; rowVersion: number },
  ): Promise<SalesTargetRow> {
    if (!canManageAll(actor) && !canApprove(actor)) {
      throw new BusinessError('targets.manage or targets.approve required', 'ERR_TARGETS_FORBIDDEN');
    }

    return withTx(pool, async (client) => {
      const existing = await salesTargetRepository.findByIdForUpdate(client, id);
      if (!existing) {
        throw new BusinessError('Sales target not found', 'ERR_TARGETS_NOT_FOUND', { id });
      }
      if (!['DRAFT', 'PENDING_APPROVAL', 'ACTIVE'].includes(existing.status)) {
        throw new BusinessError('Target cannot be cancelled in its current status', 'ERR_TARGETS_INVALID_STATUS');
      }
      if (existing.rowVersion !== input.rowVersion) concurrencyFail();

      const updated = await salesTargetRepository.updateStatus(
        client,
        id,
        input.rowVersion,
        existing.status,
        {
          status: 'CANCELLED',
          cancelledBy: actor.userId,
          cancelledAt: true,
          cancelReason: input.reason,
        },
      );
      if (!updated) concurrencyFail();
      return updated;
    }).then(async (updated) => {
      await audit(pool, actor, 'CANCEL', updated, { reason: input.reason });
      return updated;
    });
  },

  async close(pool: Pool, actor: ActorContext, id: string, rowVersion: number): Promise<SalesTargetRow> {
    if (!canManageAll(actor) && !canApprove(actor)) {
      throw new BusinessError('targets.manage or targets.approve required', 'ERR_TARGETS_FORBIDDEN');
    }

    return withTx(pool, async (client) => {
      const existing = await salesTargetRepository.findByIdForUpdate(client, id);
      if (!existing) {
        throw new BusinessError('Sales target not found', 'ERR_TARGETS_NOT_FOUND', { id });
      }
      if (existing.status !== 'ACTIVE') {
        throw new BusinessError('Only ACTIVE targets can be closed', 'ERR_TARGETS_INVALID_STATUS');
      }
      if (existing.rowVersion !== rowVersion) concurrencyFail();

      const updated = await salesTargetRepository.updateStatus(client, id, rowVersion, 'ACTIVE', {
        status: 'CLOSED',
        closedBy: actor.userId,
        closedAt: true,
      });
      if (!updated) concurrencyFail();
      return updated;
    }).then(async (updated) => {
      await audit(pool, actor, 'STATUS_CHANGE', updated, { to: 'CLOSED' });
      return updated;
    });
  },

  /**
   * Compact progress for Sales/Dashboard KPIs — ACTIVE targets covering the
   * business date. Priority for strip: INDIVIDUAL → TEAM → GENERAL.
   */
  async getProgress(
    pool: Pool,
    actor: ActorContext,
    opts?: { salespersonId?: string; asOfDate?: string },
  ): Promise<{
    asOfDate: string;
    scope: 'self' | 'team' | 'general';
    items: Array<{
      targetId: string;
      targetScope: SalesTargetScope;
      salespersonId: string | null;
      salespersonName: string | null;
      teamId: string | null;
      teamName: string | null;
      periodType: string;
      periodStart: string;
      periodEnd: string;
      targetAmount: number;
      achievedAmount: number;
      remainingAmount: number;
      achievementPercent: number;
      status: SalesTargetStatus;
    }>;
  }> {
    if (!hasPerm(actor, 'targets.read') && !canManageAll(actor) && !canApprove(actor)) {
      throw new BusinessError('targets.read required', 'ERR_TARGETS_FORBIDDEN');
    }

    const asOfDate = opts?.asOfDate || getBusinessDate();
    const focusUserId =
      opts?.salespersonId && opts.salespersonId !== actor.userId
        ? (() => {
            if (!canReadAll(actor)) {
              throw new BusinessError(
                'Not authorized to view other salespeople progress',
                'ERR_TARGETS_FORBIDDEN',
              );
            }
            return opts.salespersonId!;
          })()
        : actor.userId;

    const listed = await salesTargetRepository.list(pool, {
      status: 'ACTIVE',
      periodStart: asOfDate,
      periodEnd: asOfDate,
      visibleToUserId: canReadAll(actor) && !opts?.salespersonId ? undefined : focusUserId,
      page: 1,
      limit: 50,
    });

    // Priority: personal individual → team → general
    const individuals = listed.rows.filter(
      (t) => t.scope === 'INDIVIDUAL' && t.salespersonId === focusUserId,
    );
    const teams = listed.rows.filter((t) => t.scope === 'TEAM');
    const generals = listed.rows.filter((t) => t.scope === 'GENERAL');
    const ordered = [...individuals, ...teams, ...generals];
    const primary = ordered.slice(0, 1);
    const viewScope: 'self' | 'team' | 'general' =
      primary[0]?.scope === 'GENERAL'
        ? 'general'
        : primary[0]?.scope === 'TEAM'
          ? 'team'
          : 'self';

    const items = [];
    for (const target of primary.length ? primary : ordered.slice(0, 1)) {
      const achievement = await calculateTargetAchievement(pool, target);
      items.push({
        targetId: target.id,
        targetScope: target.scope,
        salespersonId: target.salespersonId,
        salespersonName: target.salespersonName,
        teamId: target.teamId,
        teamName: target.teamName,
        periodType: target.periodType,
        periodStart: target.periodStart,
        periodEnd: target.periodEnd,
        targetAmount: achievement.targetAmount,
        achievedAmount: achievement.achievedAmount,
        remainingAmount: achievement.remainingAmount,
        achievementPercent: achievement.achievementPercent,
        status: target.status,
      });
    }

    // Managers with no personal/team: still surface GENERAL (or first available)
    if (items.length === 0 && canReadAll(actor) && listed.rows.length > 0) {
      const fallback = [...generals, ...teams, ...individuals][0]!;
      const achievement = await calculateTargetAchievement(pool, fallback);
      items.push({
        targetId: fallback.id,
        targetScope: fallback.scope,
        salespersonId: fallback.salespersonId,
        salespersonName: fallback.salespersonName,
        teamId: fallback.teamId,
        teamName: fallback.teamName,
        periodType: fallback.periodType,
        periodStart: fallback.periodStart,
        periodEnd: fallback.periodEnd,
        targetAmount: achievement.targetAmount,
        achievedAmount: achievement.achievedAmount,
        remainingAmount: achievement.remainingAmount,
        achievementPercent: achievement.achievementPercent,
        status: fallback.status,
      });
      return {
        asOfDate,
        scope: fallback.scope === 'GENERAL' ? 'general' : fallback.scope === 'TEAM' ? 'team' : 'self',
        items,
      };
    }

    return { asOfDate, scope: viewScope, items };
  },

  async getAchievement(
    pool: Pool,
    actor: ActorContext,
    id: string,
  ): Promise<SalesTargetAchievement> {
    const target = await this.getById(pool, actor, id);
    return calculateTargetAchievement(pool, target);
  },

  async getAchievementBreakdown(
    pool: Pool,
    actor: ActorContext,
    id: string,
  ): Promise<AchievementBreakdown & { glReconciliation: unknown }> {
    const target = await this.getById(pool, actor, id);
    const breakdown = await getTargetAchievementBreakdown(pool, target);
    const gl = await salesTargetRepository.glNetSalesForPeriod(
      pool,
      target.periodStart,
      target.periodEnd,
    );
    return {
      ...breakdown,
      glReconciliation: {
        note:
          'GL 4000−4010 is tenant-wide and not cashier-scoped. Use for org-level sense-check only; individual achievement uses sales.cashier_id.',
        orgGlNetSales: gl,
        invoiceCreditNotesExcluded: true,
      },
    };
  },
};
