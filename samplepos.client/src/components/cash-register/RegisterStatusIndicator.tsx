/**
 * Register Status Indicator
 * 
 * Displays current register session status in the POS header.
 * Shows open/closed status and provides quick actions.
 */

import { useState } from 'react';
import { useCurrentSession } from '../../hooks/useCashRegister';
import { useAuth } from '../../hooks/useAuth';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { OpenRegisterDialog } from './OpenRegisterDialog';
import { CloseRegisterDialog } from './CloseRegisterDialog';
import { CashMovementDialog } from './CashMovementDialog';
import {
    getPosSessionPolicyDefinition,
    parsePosSessionPolicy,
} from '@shared/pos/posSessionPolicySsot';
import {
    Loader2,
    AlertCircle,
    CheckCircle,
    DollarSign,
    ArrowDownCircle,
    ArrowUpCircle,
    X,
} from 'lucide-react';
import { formatCurrency } from '../../utils/currency';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '../ui/popover';

interface RegisterStatusIndicatorProps {
    compact?: boolean;
    onSessionChange?: () => void;
}

export function RegisterStatusIndicator({
    compact = false,
    onSessionChange,
}: RegisterStatusIndicatorProps) {
    const { data: session, posSessionPolicy, isLoading, error } = useCurrentSession();
    const { user } = useAuth();
    const policyDef = getPosSessionPolicyDefinition(parsePosSessionPolicy(posSessionPolicy));
    const isSessionOwner = !!session && session.userId === user?.id;

    const [openDialogVisible, setOpenDialogVisible] = useState(false);
    const [closeDialogVisible, setCloseDialogVisible] = useState(false);
    const [cashInDialogVisible, setCashInDialogVisible] = useState(false);
    const [cashOutDialogVisible, setCashOutDialogVisible] = useState(false);
    const [popoverOpen, setPopoverOpen] = useState(false);

    if (isLoading) {
        return (
            <div className="flex items-center gap-2 text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                {!compact && <span className="text-sm">Loading...</span>}
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex items-center gap-2 text-red-500">
                <AlertCircle className="h-4 w-4" />
                {!compact && <span className="text-sm">Error</span>}
            </div>
        );
    }

    const hasOpenSession = !!session;

    // Compact mode - just show status badge
    if (compact) {
        return (
            <>
                <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
                    <PopoverTrigger asChild>
                        <Button
                            variant="ghost"
                            size="sm"
                            className={`gap-2 ${hasOpenSession
                                    ? 'text-green-700 hover:bg-green-50'
                                    : 'text-yellow-700 hover:bg-yellow-50'
                                }`}
                        >
                            {hasOpenSession ? (
                                <>
                                    <CheckCircle className="h-4 w-4" />
                                    <span className="hidden sm:inline">{session.registerName}</span>
                                </>
                            ) : (
                                <>
                                    <AlertCircle className="h-4 w-4" />
                                    <span className="hidden sm:inline">No Register</span>
                                </>
                            )}
                        </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-64 p-2" align="end">
                        {hasOpenSession ? (
                            <div className="space-y-2">
                                <div className="text-sm font-medium">{session.registerName}</div>
                                <div className="text-xs text-gray-500">
                                    Session: {session.sessionNumber}
                                </div>
                                <div className="text-xs text-gray-500">
                                    Float: {formatCurrency(session.openingFloat)}
                                </div>
                                <div className="flex gap-1 mt-2">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="flex-1 text-xs"
                                        onClick={() => {
                                            setCashInDialogVisible(true);
                                            setPopoverOpen(false);
                                        }}
                                    >
                                        <ArrowDownCircle className="h-3 w-3 mr-1" />
                                        In
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="flex-1 text-xs"
                                        onClick={() => {
                                            setCashOutDialogVisible(true);
                                            setPopoverOpen(false);
                                        }}
                                    >
                                        <ArrowUpCircle className="h-3 w-3 mr-1" />
                                        Out
                                    </Button>
                                    {isSessionOwner && (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="flex-1 text-xs"
                                            onClick={() => {
                                                setCloseDialogVisible(true);
                                                setPopoverOpen(false);
                                            }}
                                        >
                                            <X className="h-3 w-3 mr-1" />
                                            Close
                                        </Button>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                <div className="text-sm text-yellow-700">{policyDef.cashierPromptTitle}</div>
                                <p className="text-xs text-gray-500">
                                    {policyDef.cashierPromptBody}
                                </p>
                                <Button
                                    size="sm"
                                    className="w-full bg-green-600 hover:bg-green-700"
                                    onClick={() => {
                                        setOpenDialogVisible(true);
                                        setPopoverOpen(false);
                                    }}
                                >
                                    <DollarSign className="h-4 w-4 mr-1" />
                                    {policyDef.cashierPromptAction}
                                </Button>
                            </div>
                        )}
                    </PopoverContent>
                </Popover>

                {/* Dialogs */}
                <OpenRegisterDialog
                    open={openDialogVisible}
                    onOpenChange={setOpenDialogVisible}
                    onSuccess={onSessionChange}
                />
                <CloseRegisterDialog
                    open={closeDialogVisible}
                    onOpenChange={setCloseDialogVisible}
                    sessionId={session?.id}
                    onSuccess={onSessionChange}
                />
                <CashMovementDialog
                    open={cashInDialogVisible}
                    onOpenChange={setCashInDialogVisible}
                    sessionId={session?.id}
                    type="CASH_IN"
                />
                <CashMovementDialog
                    open={cashOutDialogVisible}
                    onOpenChange={setCashOutDialogVisible}
                    sessionId={session?.id}
                    type="CASH_OUT"
                />
            </>
        );
    }

    // Full mode - show detailed status
    return (
        <>
            <div className="flex items-center gap-3">
                {hasOpenSession ? (
                    <>
                        <div className="flex items-center gap-2">
                            <Badge variant="default" className="bg-green-100 text-green-800">
                                <CheckCircle className="h-3 w-3 mr-1" />
                                {session.registerName}
                            </Badge>
                            <span className="text-sm text-gray-500">
                                {session.sessionNumber}
                            </span>
                        </div>
                        <div className="flex gap-1">
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setCashInDialogVisible(true)}
                            >
                                <ArrowDownCircle className="h-4 w-4 mr-1" />
                                Cash In
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setCashOutDialogVisible(true)}
                            >
                                <ArrowUpCircle className="h-4 w-4 mr-1" />
                                Cash Out
                            </Button>
                            {isSessionOwner && (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => setCloseDialogVisible(true)}
                                >
                                    Close Register
                                </Button>
                            )}
                        </div>
                    </>
                ) : (
                    <>
                        <Badge variant="secondary" className="bg-yellow-100 text-yellow-800">
                            <AlertCircle className="h-3 w-3 mr-1" />
                            No Register Open
                        </Badge>
                        <Button
                            size="sm"
                            className="bg-green-600 hover:bg-green-700"
                            onClick={() => setOpenDialogVisible(true)}
                        >
                            <DollarSign className="h-4 w-4 mr-1" />
                            {policyDef.cashierPromptAction}
                        </Button>
                    </>
                )}
            </div>

            {/* Dialogs */}
            <OpenRegisterDialog
                open={openDialogVisible}
                onOpenChange={setOpenDialogVisible}
                onSuccess={onSessionChange}
            />
            <CloseRegisterDialog
                open={closeDialogVisible}
                onOpenChange={setCloseDialogVisible}
                sessionId={session?.id}
                onSuccess={onSessionChange}
            />
            <CashMovementDialog
                open={cashInDialogVisible}
                onOpenChange={setCashInDialogVisible}
                sessionId={session?.id}
                type="CASH_IN"
            />
            <CashMovementDialog
                open={cashOutDialogVisible}
                onOpenChange={setCashOutDialogVisible}
                sessionId={session?.id}
                type="CASH_OUT"
            />
        </>
    );
}
