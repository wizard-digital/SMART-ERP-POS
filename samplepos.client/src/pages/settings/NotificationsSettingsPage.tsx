import Layout from '../../components/Layout';
import ErrorBoundary from '../../components/ErrorBoundary';
import { useHasPermission } from '../../authorization/useAuthorization';
import NotificationSettingsTab from './tabs/NotificationSettingsTab';

export default function NotificationsSettingsPage() {
  const canAdmin = useHasPermission('settings.update');
  return (
    <Layout>
      <div className="min-h-screen bg-gray-50 py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Notifications</h1>
          <p className="text-gray-600 mb-8">
            Choose the areas you want to be notified about. Open an area when you need a specific event. Devices stay independent.
          </p>
          <ErrorBoundary section="Notifications">
            <NotificationSettingsTab canAdmin={canAdmin} />
          </ErrorBoundary>
        </div>
      </div>
    </Layout>
  );
}
