import type { Pool, PoolClient } from 'pg';
import type { PeriodCloseSignoff, SignoffStatus } from './types.js';
import { getSnapshotById } from './reconciliationSnapshotService.js';
import { publishNotificationEvent } from '../notifications/notificationPublisher.js';

type Db = Pool | PoolClient;

function mapSignoff(row: Record<string, unknown>): PeriodCloseSignoff {
  return {
    id: String(row.id),
    periodYear: Number(row.period_year),
    periodMonth: Number(row.period_month),
    snapshotId: row.snapshot_id != null ? String(row.snapshot_id) : null,
    status: row.status as SignoffStatus,
    requestedBy: String(row.requested_by),
    requestedAt: String(row.requested_at),
    reviewedBy: row.reviewed_by != null ? String(row.reviewed_by) : null,
    reviewedAt: row.reviewed_at != null ? String(row.reviewed_at) : null,
    reviewNotes: row.review_notes != null ? String(row.review_notes) : null,
    attestation: row.attestation != null ? String(row.attestation) : null,
  };
}

export interface RequestSignoffInput {
  periodYear: number;
  periodMonth: number;
  snapshotId?: string;
  requestedBy: string;
  attestation?: string;
}

export async function requestPeriodCloseSignoff(
  conn: Db,
  input: RequestSignoffInput,
): Promise<PeriodCloseSignoff> {
  if (input.snapshotId) {
    const snapshot = await getSnapshotById(conn, input.snapshotId);
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${input.snapshotId}`);
    }
    if (snapshot.periodCloseBlocked) {
      throw new Error(
        `Period close blocked by domains: ${snapshot.blockedDomains.join(', ')}. Resolve integrity before sign-off.`,
      );
    }
  }

  const res = await conn.query(`
    INSERT INTO financial_period_close_signoffs (
      period_year, period_month, snapshot_id, status, requested_by, attestation
    ) VALUES ($1, $2, $3, 'PENDING', $4, $5)
    RETURNING *
  `, [
    input.periodYear,
    input.periodMonth,
    input.snapshotId ?? null,
    input.requestedBy,
    input.attestation ?? null,
  ]);

  const signoff = mapSignoff(res.rows[0]);
  publishNotificationEvent({
    pool: conn as Pool,
    typeKey: 'PERIOD_CLOSE_SIGNOFF',
    entityType: 'period_close_signoff',
    entityId: signoff.id,
    idempotencyKey: `PERIOD_CLOSE_SIGNOFF:period_close_signoff:${signoff.id}`,
    payload: {
      summary: `Period-close signoff requested for ${signoff.periodYear}-${String(signoff.periodMonth).padStart(2, '0')}`,
      documentRef: `${signoff.periodYear}-${String(signoff.periodMonth).padStart(2, '0')}`,
    },
    actorUserId: input.requestedBy,
  });
  return signoff;
}

export interface ReviewSignoffInput {
  signoffId: string;
  status: 'APPROVED' | 'REJECTED';
  reviewedBy: string;
  reviewNotes?: string;
}

export async function reviewPeriodCloseSignoff(
  conn: Db,
  input: ReviewSignoffInput,
): Promise<PeriodCloseSignoff> {
  if (input.status === 'APPROVED') {
    const pending = await conn.query(`
      SELECT snapshot_id FROM financial_period_close_signoffs WHERE id = $1
    `, [input.signoffId]);
    const snapshotId = pending.rows[0]?.snapshot_id as string | null;
    if (snapshotId) {
      const snapshot = await getSnapshotById(conn, snapshotId);
      if (snapshot?.periodCloseBlocked) {
        throw new Error('Cannot approve sign-off while period-close integrity is blocked');
      }
    }
  }

  const res = await conn.query(`
    UPDATE financial_period_close_signoffs
    SET status = $2, reviewed_by = $3, reviewed_at = NOW(), review_notes = $4
    WHERE id = $1
    RETURNING *
  `, [input.signoffId, input.status, input.reviewedBy, input.reviewNotes ?? null]);

  if (!res.rows[0]) {
    throw new Error(`Sign-off not found: ${input.signoffId}`);
  }
  const signoff = mapSignoff(res.rows[0]);
  publishNotificationEvent({
    pool: conn as Pool,
    typeKey: 'PERIOD_CLOSE_SIGNOFF',
    entityType: 'period_close_signoff',
    entityId: signoff.id,
    idempotencyKey: `PERIOD_CLOSE_SIGNOFF:review:${signoff.id}:${signoff.status}`,
    payload: {
      summary: `Period-close signoff ${signoff.status.toLowerCase()} for ${signoff.periodYear}-${String(signoff.periodMonth).padStart(2, '0')}`,
      documentRef: `${signoff.periodYear}-${String(signoff.periodMonth).padStart(2, '0')}`,
    },
    actorUserId: input.reviewedBy,
  });
  return signoff;
}

export async function listPendingSignoffs(conn: Db): Promise<PeriodCloseSignoff[]> {
  const res = await conn.query(`
    SELECT * FROM financial_period_close_signoffs
    WHERE status = 'PENDING'
    ORDER BY requested_at DESC
  `);
  return res.rows.map(mapSignoff);
}

export async function getApprovedSignoffForPeriod(
  conn: Db,
  periodYear: number,
  periodMonth: number,
): Promise<PeriodCloseSignoff | null> {
  const res = await conn.query(`
    SELECT * FROM financial_period_close_signoffs
    WHERE period_year = $1 AND period_month = $2 AND status = 'APPROVED'
    ORDER BY reviewed_at DESC
    LIMIT 1
  `, [periodYear, periodMonth]);
  return res.rows[0] ? mapSignoff(res.rows[0]) : null;
}
