// User Repository - Database layer for user CRUD operations
// Contains ONLY SQL queries - NO business logic

import { pool as globalPool } from '../../db/pool.js';
import type pg from 'pg';
import type { User, CreateUser, UpdateUser } from '../../../../shared/zod/user.js';
import bcrypt from 'bcrypt';
import { BusinessError } from '../../middleware/errorHandler.js';
import { SYSTEM_USER_ID } from '../../utils/constants.js';

/** Re-export SSOT — built-in account that owns history after a human login is removed. */
export { SYSTEM_USER_ID };

/**
 * Rows that exist only for a login. Permanent delete removes them.
 * Business documents (audit, treasury, reports) are not in this set.
 */
export const USER_DELETE_IDENTITY_TABLES = new Set([
  'refresh_tokens',
  'user_sessions',
  'trusted_devices',
  'notification_device_subscriptions',
  'notification_user_preferences',
  'notifications',
  'quick_login_audit',
  'rbac_user_roles',
  'user_roles',
  'user_permissions',
]);

export type UserFkReleaseAction = 'skip' | 'delete-rows' | 'set-null' | 'reassign';

/** How a foreign key to users is cleared so DELETE FROM users can succeed. */
export function userFkReleaseAction(
  tableName: string,
  notNull: boolean,
  deleteAction: string,
): UserFkReleaseAction {
  if (deleteAction === 'c' || deleteAction === 'n') return 'skip';
  if (USER_DELETE_IDENTITY_TABLES.has(tableName)) return 'delete-rows';
  if (!notNull) return 'set-null';
  return 'reassign';
}

function quoteIdent(ident: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
    throw new BusinessError(
      'Cannot delete this user because a database link uses an unexpected name.',
      'ERR_USER_007',
      { ident },
    );
  }
  return `"${ident}"`;
}

/** Accept both Pool (normal queries) and PoolClient (inside transactions) */
type DbClient = pg.Pool | pg.PoolClient;

const SALT_ROUNDS = 12;

/**
 * Find all users (excluding password hashes)
 */
export async function findAllUsers(dbPool?: DbClient): Promise<User[]> {
  const pool = dbPool || globalPool;
  const result = await pool.query(
    `SELECT 
      u.id,
      u.user_number as "userNumber",
      u.email,
      u.full_name as "fullName",
      u.role,
      u.is_active as "isActive",
      u.created_at as "createdAt",
      u.updated_at as "updatedAt",
      r.id as "rbacRoleId",
      r.name as "rbacRoleName"
    FROM users u
    LEFT JOIN rbac_user_roles ur ON ur.user_id = u.id AND ur.is_active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
    LEFT JOIN rbac_roles r ON r.id = ur.role_id AND r.is_active = true
    ORDER BY u.created_at DESC`
  );

  return result.rows;
}

/**
 * Find user by ID (excluding password hash)
 */
export async function findUserById(id: string, dbPool?: DbClient): Promise<User | null> {
  const pool = dbPool || globalPool;
  const result = await pool.query(
    `SELECT 
      u.id,
      u.user_number as "userNumber",
      u.email,
      u.full_name as "fullName",
      u.role,
      u.is_active as "isActive",
      u.created_at as "createdAt",
      u.updated_at as "updatedAt",
      r.id as "rbacRoleId",
      r.name as "rbacRoleName"
    FROM users u
    LEFT JOIN rbac_user_roles ur ON ur.user_id = u.id AND ur.is_active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
    LEFT JOIN rbac_roles r ON r.id = ur.role_id AND r.is_active = true
    WHERE u.id = $1`,
    [id]
  );

  return result.rows[0] || null;
}

/**
 * Find user by email (excluding password hash)
 */
export async function findUserByEmail(email: string, dbPool?: DbClient): Promise<User | null> {
  const pool = dbPool || globalPool;
  const result = await pool.query(
    `SELECT 
      id,
      user_number as "userNumber",
      email,
      full_name as "fullName",
      role,
      is_active as "isActive",
      created_at as "createdAt",
      updated_at as "updatedAt"
    FROM users 
    WHERE email = $1`,
    [email]
  );

  return result.rows[0] || null;
}

/**
 * Create a new user
 */
export async function createUser(data: CreateUser, dbPool?: DbClient): Promise<User> {
  const pool = dbPool || globalPool;
  const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);
  const role = data.role || 'STAFF';

  const result = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role, is_active, user_number)
     VALUES ($1, $2, $3, $4, $5, 'USR-' || LPAD(nextval('user_number_seq')::TEXT, 4, '0'))
     RETURNING 
      id,
      user_number as "userNumber",
      email,
      full_name as "fullName",
      role,
      is_active as "isActive",
      created_at as "createdAt",
      updated_at as "updatedAt"`,
    [data.email, passwordHash, data.fullName, role, true]
  );

  return result.rows[0];
}

/**
 * Update user details
 */
export async function updateUser(id: string, data: UpdateUser, dbPool?: DbClient): Promise<User | null> {
  const pool = dbPool || globalPool;
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (data.email !== undefined) {
    fields.push(`email = $${paramIndex++}`);
    values.push(data.email);
  }
  if (data.fullName !== undefined) {
    fields.push(`full_name = $${paramIndex++}`);
    values.push(data.fullName);
  }
  if (data.role !== undefined) {
    fields.push(`role = $${paramIndex++}`);
    values.push(data.role);
  }
  if (data.isActive !== undefined) {
    fields.push(`is_active = $${paramIndex++}`);
    values.push(data.isActive);
  }

  if (fields.length === 0) {
    return findUserById(id, pool);
  }

  fields.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(id);

  const result = await pool.query(
    `UPDATE users 
     SET ${fields.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING 
      id,
      user_number as "userNumber",
      email,
      full_name as "fullName",
      role,
      is_active as "isActive",
      created_at as "createdAt",
      updated_at as "updatedAt"`,
    values
  );

  return result.rows[0] || null;
}

/**
 * Change user password
 */
export async function changeUserPassword(id: string, newPassword: string, dbPool?: DbClient): Promise<boolean> {
  const pool = dbPool || globalPool;
  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

  const result = await pool.query(
    `UPDATE users 
     SET password_hash = $1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [passwordHash, id]
  );

  return result.rowCount !== null && result.rowCount > 0;
}

