// User Service - Business logic layer for user operations

import type { Pool, PoolClient } from 'pg';
import * as userRepository from './userRepository.js';
import type { User, CreateUser, UpdateUser, ChangePassword, AdminResetPassword, UserRole } from '../../../../shared/zod/user.js';
import logger from '../../utils/logger.js';
import { BusinessError, NotFoundError } from '../../middleware/errorHandler.js';
import { UnitOfWork } from '../../db/unitOfWork.js';
import { rbacRoleNameMapsToLegacyAdmin } from '../../../../shared/authorization/rbacAdminRole.js';
import { publishNotificationEvent } from '../notifications/notificationPublisher.js';
import * as notificationRepo from '../notifications/notificationRepository.js';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Map RBAC role name to legacy users.role column value.
 * The legacy column has a CHECK constraint: ADMIN, MANAGER, CASHIER, STAFF
 */
function mapRbacRoleToLegacy(rbacRoleName: string): UserRole {
  const name = rbacRoleName.toLowerCase();
  if (rbacRoleNameMapsToLegacyAdmin(rbacRoleName)) return 'ADMIN';
  if (name.includes('manager')) return 'MANAGER';
  if (name === 'cashier') return 'CASHIER';
  // Waiter / kitchen staff / custom roles → STAFF (CHECK constraint has no WAITER)
  return 'STAFF';
}

/**
 * Resolve RBAC role ID to its name and derive legacy role.
 * Also assigns the RBAC role to the user within the transaction.
 */
async function resolveAndAssignRbacRole(
  client: PoolClient,
  userId: string,
  rbacRoleId: string
): Promise<{ legacyRole: UserRole; rbacRoleName: string }> {
  // Look up the RBAC role
  const roleResult = await client.query<{ name: string }>(
    `SELECT name FROM rbac_roles WHERE id = $1 AND is_active = true`,
    [rbacRoleId]
  );
  if (roleResult.rows.length === 0) {
    throw new BusinessError('RBAC role not found', 'ERR_ROLE_001', { rbacRoleId });
  }
  const rbacRoleName = roleResult.rows[0].name;
  const legacyRole = mapRbacRoleToLegacy(rbacRoleName);

  // Deactivate any existing RBAC role assignments
  await client.query(
    `UPDATE rbac_user_roles SET is_active = false WHERE user_id = $1 AND is_active = true`,
    [userId]
  );

  // Assign the new RBAC role
  await client.query(
    `INSERT INTO rbac_user_roles (user_id, role_id, assigned_by, is_active)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (user_id, role_id, COALESCE(scope_type, ''), COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'))
     DO UPDATE SET is_active = true, assigned_at = NOW(), assigned_by = EXCLUDED.assigned_by`,
    [userId, rbacRoleId, SYSTEM_USER_ID]
  );

  return { legacyRole, rbacRoleName };
}

/**
 * Get all users (admin/manager only)
 * @param pool - Database connection pool
 * @returns List of all users (passwords excluded)
 *
 * Features:
 * - Excludes password_hash for security
 * - Includes active and inactive users
 * - Role information included
 *
 * Use Cases:
 * - Admin user management dashboard
 * - User selection dropdowns
 * - Audit reports
 */
export async function getAllUsers(pool: Pool): Promise<User[]> {
  return userRepository.findAllUsers(pool);
}

/**
 * Get user by ID
 */
export async function getUserById(pool: Pool, id: string): Promise<User> {
  const user = await userRepository.findUserById(id, pool);

  if (!user) {
    throw new NotFoundError('User');
  }

  return user;
}

