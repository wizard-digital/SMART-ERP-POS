import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import Layout from '../../components/Layout';
import * as Tabs from '@radix-ui/react-tabs';
import InvoiceSettingsTab from './tabs/InvoiceSettingsTab';
import UserManagementTab from './tabs/UserManagementTab';
import SystemSettingsTab from './tabs/SystemSettingsTab';
import DataManagementTab from './tabs/DataManagementTab';
import BrandingSettingsTab from './tabs/BrandingSettingsTab';
import PrintingSettingsTab from './tabs/PrintingSettingsTab';
import NotificationSettingsTab from './tabs/NotificationSettingsTab';
import OfflineSyncStatusPanel from '../../components/offline/OfflineSyncStatusPanel';
import GLIntegrityPanel from '../../components/GLIntegrityPanel';
import ErrorBoundary from '../../components/ErrorBoundary';
import { useHasPermission } from '../../authorization/useAuthorization';

const VALID_TABS = [
  'invoice',
  'company',
  'users',
  'system',
  'branding',
  'printing',
  'notifications',
  'data',
  'offline',
  'gl-integrity',
] as const;

export default function SettingsPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const tabParam = searchParams.get('tab');
  const initialTab = tabParam && (VALID_TABS as readonly string[]).includes(tabParam) ? tabParam : 'invoice';
  const [activeTab, setActiveTab] = useState(initialTab);

  const canReadAccounting = useHasPermission('accounting.read');
  const canReconcileAccounting = useHasPermission('accounting.reconcile');
  const canViewGLIntegrity = canReadAccounting || canReconcileAccounting;
  const canReadSystem = useHasPermission('system.read');
  const canConfigurePrinting = canReadSystem;
  const canAdminNotifications = useHasPermission('settings.update');

  // Update tab if the URL search param changes (e.g. navigating from POS badge)
  useEffect(() => {
    if (tabParam && (VALID_TABS as readonly string[]).includes(tabParam)) {
      setActiveTab(tabParam);
    }
  }, [tabParam]);

  const onTabChange = (next: string) => {
    setActiveTab(next);
    navigate(next === 'invoice' ? '/settings' : `/settings?tab=${next}`, { replace: true });
  };

  return (
    <Layout>
      <div className="min-h-screen bg-gray-50 py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">Settings</h1>
            <p className="mt-2 text-gray-600">
              Manage your system configuration and preferences.
            </p>
          </div>

          {/* Tabs */}
          <Tabs.Root value={activeTab} onValueChange={onTabChange}>
            <Tabs.List className="flex gap-1 sm:gap-2 border-b border-gray-200 mb-8 overflow-x-auto">
              <Tabs.Trigger
                value="invoice"
                className="px-3 sm:px-6 py-3 text-sm font-medium text-gray-600 border-b-2 border-transparent hover:text-gray-900 hover:border-gray-300 data-[state=active]:text-blue-600 data-[state=active]:border-blue-600 transition-colors whitespace-nowrap"
              >
                Invoice
              </Tabs.Trigger>
              <Tabs.Trigger
                value="company"
                className="px-3 sm:px-6 py-3 text-sm font-medium text-gray-600 border-b-2 border-transparent hover:text-gray-900 hover:border-gray-300 data-[state=active]:text-blue-600 data-[state=active]:border-blue-600 transition-colors whitespace-nowrap"
              >
                Company
              </Tabs.Trigger>
              <Tabs.Trigger
                value="users"
                className="px-3 sm:px-6 py-3 text-sm font-medium text-gray-600 border-b-2 border-transparent hover:text-gray-900 hover:border-gray-300 data-[state=active]:text-blue-600 data-[state=active]:border-blue-600 transition-colors whitespace-nowrap"
              >
                Users
              </Tabs.Trigger>
              <Tabs.Trigger
                value="system"
                className="px-3 sm:px-6 py-3 text-sm font-medium text-gray-600 border-b-2 border-transparent hover:text-gray-900 hover:border-gray-300 data-[state=active]:text-blue-600 data-[state=active]:border-blue-600 transition-colors whitespace-nowrap"
              >
                System
              </Tabs.Trigger>
              <Tabs.Trigger
                value="branding"
                className="px-3 sm:px-6 py-3 text-sm font-medium text-gray-600 border-b-2 border-transparent hover:text-gray-900 hover:border-gray-300 data-[state=active]:text-blue-600 data-[state=active]:border-blue-600 transition-colors whitespace-nowrap"
              >
                Branding
              </Tabs.Trigger>
              {canConfigurePrinting && (
                <Tabs.Trigger
                  value="printing"
                  className="px-3 sm:px-6 py-3 text-sm font-medium text-gray-600 border-b-2 border-transparent hover:text-gray-900 hover:border-gray-300 data-[state=active]:text-blue-600 data-[state=active]:border-blue-600 transition-colors whitespace-nowrap"
                >
                  Printing
                </Tabs.Trigger>
              )}
              <Tabs.Trigger
                value="notifications"
                className="px-3 sm:px-6 py-3 text-sm font-medium text-gray-600 border-b-2 border-transparent hover:text-gray-900 hover:border-gray-300 data-[state=active]:text-blue-600 data-[state=active]:border-blue-600 transition-colors whitespace-nowrap"
              >
                Notifications
              </Tabs.Trigger>
              <Tabs.Trigger
                value="data"
                className="px-3 sm:px-6 py-3 text-sm font-medium text-gray-600 border-b-2 border-transparent hover:text-gray-900 hover:border-gray-300 data-[state=active]:text-red-600 data-[state=active]:border-red-600 transition-colors whitespace-nowrap"
              >
                Data
              </Tabs.Trigger>
              <Tabs.Trigger
                value="offline"
                className="px-3 sm:px-6 py-3 text-sm font-medium text-gray-600 border-b-2 border-transparent hover:text-gray-900 hover:border-gray-300 data-[state=active]:text-blue-600 data-[state=active]:border-blue-600 transition-colors whitespace-nowrap"
              >
                Offline
              </Tabs.Trigger>
              {canViewGLIntegrity && (
                <Tabs.Trigger
                  value="gl-integrity"
                  className="px-3 sm:px-6 py-3 text-sm font-medium text-gray-600 border-b-2 border-transparent hover:text-gray-900 hover:border-gray-300 data-[state=active]:text-purple-600 data-[state=active]:border-purple-600 transition-colors whitespace-nowrap"
                >
                  GL Integrity
                </Tabs.Trigger>
              )}
            </Tabs.List>

            <Tabs.Content value="invoice">
              <InvoiceSettingsTab />
            </Tabs.Content>

            <Tabs.Content value="company">
              <div className="bg-white rounded-lg shadow-sm p-6">
                <h2 className="text-xl font-semibold text-gray-900 mb-4">Company Profile</h2>
                <p className="text-gray-600">Company profile settings coming soon...</p>
              </div>
            </Tabs.Content>

            <Tabs.Content value="users">
              <UserManagementTab />
            </Tabs.Content>

            <Tabs.Content value="system">
              <SystemSettingsTab />
            </Tabs.Content>

            <Tabs.Content value="branding">
              <BrandingSettingsTab />
            </Tabs.Content>

            {canConfigurePrinting && (
              <Tabs.Content value="printing">
                <PrintingSettingsTab />
              </Tabs.Content>
            )}

            <Tabs.Content value="notifications">
              <ErrorBoundary section="Notifications">
                <NotificationSettingsTab canAdmin={canAdminNotifications} />
              </ErrorBoundary>
            </Tabs.Content>

            <Tabs.Content value="data">
              <DataManagementTab />
            </Tabs.Content>

            <Tabs.Content value="offline">
              <OfflineSyncStatusPanel />
            </Tabs.Content>

            {canViewGLIntegrity && (
              <Tabs.Content value="gl-integrity">
                <GLIntegrityPanel />
              </Tabs.Content>
            )}
          </Tabs.Root>
        </div>
      </div>
    </Layout>
  );
}