/**
 * Delete user (soft delete by setting is_active = false)
 */
/**
 * Check if user has any associated data
 */
export async function userHasData(id: string, dbPool?: DbClient): Promise<boolean> {
  const pool = dbPool || globalPool;
  const result = await pool.query(
    `SELECT EXISTS (
      SELECT 1 FROM purchase_orders WHERE created_by_id = $1
      UNION ALL
      SELECT 1 FROM goods_receipts WHERE received_by_id = $1
      UNION ALL
      SELECT 1 FROM stock_movements WHERE created_by_id = $1
      UNION ALL
      SELECT 1 FROM sales WHERE cashier_id = $1
      UNION ALL
      SELECT 1 FROM stock_counts WHERE created_by_id = $1
      UNION ALL
      SELECT 1 FROM stock_counts WHERE validated_by_id = $1
    ) AS has_data`,
    [id]
  );

  return result.rows[0]?.has_data || false;
}

/**
 * Soft delete user (set is_active = false)
 */
export async function deleteUser(id: string, dbPool?: DbClient): Promise<boolean> {
  const pool = dbPool || globalPool;
  const result = await pool.query(
    `UPDATE users 
     SET is_active = false, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id]
  );

  return result.rowCount !== null && result.rowCount > 0;
}

type UserFkRow = {
  schema: string;
  child: string;
  col: string;
  not_null: boolean;
  deltype: string;
};

/**
 * Drop login-only rows, clear optional links, and move required actor
 * columns onto the built-in system user. Then delete the login.
 */
async function releaseAndDeleteUser(client: pg.PoolClient, id: string): Promise<boolean> {
  if (id === SYSTEM_USER_ID) {
    throw new BusinessError('The built-in system user cannot be deleted.', 'ERR_USER_007', { userId: id });
  }

  const fks = await client.query<UserFkRow>(
    `SELECT n.nspname AS schema,
            c.relname AS child,
            a.attname AS col,
            a.attnotnull AS not_null,
            c2.confdeltype AS deltype
       FROM pg_constraint c2
       JOIN pg_class c ON c.oid = c2.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (c2.conkey)
      WHERE c2.contype = 'f'
        AND c2.confrelid = 'public.users'::regclass
        AND array_length(c2.conkey, 1) = 1`,
  );

  let systemChecked = false;
  for (const fk of fks.rows) {
    const action = userFkReleaseAction(fk.child, fk.not_null, fk.deltype);
    if (action === 'skip') continue;
    const qualified = `${quoteIdent(fk.schema)}.${quoteIdent(fk.child)}`;
    const col = quoteIdent(fk.col);
    if (action === 'delete-rows') {
      await client.query(`DELETE FROM ${qualified} WHERE ${col} = $1`, [id]);
      continue;
    }
    if (action === 'set-null') {
      await client.query(`UPDATE ${qualified} SET ${col} = NULL WHERE ${col} = $1`, [id]);
      continue;
    }
    if (!systemChecked) {
      const system = await client.query(`SELECT 1 FROM users WHERE id = $1`, [SYSTEM_USER_ID]);
      if ((system.rowCount ?? 0) === 0) {
        throw new BusinessError(
          'Cannot delete this user because required history has nowhere to go.',
          'ERR_USER_007',
          { userId: id, table: fk.child },
        );
      }
      systemChecked = true;
    }
    await client.query(`UPDATE ${qualified} SET ${col} = $2 WHERE ${col} = $1`, [id, SYSTEM_USER_ID]);
  }

  const result = await client.query(`DELETE FROM users WHERE id = $1`, [id]);
  return result.rowCount !== null && result.rowCount > 0;
}

/**
 * Hard delete user (permanent deletion).
 * Login rows are removed. Required document actors move to the system user.
 */
export async function hardDeleteUser(id: string, dbPool?: DbClient): Promise<boolean> {
  const pool = dbPool || globalPool;
  if ('release' in pool) {
    return releaseAndDeleteUser(pool, id);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deleted = await releaseAndDeleteUser(client, id);
    await client.query('COMMIT');
    return deleted;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Verify user password (used for authentication and password change)
 */
export async function verifyUserPassword(email: string, password: string, dbPool?: DbClient): Promise<boolean> {
  const pool = dbPool || globalPool;
  const result = await pool.query(
    'SELECT password_hash FROM users WHERE email = $1 AND is_active = true',
    [email]
  );

  if (result.rows.length === 0) {
    return false;
  }

  return bcrypt.compare(password, result.rows[0].password_hash);
}

/**
 * Count active users
 */
export async function countUsers(dbPool?: DbClient): Promise<number> {
  const pool = dbPool || globalPool;
  const result = await pool.query('SELECT COUNT(*) as count FROM users WHERE is_active = true');
  return parseInt(result.rows[0].count, 10);
}
