// Auth Service - Business logic layer
// Handles authentication logic, password hashing, validation

import bcrypt from 'bcrypt';
import { Pool } from 'pg';
// import { LoginSchema, CreateUserSchema } from '../../../../shared/zod/user.js'; // Temporarily disabled - path issue
import { generateToken } from '../../middleware/auth.js';
import { findUserByEmail, findUserById, createUser, type UserRole } from './authRepository.js';
import * as passwordPolicy from './passwordPolicyService.js';
import logger from '../../utils/logger.js';

/**
 * Structured login failure — carries attempt metadata so the controller
 * can return CAPTCHA flags, attempts remaining, and lockout info.
 */
export class LoginFailedError extends Error {
  public readonly failedAttempts: number;
  public readonly maxAttempts: number;
  public readonly locked: boolean;
  public readonly remainingMinutes: number | null;
  /** Frontend should gate login behind a CAPTCHA challenge */
  public readonly requiresCaptcha: boolean;

  constructor(opts: {
    message: string;
    failedAttempts: number;
    maxAttempts?: number;
    locked?: boolean;
    remainingMinutes?: number | null;
  }) {
    super(opts.message);
    this.name = 'LoginFailedError';
    this.failedAttempts = opts.failedAttempts;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.locked = opts.locked ?? false;
    this.remainingMinutes = opts.remainingMinutes ?? null;
    // Require CAPTCHA after 3 consecutive failures
    this.requiresCaptcha = opts.failedAttempts >= 3;
  }
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterData {
  email: string;
  password: string;
  fullName: string;
  role: UserRole;
}

export interface AuthResponse {
  user: {
    id: string;
    email: string;
    fullName: string;
    role: UserRole;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
  };
  token: string;
}

/**
 * Authenticate user with email and password
 * @param pool - Database connection pool
 * @param credentials - Login credentials
 * @returns User data with JWT token
 * @throws Error if authentication fails
 */
export async function authenticateUser(
  pool: Pool,
  credentials: LoginCredentials
): Promise<
  AuthResponse & {
    passwordExpiry?: { expired: boolean; daysUntilExpiry: number | null };
    mustChangePassword?: { mustChange: boolean; reason: 'expired' | 'first_login' | null };
  }
> {
  // Validate input (basic validation - TODO: restore schema validation)
  if (!credentials.email || !credentials.password) {
    throw new Error('Email and password are required');
  }
  const validatedData = credentials;

  // Find user by email
  const user = await findUserByEmail(pool, validatedData.email);
  if (!user) {
    logger.warn('Login attempt with invalid email', { email: validatedData.email });
    throw new LoginFailedError({
      message: 'Invalid email or password',
      failedAttempts: 1,
    });
  }

  // Check account lockout status (must use tenant pool, not globalPool)
  const lockoutStatus = await passwordPolicy.checkAccountLockout(user.id, pool);
  if (lockoutStatus.locked) {
    logger.warn('Login attempt for locked account', {
      email: validatedData.email,
      remainingMinutes: lockoutStatus.remainingMinutes
    });
    throw new LoginFailedError({
      message: `Account is locked. Please try again in ${lockoutStatus.remainingMinutes} minutes.`,
      failedAttempts: lockoutStatus.failedAttempts,
      locked: true,
      remainingMinutes: lockoutStatus.remainingMinutes,
    });
  }

  // Check if account is active
  if (!user.isActive) {
    logger.warn('Login attempt for disabled account', { email: validatedData.email });
    throw new Error('Account is disabled');
  }

  // Verify password
  const isValidPassword = await bcrypt.compare(validatedData.password, user.passwordHash);
  if (!isValidPassword) {
    // Record failed attempt (must use tenant pool)
    const failedStatus = await passwordPolicy.recordFailedLoginAttempt(user.id, pool);

    if (failedStatus.locked) {
      throw new LoginFailedError({
        message: `Too many failed attempts. Account locked for ${failedStatus.remainingMinutes} minutes.`,
        failedAttempts: failedStatus.failedAttempts,
        locked: true,
        remainingMinutes: failedStatus.remainingMinutes,
      });
    }

    const attemptsRemaining = 5 - failedStatus.failedAttempts;
    logger.warn('Login attempt with invalid password', {
      email: validatedData.email,
      attemptsRemaining,
    });
    throw new LoginFailedError({
      message: 'Invalid email or password',
      failedAttempts: failedStatus.failedAttempts,
    });
  }

  // Successful login - reset failed attempts (must use tenant pool)
  await passwordPolicy.resetFailedLoginAttempts(user.id, pool);

  // Check password expiry / forced change (tenant pool)
  const expiryStatus = await passwordPolicy.getPasswordExpiryStatus(user.id, pool);
  const mustChangePassword = await passwordPolicy.mustChangePassword(user.id, pool);

  // Generate JWT token
  const token = generateToken(user);

  // Remove password hash from response
  const { passwordHash, ...userWithoutPassword } = user;

  logger.info('User logged in successfully', { userId: user.id, email: user.email });

  return {
    user: userWithoutPassword,
    token,
    passwordExpiry: {
      expired: expiryStatus.expired,
      daysUntilExpiry: expiryStatus.daysUntilExpiry,
    },
    mustChangePassword,
  };
}

/**
 * Register new user
 * @param pool - Database connection pool
 * @param data - Registration data
 * @returns User data with JWT token
 * @throws Error if registration fails
 */
export async function registerUser(pool: Pool, data: RegisterData): Promise<AuthResponse> {
  // Validate input (basic validation - TODO: restore schema validation)
  if (!data.email || !data.password || !data.fullName || !data.role) {
    throw new Error('All fields are required');
  }
  const validatedData = data;

  // Validate password meets policy requirements
  const passwordValidation = passwordPolicy.validatePassword(validatedData.password);
  if (!passwordValidation.valid) {
    throw new Error(`Password does not meet requirements: ${passwordValidation.errors.join(', ')}`);
  }

  // Check if user already exists
  const existingUser = await findUserByEmail(pool, validatedData.email);
  if (existingUser) {
    logger.warn('Registration attempt with existing email', { email: validatedData.email });
    throw new Error('Email already registered');
  }

  // Hash password with stronger salt rounds
  const passwordHash = await bcrypt.hash(validatedData.password, 12);

  // Create user
  const user = await createUser(pool, {
    email: validatedData.email,
    passwordHash,
    fullName: validatedData.fullName,
    role: validatedData.role,
  });

  // Generate JWT token
  const token = generateToken(user);

  logger.info('User registered successfully', { userId: user.id, email: user.email });

  return {
    user,
    token,
  };
}

/**
 * Get user profile by ID
 * @param pool - Database connection pool
 * @param userId - User ID
 * @returns User profile data
 * @throws Error if user not found
 */
/**
 * Get user profile by ID (excludes password hash)
 * @param pool - Database connection pool
 * @param userId - User UUID
 * @returns User profile data without sensitive fields
 * @throws Error if user not found
 * 
 * Use Cases:
 * - Profile page display
 * - Admin user management
 * - Audit trail user lookups
 */
export async function getUserProfile(pool: Pool, userId: string) {
  const user = await findUserById(pool, userId);
  if (!user) {
    logger.warn('Profile request for non-existent user', { userId });
    throw new Error('User not found');
  }

  return user;
}
