/**
 * Cash Register API Hook
 * 
 * React Query hooks for cash register management.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '../services/api';
import { useOfflineContext } from '../contexts/OfflineContext';
import type {
    CashRegister,
    CashRegisterSession,
    CashMovement,
    SessionSummary,
    OpenSessionInput,
    CloseSessionInput,
    RecordMovementInput,
    SessionStatus
} from '../types/cashRegister';
import {
    POS_SESSION_POLICY_STORAGE_KEY,
    parsePosSessionPolicy,
} from '@shared/pos/posSessionPolicySsot';

// Query keys
const QUERY_KEYS = {
    registers: ['cash-registers'] as const,
    register: (id: string) => ['cash-registers', id] as const,
    currentSession: ['cash-register-session', 'current'] as const,
    sessions: (filters?: SessionFilters) => ['cash-register-sessions', filters] as const,
    session: (id: string) => ['cash-register-session', id] as const,
    sessionSummary: (id: string) => ['cash-register-session', id, 'summary'] as const,
    sessionMovements: (id: string) => ['cash-register-session', id, 'movements'] as const,
};

interface SessionFilters {
    registerId?: string;
    userId?: string;
    status?: SessionStatus;
    startDate?: string;
    endDate?: string;
    limit?: number;
    offset?: number;
}

// ============================================================================
// REGISTER HOOKS
// ============================================================================

/**
 * Get all cash registers
 */
export function useRegisters() {
    return useQuery({
        queryKey: QUERY_KEYS.registers,
        queryFn: async () => {
            const response = await api.get<{ success: boolean; data: CashRegister[] }>(
                '/cash-registers'
            );
            return response.data.data;
        },
    });
}

/**
 * Create a new register
 */
export function useCreateRegister() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (data: { name: string; location?: string }) => {
            const response = await api.post<{ success: boolean; data: CashRegister }>(
                '/cash-registers',
                data
            );
            return response.data.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.registers });
        },
    });
}

/**
 * Update a register (name, location, isActive)
 */
export function useUpdateRegister() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({ id, ...data }: { id: string; name?: string; location?: string | null; isActive?: boolean }) => {
            const response = await api.put<{ success: boolean; data: CashRegister }>(
                `/cash-registers/${id}`,
                data
            );
            return response.data.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.registers });
        },
    });
}

// ============================================================================
// SESSION HOOKS
// ============================================================================

// Key for caching session in localStorage (offline resilience)
const SESSION_CACHE_KEY = 'cash_register_session';
const SESSION_POLICY_KEY = POS_SESSION_POLICY_STORAGE_KEY;
const TRANSACTION_MODE_KEY = 'pos_transaction_mode';

interface SessionWithPolicy {
    session: CashRegisterSession | null;
    posSessionPolicy: string;
    posTransactionMode: 'DirectSale' | 'OrderToPayment';
}

