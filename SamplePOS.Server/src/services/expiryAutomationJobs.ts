/**
 * Nightly inventory quarantine automations (calculations queue):
 * - expiry-automation (04:00) — quarantine only, no P&L
 * - quarantine-auto-dispose (04:30) — aged EXPIRED dispose, posts P&L when flag on
 */

import type { Pool } from 'pg';
import { jobQueue } from './jobQueue.js';
import { runScheduledExpiryAutomation } from '../modules/inventory/warehouse/expiryAutomationService.js';
import { runScheduledQuarantineAutoDispose } from '../modules/loss-quarantine/quarantineAutoDisposeService.js';
import logger from '../utils/logger.js';

const EXPIRY_JOB_ID = 'expiry-automation-nightly';
const EXPIRY_JOB_TYPE = 'expiry-automation';
const EXPIRY_CRON = '0 4 * * *';

const AUTO_DISPOSE_JOB_ID = 'quarantine-auto-dispose-nightly';
const AUTO_DISPOSE_JOB_TYPE = 'quarantine-auto-dispose';
const AUTO_DISPOSE_CRON = '30 4 * * *';

export function registerExpiryAutomationCalculationsHandlers(pool: Pool): void {
  jobQueue.registerCalculationsHandler(EXPIRY_JOB_TYPE, async () => {
    await runScheduledExpiryAutomation(pool);
    const { publishInventoryConditionNotifications } = await import(
      '../modules/notifications/inventoryConditionPublisher.js'
    );
    await publishInventoryConditionNotifications(pool);
    return { ok: true, type: EXPIRY_JOB_TYPE };
  });
  jobQueue.registerCalculationsHandler(AUTO_DISPOSE_JOB_TYPE, async () => {
    await runScheduledQuarantineAutoDispose(pool);
    return { ok: true, type: AUTO_DISPOSE_JOB_TYPE };
  });
}

export function scheduleExpiryAutomationJobs(pool: Pool): void {
  const calculationsQueue = jobQueue.getQueue('calculations');
  if (!calculationsQueue) {
    logger.warn('[ExpiryAutomation] Calculations queue not available — skipping scheduled jobs');
    return;
  }

  calculationsQueue
    .add(
      {
        type: EXPIRY_JOB_TYPE,
        payload: {},
        userId: 'system',
        timestamp: new Date().toISOString(),
      },
      {
        repeat: { cron: EXPIRY_CRON },
        jobId: EXPIRY_JOB_ID,
        removeOnComplete: 14,
        removeOnFail: 50,
      },
    )
    .then(() => {
      logger.info('[ExpiryAutomation] Nightly job scheduled (04:00 server time)');
    })
    .catch((err: unknown) => {
      logger.warn('[ExpiryAutomation] Failed to schedule nightly job', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  calculationsQueue
    .add(
      {
        type: AUTO_DISPOSE_JOB_TYPE,
        payload: {},
        userId: 'system',
        timestamp: new Date().toISOString(),
      },
      {
        repeat: { cron: AUTO_DISPOSE_CRON },
        jobId: AUTO_DISPOSE_JOB_ID,
        removeOnComplete: 14,
        removeOnFail: 50,
      },
    )
    .then(() => {
      logger.info('[QuarantineAutoDispose] Nightly job scheduled (04:30 server time)');
    })
    .catch((err: unknown) => {
      logger.warn('[QuarantineAutoDispose] Failed to schedule nightly job', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/** Register handlers + schedule cron jobs (processor started separately). */
export function initExpiryAutomationJobs(pool: Pool): void {
  registerExpiryAutomationCalculationsHandlers(pool);
  scheduleExpiryAutomationJobs(pool);
}