/**
 * Create new user with role assignment (ATOMIC TRANSACTION)
 * @param pool - Database connection pool
 * @param data - User creation data (email, password, name, role)
 * @returns Created user with auto-generated user_number
 * @throws Error if email already exists
 *
 * Business Rules:
 * - Email must be unique across all users
 * - Password hashed using bcrypt (salt rounds: 12)
 * - user_number auto-generated: USER-YYYY-####
 *
 * Roles:
 * - ADMIN: Full system access
 * - MANAGER: Sales, inventory, reports (no system settings)
 * - CASHIER: POS operations only
 * - STAFF: Limited read access
 *
 * Transaction Flow:
 * 1. Validate email uniqueness
 * 2. Hash password with bcrypt
 * 3. Create user record
 * 4. Commit transaction atomically
 *
 * Security:
 * - Password never stored in plain text
 * - Bcrypt with salt for one-way hashing
 * - Rate limiting on auth endpoints (middleware)
 */
export async function createUser(pool: Pool, data: CreateUser, actorUserId?: string | null): Promise<User> {
  // Check if email already exists
  const existingUser = await userRepository.findUserByEmail(data.email, pool);

  if (existingUser) {
    throw new BusinessError('Email already in use', 'ERR_USER_001', { email: data.email });
  }

  // Transaction: Create user atomically with role assignment
  const created = await UnitOfWork.run(pool, async (client) => {
    // If rbacRoleId is provided, derive the legacy role from it
    let createData = data;
    if (data.rbacRoleId) {
      // We need a placeholder role first — resolve after user creation
      const roleResult = await client.query<{ name: string }>(
        `SELECT name FROM rbac_roles WHERE id = $1 AND is_active = true`,
        [data.rbacRoleId]
      );
      if (roleResult.rows.length === 0) {
        throw new BusinessError('RBAC role not found', 'ERR_ROLE_001', { rbacRoleId: data.rbacRoleId });
      }
      const legacyRole = mapRbacRoleToLegacy(roleResult.rows[0].name);
      createData = { ...data, role: legacyRole };
    }

    const user = await userRepository.createUser(createData, client);

    // Assign RBAC role if provided
    if (data.rbacRoleId) {
      await resolveAndAssignRbacRole(client, user.id, data.rbacRoleId);
    }

    logger.info('User created (transaction committed)', {
      userId: user.id,
      email: user.email,
      role: user.role,
      rbacRoleId: data.rbacRoleId,
    });

    // Re-fetch to include RBAC role info in response
    const fullUser = await userRepository.findUserById(user.id, client);
    return fullUser ?? user;
  });
  publishNotificationEvent({
    pool,
    typeKey: 'SECURITY_USER_CREATED',
    entityType: 'user',
    entityId: created.id,
    idempotencyKey: `SECURITY_USER_CREATED:user:${created.id}`,
    payload: { summary: 'A user account was created', documentRef: created.email },
    actorUserId: actorUserId ?? null,
    subjectUserId: created.id,
  });
  return created;
}

/**
 * Update user details (partial update supported)
 * @param pool - Database connection pool
 * @param id - User UUID to update
 * @param data - Fields to update (all optional)
 * @returns Updated user record
 * @throws Error if email conflict or user not found
 *
 * Updatable Fields:
 * - email (with uniqueness validation)
 * - name, phone
 * - role (ADMIN, MANAGER, CASHIER, STAFF)
 * - is_active (soft delete)
 *
 * Business Rules:
 * - Cannot change email to one already in use
 * - Cannot update password via this endpoint (use changePassword)
 * - Audit trail: updated_at timestamp auto-updated
 *
 * Security:
 * - Only ADMIN can change user roles
 * - Users can update own profile (limited fields)
 * - Password changes require old password verification
 */
export async function updateUser(pool: Pool, id: string, data: UpdateUser): Promise<User> {
  // If email is being changed, check it's not already in use
  if (data.email) {
    const existingUser = await userRepository.findUserByEmail(data.email, pool);
    if (existingUser && existingUser.id !== id) {
      throw new BusinessError('Email already in use', 'ERR_USER_001', {
        email: data.email,
        conflictUserId: existingUser.id,
      });
    }
  }

  // Transaction: Update user atomically with role changes
  return UnitOfWork.run(pool, async (client) => {
    // If rbacRoleId is provided, derive the legacy role from it
    let updateData = data;
    if (data.rbacRoleId) {
      const { legacyRole } = await resolveAndAssignRbacRole(client, id, data.rbacRoleId);
      updateData = { ...data, role: legacyRole };
    }

    const user = await userRepository.updateUser(id, updateData, client);

    if (!user) {
      throw new NotFoundError('User');
    }

    logger.info('User updated (transaction committed)', {
      userId: user.id,
      updates: Object.keys(data),
      rbacRoleId: data.rbacRoleId,
    });

    // Re-fetch to include RBAC role info in response
    const fullUser = await userRepository.findUserById(id, client);
    return fullUser ?? user;
  });
}