function getCachedSession(): CashRegisterSession | null {
    try {
        const raw = localStorage.getItem(SESSION_CACHE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

/** Read the cached transaction mode. ALWAYS returns the last server-confirmed value. */
function getCachedTransactionMode(): 'DirectSale' | 'OrderToPayment' {
    const val = localStorage.getItem(TRANSACTION_MODE_KEY);
    return val === 'OrderToPayment' ? 'OrderToPayment' : 'DirectSale';
}

function getCachedSessionWithPolicy(): SessionWithPolicy {
    return {
        session: getCachedSession(),
        posSessionPolicy: parsePosSessionPolicy(localStorage.getItem(SESSION_POLICY_KEY)),
        posTransactionMode: getCachedTransactionMode(),
    };
}

/**
 * Get current user's open session + POS session policy (single API call).
 *
 * RESILIENCE CONTRACT:
 * - Online: Always fetches fresh from server on mount (refetchOnMount: always).
 * - Online: Re-polls every 15 seconds to catch admin setting changes.
 * - Offline: Returns last server-confirmed value from localStorage.
 * - Cross-tab: Listens for localStorage changes so admin tab → POS tab is instant.
 * - Settings save: Cache is invalidated immediately (see SystemSettingsTab).
 * - Hard refresh: staleTime:0 guarantees a server fetch; localStorage is placeholder only.
 */
export function useCurrentSession() {
    const { isOnline } = useOfflineContext();
    const queryClient = useQueryClient();

    // Track the last confirmed value so we never lose it on fetch errors
    const lastConfirmed = useRef<SessionWithPolicy>(getCachedSessionWithPolicy());

    const query = useQuery<SessionWithPolicy>({
        queryKey: QUERY_KEYS.currentSession,
        queryFn: async (): Promise<SessionWithPolicy> => {
            const response = await api.get<{
                success: boolean;
                data: CashRegisterSession | null;
                posSessionPolicy?: string;
                posTransactionMode?: string;
            }>('/cash-registers/sessions/current');
            const session = response.data.data;
            const posSessionPolicy = parsePosSessionPolicy(response.data.posSessionPolicy);
            const posTransactionMode = (response.data.posTransactionMode || 'DirectSale') as 'DirectSale' | 'OrderToPayment';
            // Persist for offline use — this is the single source of truth for cache
            if (session) {
                localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(session));
            } else {
                localStorage.removeItem(SESSION_CACHE_KEY);
            }
            localStorage.setItem(SESSION_POLICY_KEY, posSessionPolicy);
            localStorage.setItem(TRANSACTION_MODE_KEY, posTransactionMode);

            const result: SessionWithPolicy = { session, posSessionPolicy, posTransactionMode };
            lastConfirmed.current = result;
            return result;
        },
        // Poll every 15s online; stop polling offline (localStorage is used)
        refetchInterval: isOnline ? 15_000 : false,
        staleTime: 30_000,
        refetchOnMount: 'always',
        // Resume coordinator + interval polling — avoid focus refetch storms after idle.
        refetchOnWindowFocus: false,
        // On network errors, keep showing the last successful data
        retry: 2,
        retryDelay: 2000,
        // Seed UI from localStorage while the first fetch is in flight
        placeholderData: getCachedSessionWithPolicy,
    });

    // Cross-tab sync: if another tab changes the setting via localStorage, pick it up
    useEffect(() => {
        const handleStorage = (e: StorageEvent) => {
            if (e.key === TRANSACTION_MODE_KEY || e.key === SESSION_POLICY_KEY) {
                // Another tab wrote a new value — invalidate so React Query re-reads
                queryClient.invalidateQueries({ queryKey: QUERY_KEYS.currentSession });
            }
        };
        window.addEventListener('storage', handleStorage);
        return () => window.removeEventListener('storage', handleStorage);
    }, [queryClient]);

    // Derive the effective value: prefer fresh query data, fall back to last confirmed, then cache
    const effective = query.data ?? lastConfirmed.current;

    return {
        ...query,
        data: effective.session,
        posSessionPolicy: effective.posSessionPolicy,
        posTransactionMode: effective.posTransactionMode,
    };
}

/**
 * Get sessions with filters
 */
export function useSessions(filters?: SessionFilters) {
    return useQuery({
        queryKey: QUERY_KEYS.sessions(filters),
        queryFn: async () => {
            const params = new URLSearchParams();
            if (filters?.registerId) params.append('registerId', filters.registerId);
            if (filters?.userId) params.append('userId', filters.userId);
            if (filters?.status) params.append('status', filters.status);
            if (filters?.startDate) params.append('startDate', filters.startDate);
            if (filters?.endDate) params.append('endDate', filters.endDate);
            if (filters?.limit) params.append('limit', filters.limit.toString());
            if (filters?.offset) params.append('offset', filters.offset.toString());

            const response = await api.get<{
                success: boolean;
                data: CashRegisterSession[];
                pagination: { total: number; limit: number; offset: number };
            }>(`/cash-registers/sessions?${params.toString()}`);

            return {
                sessions: response.data.data,
                pagination: response.data.pagination,
            };
        },
    });
}

/**
 * Get session summary with movements
 */
export function useSessionSummary(sessionId: string | undefined) {
    return useQuery({
        queryKey: QUERY_KEYS.sessionSummary(sessionId || ''),
        queryFn: async () => {
            if (!sessionId) return null;
            const response = await api.get<{ success: boolean; data: SessionSummary }>(
                `/cash-registers/sessions/${sessionId}/summary`
            );
            return response.data.data;
        },
        enabled: !!sessionId,
        staleTime: 30000, // Cache for 30 seconds to prevent infinite refetches
        refetchOnMount: true, // Refetch once when dialog opens
        refetchOnWindowFocus: false, // Don't refetch on window focus
    });
}

/**
 * Open a new session
 */
export function useOpenSession() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (data: OpenSessionInput) => {
            try {
                const response = await api.post<{ success: boolean; data: CashRegisterSession; error?: string }>(
                    '/cash-registers/sessions/open',
                    data
                );
                if (!response.data.success) {
                    throw new Error(response.data.error || 'Failed to open session');
                }
                return response.data.data;
            } catch (error: unknown) {
                // Extract error message from axios error response
                if (error && typeof error === 'object' && 'response' in error) {
                    const axiosError = error as { response?: { data?: { error?: string; message?: string } } };
                    const errorMessage = axiosError.response?.data?.error
                        || axiosError.response?.data?.message
                        || 'Failed to open session';
                    throw new Error(errorMessage);
                }
                throw error;
            }
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.currentSession });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.registers });
        },
    });
}

