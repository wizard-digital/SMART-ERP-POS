/**
 * Two-Factor Authentication Routes
 * 
 * Endpoints for 2FA setup, verification, and management.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate, authorize, generateToken } from '../../middleware/auth.js';
import * as twoFactorService from './twoFactorService.js';
import * as refreshTokenService from './refreshTokenService.js';
import * as passwordPolicy from './passwordPolicyService.js';
import { strictRateLimit } from '../../middleware/security.js';
import logger from '../../utils/logger.js';
import { pool as globalPool } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';

const TwoFactorTokenSchema = z.object({
  token: z.string().length(6, 'Token must be a 6-digit code'),
});

const TwoFactorVerifySchema = z.object({
  userId: z.string().uuid('User ID must be a valid UUID'),
  token: z.string().min(1, 'Token is required'),
});

const router = Router();

/**
 * GET /api/auth/2fa/status
 * Get current 2FA status for the authenticated user
 */
router.get('/status', authenticate, asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const status = await twoFactorService.get2FAStatus(userId, req.tenantPool);

    res.json({
        success: true,
        data: status,
    });
}));

/**
 * POST /api/auth/2fa/setup
 * Initialize 2FA setup - returns QR code and backup codes
 */
router.post('/setup', authenticate, asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const email = req.user!.email;

    const setupResult = await twoFactorService.setup2FA(userId, email, req.tenantPool);

    res.json({
        success: true,
        data: {
            qrCodeDataUrl: setupResult.qrCodeDataUrl,
            backupCodes: setupResult.backupCodes,
            // Don't return the secret directly for security
            // User should scan QR code with authenticator app
        },
        message: 'Scan the QR code with your authenticator app, then verify with a code to enable 2FA',
    });
}));

/**
 * POST /api/auth/2fa/verify-setup
 * Verify 2FA setup with a token from authenticator app
 */
router.post('/verify-setup', authenticate, strictRateLimit, asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const { token } = TwoFactorTokenSchema.parse(req.body);

    const verified = await twoFactorService.verify2FASetup(userId, token, req.tenantPool);

    if (!verified) {
        res.status(400).json({
            success: false,
            error: 'Invalid verification code. Please try again.',
        });
        return;
    }

    res.json({
        success: true,
        message: '2FA has been enabled successfully. Please save your backup codes in a secure location.',
    });
}));

/**
 * POST /api/auth/2fa/verify
 * Verify 2FA token during login (called after initial login)
 * Returns JWT token on successful verification
 */
router.post('/verify', strictRateLimit, asyncHandler(async (req, res) => {
    const { userId, token } = TwoFactorVerifySchema.parse(req.body);

    // Normalize token (remove spaces/dashes for backup codes)
    const normalizedToken = token.toString().replace(/[\s-]/g, '');

    const verified = await twoFactorService.verify2FALogin(userId, normalizedToken, req.tenantPool);

    if (!verified) {
        logger.warn('2FA verification failed', { userId, tokenLength: normalizedToken.length });
        res.status(401).json({
            success: false,
            error: 'Invalid 2FA code. Please check your authenticator app and try again.',
        });
        return;
    }

    // Get user data to generate token
    const queryPool = req.tenantPool || globalPool;
    const userResult = await queryPool.query(
        `SELECT id, email, full_name as "fullName", role, is_active as "isActive", 
          created_at as "createdAt", updated_at as "updatedAt"
       FROM users WHERE id = $1`,
        [userId]
    );

    if (userResult.rows.length === 0) {
        res.status(404).json({
            success: false,
            error: 'User not found',
        });
        return;
    }

    const user = userResult.rows[0];

    // Generate JWT token pair after successful 2FA (with tenant context)
    const deviceInfo = req.headers['user-agent'] || undefined;
    const ipAddress = req.ip || req.socket.remoteAddress || undefined;
    const tokenPair = await refreshTokenService.generateTokenPair(
        {
            id: user.id,
            email: user.email,
            fullName: user.fullName,
            role: user.role,
            tenantId: req.tenantId,
            tenantSlug: req.tenant?.slug,
        },
        deviceInfo,
        ipAddress,
        queryPool
    );

    // Same soft-expiry payload as password login — client soft-redirects; no hard API brick.
    const expiryStatus = await passwordPolicy.getPasswordExpiryStatus(userId, queryPool);
    const mustChangePassword = await passwordPolicy.mustChangePassword(userId, queryPool);

    logger.info('2FA login verified, token issued', { userId, email: user.email });

    // Set refresh token as httpOnly cookie
    res.cookie('refreshToken', tokenPair.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        path: '/api/auth/token',
    });

    res.json({
        success: true,
        data: {
            user: {
                id: user.id,
                email: user.email,
                fullName: user.fullName,
                role: user.role,
                isActive: user.isActive,
                createdAt: user.createdAt,
                updatedAt: user.updatedAt,
            },
            token: tokenPair.accessToken,
            accessToken: tokenPair.accessToken,
            refreshToken: tokenPair.refreshToken,
            expiresIn: tokenPair.expiresIn,
            passwordExpiry: {
                expired: expiryStatus.expired,
                daysUntilExpiry: expiryStatus.daysUntilExpiry,
            },
            mustChangePassword,
        },
        message: '2FA verification successful',
    });
}));

/**
 * POST /api/auth/2fa/disable
 * Disable 2FA (requires current 2FA token)
 */
router.post('/disable', authenticate, strictRateLimit, asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const { token } = z.object({ token: z.string().min(1, '2FA token is required') }).parse(req.body);

    await twoFactorService.disable2FA(userId, token, req.tenantPool);

    res.json({
        success: true,
        message: '2FA has been disabled',
    });
}));

/**
 * POST /api/auth/2fa/regenerate-backup-codes
 * Regenerate backup codes (requires current 2FA token)
 */
router.post('/regenerate-backup-codes', authenticate, strictRateLimit, asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const { token } = z.object({ token: z.string().min(1, '2FA token is required') }).parse(req.body);

    const newBackupCodes = await twoFactorService.regenerateBackupCodes(userId, token, req.tenantPool);

    res.json({
        success: true,
        data: {
            backupCodes: newBackupCodes,
        },
        message: 'New backup codes generated. Please save them in a secure location.',
    });
}));

export default router;

