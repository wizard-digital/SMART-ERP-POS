/**
 * Open Register Dialog
 * 
 * Dialog for opening a new cash register session.
 * Shows register availability status and handles:
 * - Opening a fresh session on an available register
 * - Auto-resuming if user already has a session on the selected register
 * - Force-closing stale sessions (admin/manager only)
 */

import { useState, useMemo, useRef, useEffect } from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '../ui/temp-ui-components';
import { useTransactionGuard, ZINDEX } from '../../hooks/useTransactionGuard';
import type { GuardHandle } from '../../hooks/useTransactionGuard';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../ui/select';
import { useRegisters, useOpenSession, useForceCloseSession, useCurrentSession } from '../../hooks/useCashRegister';
import { useAuth } from '../../hooks/useAuth';
import { useHasPermission } from '../../authorization/useAuthorization';
import { Loader2, DollarSign, AlertTriangle, User } from 'lucide-react';
import { formatTimestamp } from '../../utils/businessDate';
import {
    getPosSessionPolicyDefinition,
    parsePosSessionPolicy,
    posSessionAllowsJoin,
} from '@shared/pos/posSessionPolicySsot';

interface OpenRegisterDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess?: () => void;
}

export function OpenRegisterDialog({
    open,
    onOpenChange,
    onSuccess,
}: OpenRegisterDialogProps) {
    const [registerId, setRegisterId] = useState<string>('');
    const [openingFloat, setOpeningFloat] = useState<string>('');
    const [showForceCloseConfirm, setShowForceCloseConfirm] = useState(false);

    // ── Transaction Guard ──────────────────────────────────────────────────────
    const { openGuard, closeGuard } = useTransactionGuard();
    const guardRef = useRef<GuardHandle | null>(null);
    useEffect(() => {
        if (open) {
            guardRef.current = openGuard({ cancellable: false, label: 'Open cash register' });
            return () => { if (guardRef.current) { closeGuard(guardRef.current.id); guardRef.current = null; } };
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const { data: registers, isLoading: loadingRegisters } = useRegisters();
    const openSession = useOpenSession();
    const forceCloseSession = useForceCloseSession();
    const { user } = useAuth();
    const { data: currentSession, posSessionPolicy } = useCurrentSession();
    const policy = parsePosSessionPolicy(posSessionPolicy);
    const canJoinOccupied = posSessionAllowsJoin(policy);
    const policyDef = getPosSessionPolicyDefinition(policy);

    const activeRegisters = registers?.filter((r) => r.isActive) || [];

    // Selected register's details
    const selectedRegister = useMemo(
        () => activeRegisters.find((r) => r.id === registerId) ?? null,
        [activeRegisters, registerId]
    );

    const isOnSelectedSession =
        !!selectedRegister?.currentSessionId &&
        currentSession?.id === selectedRegister.currentSessionId;
    const isOccupiedByMe = selectedRegister?.currentSessionId != null && (
        selectedRegister.currentSessionUserId === user?.id || isOnSelectedSession
    );
    const isOccupiedByOther = selectedRegister?.currentSessionId != null
        && selectedRegister.currentSessionUserId !== user?.id
        && !isOnSelectedSession;
    const isAvailable = selectedRegister != null && selectedRegister.currentSessionId == null;
    const canForceCloseRegister = useHasPermission('pos.approve');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!registerId) return;

        const floatAmount = openingFloat ? parseFloat(openingFloat) : 0;

        try {
            await openSession.mutateAsync({
                registerId,
                openingFloat: floatAmount,
            });
            onOpenChange(false);
            setRegisterId('');
            setOpeningFloat('');
            onSuccess?.();
        } catch (error) {
            console.error('Failed to open session:', error);
        }
    };

    const handleForceClose = async () => {
        if (!selectedRegister?.currentSessionId) return;
        try {
            await forceCloseSession.mutateAsync(selectedRegister.currentSessionId);
            setShowForceCloseConfirm(false);
            // After force-close, the register is free — user can now open it
        } catch (error) {
            console.error('Failed to force-close session:', error);
        }
    };

    // Format the opened-at time for display
    const formatSessionTime = (dateStr: string | null | undefined): string => {
        if (!dateStr) return '';
        try {
            return formatTimestamp(dateStr);
        } catch {
            return dateStr;
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange} zIndex={guardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <DollarSign className="h-5 w-5 text-green-600" />
                        {policyDef.cashierPromptAction}
                    </DialogTitle>
                    <DialogDescription>
                        {policyDef.cashierPromptBody}
                    </DialogDescription>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="space-y-4 mt-4">
                    <div className="space-y-2">
                        <Label htmlFor="register">Select Register</Label>
                        {loadingRegisters ? (
                            <div className="flex items-center gap-2 text-sm text-gray-500">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Loading registers...
                            </div>
                        ) : (
                            <Select value={registerId} onValueChange={(val) => {
                                setRegisterId(val);
                                setShowForceCloseConfirm(false);
                                openSession.reset();
                            }}>
                                <SelectTrigger id="register">
                                    <SelectValue placeholder="Select a register" />
                                </SelectTrigger>
                                <SelectContent>
                                    {activeRegisters.map((register) => {
                                        const occupied = register.currentSessionId != null;
                                        const isMine = register.currentSessionUserId === user?.id
                                            || register.currentSessionId === currentSession?.id;
                                        return (
                                            <SelectItem key={register.id} value={register.id}>
                                                <span className="flex items-center gap-2">
                                                    <span
                                                        className={`inline-block w-2 h-2 rounded-full ${
                                                            !occupied ? 'bg-green-500' :
                                                            isMine ? 'bg-blue-500' :
                                                            'bg-red-500'
                                                        }`}
                                                    />
                                                    {register.name}
                                                    {register.location && ` - ${register.location}`}
                                                {occupied && !isMine && canJoinOccupied && (
                                                        <span className="text-xs text-blue-600 ml-1">
                                                            (Join)
                                                        </span>
                                                    )}
                                                    {occupied && !isMine && !canJoinOccupied && (
                                                        <span className="text-xs text-red-500 ml-1">
                                                            (In use)
                                                        </span>
                                                    )}
                                                    {isMine && (
                                                        <span className="text-xs text-blue-500 ml-1">
                                                            (Your session)
                                                        </span>
                                                    )}
                                                </span>
                                            </SelectItem>
                                        );
                                    })}
                                </SelectContent>
                            </Select>
                        )}
                    </div>

                    {/* Status message for occupied by me (auto-resume) */}
                    {isOccupiedByMe && (
                        <div className="p-3 bg-blue-50 border border-blue-200 rounded-md text-sm text-blue-700">
                            <div className="flex items-center gap-2 font-medium">
                                <User className="h-4 w-4" />
                                You have an open session on this register
                            </div>
                            <p className="mt-1 text-xs">
                                Session {selectedRegister?.currentSessionNumber} — opened{' '}
                                {formatSessionTime(selectedRegister?.currentSessionOpenedAt)}.
                                Click &quot;Resume Session&quot; to continue.
                            </p>
                        </div>
                    )}

                    {/* Status message for occupied by another user */}
                    {isOccupiedByOther && (
                        <div className={`p-3 border rounded-md text-sm ${canJoinOccupied ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>
                            <div className="flex items-center gap-2 font-medium">
                                <AlertTriangle className="h-4 w-4" />
                                {canJoinOccupied
                                    ? `Open on this counter — ${selectedRegister?.currentSessionUserName || 'another cashier'} started session ${selectedRegister?.currentSessionNumber}`
                                    : `Register in use by ${selectedRegister?.currentSessionUserName || 'another user'}`}
                            </div>
                            <p className="mt-1 text-xs">
                                Session {selectedRegister?.currentSessionNumber} — opened{' '}
                                {formatSessionTime(selectedRegister?.currentSessionOpenedAt)}.
                                {canJoinOccupied
                                    ? ' Join this session to sell on the same drawer. Do not count a second float.'
                                    : canForceCloseRegister
                                        ? ' You can force-close this session as a manager.'
                                        : ' Please select a different register or ask a manager to close this session.'}
                            </p>
                            {canForceCloseRegister && !showForceCloseConfirm && (
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="mt-2 border-amber-300 text-amber-700 hover:bg-amber-100"
                                    onClick={() => setShowForceCloseConfirm(true)}
                                >
                                    Force Close Session
                                </Button>
                            )}
                            {canForceCloseRegister && showForceCloseConfirm && (
                                <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
                                    <p className="font-medium">
                                        Are you sure? This will close {selectedRegister?.currentSessionUserName}&apos;s
                                        session without a cash count.
                                    </p>
                                    <div className="flex gap-2 mt-2">
                                        <Button
                                            type="button"
                                            variant="destructive"
                                            size="sm"
                                            disabled={forceCloseSession.isPending}
                                            onClick={handleForceClose}
                                        >
                                            {forceCloseSession.isPending ? (
                                                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                            ) : null}
                                            Confirm Force Close
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            onClick={() => setShowForceCloseConfirm(false)}
                                        >
                                            Cancel
                                        </Button>
                                    </div>
                                    {forceCloseSession.error && (
                                        <p className="mt-1 text-red-600">
                                            {forceCloseSession.error instanceof Error
                                                ? forceCloseSession.error.message
                                                : 'Force-close failed'}
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Opening float — only show for available registers or resume */}
                    {(isAvailable || (!selectedRegister && registerId === '')) && (
                        <div className="space-y-2">
                            <Label htmlFor="openingFloat">Opening Float (UGX)</Label>
                            <Input
                                id="openingFloat"
                                type="number"
                                min="0"
                                step="100"
                                placeholder="Enter opening cash amount"
                                value={openingFloat}
                                onChange={(e) => setOpeningFloat(e.target.value)}
                                className="text-lg"
                            />
                            <p className="text-xs text-gray-500">
                                Count the cash in the drawer before starting. Leave empty or 0 if no float.
                            </p>
                        </div>
                    )}

                    {openSession.error && (
                        <div className="p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-600">
                            {openSession.error instanceof Error
                                ? openSession.error.message
                                : 'Failed to open register'}
                        </div>
                    )}

                    <DialogFooter className="gap-2 mt-6">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                        >
                            Cancel
                        </Button>
                        {isOccupiedByMe ? (
                            <Button
                                type="submit"
                                disabled={openSession.isPending}
                                className="bg-blue-600 hover:bg-blue-700"
                            >
                                {openSession.isPending ? (
                                    <>
                                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                        Resuming...
                                    </>
                                ) : (
                                    'Resume Session'
                                )}
                            </Button>
                        ) : isOccupiedByOther && canJoinOccupied ? (
                            <Button
                                type="submit"
                                disabled={!registerId || openSession.isPending}
                                className="bg-blue-600 hover:bg-blue-700"
                            >
                                {openSession.isPending ? (
                                    <>
                                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                        Joining...
                                    </>
                                ) : (
                                    'Join Session'
                                )}
                            </Button>
                        ) : (
                            <Button
                                type="submit"
                                disabled={!registerId || isOccupiedByOther || openSession.isPending}
                                className="bg-green-600 hover:bg-green-700"
                            >
                                {openSession.isPending ? (
                                    <>
                                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                        Opening...
                                    </>
                                ) : (
                                    'Open Register'
                                )}
                            </Button>
                        )}
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
