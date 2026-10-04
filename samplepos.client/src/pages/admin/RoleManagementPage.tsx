/**
 * Role Management Page — Enterprise RBAC
 * Manage system and custom roles with full permission editing.
 * System roles: name/description locked, permissions editable by Super Admin.
 * Custom roles: full CRUD.
 */

import { useState, useMemo, useEffect, useCallback } from 'react';
import Layout from '../../components/Layout';
import {
  useRoles,
  useRole,
  usePermissions,
  useCreateRole,
  useUpdateRole,
  useDeleteRole,
} from '../../hooks/useRbac';
import type { Role, Permission } from '../../types/rbac';
import toast from 'react-hot-toast';
import { useSubmitOnEnter } from '../../hooks/useSubmitOnEnter';

// Module display order (enterprise: most critical first)
const MODULE_ORDER: string[] = [
  'system', 'admin', 'sales', 'pos', 'orders', 'restaurant', 'quotations', 'inventory', 'purchasing',
  'accounting', 'expenses', 'banking', 'customers', 'suppliers', 'delivery', 'distribution',
  'corrections', 'reports', 'settings', 'crm', 'hr', 'targets',
];

// Module descriptions for admin context
const MODULE_DESCRIPTIONS: Record<string, string> = {
  system: 'User, role & audit management',
  admin: 'Administrative panel access',
  sales: 'Sales transactions & invoicing',
  pos: 'Point of Sale terminal',
  orders: 'POS order queue (dispenser / cashier)',
  restaurant: 'Restaurant floor, KOT, bill & settle',
  quotations: 'Sales quotations & estimates',
  inventory: 'Stock & batch management',
  purchasing: 'Purchase orders & goods receipts',
  accounting: 'General Ledger, journal entries & periods',
  expenses: 'Expense tracking & approval workflow',
  banking: 'Bank accounts & reconciliation',
  customers: 'Customer records & groups',
  suppliers: 'Supplier records',
  delivery: 'Delivery orders & routing',
  distribution: 'Sales orders, deliveries & invoices',
  corrections: 'Correction wizards (wrong product / supplier)',
  reports: 'Business reports & analytics',
  settings: 'Application configuration',
  crm: 'Leads, opportunities & pipeline',
  hr: 'Employees, departments & payroll',
  targets: 'Sales targets & achievement',
};

