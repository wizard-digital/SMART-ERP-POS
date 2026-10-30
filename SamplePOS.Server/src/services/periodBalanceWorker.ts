/**
 * PERIOD BALANCE WORKER
 *
 * Processes gl_projection_events (the outbox table) to keep gl_period_balances
 * in sync with ledger_entries without ever touching the sync request path.
 *
 * DESIGN PRINCIPLES:
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚡ NON-BLOCKING REQUEST PATH
 *    AccountingCore writes ledger entries + projection events atomically.
 *    This worker processes those events in the background.
 *    No HTTP request waits on gl_period_balances being updated.
 *
 * 🔒 DURABLE, CRASH-SAFE DELIVERY (OUTBOX PATTERN)
 *    Events are committed to gl_projection_events in the SAME DB transaction
 *    as the ledger entries.
 *
 *    A poll cycle is ONE transaction: claim (FOR UPDATE SKIP LOCKED) → rebuild
 *    on the same connection → mark DONE/FAILED → COMMIT. The row lock IS the
 *    claim. If the process dies at any point, Postgres drops the connection,
 *    rolls the transaction back and releases the locks: the events are simply
 *    still PENDING for the next cycle. A committed 'PROCESSING' state is never
 *    written, so events can no longer be stranded in PROCESSING (the previous
 *    implementation committed a status flip as the claim, with no lease and no
 *    recovery, and swallowed errors from the final DONE update).
 *
 * 🔄 IDEMPOTENT REBUILDS
 *    rebuildSingleAccountPeriodOnClient() does an ABSOLUTE recompute from
 *    ledger_entries. Re-processing the same event always yields the same
 *    gl_period_balances row, so at-least-once delivery is safe (duplicate Bull
 *    jobs, concurrent workers, re-delivery after a crash). The balance upsert
 *    and the DONE mark commit together — they cannot diverge.
 *
 * 📦 DEDUPLICATION
 *    Multiple events for the same (account_id, fiscal_year, fiscal_period)
 *    are collapsed into a single rebuild call per polling cycle.
 *
 * 🔁 RETRY
 *    A failing tuple is isolated with a SAVEPOINT (other tuples in the batch
 *    still commit), its events are marked FAILED with retry_count + 1 and are
 *    retried on later cycles. Events exceeding MAX_RETRIES stay FAILED for
 *    human inspection.
 *    Full recovery always available via POST /api/system/gl/rebuild-period-balances.
 *
 * 🧱 NO DEADLOCKS BETWEEN WORKERS
 *    Tuples are rebuilt in sorted order, so concurrent workers that share tuples
 *    always acquire gl_period_balances row locks in the same order.
 *
 * 🧹 LEGACY PROCESSING ROWS
 *    Rows stranded in PROCESSING by the old implementation are reclaimed after
 *    LEGACY_PROCESSING_RECLAIM_SECONDS. No ledger or journal is ever modified;
 *    only the derived gl_period_balances row is recomputed from the ledger.
 *
 * 🌐 MULTI-TENANT SAFE
 *    Every function accepts a `pool` parameter — callers pass the tenant-specific
 *    pool.  No global pool references inside this module.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type pg from 'pg';
import logger from '../utils/logger.js';
import { rebuildSingleAccountPeriodOnClient } from './glPeriodRebuildService.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_RETRIES = 5;
const BATCH_SIZE = 100; // Max events to claim per polling cycle

/**
 * Rows left in PROCESSING by the previous worker implementation (claim committed
 * as a status flip, then the process died before DONE/FAILED) are reclaimed once
 * they are older than this. The current implementation never commits PROCESSING,
 * so any committed PROCESSING row is legacy; the age guard only protects a live
 * old-version worker during a rolling deploy. Re-delivery is harmless anyway
 * (absolute recompute), this just avoids pointless duplicate work.
 */
export const LEGACY_PROCESSING_RECLAIM_SECONDS = 300;

const SAVEPOINT = 'gl_projection_tuple';

// =============================================================================
// TYPES
// =============================================================================

interface ProjectionEvent {
    id: string;
    account_id: string;
    fiscal_year: number;
    fiscal_period: number;
    transaction_id: string;
    idempotency_key: string;
    retry_count: number;
}

interface TupleGroup {
    key: string;
    accountId: string;
    fiscalYear: number;
    fiscalPeriod: number;
    eventIds: string[];
}

// =============================================================================
// CORE WORKER FUNCTION
// =============================================================================

