import { Navigate } from 'react-router-dom';
import { useSalesTargetsEnabled } from '../../hooks/useSalesTargetsEnabled';

/** Redirects to Sales when tenant flag is off. */
export function SalesTargetsFeatureGate({ children }: { children: React.ReactNode }) {
  const { data: enabled, isFetched, isError } = useSalesTargetsEnabled();

  if (!isFetched && !isError) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600" />
      </div>
    );
  }

  if (!enabled) {
    return <Navigate to="/sales" replace />;
  }

  return <>{children}</>;
}
