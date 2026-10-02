/**
 * Idempotency Middleware
 *
 * Prevents duplicate transaction submissions caused by network retries,
 * double-clicks, or two terminals posting the same key.
 *
 * The key is claimed before the route runs. A second request waits for the
 * stored response and replays it. The business logic runs once.
 *
 * APPLIED TO: POST, PUT, PATCH, DELETE requests that include the header
 * SKIPPED:    GET/HEAD, requests without the header (opt-in per client)
 *
 * REQUIRES: idempotency_keys table (migration 071_idempotency_keys.sql)
 */

import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import logger from '../utils/logger.js';
import { createPgIdempotencyStore, waitForCompleted } from './idempotencyClaim.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function idempotencyMiddleware(globalPool: Pool) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!MUTATING_METHODS.has(req.method)) {
      next();
      return;
    }

    const rawKey = req.headers['x-idempotency-key'];
    if (typeof rawKey !== 'string' || !rawKey.trim()) {
      next();
      return;
    }
    const idempotencyKey = rawKey.trim();

    const pool: Pool = req.tenantPool ?? globalPool;
    const store = createPgIdempotencyStore(pool);
    const userId = req.user?.id ?? null;

    let owned = false;
    try {
      const existing = await store.readCompleted(idempotencyKey);
      if (existing) {
        logger.debug('Idempotency key hit — replaying cached response', {
          key: idempotencyKey,
          statusCode: existing.statusCode,
          path: req.path,
        });
        res.status(existing.statusCode).json(existing.body);
        return;
      }

      owned = await store.claim(idempotencyKey, userId, req.method, req.path);
      if (!owned) {
        const replay = await waitForCompleted(store, idempotencyKey);
        if (!replay) {
          res.status(409).json({
            success: false,
            error: 'Duplicate request is still in progress',
          });
          return;
        }
        res.status(replay.statusCode).json(replay.body);
        return;
      }
    } catch (err) {
      logger.warn('Idempotency key lookup failed (proceeding without dedup)', {
        key: idempotencyKey,
        path: req.path,
        error: err instanceof Error ? err.message : String(err),
      });
      next();
      return;
    }

    const originalJson = res.json.bind(res) as (body: unknown) => Response;
    let phase: 'open' | 'finishing' | 'done' = 'open';
    (res as Response).json = function (body: unknown): Response {
      if (phase !== 'open') return originalJson(body);
      phase = 'finishing';
      const statusCode = res.statusCode >= 200 ? res.statusCode : 200;
      void (async () => {
        try {
          if (statusCode >= 200 && statusCode < 300) {
            await store.complete(idempotencyKey, statusCode, body);
          } else {
            await store.release(idempotencyKey);
          }
        } catch (storeErr) {
          logger.error('Failed to store idempotency key (non-fatal)', {
            key: idempotencyKey,
            error: storeErr instanceof Error ? storeErr.message : String(storeErr),
          });
        } finally {
          phase = 'done';
          originalJson(body);
        }
      })();
      return res;
    };

    next();
  };
}