/**
 * Change user password
 */
export async function changePassword(
  pool: Pool,
  userId: string,
  data: ChangePassword
): Promise<void> {
  const user = await userRepository.findUserById(userId, pool);

  if (!user) {
    throw new NotFoundError('User');
  }

  // Verify current password
  const isValid = await userRepository.verifyUserPassword(user.email, data.currentPassword, pool);

  if (!isValid) {
    throw new BusinessError('Current password is incorrect', 'ERR_USER_002', { userId });
  }

  const success = await userRepository.changeUserPassword(userId, data.newPassword, pool);

  if (!success) {
    throw new BusinessError('Failed to change password', 'ERR_USER_003', { userId });
  }

  logger.info('Password changed', { userId });
}

/**
 * Admin reset password (no current password required)
 */
export async function adminResetPassword(
  pool: Pool,
  userId: string,
  data: AdminResetPassword
): Promise<void> {
  const user = await userRepository.findUserById(userId, pool);

  if (!user) {
    throw new NotFoundError('User');
  }

  const success = await userRepository.changeUserPassword(userId, data.newPassword, pool);

  if (!success) {
    throw new BusinessError('Failed to reset password', 'ERR_USER_004', { userId });
  }

  logger.info('Password reset by admin', { userId });
}

/**
 * Delete user (soft delete by default, hard delete if specified)
 */
export async function deleteUser(
  pool: Pool,
  id: string,
  hardDelete: boolean = false,
  actorUserId?: string | null,
): Promise<{ deleted: boolean; message: string }> {
  const user = await userRepository.findUserById(id, pool);

  if (!user) {
    throw new NotFoundError('User');
  }

  // Check if user has associated data
  const hasData = await userRepository.userHasData(id, pool);

  if (hardDelete) {
    if (hasData) {
      throw new BusinessError(
        'Cannot permanently delete user with associated transactions. Please deactivate instead.',
        'ERR_USER_004',
        { userId: id, hasTransactions: true }
      );
    }
    const success = await userRepository.hardDeleteUser(id, pool);
    if (!success) {
      throw new BusinessError('Failed to delete user', 'ERR_USER_005', { userId: id });
    }
    logger.info('User permanently deleted', { userId: id, email: user.email });
    return { deleted: true, message: 'User permanently deleted' };
  } else {
    const success = await userRepository.deleteUser(id, pool);
    if (!success) {
      throw new BusinessError('Failed to deactivate user', 'ERR_USER_006', { userId: id });
    }
    await notificationRepo.revokeAllDevicesForUser(pool, id);
    publishNotificationEvent({
      pool,
      typeKey: 'SECURITY_ACCOUNT_DISABLED',
      entityType: 'user',
      entityId: id,
      idempotencyKey: `SECURITY_ACCOUNT_DISABLED:user:${id}:${Date.now()}`,
      payload: { summary: 'A user account was deactivated' },
      actorUserId: actorUserId ?? id,
    });
    logger.info('User deactivated', { userId: id, email: user.email });
    return { deleted: false, message: 'User deactivated successfully' };
  }
}

/**
 * Get user statistics
 */
export async function getUserStats(pool: Pool) {
  const total = await userRepository.countUsers(pool);
  const users = await userRepository.findAllUsers(pool);

  const roleCount = users.reduce(
    (acc, user) => {
      acc[user.role] = (acc[user.role] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return {
    total,
    active: users.filter((u) => u.isActive).length,
    inactive: users.filter((u) => !u.isActive).length,
    byRole: roleCount,
  };
}
