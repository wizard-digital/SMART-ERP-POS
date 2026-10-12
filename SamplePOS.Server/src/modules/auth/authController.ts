// Auth Controller - HTTP request handlers
// Validates input, calls service layer, formats responses
// SECURITY: Uses req.tenantPool for multi-tenant isolation

import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { pool as globalPool } from '../../db/pool.js';
import { connectionManager } from '../../db/connectionManager.js';
import { tenantRepository } from '../platform/tenantRepository.js';
import { authenticateUser, registerUser, getUserProfile, LoginFailedError } from './authService.js';
import * as auditService from '../audit/auditService.js';
import * as twoFactorService from './twoFactorService.js';
import * as refreshTokenService from './refreshTokenService.js';
import { resetAuthRateLimit } from '../../middleware/security.js';
import { asyncHandler, UnauthorizedError, NotFoundError, ConflictError } from '../../middleware/errorHandler.js';
import logger from '../../utils/logger.js';

const LoginSchema = z.object({
  email: z.string().email('Valid email is required'),
  password: z.string().min(1, 'Password is required'),
});

const RegisterSchema = z.object({
  email: z.string().email('Valid email is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  fullName: z.string().min(1, 'Full name is required').max(255),
  role: z.enum(['ADMIN', 'MANAGER', 'CASHIER', 'STAFF']).default('STAFF'),
});

/**
 * Login controller
 * POST /api/auth/login
 */
export const login = asyncHandler(async (req: Request, res: Response) => {
  try {
    // SECURITY: Use tenant pool for multi-tenant isolation
    const pool = req.tenantPool || globalPool;
    const tenantId = req.tenantId;
    const tenantSlug = req.tenant?.slug;
    const credentials = LoginSchema.parse(req.body);
    const result = await authenticateUser(pool, credentials);

    // Successful auth — clear IP-based rate limit so the user is never locked out
    resetAuthRateLimit(req);

    // Check if 2FA is enabled for this user
    const twoFactorStatus = await twoFactorService.get2FAStatus(result.user.id, pool);

    if (twoFactorStatus.enabled) {
      // 2FA is enabled - return partial login, require 2FA verification
      logger.info('2FA verification required', { userId: result.user.id, email: result.user.email });

      res.json({
        success: true,
        data: {
          requires2FA: true,
          userId: result.user.id,
        },
        message: 'Please enter your 2FA code',
      });
      return;
    }

    // Check if user's role requires 2FA but it's not set up
    if (twoFactorStatus.required && !twoFactorStatus.enabled) {
      logger.info('2FA setup required for role', { userId: result.user.id, role: result.user.role });

      // Generate token pair even when 2FA setup is required
      const deviceInfo = req.headers['user-agent'] || undefined;
      const ipAddress = req.ip || req.socket.remoteAddress || undefined;
      const tokenPair = await refreshTokenService.generateTokenPair(
        { id: result.user.id, email: result.user.email, fullName: result.user.fullName, role: result.user.role, tenantId, tenantSlug },
        deviceInfo,
        ipAddress,
        pool
      );

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
          user: result.user,
          token: tokenPair.accessToken,
          accessToken: tokenPair.accessToken,
          refreshToken: tokenPair.refreshToken,
          expiresIn: tokenPair.expiresIn,
          requires2FASetup: true,
          passwordExpiry: result.passwordExpiry,
          mustChangePassword: result.mustChangePassword,
        },
        message: 'Login successful. 2FA setup is required for your role.',
      });
      return;
    }

    // Generate token pair for successful login
    const deviceInfo = req.headers['user-agent'] || undefined;
    const ipAddress = req.ip || req.socket.remoteAddress || undefined;
    const tokenPair = await refreshTokenService.generateTokenPair(
      { id: result.user.id, email: result.user.email, fullName: result.user.fullName, role: result.user.role, tenantId, tenantSlug },
      deviceInfo,
      ipAddress,
      pool
    );

    // Set refresh token as httpOnly cookie
    res.cookie('refreshToken', tokenPair.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      path: '/api/auth/token',
    });

    // Create user session and log login audit entry
    try {
      const auditContext = {
        userId: result.user.id,
        userName: result.user.fullName,
        userRole: result.user.role,
        ipAddress: req.ip || req.socket.remoteAddress,
        userAgent: req.headers['user-agent'],
      };

      const session = await auditService.logUserLogin(
        pool,
        result.user.id,
        result.user.fullName,
        result.user.role,
        auditContext
      );

      res.cookie('sessionId', session.id, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: 'strict',
      });
    } catch (auditError) {
      logger.error('Audit logging failed for login (non-fatal)', { error: auditError });
    }

    res.json({
      success: true,
      data: {
        user: result.user,
        token: tokenPair.accessToken,
        accessToken: tokenPair.accessToken,
        refreshToken: tokenPair.refreshToken,
        expiresIn: tokenPair.expiresIn,
        passwordExpiry: result.passwordExpiry,
        mustChangePassword: result.mustChangePassword,
      },
      message: 'Login successful',
    });
  } catch (error) {
    // ── Artificial delay on ALL login failures (600ms) ────────────
    // Prevents timing attacks and slows brute-force automation.
    await new Promise(resolve => setTimeout(resolve, 600));

    // ── Structured LoginFailedError (per-user lockout) ───────────
    if (error instanceof LoginFailedError) {
      // ── Super admin fallback: check before returning failure ──
      if (error.message === 'Invalid email or password') {
        try {
          const masterPool = connectionManager.getMasterPool();
          const superAdmin = await tenantRepository.findSuperAdminByEmail(masterPool, req.body.email);

          if (superAdmin && superAdmin.isActive) {
            const validPassword = await bcrypt.compare(req.body.password, superAdmin.passwordHash);

            if (validPassword) {
              logger.info('Super admin detected via tenant login — redirecting to platform portal', { email: superAdmin.email });
              res.json({
                success: true,
                data: { isSuperAdmin: true, redirectTo: '/platform/login' },
                message: 'Please use the Platform Admin portal to log in.',
              });
              return;
            }
          }
        } catch (superAdminError) {
          logger.debug('Super admin fallback check failed (non-fatal)', {
            error: superAdminError instanceof Error ? superAdminError.message : String(superAdminError),
          });
        }
      }

      // Log to audit trail
      try {
        const auditContext = {
          userId: '00000000-0000-0000-0000-000000000000',
          userName: 'Anonymous',
          userRole: 'NONE' as string,
          ipAddress: req.ip || req.socket.remoteAddress,
          userAgent: req.headers['user-agent'],
        };
        await auditService.logLoginFailed(
          req.tenantPool || globalPool,
          req.body.email || 'unknown',
          error.message,
          auditContext
        );
      } catch (auditError) {
        logger.error('Audit logging failed for failed login (non-fatal)', {
          error: auditError instanceof Error ? auditError.message : String(auditError),
        });
      }

      const statusCode = error.locked ? 423 : 401; // 423 Locked for account lockout
      res.status(statusCode).json({
        success: false,
        error: error.locked
          ? `Account is locked. Please try again in ${error.remainingMinutes} minutes.`
          : `Invalid email or password. ${error.maxAttempts - error.failedAttempts} attempts remaining.`,
        data: {
          failedAttempts: error.failedAttempts,
          maxAttempts: error.maxAttempts,
          locked: error.locked,
          remainingMinutes: error.remainingMinutes,
          requiresCaptcha: error.requiresCaptcha,
        },
      });
      return;
    }

    // ── Super admin fallback ──────────────────────────────
    // If tenant login fails with "Invalid email or password",
    // check the master DB's super_admins table so platform
    // admins can log in through any tenant's login page.
    if (error instanceof Error && error.message === 'Invalid email or password') {
      try {
        const masterPool = connectionManager.getMasterPool();
        const superAdmin = await tenantRepository.findSuperAdminByEmail(masterPool, req.body.email);

        if (superAdmin && superAdmin.isActive) {
          const validPassword = await bcrypt.compare(req.body.password, superAdmin.passwordHash);

          if (validPassword) {
            logger.info('Super admin detected via tenant login — redirecting to platform portal', { email: superAdmin.email });

            res.json({
              success: true,
              data: {
                isSuperAdmin: true,
                redirectTo: '/platform/login',
              },
              message: 'Please use the Platform Admin portal to log in.',
            });
            return;
          }
        }
      } catch (superAdminError) {
        logger.debug('Super admin fallback check failed (non-fatal)', {
          error: superAdminError instanceof Error ? superAdminError.message : String(superAdminError),
        });
      }
    }

    logger.error('Login failed', { error, body: req.body });

    // Log failed login attempt to audit trail
    try {
      const auditContext = {
        userId: '00000000-0000-0000-0000-000000000000',
        userName: 'Anonymous',
        userRole: 'NONE' as string,
        ipAddress: req.ip || req.socket.remoteAddress,
        userAgent: req.headers['user-agent'],
      };

      await auditService.logLoginFailed(
        req.tenantPool || globalPool,
        req.body.email || 'unknown',
        error instanceof Error ? error.message : 'Unknown error',
        auditContext
      );
    } catch (auditError) {
      logger.error('Audit logging failed for failed login (non-fatal)', {
        error: auditError instanceof Error ? auditError.message : String(auditError),
        stack: auditError instanceof Error ? auditError.stack : undefined
      });
    }

    // Handle authentication errors with 401
    if (error instanceof Error) {
      if (error.message === 'Invalid email or password' || error.message === 'Account is disabled') {
        throw new UnauthorizedError(error.message);
      }
    }

    // Re-throw for asyncHandler → global error handler
    throw error;
  }
});

