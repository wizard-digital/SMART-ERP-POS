/**
 * Banking retry worker — processes jobs from the Bull `banking` queue.
 * (Extracted from server.ts so every failure path is testable; behaviour is otherwise the same.)
 *
 * Guarantees (unit: bankingRetryWorker.proof.test.ts; Redis/Bull: redisResilience.proof.test.ts;
 * DB idempotency: saleBankMirror.idempotency.realpg.test.ts):
 *  - NO SILENT LOSS: a job is only "completed" when every payment was mirrored or deliberately skipped by
 *    the mirror policy. An unresolvable tenant pool THROWS, so Bull retries with backoff and finally keeps
 *    the job in `failed` (removeOnFail: 1000) for audit — it is never returned as success.
 *  - UNTRUSTED INPUT: the payload is schema-validated before any DB access. A job planted in Redis
 *    (Redis was unauthenticated before 2026-10-28) cannot drive a bank write with an arbitrary saleId,
 *    tenant, method or amount. Invalid jobs are discarded (no pointless retries) and kept in `failed`.
 *  - IDEMPOTENT: delegates to BankingService.createFromSale (existing-row check + unique index), so a
 *    duplicate delivery never creates a second bank row or a second journal.
 *  - TENANT ISOLATION: the pool is resolved by tenantId from the registry; a tenant-scoped job NEVER
 *    falls back to the default pool.
 */
import type pg from 'pg';
import { z } from 'zod';
import logger from '../utils/logger.js';
import { aggregatePaymentsByMethod } from '../modules/treasury/saleBankMirrorPolicy.js';

const PAYMENT_METHODS = ['CASH', 'CARD', 'MOBILE_MONEY', 'AIRTEL_MONEY', 'BANK_TRANSFER', 'CREDIT', 'DEPOSIT'] as const;

export const bankingJobPayloadSchema = z
  .object({
    saleId: z.string().uuid(),
    saleNumber: z.string().min(1).max(64),
    saleDate: z.string().min(8).max(40),
    payments: z
      .array(
        z.object({
          amount: z.number().finite().positive().max(1_000_000_000_000),
          paymentMethod: z.enum(PAYMENT_METHODS),
        }),
      )
      .min(1)
      .max(20),
    tenantId: z.string().uuid().optional(),
  })
  .passthrough(); // failedAt / originalError are informational

export type BankingJobPayload = z.infer<typeof bankingJobPayloadSchema>;

export interface BankingJobLike {
  id?: string | number;
  data: { payload?: unknown };
  attemptsMade: number;
  discard?: () => void;
}

export interface BankingRetryDeps {
  /** Resolve (or re-create) the tenant pool by id; null when the tenant cannot be resolved. */
  resolveTenantPool: (tenantId: string) => Promise<pg.Pool | null>;
  createFromSale: (
    saleId: string,
    saleNumber: string,
    amount: number,
    paymentMethod: string,
    saleDate: string,
    pool?: pg.Pool,
  ) => Promise<unknown>;
}

export class BankingJobRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BankingJobRejectedError';
  }
}

export async function processBankingJob(
  job: BankingJobLike,
  deps: BankingRetryDeps,
): Promise<{ mirrored: number; saleId: string }> {
  const parsed = bankingJobPayloadSchema.safeParse(job.data?.payload);
  if (!parsed.success) {
    job.discard?.(); // retrying an invalid payload can never succeed
    logger.error('Banking retry: rejected invalid job payload (not processed, kept in failed set)', {
      jobId: job.id,
      issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
    });
    throw new BankingJobRejectedError(`invalid banking job payload: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  const payload = parsed.data;

  let pool: pg.Pool | undefined;
  if (payload.tenantId) {
    const resolved = await deps.resolveTenantPool(payload.tenantId);
    if (!resolved) {
      // THROW (do not return): returning would mark the job completed and silently lose the mirror.
      throw new Error(`Banking retry: tenant pool for ${payload.tenantId} unavailable (sale ${payload.saleNumber}); will retry`);
    }
    pool = resolved;
  }

  const lines = aggregatePaymentsByMethod(payload.payments);
  for (const line of lines) {
    await deps.createFromSale(payload.saleId, payload.saleNumber, line.amount, line.paymentMethod, payload.saleDate, pool);
  }

  logger.info('Banking retry succeeded', {
    saleId: payload.saleId,
    saleNumber: payload.saleNumber,
    attempt: job.attemptsMade + 1,
    methods: lines.map((l) => l.paymentMethod),
  });
  return { mirrored: lines.length, saleId: payload.saleId };
}