export default function RoleManagementPage() {
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showSystemRoleConfirm, setShowSystemRoleConfirm] = useState(false);
  const [permissionSearch, setPermissionSearch] = useState('');

  // Form state
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formPermissions, setFormPermissions] = useState<Set<string>>(new Set());
  const [originalPermissions, setOriginalPermissions] = useState<Set<string>>(new Set());

  // Queries
  const { data: roles, isLoading: rolesLoading } = useRoles();
  const { data: roleDetails, isLoading: roleDetailsLoading } = useRole(selectedRoleId);
  const { data: permissions, isLoading: permissionsLoading, error: permissionsError } = usePermissions();

  // Mutations
  const createRole = useCreateRole();
  const updateRole = useUpdateRole();
  const deleteRole = useDeleteRole();

  // Track if permissions changed from original
  const hasPermissionChanges = useMemo(() => {
    if (formPermissions.size !== originalPermissions.size) return true;
    for (const key of formPermissions) {
      if (!originalPermissions.has(key)) return true;
    }
    return false;
  }, [formPermissions, originalPermissions]);

  // Compute permission diffs for confirmation modal
  const permissionDiff = useMemo(() => {
    const added: string[] = [];
    const removed: string[] = [];
    for (const key of formPermissions) {
      if (!originalPermissions.has(key)) added.push(key);
    }
    for (const key of originalPermissions) {
      if (!formPermissions.has(key)) removed.push(key);
    }
    return { added, removed };
  }, [formPermissions, originalPermissions]);

  // Permission label helper
  const permissionLabel = useCallback((perm: Permission): string => {
    const parts = perm.key.split('.');
    const actionPart = parts[1] || perm.action;
    // Compound keys with underscore: show "sub: action" format
    if (actionPart.includes('_')) {
      const underscoreIdx = actionPart.indexOf('_');
      const sub = actionPart.slice(0, underscoreIdx);
      const act = actionPart.slice(underscoreIdx + 1);
      return `${sub}: ${act}`;
    }
    return perm.action.replace(/_/g, ' ');
  }, []);

  // Group permissions by module
  const groupedPermissions = useMemo(() => {
    if (!permissions) return {};
    const grouped: Record<string, Permission[]> = {};
    for (const perm of permissions) {
      if (!grouped[perm.module]) grouped[perm.module] = [];
      grouped[perm.module].push(perm);
    }
    return grouped;
  }, [permissions]);

  // Sorted module list (enterprise order)
  const sortedModules = useMemo(() => {
    const modules = Object.keys(groupedPermissions);
    return modules.sort((a, b) => {
      const idxA = MODULE_ORDER.indexOf(a);
      const idxB = MODULE_ORDER.indexOf(b);
      return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
    });
  }, [groupedPermissions]);

  // Filter modules/permissions by search
  const filteredModules = useMemo(() => {
    if (!permissionSearch.trim()) return sortedModules;
    const q = permissionSearch.toLowerCase();
    return sortedModules.filter((module) => {
      if (module.toLowerCase().includes(q)) return true;
      const perms = groupedPermissions[module] || [];
      return perms.some(
        (p) =>
          p.key.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.action.toLowerCase().includes(q)
      );
    });
  }, [sortedModules, groupedPermissions, permissionSearch]);

  // Handle create
  const handleOpenCreate = () => {
    setFormName('');
    setFormDescription('');
    setFormPermissions(new Set());
    setOriginalPermissions(new Set());
    setPermissionSearch('');
    setShowCreateModal(true);
  };

  const handleCreate = async () => {
    if (!formName.trim()) {
      toast.error('Role name is required');
      return;
    }
    if (formPermissions.size === 0) {
      toast.error('At least one permission is required');
      return;
    }
    try {
      await createRole.mutateAsync({
        name: formName.trim(),
        description: formDescription.trim(),
        permissionKeys: Array.from(formPermissions),
      });
      setShowCreateModal(false);
    } catch {
      // Error handled by hook
    }
  };

  // Handle edit — works for both system and custom roles
  const handleOpenEdit = (role: Role) => {
    setFormPermissions(new Set());
    setOriginalPermissions(new Set());
    setSelectedRoleId(role.id);
    setFormName(role.name);
    setFormDescription(role.description);
    setPermissionSearch('');
    setShowEditModal(true);
  };

  // Effect: populate permissions when roleDetails loads
  useEffect(() => {
    if (roleDetails?.permissions && showEditModal && selectedRoleId) {
      const permsSet = new Set(roleDetails.permissions);
      setFormPermissions(permsSet);
      setOriginalPermissions(new Set(permsSet));
    }
  }, [roleDetails?.permissions, showEditModal, selectedRoleId]);

  const handleUpdate = async () => {
    if (!selectedRoleId) return;

    if (formPermissions.size === 0) {
      toast.error('At least one permission is required');
      return;
    }

    // System roles: require confirmation before saving
    if (selectedRole?.isSystemRole) {
      if (!hasPermissionChanges) {
        toast('No changes to save');
        return;
      }
      setShowSystemRoleConfirm(true);
      return;
    }

    if (!formName.trim()) {
      toast.error('Role name is required');
      return;
    }

    await doUpdate();
  };

  const doUpdate = async () => {
    if (!selectedRoleId) return;

    try {
      const input: { name?: string; description?: string; permissionKeys: string[] } = {
        permissionKeys: Array.from(formPermissions),
      };

      // Only send name/description for custom roles
      if (!selectedRole?.isSystemRole) {
        input.name = formName.trim();
        input.description = formDescription.trim();
      }

      await updateRole.mutateAsync({ roleId: selectedRoleId, input });
      setShowEditModal(false);
      setShowSystemRoleConfirm(false);
      setSelectedRoleId(null);
    } catch {
      // Error handled by hook
    }
  };

  // Handle delete
  const handleOpenDelete = (role: Role) => {
    setSelectedRoleId(role.id);
    setShowDeleteConfirm(true);
  };

  const handleDelete = async () => {
    if (!selectedRoleId) return;
    try {
      await deleteRole.mutateAsync(selectedRoleId);
      setShowDeleteConfirm(false);
      setSelectedRoleId(null);
    } catch {
      // Error handled by hook
    }
  };

  // Toggle permission
  const togglePermission = (permKey: string) => {
    setFormPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(permKey)) next.delete(permKey);
      else next.add(permKey);
      return next;
    });
  };

  // Toggle all permissions in a module
  const toggleModule = (module: string) => {
    const modulePerms = groupedPermissions[module] || [];
    const moduleKeys = modulePerms.map((p) => p.key);
    const allSelected = moduleKeys.every((k) => formPermissions.has(k));
    setFormPermissions((prev) => {
      const next = new Set(prev);
      if (allSelected) moduleKeys.forEach((k) => next.delete(k));
      else moduleKeys.forEach((k) => next.add(k));
      return next;
    });
  };

  // Select/deselect all permissions
  const selectAllPermissions = () => {
    if (!permissions) return;
    setFormPermissions(new Set(permissions.map((p) => p.key)));
  };

  const deselectAllPermissions = () => {
    setFormPermissions(new Set());
  };

  const selectedRole = useMemo(() => {
    return roles?.find((r) => r.id === selectedRoleId) || null;
  }, [roles, selectedRoleId]);

  // Role card badge color
  const roleBadgeColor = (role: Role): string => {
    if (!role.isSystemRole) return 'border-blue-500';
    const name = role.name.toLowerCase();
    if (name.includes('super')) return 'border-red-500';
    if (name.includes('administrator')) return 'border-purple-500';
    if (name.includes('manager')) return 'border-orange-500';
    if (name.includes('cashier')) return 'border-green-500';
    if (name.includes('auditor')) return 'border-yellow-500';
    if (name.includes('accountant')) return 'border-indigo-500';
    if (name.includes('warehouse')) return 'border-teal-500';
    if (name.includes('sales')) return 'border-cyan-500';
    if (name.includes('hr')) return 'border-pink-500';
    return 'border-yellow-500';
  };

  const closeModal = () => {
    setShowCreateModal(false);
    setShowEditModal(false);
    setSelectedRoleId(null);
    setPermissionSearch('');
  };

  useSubmitOnEnter(showCreateModal, !createRole.isPending, handleCreate);
  useSubmitOnEnter(showEditModal, !updateRole.isPending, handleUpdate);
  useSubmitOnEnter(showSystemRoleConfirm, !updateRole.isPending, doUpdate);

  if (rolesLoading || permissionsLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          <span className="ml-3 text-gray-600">Loading roles and permissions...</span>
        </div>
      </Layout>
    );
  }

  // Separate system and custom roles
  const systemRoles = roles?.filter((r) => r.isSystemRole) || [];
  const customRoles = roles?.filter((r) => !r.isSystemRole) || [];

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Role & Permission Management</h1>
            <p className="text-gray-600 mt-1">
              Configure system roles and create custom roles with granular permissions
            </p>
          </div>
          <button
            onClick={handleOpenCreate}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 flex items-center gap-2"
          >
            <span>+</span> Create Custom Role
          </button>
        </div>

        {/* System Roles Section */}
        <div>
          <h2 className="text-lg font-semibold text-gray-800 mb-3 flex items-center gap-2">
            <span className="w-3 h-3 bg-yellow-400 rounded-full inline-block" />
            System Roles
            <span className="text-sm font-normal text-gray-500">
              — permissions editable, names protected
            </span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {systemRoles.map((role) => (
              <div
                key={role.id}
                className={`bg-white rounded-lg shadow p-4 border-l-4 ${roleBadgeColor(role)}`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-semibold text-gray-900">{role.name}</h3>
                    <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded">
                      System Role
                    </span>
                  </div>
                  <span className="text-sm bg-blue-100 text-blue-800 px-2 py-1 rounded">
                    {role.permissionCount} perms
                  </span>
                </div>
                <p className="text-sm text-gray-500 mt-2 line-clamp-2">{role.description}</p>
                <div className="mt-4 flex gap-2">
                  <button
                    onClick={() => handleOpenEdit(role)}
                    className="text-sm text-blue-600 hover:text-blue-800 font-medium"
                  >
                    Edit Permissions
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Custom Roles Section */}
        <div>
          <h2 className="text-lg font-semibold text-gray-800 mb-3 flex items-center gap-2">
            <span className="w-3 h-3 bg-blue-400 rounded-full inline-block" />
            Custom Roles
            <span className="text-sm font-normal text-gray-500">
              — fully editable
            </span>
          </h2>
          {customRoles.length === 0 ? (
            <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
              No custom roles yet. Create one to define specialized permission sets.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {customRoles.map((role) => (
                <div
                  key={role.id}
                  className="bg-white rounded-lg shadow p-4 border-l-4 border-blue-500"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-semibold text-gray-900">{role.name}</h3>
                      <span className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                        Custom Role
                      </span>
                    </div>
                    <span className="text-sm bg-blue-100 text-blue-800 px-2 py-1 rounded">
                      {role.permissionCount} perms
                    </span>
                  </div>
                  <p className="text-sm text-gray-500 mt-2 line-clamp-2">{role.description}</p>
                  <div className="mt-4 flex gap-2">
                    <button
                      onClick={() => handleOpenEdit(role)}
                      className="text-sm text-blue-600 hover:text-blue-800 font-medium"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleOpenDelete(role)}
                      className="text-sm text-red-600 hover:text-red-800"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Create/Edit Modal */}
      {(showCreateModal || showEditModal) && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-[95vw] sm:max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between shrink-0">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">
                  {showCreateModal
                    ? 'Create Custom Role'
                    : selectedRole?.isSystemRole
                      ? `Edit Permissions: ${selectedRole.name}`
                      : `Edit Role: ${selectedRole?.name}`}
                </h2>
                {showEditModal && selectedRole?.isSystemRole && (
                  <p className="text-sm text-amber-600 mt-1">
                    System role — name and description are protected. Permissions can be customized.
                  </p>
                )}
              </div>
              <button onClick={closeModal} className="text-gray-400 hover:text-gray-600 text-xl">
                ✕
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto flex-1">
              {/* Name & Description */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Role Name *
                  </label>
                  <input
                    type="text"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    disabled={selectedRole?.isSystemRole}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
                    placeholder="e.g., Sales Manager"
                  />
                  {selectedRole?.isSystemRole && (
                    <p className="text-xs text-gray-400 mt-1">System role names cannot be changed</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Description
                  </label>
                  <input
                    type="text"
                    value={formDescription}
                    onChange={(e) => setFormDescription(e.target.value)}
                    disabled={selectedRole?.isSystemRole}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
                    placeholder="Describe the role's purpose"
                  />
                </div>
              </div>

              {/* Permissions Section */}
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <label className="text-sm font-medium text-gray-700">
                    Permissions ({formPermissions.size}/{permissions?.length || 0} selected)
                    {hasPermissionChanges && showEditModal && (
                      <span className="ml-2 text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded">
                        Unsaved changes
                      </span>
                    )}
                  </label>
                  <div className="flex items-center gap-2">
                    {/* Search */}
                    <input
                      type="text"
                      value={permissionSearch}
                      onChange={(e) => setPermissionSearch(e.target.value)}
                      placeholder="Search permissions..."
                      className="px-3 py-1.5 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-blue-500 w-48"
                    />
                    {/* Bulk actions */}
                    <button
                      onClick={selectAllPermissions}
                      className="text-xs text-blue-600 hover:text-blue-800 whitespace-nowrap"
                    >
                      Select All
                    </button>
                    <button
                      onClick={deselectAllPermissions}
                      className="text-xs text-gray-500 hover:text-gray-700 whitespace-nowrap"
                    >
                      Clear All
                    </button>
                  </div>
                  {permissionsError && (
                    <span className="text-red-500 text-sm">Failed to load permissions</span>
                  )}
                </div>

                {permissionsLoading ? (
                  <div className="text-center py-8 text-gray-500">Loading permissions catalog...</div>
                ) : roleDetailsLoading && showEditModal ? (
                  <div className="text-center py-8 text-gray-500">Loading role permissions...</div>
                ) : filteredModules.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    {permissionSearch ? 'No permissions match your search.' : 'No permissions available.'}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {filteredModules.map((module) => {
                      const perms = groupedPermissions[module] || [];
                      const moduleKeys = perms.map((p) => p.key);
                      const selectedCount = moduleKeys.filter((k) =>
                        formPermissions.has(k)
                      ).length;
                      const allSelected = selectedCount === moduleKeys.length && moduleKeys.length > 0;

                      return (
                        <div
                          key={module}
                          className={`bg-gray-50 rounded-lg p-3 border ${selectedCount > 0 ? 'border-blue-300 bg-blue-50/30' : 'border-gray-200'
                            }`}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={allSelected}
                                ref={(el) => {
                                  if (el) el.indeterminate = selectedCount > 0 && !allSelected;
                                }}
                                onChange={() => toggleModule(module)}
                                className="rounded text-blue-600 focus:ring-blue-500"
                              />
                              <span className="font-medium text-gray-900 capitalize">
                                {module}
                              </span>
                            </label>
                            <span className="text-xs text-gray-500">
                              {selectedCount}/{perms.length}
                            </span>
                          </div>
                          {MODULE_DESCRIPTIONS[module] && (
                            <p className="text-xs text-gray-400 ml-6 mb-1">
                              {MODULE_DESCRIPTIONS[module]}
                            </p>
                          )}
                          <div className="space-y-1 ml-6">
                            {perms.map((perm) => (
                              <label
                                key={perm.key}
                                className="flex items-center gap-2 text-sm"
                              >
                                <input
                                  type="checkbox"
                                  checked={formPermissions.has(perm.key)}
                                  onChange={() => togglePermission(perm.key)}
                                  className="rounded text-blue-600 focus:ring-blue-500"
                                />
                                <span className="text-gray-700" title={perm.description}>
                                  {permissionLabel(perm)}
                                </span>
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between shrink-0">
              <div className="text-sm text-gray-500">
                {showEditModal && selectedRole?.isSystemRole && hasPermissionChanges && (
                  <span>
                    {permissionDiff.added.length} added, {permissionDiff.removed.length} removed
                  </span>
                )}
              </div>
              <div className="flex gap-3">
                <button
                  onClick={closeModal}
                  className="px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
                >
                  Cancel
                </button>
                <button
                  onClick={showCreateModal ? handleCreate : handleUpdate}
                  disabled={
                    createRole.isPending ||
                    updateRole.isPending ||
                    (showEditModal && !hasPermissionChanges && selectedRole?.isSystemRole)
                  }
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {createRole.isPending || updateRole.isPending
                    ? 'Saving...'
                    : showCreateModal
                      ? 'Create Role'
                      : selectedRole?.isSystemRole
                        ? 'Update Permissions'
                        : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* System Role Permission Change Confirmation */}
      {showSystemRoleConfirm && selectedRole && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60]">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
                <span className="text-amber-600 text-lg">⚠</span>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-gray-900">
                  Modify System Role Permissions
                </h2>
                <p className="text-sm text-gray-500">
                  {selectedRole.name}
                </p>
              </div>
            </div>

            <p className="text-gray-600 mb-4">
              You are about to change the permissions of a system role. This will affect all users
              assigned to <strong>{selectedRole.name}</strong>.
            </p>

            {/* Diff summary */}
            <div className="bg-gray-50 rounded-lg p-4 mb-4 max-h-48 overflow-y-auto">
              {permissionDiff.added.length > 0 && (
                <div className="mb-3">
                  <h4 className="text-sm font-medium text-green-700 mb-1">
                    + Adding {permissionDiff.added.length} permission{permissionDiff.added.length > 1 ? 's' : ''}
                  </h4>
                  <div className="flex flex-wrap gap-1">
                    {permissionDiff.added.map((key) => (
                      <span key={key} className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded">
                        {key}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {permissionDiff.removed.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-red-700 mb-1">
                    − Removing {permissionDiff.removed.length} permission{permissionDiff.removed.length > 1 ? 's' : ''}
                  </h4>
                  <div className="flex flex-wrap gap-1">
                    {permissionDiff.removed.map((key) => (
                      <span key={key} className="text-xs bg-red-100 text-red-800 px-2 py-0.5 rounded">
                        {key}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowSystemRoleConfirm(false)}
                className="px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
              >
                Cancel
              </button>
              <button
                onClick={doUpdate}
                disabled={updateRole.isPending}
                className="px-4 py-2 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
              >
                {updateRole.isPending ? 'Saving...' : 'Confirm & Update'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && selectedRole && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Delete Role</h2>
            <p className="text-gray-600 mb-6">
              Are you sure you want to delete the role &ldquo;{selectedRole.name}&rdquo;? This action cannot
              be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setSelectedRoleId(null);
                }}
                className="px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleteRole.isPending}
                className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                {deleteRole.isPending ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
