import type { Pool } from 'pg';
import { RbacRepository } from './repository.js';
import { isValidPermissionKey, getAllPermissions, getPermission } from './permissions.js';
import type { Role, UserRole, EffectivePermission, RbacAuditLog, RbacAuditAction, AuthorizationContext } from './types.js';
import type { CreateRoleInput, UpdateRoleInput, AssignUserRoleInput, RemoveUserRoleInput } from './validation.js';
import { publishNotificationEvent } from '../modules/notifications/notificationPublisher.js';

export class RbacError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'RbacError';
  }
}

export class RbacService {
  private repository: RbacRepository;
  private pool: Pool;
  private permissionCache: Map<string, { permissions: Set<string>; expiry: number }> = new Map();
  private readonly CACHE_TTL = 60000;

  constructor(pool: Pool) {
    this.pool = pool;
    this.repository = new RbacRepository(pool);
  }

  async createRole(
    input: CreateRoleInput,
    actorUserId: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<Role> {
    for (const key of input.permissionKeys) {
      if (!isValidPermissionKey(key)) {
        throw new RbacError(`Invalid permission key: ${key}`, 'INVALID_PERMISSION', 400);
      }
    }

    const existingRole = await this.repository.getRoleByName(input.name);
    if (existingRole) {
      throw new RbacError(`Role with name "${input.name}" already exists`, 'DUPLICATE_ROLE', 409);
    }

    const client = await this.repository.beginTransaction();
    try {
      const role = await this.repository.createRole(client, {
        name: input.name,
        description: input.description,
        createdBy: actorUserId,
      });

      await this.repository.setRolePermissions(client, role.id, input.permissionKeys, actorUserId);

      await this.repository.createAuditLog(client, {
        actorUserId,
        targetRoleId: role.id,
        action: 'role_created',
        previousState: null,
        newState: { name: role.name, description: role.description, permissions: input.permissionKeys },
        ipAddress,
        userAgent,
      });

      await this.repository.commitTransaction(client);
      return role;
    } catch (error) {
      await this.repository.rollbackTransaction(client);
      throw error;
    }
  }

  async updateRole(
    roleId: string,
    input: UpdateRoleInput,
    actorUserId: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<Role> {
    const existingRole = await this.repository.getRoleById(roleId);
    if (!existingRole) {
      throw new RbacError('Role not found', 'ROLE_NOT_FOUND', 404);
    }

    // System roles: allow permission updates only — block name/description changes
    if (existingRole.isSystemRole) {
      if (input.name && input.name !== existingRole.name) {
        throw new RbacError(
          'System role names cannot be changed',
          'SYSTEM_ROLE_NAME_IMMUTABLE',
          403
        );
      }
      if (input.description && input.description !== existingRole.description) {
        throw new RbacError(
          'System role descriptions cannot be changed',
          'SYSTEM_ROLE_DESC_IMMUTABLE',
          403
        );
      }
      if (!input.permissionKeys || input.permissionKeys.length === 0) {
        throw new RbacError(
          'System roles require at least one permission',
          'SYSTEM_ROLE_EMPTY_PERMS',
          400
        );
      }
    }

    if (!existingRole.isSystemRole && input.name && input.name !== existingRole.name) {
      const duplicateRole = await this.repository.getRoleByName(input.name);
      if (duplicateRole && duplicateRole.id !== roleId) {
        throw new RbacError(`Role with name "${input.name}" already exists`, 'DUPLICATE_ROLE', 409);
      }
    }

    if (input.permissionKeys) {
      for (const key of input.permissionKeys) {
        if (!isValidPermissionKey(key)) {
          throw new RbacError(`Invalid permission key: ${key}`, 'INVALID_PERMISSION', 400);
        }
      }
    }

    const previousPermissions = await this.repository.getRolePermissions(roleId);

    const client = await this.repository.beginTransaction();
    try {
      let updatedRole: Role;

      if (existingRole.isSystemRole) {
        // System role: only update permissions, bump version
        await this.repository.setRolePermissions(client, roleId, input.permissionKeys!, actorUserId);

        const touched = await this.repository.touchSystemRole(client, roleId, actorUserId);
        if (!touched) {
          throw new RbacError('Failed to update system role', 'UPDATE_FAILED', 500);
        }
        updatedRole = touched;

        await this.repository.createAuditLog(client, {
          actorUserId,
          targetRoleId: roleId,
          action: 'role_permissions_updated',
          previousState: { permissions: previousPermissions },
          newState: { permissions: input.permissionKeys },
          ipAddress,
          userAgent,
        });
      } else {
        // Custom role: full update
        const updated = await this.repository.updateRole(client, roleId, {
          name: input.name,
          description: input.description,
          updatedBy: actorUserId,
        });

        if (!updated) {
          throw new RbacError('Failed to update role', 'UPDATE_FAILED', 500);
        }
        updatedRole = updated;

        if (input.permissionKeys) {
          await this.repository.setRolePermissions(client, roleId, input.permissionKeys, actorUserId);

          await this.repository.createAuditLog(client, {
            actorUserId,
            targetRoleId: roleId,
            action: 'role_permissions_updated',
            previousState: { permissions: previousPermissions },
            newState: { permissions: input.permissionKeys },
            ipAddress,
            userAgent,
          });
        }

        await this.repository.createAuditLog(client, {
          actorUserId,
          targetRoleId: roleId,
          action: 'role_updated',
          previousState: { name: existingRole.name, description: existingRole.description, version: existingRole.version },
          newState: { name: updatedRole.name, description: updatedRole.description, version: updatedRole.version },
          ipAddress,
          userAgent,
        });
      }

      await this.repository.commitTransaction(client);
      this.invalidatePermissionCache();
      return updatedRole;
    } catch (error) {
      await this.repository.rollbackTransaction(client);
      throw error;
    }
  }

  async deleteRole(
    roleId: string,
    actorUserId: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    const role = await this.repository.getRoleById(roleId);
    if (!role) {
      throw new RbacError('Role not found', 'ROLE_NOT_FOUND', 404);
    }

    if (role.isSystemRole) {
      throw new RbacError('System roles cannot be deleted', 'SYSTEM_ROLE_IMMUTABLE', 403);
    }

    const inUse = await this.repository.checkRoleInUse(roleId);
    if (inUse) {
      throw new RbacError('Role is currently assigned to users and cannot be deleted', 'ROLE_IN_USE', 409);
    }

    const client = await this.repository.beginTransaction();
    try {
      const deleted = await this.repository.softDeleteRole(client, roleId, actorUserId);
      if (!deleted) {
        throw new RbacError('Failed to delete role', 'DELETE_FAILED', 500);
      }

      await this.repository.createAuditLog(client, {
        actorUserId,
        targetRoleId: roleId,
        action: 'role_deleted',
        previousState: { name: role.name, isActive: true },
        newState: { name: role.name, isActive: false },
        ipAddress,
        userAgent,
      });

      await this.repository.commitTransaction(client);
      this.invalidatePermissionCache();
    } catch (error) {
      await this.repository.rollbackTransaction(client);
      throw error;
    }
  }

  async getRole(roleId: string): Promise<Role & { permissions: string[] }> {
    const role = await this.repository.getRoleById(roleId);
    if (!role || !role.isActive) {
      throw new RbacError('Role not found', 'ROLE_NOT_FOUND', 404);
    }

    const permissions = await this.repository.getRolePermissions(roleId);
    return { ...role, permissions };
  }

  async getAllRoles(): Promise<(Role & { permissionCount: number })[]> {
    return this.repository.getAllActiveRoles();
  }

  async getPermissionCatalog() {
    return getAllPermissions();
  }

  async assignRoleToUser(
    input: AssignUserRoleInput,
    actorUserId: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<UserRole> {
    const role = await this.repository.getRoleById(input.roleId);
    if (!role || !role.isActive) {
      throw new RbacError('Role not found', 'ROLE_NOT_FOUND', 404);
    }

    const client = await this.repository.beginTransaction();
    try {
      const userRole = await this.repository.assignUserRole(client, {
        userId: input.userId,
        roleId: input.roleId,
        scopeType: input.scopeType || null,
        scopeId: input.scopeId || null,
        assignedBy: actorUserId,
        expiresAt: input.expiresAt || null,
      });

      await this.repository.createAuditLog(client, {
        actorUserId,
        targetUserId: input.userId,
        targetRoleId: input.roleId,
        action: 'user_role_assigned',
        previousState: null,
        newState: {
          roleId: input.roleId,
          roleName: role.name,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          expiresAt: input.expiresAt,
        },
        ipAddress,
        userAgent,
      });

      await this.repository.commitTransaction(client);
      this.invalidateUserPermissionCache(input.userId);
      publishNotificationEvent({
        pool: this.pool,
        typeKey: 'SECURITY_ROLE_CHANGED',
        entityType: 'user',
        entityId: input.userId,
        idempotencyKey: `SECURITY_ROLE_CHANGED:user:${input.userId}:${userRole.id}`,
        payload: { subjectUserId: input.userId, summary: 'A user role was changed' },
        actorUserId,
        subjectUserId: input.userId,
      });
      return userRole;
    } catch (error) {
      await this.repository.rollbackTransaction(client);
      throw error;
    }
  }

  async removeRoleFromUser(
    input: RemoveUserRoleInput,
    actorUserId: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    const role = await this.repository.getRoleById(input.roleId);

    const client = await this.repository.beginTransaction();
    try {
      const removed = await this.repository.removeUserRole(
        client,
        input.userId,
        input.roleId,
        input.scopeType || null,
        input.scopeId || null
      );

      if (!removed) {
        throw new RbacError('User role assignment not found', 'USER_ROLE_NOT_FOUND', 404);
      }

      await this.repository.createAuditLog(client, {
        actorUserId,
        targetUserId: input.userId,
        targetRoleId: input.roleId,
        action: 'user_role_removed',
        previousState: {
          roleId: input.roleId,
          roleName: role?.name,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
        },
        newState: null,
        ipAddress,
        userAgent,
      });

      await this.repository.commitTransaction(client);
      this.invalidateUserPermissionCache(input.userId);
    } catch (error) {
      await this.repository.rollbackTransaction(client);
      throw error;
    }
  }

  async getUserRoles(userId: string): Promise<UserRole[]> {
    return this.repository.getUserRoles(userId);
  }

  async getUserEffectivePermissions(userId: string): Promise<EffectivePermission[]> {
    return this.repository.getUserEffectivePermissions(userId);
  }

  async checkPermission(
    userId: string,
    permissionKey: string,
    scopeType?: string | null,
    scopeId?: string | null
  ): Promise<boolean> {
    if (!isValidPermissionKey(permissionKey)) {
      return false;
    }

    const cacheKey = `${userId}:${scopeType || 'global'}:${scopeId || 'all'}`;
    const cached = this.permissionCache.get(cacheKey);

    if (cached && cached.expiry > Date.now()) {
      return cached.permissions.has(permissionKey);
    }

    const hasPermission = await this.repository.userHasPermission(userId, permissionKey, scopeType, scopeId);
    return hasPermission;
  }

  async buildAuthorizationContext(userId: string): Promise<AuthorizationContext> {
    const effectivePermissions = await this.repository.getUserEffectivePermissions(userId);

    const permissions = new Set<string>();
    const scopedPermissions = new Map<string, EffectivePermission[]>();

    for (const ep of effectivePermissions) {
      permissions.add(ep.permissionKey);

      const existing = scopedPermissions.get(ep.permissionKey) || [];
      existing.push(ep);
      scopedPermissions.set(ep.permissionKey, existing);
    }

    return { userId, permissions, scopedPermissions };
  }

  async getAuditLogs(options: {
    actorUserId?: string;
    targetUserId?: string;
    targetRoleId?: string;
    action?: RbacAuditAction;
    fromDate?: string;
    toDate?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ logs: RbacAuditLog[]; total: number }> {
    return this.repository.getAuditLogs(options);
  }

  async logPermissionDenied(
    userId: string,
    permissionKey: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    const client = await this.repository.beginTransaction();
    try {
      await this.repository.createAuditLog(client, {
        actorUserId: userId,
        targetUserId: userId,
        action: 'permission_denied',
        previousState: null,
        newState: { permissionKey, denied: true },
        ipAddress,
        userAgent,
      });
      await this.repository.commitTransaction(client);
    } catch (error) {
      await this.repository.rollbackTransaction(client);
    }
  }

  private invalidatePermissionCache(): void {
    this.permissionCache.clear();
  }

  private invalidateUserPermissionCache(userId: string): void {
    for (const key of this.permissionCache.keys()) {
      if (key.startsWith(`${userId}:`)) {
        this.permissionCache.delete(key);
      }
    }
  }
}
