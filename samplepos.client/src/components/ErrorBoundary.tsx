import React from 'react';
import { isOfflineModuleError } from '../lib/chunkLoadError';
import { OfflineIntegrityCode, reportOfflineIntegrityEvent } from '../lib/offlineIntegrity';
import { resolveOfflineRecoveryHome } from '../lib/offlineRecoveryHome';

/**
 * Props for ErrorBoundary
 */
interface ErrorBoundaryProps {
  /** Child components to protect */
  children: React.ReactNode;
  /** Optional custom fallback UI */
  fallback?: React.ReactNode;
  /** Optional error handler callback */
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  /** Optional label for which section is protected (for logging) */
  section?: string;
}

/**
 * ErrorBoundary state
 */
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

/**
 * ErrorBoundary — catches render errors in child components.
 *
 * Wrap page-level or feature-level subtrees to prevent a single
 * component crash from taking down the entire application.
 *
 * Usage:
 *   <ErrorBoundary section="POS">
 *     <POSPage />
 *   </ErrorBoundary>
 *
 *   <ErrorBoundary fallback={<div>Custom Error UI</div>}>
 *     <SomeComponent />
 *   </ErrorBoundary>
 */
class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.setState({ errorInfo });

    const section = this.props.section ?? 'Unknown';
    console.error(`[ErrorBoundary:${section}] Caught render error:`, error, errorInfo);

    if (isOfflineModuleError(error)) {
      reportOfflineIntegrityEvent(
        OfflineIntegrityCode.CHUNK_LOAD_OFFLINE,
        `ErrorBoundary(${section}): offline module failure`,
        error,
        { section, componentStack: errorInfo.componentStack ?? undefined },
      );
    }

    this.props.onError?.(error, errorInfo);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const isDev = import.meta.env.DEV;
      const offlineLoad = isOfflineModuleError(this.state.error);

      if (offlineLoad) {
        const recovery = resolveOfflineRecoveryHome();
        return (
          <div
            role="alert"
            className="flex flex-col items-center justify-center min-h-screen p-8 bg-slate-50 text-slate-800"
          >
            <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 shadow-sm text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700 text-xl" aria-hidden>
                📡
              </div>
              <h2 className="text-lg font-semibold text-slate-900 mb-2">You&apos;re offline</h2>
              <p className="text-sm text-slate-600 mb-6">
                {this.state.error?.message ||
                  'This screen is not cached yet. Reconnect, open it once online, then it can work offline.'}
              </p>
              <div className="flex flex-col sm:flex-row gap-2 justify-center">
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                >
                  Try Again
                </button>
                <button
                  type="button"
                  onClick={() => {
                    this.handleReset();
                    window.location.assign(recovery.path);
                  }}
                  className="px-4 py-2 bg-slate-100 text-slate-800 rounded-md hover:bg-slate-200"
                >
                  {recovery.label}
                </button>
              </div>
            </div>
          </div>
        );
      }

      return (
        <div
          role="alert"
          className="flex flex-col items-center justify-center min-h-[300px] p-8 bg-red-50 border border-red-200 rounded-lg m-4"
        >
          <svg
            className="w-12 h-12 text-red-500 mb-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
            />
          </svg>
          <h2 className="text-lg font-semibold text-red-800 mb-2">Something went wrong</h2>
          <p className="text-sm text-red-600 mb-4 text-center max-w-md">
            {this.props.section
              ? `An error occurred in the ${this.props.section} section.`
              : 'An unexpected error occurred.'}
            {' '}Please try again or contact support if the problem persists.
          </p>
          <button
            onClick={this.handleReset}
            className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
          >
            Try Again
          </button>
          {isDev && this.state.error && (
            <details className="mt-4 w-full max-w-2xl">
              <summary className="cursor-pointer text-sm text-red-500 hover:text-red-700">
                Error Details (Dev Only)
              </summary>
              <pre className="mt-2 p-3 bg-red-100 rounded text-xs text-red-800 overflow-auto max-h-64">
                {this.state.error.toString()}
                {this.state.errorInfo?.componentStack}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
