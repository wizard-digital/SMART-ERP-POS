/**
 * Security Settings Page
 * 
 * Allows users to manage security settings including 2FA and password.
 */

import { useLocation } from 'react-router-dom';
import { TwoFactorSetup } from '../../components/auth/TwoFactorSetup';
import { ChangePasswordForm } from '../../components/auth/ChangePasswordForm';
import QuickLoginSettings from './QuickLoginSettings';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Shield, AlertTriangle, Key, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useMustChangePassword, usePasswordExpiry } from '../../hooks/usePasswordPolicy';
import Layout from '../../components/Layout';

export default function SecuritySettingsPage() {
    const location = useLocation();
    const [showSetupAlert, setShowSetupAlert] = useState(false);
    const { data: expiryStatus } = usePasswordExpiry();
    const { data: mustChange } = useMustChangePassword();

    const routeReason = (location.state as { reason?: 'expired' | 'first_login' | null } | null)?.reason;
    const passwordReason = mustChange?.reason || routeReason || null;
    const passwordRequired =
        mustChange?.mustChange === true ||
        (location.state as { mustChangePassword?: boolean } | null)?.mustChangePassword === true;

    useEffect(() => {
        // Check if we were redirected here with a message to set up 2FA / change password
        if (location.state?.message) {
            setShowSetupAlert(true);
        }
    }, [location.state]);

    return (
        <Layout>
            <div className="container mx-auto py-6 px-4 max-w-4xl">
                <div className="flex items-center gap-3 mb-6">
                    <Shield className="w-8 h-8 text-blue-600" />
                    <div>
                        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                            Security Settings
                        </h1>
                        <p className="text-gray-500 dark:text-gray-400">
                            Manage your account security settings
                        </p>
                    </div>
                </div>

                {showSetupAlert && (
                    <div className="mb-6 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg flex items-start gap-3">
                        <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                        <div>
                            <p className="font-medium text-amber-800 dark:text-amber-200">
                                {(location.state as { mustChangePassword?: boolean } | null)?.mustChangePassword
                                    ? 'Password change required'
                                    : 'Two-Factor Authentication Required'}
                            </p>
                            <p className="text-sm text-amber-700 dark:text-amber-300">
                                {location.state?.message || 'Your role requires 2FA. Please set it up to continue using all features.'}
                            </p>
                        </div>
                        <button
                            onClick={() => setShowSetupAlert(false)}
                            className="ml-auto text-amber-600 hover:text-amber-800"
                        >
                            ✕
                        </button>
                    </div>
                )}

                <div className="space-y-6">
                    {/* Two-Factor Authentication */}
                    <TwoFactorSetup />

                    {/* Quick Login (POS PIN / Biometric) */}
                    <QuickLoginSettings />

                    {/* Password Section */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Key className="w-5 h-5 text-blue-600" />
                                Password
                                {expiryStatus?.showWarning && (
                                    <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-800 rounded-full">
                                        {expiryStatus.expired || (expiryStatus.daysUntilExpiry ?? 0) <= 0
                                            ? 'Expired'
                                            : `Expires in ${expiryStatus.daysUntilExpiry} days`}
                                    </span>
                                )}
                            </CardTitle>
                            <CardDescription>
                                Update your password to keep your account secure
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <ChangePasswordForm
                                required={passwordRequired}
                                reason={passwordReason}
                            />
                        </CardContent>
                    </Card>

                    {/* Session Management (placeholder for future) */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Lock className="w-5 h-5 text-gray-400" />
                                Active Sessions
                            </CardTitle>
                            <CardDescription>
                                View and manage your active sessions
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <p className="text-sm text-gray-500">
                                Session management functionality coming soon.
                            </p>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </Layout>
    );
}
