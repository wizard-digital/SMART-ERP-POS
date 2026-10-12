/**
 * Password Expiry Warning Banner
 *
 * Displays a warning when password is close to expiring, already expired,
 * or must be set on first login. Link target `/settings/security` is open
 * to every authenticated role (not gated by system.read).
 */

import { useState } from 'react';
import { useMustChangePassword, usePasswordExpiry } from '../../hooks/usePasswordPolicy';
import { Link } from 'react-router-dom';

export function PasswordExpiryWarning() {
    const { data: expiryStatus, isLoading: expiryLoading } = usePasswordExpiry();
    const { data: mustChange, isLoading: mustLoading } = useMustChangePassword();
    const [dismissed, setDismissed] = useState(false);

    const forceChange = mustChange?.mustChange === true;
    const showExpiryWarning = expiryStatus?.showWarning === true;
    const isLoading = expiryLoading || mustLoading;

    // Don't show if loading, dismissed, or no warning needed
    if (isLoading || dismissed || (!forceChange && !showExpiryWarning)) {
        return null;
    }

    const daysLeft = expiryStatus?.daysUntilExpiry ?? 0;
    const expired =
        mustChange?.reason === 'expired' ||
        expiryStatus?.expired === true ||
        (showExpiryWarning && daysLeft <= 0);
    const firstLogin = mustChange?.reason === 'first_login';
    const isUrgent = firstLogin || expired || daysLeft <= 3;

    return (
        <div className={`px-4 py-3 ${isUrgent ? 'bg-red-50 border-red-200' : 'bg-yellow-50 border-yellow-200'} border-b`}>
            <div className="flex items-center justify-between max-w-7xl mx-auto">
                <div className="flex items-center gap-3">
                    <svg
                        className={`w-5 h-5 ${isUrgent ? 'text-red-500' : 'text-yellow-500'}`}
                        fill="currentColor"
                        viewBox="0 0 20 20"
                    >
                        <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                    <span className={`text-sm ${isUrgent ? 'text-red-800' : 'text-yellow-800'}`}>
                        {firstLogin ? (
                            <strong>Please set your password.</strong>
                        ) : expired ? (
                            <strong>Your password has expired.</strong>
                        ) : isUrgent ? (
                            <strong>
                                Your password expires in {daysLeft} day{daysLeft !== 1 ? 's' : ''}!
                            </strong>
                        ) : (
                            <>
                                Your password will expire in <strong>{daysLeft} days</strong>
                            </>
                        )}
                        {' '}
                        <Link
                            to="/settings/security"
                            state={
                                forceChange
                                    ? { mustChangePassword: true, reason: mustChange?.reason }
                                    : undefined
                            }
                            className={`underline hover:no-underline ${isUrgent ? 'text-red-700' : 'text-yellow-700'}`}
                        >
                            Change it now
                        </Link>
                    </span>
                </div>
                {!forceChange && (
                    <button
                        onClick={() => setDismissed(true)}
                        className={`p-1 rounded hover:bg-opacity-50 ${isUrgent ? 'hover:bg-red-100 text-red-600' : 'hover:bg-yellow-100 text-yellow-600'}`}
                        aria-label="Dismiss warning"
                    >
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                        </svg>
                    </button>
                )}
            </div>
        </div>
    );
}

export default PasswordExpiryWarning;
