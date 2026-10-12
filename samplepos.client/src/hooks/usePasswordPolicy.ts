/**
 * Password Policy API hooks
 *
 * Provides React Query hooks for password management:
 * - Policy requirements
 * - Password validation
 * - Password change
 * - Expiry status
 *
 * Uses the shared apiClient so tenant headers, token refresh, and
 * 401 handling match the rest of the app (never raw axios + stale token).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../utils/api';
import { getAccessToken } from './useTokenRefresh';

export interface PasswordPolicy {
    requirements: {
        minLength: number;
        maxLength: number;
        requireUppercase: boolean;
        requireLowercase: boolean;
        requireDigit: boolean;
        requireSpecial: boolean;
    };
    expiryDays: Record<string, number>;
    historyCount: number;
    maxFailedAttempts: number;
    lockoutMinutes: number;
}

export interface PasswordValidation {
    valid: boolean;
    errors: string[];
    strength: 'weak' | 'fair' | 'good' | 'strong';
    score: number;
}

export interface PasswordExpiryStatus {
    expired: boolean;
    expiresAt: string | null;
    daysUntilExpiry: number | null;
    showWarning: boolean;
}

export interface MustChangePasswordStatus {
    mustChange: boolean;
    reason: 'expired' | 'first_login' | null;
}

export interface ChangePasswordData {
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
}

function hasSessionToken(): boolean {
    return !!(getAccessToken() || localStorage.getItem('auth_token'));
}

/**
 * Get password policy requirements (public - no auth needed)
 */
export function usePasswordPolicy() {
    return useQuery({
        queryKey: ['password-policy'],
        queryFn: async (): Promise<PasswordPolicy> => {
            const response = await apiClient.get('auth/password/policy');
            return response.data.data;
        },
        staleTime: 1000 * 60 * 60, // Cache for 1 hour - policy rarely changes
    });
}

/**
 * Validate password strength (debounced in component)
 */
export function useValidatePassword() {
    return useMutation({
        mutationFn: async (password: string): Promise<PasswordValidation> => {
            const response = await apiClient.post('auth/password/validate', { password });
            return response.data.data;
        },
    });
}

/**
 * Get password expiry status (requires auth)
 */
export function usePasswordExpiry() {
    return useQuery({
        queryKey: ['password-expiry'],
        queryFn: async (): Promise<PasswordExpiryStatus> => {
            const response = await apiClient.get('auth/password/expiry');
            return response.data.data;
        },
        retry: false,
        enabled: hasSessionToken(),
    });
}

/**
 * Check if user must change password (requires auth)
 */
export function useMustChangePassword() {
    return useQuery({
        queryKey: ['must-change-password'],
        queryFn: async (): Promise<MustChangePasswordStatus> => {
            const response = await apiClient.get('auth/password/must-change');
            return response.data.data;
        },
        retry: false,
        enabled: hasSessionToken(),
    });
}

/**
 * Change password (requires auth)
 */
export function useChangePassword() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (data: ChangePasswordData): Promise<void> => {
            await apiClient.post('auth/password/change', data);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['password-expiry'] });
            queryClient.invalidateQueries({ queryKey: ['must-change-password'] });
        },
    });
}
