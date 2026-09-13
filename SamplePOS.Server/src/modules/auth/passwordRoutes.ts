/**
 * Password Policy Routes
 *
 * Endpoints for password management:
 * - GET /policy - Get password requirements
 * - POST /validate - Validate password strength
 * - POST /change - Change password with policy enforcement
 * - GET /expiry - Check password expiry status
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { authRateLimit, strictRateLimit } from '../../middleware/security.js';
import * as passwordPolicy from './passwordPolicyService.js';
import logger from '../../utils/logger.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { pool as globalPool } from '../../db/pool.js';
import type { Pool } from 'pg';

const ValidatePasswordSchema = z.object({
    password: z.string().min(1, 'Password is required'),
});

const ChangePasswordSchema = z
    .object({
        currentPassword: z.string().min(1, 'Current password is required'),
        newPassword: z.string().min(1, 'New password is required'),
        confirmPassword: z.string().min(1, 'Confirm password is required'),
    })
    .refine((data) => data.newPassword === data.confirmPassword, {
        message: 'New passwords do not match',
        path: ['confirmPassword'],
    });

const router = Router();

/**
 * GET /api/auth/password/policy
 * Get password policy requirements (public)
 */
router.get('/policy', (req: Request, res: Response) => {
    const config = passwordPolicy.getPasswordPolicyConfig();

    res.json({
        success: true,
        data: {
            requirements: {
                minLength: config.minLength,
                maxLength: config.maxLength,
                requireUppercase: config.requireUppercase,
                requireLowercase: config.requireLowercase,
                requireDigit: config.requireDigit,
                requireSpecial: config.requireSpecial,
            },
            expiryDays: config.expiryDays,
            historyCount: config.historyCount,
            maxFailedAttempts: config.maxFailedAttempts,
            lockoutMinutes: config.lockoutMinutes,
        },
    });
});

/**
 * POST /api/auth/password/validate
 * Validate password strength (no auth required - for forms)
 */
router.post('/validate', authRateLimit, (req: Request, res: Response) => {
    const { password } = ValidatePasswordSchema.parse(req.body);

    const validation = passwordPolicy.validatePassword(password);

    res.json({
        success: true,
        data: validation,
    });
});

/**
 * GET /api/auth/password/expiry
 * Check password expiry status (requires auth)
 */
router.get(
    '/expiry',
    authenticate,
    asyncHandler(async (req, res) => {
        const userId = req.user!.id;
        const dbPool = (req as unknown as { tenantPool?: Pool }).tenantPool || globalPool;
        const status = await passwordPolicy.getPasswordExpiryStatus(userId, dbPool);

        res.json({
            success: true,
            data: {
                expired: status.expired,
                expiresAt: status.expiresAt?.toISOString(),
                daysUntilExpiry: status.daysUntilExpiry,
                showWarning:
                    status.daysUntilExpiry !== null && status.daysUntilExpiry <= status.warningDays,
            },
        });
    })
);

/**
 * POST /api/auth/password/change
 * Change password with policy enforcement (requires auth)
 */
router.post(
    '/change',
    authenticate,
    strictRateLimit,
    asyncHandler(async (req, res) => {
        const userId = req.user!.id;
        const { currentPassword, newPassword } = ChangePasswordSchema.parse(req.body);

        // Verify current password
        const { findUserByEmail } = await import('./authRepository.js');
        const bcrypt = await import('bcrypt');
        const dbPool = (req as unknown as { tenantPool?: Pool }).tenantPool || globalPool;

        // Get user with password hash
        const userResult = await dbPool.query('SELECT email, password_hash FROM users WHERE id = $1', [
            userId,
        ]);

        if (userResult.rows.length === 0) {
            res.status(404).json({
                success: false,
                error: 'User not found',
            });
            return;
        }

        const isValidPassword = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
        if (!isValidPassword) {
            res.status(401).json({
                success: false,
                error: 'Current password is incorrect',
            });
            return;
        }

        // Update password with policy enforcement
        await passwordPolicy.updatePasswordWithPolicy(userId, newPassword, dbPool);

        const { publishNotificationEvent } = await import('../notifications/notificationPublisher.js');
        publishNotificationEvent({
            pool: dbPool,
            tenantId: req.tenantId || req.user?.tenantId,
            typeKey: 'SECURITY_PASSWORD_CHANGED',
            entityType: 'user',
            entityId: userId,
            idempotencyKey: `SECURITY_PASSWORD_CHANGED:user:${userId}:${Date.now()}`,
            payload: { subjectUserId: userId, summary: 'Your password was changed' },
            actorUserId: userId,
            subjectUserId: userId,
        });

        logger.info('Password changed successfully', { userId });

        res.json({
            success: true,
            message: 'Password changed successfully',
        });
    })
);

/**
 * GET /api/auth/password/must-change
 * Check if user must change password (requires auth)
 */
router.get(
    '/must-change',
    authenticate,
    asyncHandler(async (req, res) => {
        const userId = req.user!.id;
        const dbPool = (req as unknown as { tenantPool?: Pool }).tenantPool || globalPool;
        const result = await passwordPolicy.mustChangePassword(userId, dbPool);

        res.json({
            success: true,
            data: result,
        });
    })
);

export default router;
