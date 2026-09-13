import type { Pool, PoolClient } from 'pg';
import type { DomainLaneSummary } from '../financial-reconciliation/types.js';
import { resolveMaterialityThreshold } from './materialityConfigService.js';
import type { FinancialDomain } from '../financial-reconciliation/types.js';
import type { IntegrityAlert, IntegrityAlertType } from './types.js';
import { publishNotificationEvent } from '../notifications/notificationPublisher.js';

type Db = Pool | PoolClient;

function mapAlert(row: Record<string, unknown>): IntegrityAlert {
  return {
    id: String(row.id),
    domain: String(row.domain),
    lane: String(row.lane),
    alertType: row.alert_type as IntegrityAlertType,
    previousDifference: row.previous_difference != null ? Number(row.previous_difference) : null,
    currentDifference: row.current_difference != null ? Number(row.current_difference) : null,
    materialityThreshold: row.materiality_threshold != null ? Number(row.materiality_threshold) : null,
    severity: row.severity as IntegrityAlert['severity'],
    message: String(row.message),
    snapshotId: row.snapshot_id != null ? String(row.snapshot_id) : null,
    acknowledged: Boolean(row.acknowledged),
    acknowledgedBy: row.acknowledged_by != null ? String(row.acknowledged_by) : null,
    acknowledgedAt: row.acknowledged_at != null ? String(row.acknowledged_at) : null,
    createdAt: String(row.created_at),
  };
}

async function insertAlert(
  conn: Db,
  alert: {
    domain: string;
    alertType: IntegrityAlertType;
    previousDifference: number | null;
    currentDifference: number | null;
    materialityThreshold: number | null;
    severity: IntegrityAlert['severity'];
    message: string;
    snapshotId: string;
  },
): Promise<IntegrityAlert> {
  const res = await conn.query(`
    INSERT INTO financial_integrity_alerts (
      domain, lane, alert_type, previous_difference, current_difference,
      materiality_threshold, severity, message, snapshot_id
    ) VALUES ($1, 'integrity', $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
  `, [
    alert.domain,
    alert.alertType,
    alert.previousDifference,
    alert.currentDifference,
    alert.materialityThreshold,
    alert.severity,
    alert.message,
    alert.snapshotId,
  ]);
  return mapAlert(res.rows[0]);
}

function integrityDiff(summary: DomainLaneSummary): number {
  const lane = summary.lanes.find((l) => l.lane === 'integrity');
  return lane?.difference ?? 0;
}

function integrityGl(summary: DomainLaneSummary): number {
  const lane = summary.lanes.find((l) => l.lane === 'integrity');
  return lane?.leftAmount ?? 0;
}

function wasWithinThreshold(diff: number, threshold: number): boolean {
  return Math.abs(diff) <= threshold;
}

export async function detectIntegrityDriftAlerts(
  conn: Db,
  previousSummary: DomainLaneSummary[],
  currentSummary: DomainLaneSummary[],
  snapshotId: string,
): Promise<IntegrityAlert[]> {
  const alerts: IntegrityAlert[] = [];
  const domains: FinancialDomain[] = ['ap', 'ar', 'inventory'];

  for (const domain of domains) {
    const prev = previousSummary.find((s) => s.domain === domain);
    const curr = currentSummary.find((s) => s.domain === domain);
    if (!curr) continue;

    const prevDiff = prev ? integrityDiff(prev) : 0;
    const currDiff = integrityDiff(curr);
    const { threshold } = await resolveMaterialityThreshold(conn, domain, integrityGl(curr));

    const prevOk = wasWithinThreshold(prevDiff, threshold);
    const currOk = wasWithinThreshold(currDiff, threshold);

    if (!prev && !currOk) {
      alerts.push(await insertAlert(conn, {
        domain,
        alertType: 'new_drift',
        previousDifference: null,
        currentDifference: currDiff,
        materialityThreshold: threshold,
        severity: 'critical',
        message: `${domain.toUpperCase()} integrity drift detected: ${currDiff.toFixed(2)} exceeds materiality ${threshold.toFixed(2)}`,
        snapshotId,
      }));
      continue;
    }

    if (prevOk && !currOk) {
      alerts.push(await insertAlert(conn, {
        domain,
        alertType: 'new_drift',
        previousDifference: prevDiff,
        currentDifference: currDiff,
        materialityThreshold: threshold,
        severity: 'critical',
        message: `${domain.toUpperCase()} integrity newly out of tolerance: was ${prevDiff.toFixed(2)}, now ${currDiff.toFixed(2)}`,
        snapshotId,
      }));
    } else if (!prevOk && currOk) {
      alerts.push(await insertAlert(conn, {
        domain,
        alertType: 'drift_resolved',
        previousDifference: prevDiff,
        currentDifference: currDiff,
        materialityThreshold: threshold,
        severity: 'info',
        message: `${domain.toUpperCase()} integrity returned within materiality`,
        snapshotId,
      }));
    } else if (!prevOk && !currOk && Math.abs(currDiff) > Math.abs(prevDiff) + 0.01) {
      alerts.push(await insertAlert(conn, {
        domain,
        alertType: 'drift_worsened',
        previousDifference: prevDiff,
        currentDifference: currDiff,
        materialityThreshold: threshold,
        severity: 'warning',
        message: `${domain.toUpperCase()} integrity drift worsened: ${prevDiff.toFixed(2)} → ${currDiff.toFixed(2)}`,
        snapshotId,
      }));
    }
  }

  for (const alert of alerts) {
    if (alert.alertType === 'drift_resolved') continue;
    publishNotificationEvent({
      pool: conn as Pool,
      typeKey: 'FINANCIAL_INTEGRITY_ALERT',
      entityType: 'integrity_alert',
      entityId: alert.id,
      idempotencyKey: `FINANCIAL_INTEGRITY_ALERT:integrity_alert:${alert.id}`,
      payload: { summary: alert.message, documentRef: alert.domain },
    });
  }

  return alerts;
}

export async function listOpenAlerts(conn: Db, limit = 50): Promise<IntegrityAlert[]> {
  const res = await conn.query(`
    SELECT * FROM financial_integrity_alerts
    WHERE acknowledged = false
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);
  return res.rows.map(mapAlert);
}

export async function acknowledgeAlert(
  conn: Db,
  alertId: string,
  userId: string,
): Promise<IntegrityAlert | null> {
  const res = await conn.query(`
    UPDATE financial_integrity_alerts
    SET acknowledged = true, acknowledged_by = $2, acknowledged_at = NOW()
    WHERE id = $1
    RETURNING *
  `, [alertId, userId]);
  return res.rows[0] ? mapAlert(res.rows[0]) : null;
}