/**
 * Register controller
 * POST /api/auth/register
 */
export const register = asyncHandler(async (req: Request, res: Response) => {
  const regPool = req.tenantPool || globalPool;
  try {
    const validated = RegisterSchema.parse(req.body);
    const result = await registerUser(regPool, validated);
    res.status(201).json({
      success: true,
      data: result,
      message: 'User registered successfully',
    });
  } catch (error) {
    // Handle duplicate email error
    if (error instanceof Error && error.message === 'Email already registered') {
      throw new ConflictError(error.message);
    }
    throw error;
  }
});

/**
 * Logout controller
 * POST /api/auth/logout
 */
export const logout = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?.id;
  const userName = req.user?.fullName;
  const sessionId = req.cookies?.sessionId || (req.headers['x-session-id'] as string);

  if (userId && sessionId) {
    try {
      const auditContext = {
        userId,
        userName: userName || 'Unknown',
        userRole: req.user?.role || 'STAFF',
        sessionId,
        ipAddress: req.ip || req.socket.remoteAddress,
        userAgent: req.headers['user-agent'],
      };

      const logoutPool = req.tenantPool || globalPool;
      await auditService.logUserLogout(logoutPool, sessionId, 'MANUAL', auditContext);
      res.clearCookie('sessionId');
    } catch (auditError) {
      logger.error('Audit logging failed for logout (non-fatal)', {
        error: auditError instanceof Error ? auditError.message : String(auditError),
        stack: auditError instanceof Error ? auditError.stack : undefined,
        sessionId,
        userId
      });
    }
  }

  // Revoke refresh token if present
  const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
  if (refreshToken) {
    try {
      const logoutPool = req.tenantPool || globalPool;
      await refreshTokenService.revokeRefreshToken(refreshToken, logoutPool);
    } catch (revokeError) {
      logger.error('Failed to revoke refresh token (non-fatal)', { error: revokeError });
    }
  }

  res.clearCookie('refreshToken', { path: '/api/auth/token' });
  res.json({ success: true, message: 'Logout successful' });
});

/**
 * Get profile controller
 * GET /api/auth/profile
 */
export const getProfile = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    throw new UnauthorizedError('Not authenticated');
  }

  const profilePool = req.tenantPool || globalPool;
  try {
    const user = await getUserProfile(profilePool, userId);
    res.json({ success: true, data: user });
  } catch (error) {
    if (error instanceof Error && error.message === 'User not found') {
      throw new NotFoundError('User');
    }
    throw error;
  }
});
