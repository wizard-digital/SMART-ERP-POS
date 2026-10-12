/**
 * Password Expiry Middleware
 *
 * Soft/header helpers and an optional hard gate. The hard gate is intentionally
 * NOT mounted globally on the API — that would brick POS/FOH for every user with
 * an expired password. The client soft-redirects expired users to
 * `/settings/security` after login and shows the warning banner.
 *
 * If you mount `checkPasswordExpiry`, use it AFTER authenticate and ensure
 * password / logout / 2FA / session routes stay exempt.
 */

import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import * as passwordPolicy from '../modules/auth/passwordPolicyService.js';
import { pool as globalPool } from '../db/pool.js';
import logger from '../utils/logger.js';

// Routes that are exempt from password expiry check
const EXEMPT_ROUTES = [
    '/api/auth/password',
    '/api/auth/logout',
    '/api/auth/2fa',
    '/api/auth/token',
    '/api/auth/session',
    '/api/health',
];

function resolvePool(req: Request): Pool {
    return (req as unknown as { tenantPool?: Pool }).tenantPool || globalPool;
}

function isExemptPath(path: string): boolean {
    return EXEMPT_ROUTES.some((route) => path === route || path.startsWith(`${route}/`) || path.startsWith(route));
}

/**
 * Middleware to check password expiry
 * Must be used AFTER authenticate middleware
 * Prefer tenantPool when present (multi-tenant).
 */
export async function checkPasswordExpiry(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    // Skip if no user (not authenticated)
    if (!req.user) {
        next();
        return;
    }

    // Check if route is exempt (req.path is relative to mount; also check originalUrl)
    const candidates = [req.path, req.originalUrl?.split('?')[0] || ''];
    if (candidates.some(isExemptPath)) {
        next();
        return;
    }

    try {
        const dbPool = resolvePool(req);
        const { mustChange, reason } = await passwordPolicy.mustChangePassword(req.user.id, dbPool);

        if (mustChange) {
            logger.warn('User must change password', {
                userId: req.user.id,
                reason,
                path: req.path
            });

            res.status(403).json({
                success: false,
                error: reason === 'expired'
                    ? 'Your password has expired. Please change it to continue.'
                    : 'You must change your password before continuing.',
                code: 'PASSWORD_EXPIRED',
                passwordExpired: true,
                reason,
            });
            return;
        }

        next();
    } catch (error) {
        logger.error('Password expiry check failed', { error, userId: req.user.id });
        // Don't block on error - allow request to proceed
        next();
    }
}

/**
 * Optional middleware to add password expiry warning to response headers
 * Non-blocking - just adds headers for frontend to display warning
 */
export async function addPasswordExpiryHeader(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    // Skip if no user
    if (!req.user) {
        next();
        return;
    }

    try {
        const dbPool = resolvePool(req);
        const status = await passwordPolicy.getPasswordExpiryStatus(req.user.id, dbPool);

        if (status.daysUntilExpiry !== null && status.daysUntilExpiry <= 14) {
            res.setHeader('X-Password-Expiry-Warning', 'true');
            res.setHeader('X-Password-Days-Remaining', status.daysUntilExpiry.toString());
        }
    } catch (error) {
        logger.warn('Password expiry check failed', { error: (error as Error).message });
    }

    next();
}