/**
 * Close a session
 */
export function useCloseSession() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({ sessionId, data }: { sessionId: string; data: CloseSessionInput }) => {
            const response = await api.post<{ success: boolean; data: CashRegisterSession }>(
                `/cash-registers/sessions/${sessionId}/close`,
                data
            );
            return response.data.data;
        },
        onSuccess: (_, { sessionId }) => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.currentSession });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.session(sessionId) });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.sessionSummary(sessionId) });
        },
    });
}

/**
 * Reconcile a session (manager only)
 */
export function useReconcileSession() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (sessionId: string) => {
            const response = await api.post<{ success: boolean; data: CashRegisterSession }>(
                `/cash-registers/sessions/${sessionId}/reconcile`
            );
            return response.data.data;
        },
        onSuccess: (_, sessionId) => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.session(sessionId) });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.sessions() });
        },
    });
}

/**
 * Force-close a stale/abandoned session (admin/manager only)
 */
export function useForceCloseSession() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (sessionId: string) => {
            try {
                const response = await api.post<{ success: boolean; data: CashRegisterSession; error?: string }>(
                    `/cash-registers/sessions/${sessionId}/force-close`
                );
                if (!response.data.success) {
                    throw new Error(response.data.error || 'Failed to force-close session');
                }
                return response.data.data;
            } catch (error: unknown) {
                if (error && typeof error === 'object' && 'response' in error) {
                    const axiosError = error as { response?: { data?: { error?: string; message?: string } } };
                    const errorMessage = axiosError.response?.data?.error
                        || axiosError.response?.data?.message
                        || 'Failed to force-close session';
                    throw new Error(errorMessage);
                }
                throw error;
            }
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.currentSession });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.registers });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.sessions() });
        },
    });
}

// ============================================================================
// MOVEMENT HOOKS
// ============================================================================

/**
 * Get movements for a session
 */
export function useSessionMovements(sessionId: string | undefined) {
    return useQuery({
        queryKey: QUERY_KEYS.sessionMovements(sessionId || ''),
        queryFn: async () => {
            if (!sessionId) return [];
            const response = await api.get<{ success: boolean; data: CashMovement[] }>(
                `/cash-registers/sessions/${sessionId}/movements`
            );
            return response.data.data;
        },
        enabled: !!sessionId,
    });
}

/**
 * Record a cash movement
 */
export function useRecordMovement() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (data: RecordMovementInput) => {
            const response = await api.post<{ success: boolean; data: CashMovement }>(
                '/cash-registers/movements',
                data
            );
            return response.data.data;
        },
        onSuccess: (_, { sessionId }) => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.sessionMovements(sessionId) });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.sessionSummary(sessionId) });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.currentSession });
        },
    });
}