/**
 * Poll gl_projection_events for PENDING (or retryable FAILED) events and
 * process them in batches.
 *
 * Called by:
 *   - Bull worker (scheduled every ~30s)
 *   - Immediate fire-and-forget after ledger commit (fast path)
 *   - Manual trigger via POST /api/system/gl/process-projection-events
 *
 * @returns Stats about what was processed.
 */
export async function pollAndProcessPendingEvents(pool: pg.Pool): Promise<{
    claimed: number;
    rebuilt: number;
    failed: number;
    durationMs: number;
}> {
    const start = Date.now();
    let claimed = 0;
    let rebuilt = 0;
    let failed = 0;

    let client: pg.PoolClient | undefined;
    let destroyClient = false;
    let inTransaction = false;

    // A checked-out pg client has no 'error' listener of its own. If Postgres drops the
    // connection mid-cycle (restart, crash, pg_terminate_backend) 'error' would be emitted
    // with no listener and crash the process. Treat it as a lost connection: never reuse the
    // client; the open transaction is rolled back by the server, events stay claimable.
    const onClientError = (e: Error): void => {
        destroyClient = true;
        logger.warn('[PeriodBalanceWorker] connection lost mid-cycle (events remain claimable)', {
            error: e.message,
        });
    };

    try {
        client = await pool.connect();
        client.on('error', onClientError);
        await client.query('BEGIN');
        inTransaction = true;

        // ── 1. Claim a batch (row locks held until COMMIT; SKIP LOCKED = concurrent-safe) ──
        const claimResult = await client.query<ProjectionEvent>(
            `SELECT id, account_id, fiscal_year, fiscal_period,
                    transaction_id, idempotency_key, retry_count
             FROM gl_projection_events
             WHERE (status IN ('PENDING', 'FAILED') AND retry_count < $1)
                OR (status = 'PROCESSING'
                    AND created_at < NOW() - make_interval(secs => $3::int))
             ORDER BY created_at ASC
             LIMIT $2
             FOR UPDATE SKIP LOCKED`,
            [MAX_RETRIES, BATCH_SIZE, LEGACY_PROCESSING_RECLAIM_SECONDS],
        );

        const events = claimResult.rows;
        claimed = events.length;

        if (claimed === 0) {
            await client.query('COMMIT');
            inTransaction = false;
            return { claimed: 0, rebuilt: 0, failed: 0, durationMs: Date.now() - start };
        }

        // ── 2. Collapse events into unique (account, year, period) tuples ──
        const groups = new Map<string, TupleGroup>();
        for (const ev of events) {
            const key = `${ev.account_id}|${ev.fiscal_year}|${ev.fiscal_period}`;
            const g = groups.get(key);
            if (g) {
                g.eventIds.push(ev.id);
            } else {
                groups.set(key, {
                    key,
                    accountId: ev.account_id,
                    fiscalYear: ev.fiscal_year,
                    fiscalPeriod: ev.fiscal_period,
                    eventIds: [ev.id],
                });
            }
        }
        // Deterministic lock order across concurrent workers (no cross-worker deadlocks).
        const ordered = [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

        // ── 3. Rebuild each tuple on THIS connection; isolate failures with a savepoint ──
        const doneIds: string[] = [];
        const failedGroups: Array<{ group: TupleGroup; message: string }> = [];

        for (const group of ordered) {
            await client.query(`SAVEPOINT ${SAVEPOINT}`);
            try {
                await rebuildSingleAccountPeriodOnClient(
                    client,
                    group.accountId,
                    group.fiscalYear,
                    group.fiscalPeriod,
                );
                await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
                doneIds.push(...group.eventIds);
                logger.debug('[PeriodBalanceWorker] rebuilt period balance', {
                    accountId: group.accountId,
                    fiscalYear: group.fiscalYear,
                    fiscalPeriod: group.fiscalPeriod,
                    eventCount: group.eventIds.length,
                });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                // If the rollback itself fails the connection is unusable: abort the whole cycle
                // (outer catch rolls back; every event stays claimable).
                await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
                failedGroups.push({ group, message });
                logger.warn('[PeriodBalanceWorker] rebuild failed', {
                    accountId: group.accountId,
                    fiscalYear: group.fiscalYear,
                    fiscalPeriod: group.fiscalPeriod,
                    error: message,
                    eventIds: group.eventIds,
                });
            }
        }

        // ── 4. Persist outcomes in the SAME transaction as the balance upserts ──
        if (doneIds.length > 0) {
            await client.query(
                `UPDATE gl_projection_events
                 SET status = 'DONE', processed_at = NOW(), error_message = NULL
                 WHERE id = ANY($1::uuid[])`,
                [doneIds],
            );
        }
        for (const { group, message } of failedGroups) {
            await client.query(
                `UPDATE gl_projection_events
                 SET status = 'FAILED',
                     retry_count = retry_count + 1,
                     error_message = $1
                 WHERE id = ANY($2::uuid[])`,
                [message.slice(0, 1000), group.eventIds],
            );
        }

        await client.query('COMMIT');
        inTransaction = false;

        rebuilt = ordered.length - failedGroups.length;
        failed = failedGroups.length;

        const durationMs = Date.now() - start;
        logger.info('[PeriodBalanceWorker] cycle complete', {
            claimed,
            rebuilt,
            failed,
            durationMs,
        });

        return { claimed, rebuilt, failed, durationMs };
    } catch (err) {
        if (inTransaction && client) {
            try {
                await client.query('ROLLBACK');
            } catch {
                destroyClient = true; // connection is broken — do not return it to the pool
            }
            inTransaction = false;
        }

        // In multi-tenant production the global pool points to an empty database
        // that has no GL tables yet.  This is expected — swallow silently at DEBUG
        // so logs stay clean.  Code '42P01' = undefined_table in PostgreSQL.
        const isTableMissing =
            err instanceof Error &&
            (err.message.includes('relation') && err.message.includes('does not exist') ||
                (err as unknown as { code?: string }).code === '42P01');

        if (isTableMissing) {
            logger.debug('[PeriodBalanceWorker] gl_projection_events not found in this pool — skipping (expected for global/empty DB)');
        } else {
            logger.error('[PeriodBalanceWorker] poll cycle error (events remain claimable)', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
        // Nothing committed => nothing processed, whatever was claimed in the aborted transaction.
        return { claimed, rebuilt: 0, failed: 0, durationMs: Date.now() - start };
    } finally {
        if (client) {
            // Healthy client goes back to the pool (which installs its own idle listener).
            // A lost/broken client keeps our listener so a late 'error' can never be unhandled.
            if (!destroyClient) client.removeListener('error', onClientError);
            client.release(destroyClient);
        }
    }
}

// =============================================================================
// FIRE-AND-FORGET TRIGGER (called after every ledger commit)
// =============================================================================

/**
 * Non-blocking trigger called by AccountingCore immediately after a ledger
 * commit.  Fires pollAndProcessPendingEvents in the next event-loop tick so
 * gl_period_balances is usually current within milliseconds.
 *
 * This is a BEST-EFFORT fast path.  The durable path (gl_projection_events
 * table) guarantees delivery even if this call is skipped or the process
 * crashes before it runs.
 *
 * @param pool  Tenant-specific pool (same pool used to write the ledger).
 */
export function scheduleImmediateRebuild(pool: pg.Pool): void {
    setImmediate(() => {
        pollAndProcessPendingEvents(pool).catch((e) =>
            logger.warn('[PeriodBalanceWorker] immediate rebuild fire-and-forget failed (non-fatal)', {
                error: e instanceof Error ? e.message : String(e),
            }),
        );
    });
}

// =============================================================================
// WRITE PROJECTION EVENT (called inside DB transaction by AccountingCore)
// =============================================================================

/**
 * Insert a single projection event into gl_projection_events.
 *
 * MUST be called with the SAME PoolClient that is writing the ledger entry —
 * this ensures the event commits atomically with the ledger data (outbox pattern).
 *
 * ON CONFLICT DO NOTHING: if the exact same (account_id, year, period, txn_id)
 * event is already in the table (e.g. idempotent retry of the same journal entry
 * that was previously processed), this is a no-op.
 */
export async function writeProjectionEvent(
    client: pg.PoolClient,
    accountId: string,
    fiscalYear: number,
    fiscalPeriod: number,
    transactionId: string,
    idempotencyKey: string,
): Promise<void> {
    await client.query(
        `INSERT INTO gl_projection_events
             (account_id, fiscal_year, fiscal_period, transaction_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id, fiscal_year, fiscal_period, transaction_id) DO NOTHING`,
        [accountId, fiscalYear, fiscalPeriod, transactionId, idempotencyKey],
    );
}
