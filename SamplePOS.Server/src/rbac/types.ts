export type PermissionModule =
  | 'sales'
  | 'inventory'
  | 'accounting'
  | 'admin'
  | 'pos'
  | 'orders'
  | 'restaurant'
  | 'purchasing'
  | 'customers'
  | 'suppliers'
  | 'reports'
  | 'system'
  | 'banking'
  | 'delivery'
  | 'settings'
  | 'crm'
  | 'hr'
  | 'expenses'
  | 'quotations'
  | 'distribution'
  | 'corrections'
  | 'kitchen'
  | 'targets';

export type PermissionAction =
  | 'read'
  | 'create'
  | 'update'
  | 'delete'
  | 'post'
  | 'approve'
  | 'void'
  | 'pay'
  | 'cancel'
  | 'refund'
  | 'exchange'
  | 'export'
  | 'import'
  | 'reconcile'
  | 'manage'
  | 'payroll_process'
  | 'payroll_post'
  | 'payroll_pay'
  | 'advance'
  | 'adjust'
  | 'execute'
  | 'sales_view'
  | 'inventory_view'
  | 'financial_view'
  | 'purchasing_view'
  | 'customers_view'
  | 'banking_view'
  | 'hr_view'
  | 'period_manage'
  | 'chart_manage'
  | 'reprint'
  | 'tax_override';

export interface Permission {
  key: string;
  module: PermissionModule;
  action: PermissionAction;
  description: string;
}

export interface Role {
  id: string;
  name: string;
  description: string;
  version: number;
  isSystemRole: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

export interface RolePermission {
  roleId: string;
  permissionKey: string;
  grantedAt: string;
  grantedBy: string;
}

export interface UserRole {
  id: string;
  userId: string;
  roleId: string;
  roleName?: string;
  scopeType: 'global' | 'organization' | 'branch' | 'warehouse' | null;
  scopeId: string | null;
  assignedAt: string;
  assignedBy: string;
  expiresAt: string | null;
  isActive: boolean;
}

export interface RbacAuditLog {
  id: string;
  actorUserId: string;
  targetUserId: string | null;
  targetRoleId: string | null;
  action: RbacAuditAction;
  previousState: Record<string, unknown> | null;
  newState: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  timestamp: string;
}

export type RbacAuditAction =
  | 'role_created'
  | 'role_updated'
  | 'role_deleted'
  | 'role_permissions_updated'
  | 'user_role_assigned'
  | 'user_role_removed'
  | 'user_role_expired'
  | 'permission_denied'
  | 'permission_granted';

export interface EffectivePermission {
  permissionKey: string;
  roleId: string;
  roleName: string;
  scopeType: 'global' | 'organization' | 'branch' | 'warehouse' | null;
  scopeId: string | null;
}

export interface AuthorizationContext {
  userId: string;
  permissions: Set<string>;
  scopedPermissions: Map<string, EffectivePermission[]>;
}
