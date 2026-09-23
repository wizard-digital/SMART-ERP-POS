/**
 * CRM Module — ERP-style Opportunity Workspace
 *
 * Layout:
 *   - Pipeline kanban / Leads table (list views)
 *   - Click an opportunity card => OpportunityWorkspace (single-screen deal view)
 *
 * Workspace layout (ERP pattern):
 *   Header bar: title, stage badge, value, probability, deadline, assigned, actions
 *   Left 40%:  Activity timeline (heartbeat of the deal)
 *   Right 60%: Opportunity details card
 *   Full width: Line items (BOQ table)
 *   Bottom:     Documents
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatCurrency } from '../../utils/currency';
import Layout from '../../components/Layout';
import { DatePicker } from '../../components/ui/date-picker';
import { apiClient, api } from '../../utils/api';
import type { ApiResponse } from '../../utils/api';
import { formatTimestampDate } from '../../utils/businessDate';

// ============================================================================
// TYPES
// ============================================================================

interface Lead {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    source: string | null;
    notes: string | null;
    status: string;
    convertedCustomerId: string | null;
    createdByName?: string;
    createdAt: string;
}

interface Opportunity {
    id: string;
    customerId: string | null;
    leadId: string | null;
    title: string;
    tenderRef: string | null;
    procuringEntity: string | null;
    deadline: string | null;
    estimatedValue: number | null;
    probability: number;
    status: string;
    assignedTo: string | null;
    assignedToName?: string;
    customerName?: string;
    leadName?: string;
    notes: string | null;
    wonAt: string | null;
    lostReason: string | null;
    quotationId: string | null;
    itemCount?: number;
    createdAt: string;
    updatedAt?: string;
}

interface OpportunityItem {
    id: string;
    opportunityId: string;
    description: string | null;
    quantity: number | null;
    estimatedPrice: number | null;
    lineTotal: number | null;
    sortOrder: number;
}

interface OpportunityDocument {
    id: string;
    opportunityId: string;
    fileName: string;
    fileUrl: string;
    fileSize: number | null;
    mimeType: string | null;
    uploadedBy: string | null;
    uploadedByName?: string;
    uploadedAt: string;
}

interface Activity {
    id: string;
    opportunityId: string | null;
    leadId: string | null;
    type: string;
    title: string | null;
    notes: string | null;
    activityDate: string | null;
    dueDate: string | null;
    completed: boolean;
    createdByName?: string;
    createdAt: string;
    opportunityTitle?: string;
    leadName?: string;
}

interface OpportunityDetail {
    opportunity: Opportunity;
    items: OpportunityItem[];
    activities: Activity[];
    documents: OpportunityDocument[];
}

interface PipelineSummary {
    status: string;
    count: number;
    totalValue: number;
}

interface Customer {
    id: string;
    name: string;
    phone?: string;
    email?: string;
}

// ============================================================================
// API helpers
// ============================================================================

const crmApi = {
    getLeads: (params: Record<string, unknown>) =>
        apiClient.get<ApiResponse>('crm/leads', { params }),
    createLead: (data: Record<string, unknown>) =>
        apiClient.post<ApiResponse>('crm/leads', data),
    updateLead: (id: string, data: Record<string, unknown>) =>
        apiClient.put<ApiResponse>(`crm/leads/${id}`, data),
    deleteLead: (id: string) =>
        apiClient.delete<ApiResponse>(`crm/leads/${id}`),
    convertLead: (id: string, customerId: string) =>
        apiClient.post<ApiResponse>(`crm/leads/${id}/convert`, { customerId }),

    getOpportunities: (params: Record<string, unknown>) =>
        apiClient.get<ApiResponse>('crm/opportunities', { params }),
    getOpportunityById: (id: string) =>
        apiClient.get<ApiResponse>(`crm/opportunities/${id}`),
    createOpportunity: (data: Record<string, unknown>) =>
        apiClient.post<ApiResponse>('crm/opportunities', data),
    updateOpportunityStatus: (id: string, status: string, lostReason?: string) =>
        apiClient.put<ApiResponse>(`crm/opportunities/${id}/status`, { status, lostReason }),
    deleteOpportunity: (id: string) =>
        apiClient.delete<ApiResponse>(`crm/opportunities/${id}`),
    getPipeline: () =>
        apiClient.get<ApiResponse>('crm/opportunities/pipeline'),

    getActivities: (params: Record<string, unknown>) =>
        apiClient.get<ApiResponse>('crm/activities', { params }),
    createActivity: (data: Record<string, unknown>) =>
        apiClient.post<ApiResponse>('crm/activities', data),
    updateActivity: (id: string, data: Record<string, unknown>) =>
        apiClient.put<ApiResponse>(`crm/activities/${id}`, data),
    deleteActivity: (id: string) =>
        apiClient.delete<ApiResponse>(`crm/activities/${id}`),
};

// ============================================================================
// REUSABLE SEARCH SELECTS
// ============================================================================

function CustomerSearchSelect({
    value,
    onChange,
    label = 'Customer',
    required = false,
}: {
    value: string;
    onChange: (id: string, name: string) => void;
    label?: string;
    required?: boolean;
}) {
    const [search, setSearch] = useState('');
    const [open, setOpen] = useState(false);
    const [selectedName, setSelectedName] = useState('');
    const ref = useRef<HTMLDivElement>(null);

    const { data: customers } = useQuery({
        queryKey: ['customers-search', search],
        queryFn: () =>
            api.customers.list({
                page: 1,
                limit: 20,
                search: search || undefined,
            } as Record<string, unknown>),
        select: (res) => (res.data?.data || []) as Customer[],
        enabled: open,
    });

    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    return (
        <div ref={ref} className="relative">
            <label className="block text-sm font-medium text-gray-700 mb-1">
                {label} {required && '*'}
            </label>
            <input
                type="text"
                value={open ? search : selectedName || ''}
                onChange={(e) => {
                    setSearch(e.target.value);
                    if (!open) setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                placeholder="Search customers..."
                className="w-full border rounded-lg px-3 py-2 text-sm"
            />
            {value && (
                <button
                    type="button"
                    onClick={() => {
                        onChange('', '');
                        setSelectedName('');
                        setSearch('');
                    }}
                    className="absolute right-2 top-8 text-gray-400 hover:text-gray-600 text-sm"
                >
                    x
                </button>
            )}
            {open && customers && (
                <div className="absolute z-20 mt-1 w-full bg-white border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                    {customers.length === 0 ? (
                        <div className="px-3 py-2 text-sm text-gray-400">No customers found</div>
                    ) : (
                        customers.map((c) => (
                            <button
                                key={c.id}
                                type="button"
                                onClick={() => {
                                    onChange(c.id, c.name);
                                    setSelectedName(c.name);
                                    setSearch('');
                                    setOpen(false);
                                }}
                                className={`block w-full text-left px-3 py-2 text-sm hover:bg-blue-50 ${c.id === value ? 'bg-blue-50 font-medium' : ''
                                    }`}
                            >
                                <div className="font-medium">{c.name}</div>
                                {(c.phone || c.email) && (
                                    <div className="text-xs text-gray-400">{c.phone || c.email}</div>
                                )}
                            </button>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}

function LeadSearchSelect({
    value,
    onChange,
    label = 'Lead',
    required = false,
    excludeConverted = false,
}: {
    value: string;
    onChange: (id: string, name: string) => void;
    label?: string;
    required?: boolean;
    excludeConverted?: boolean;
}) {
    const [search, setSearch] = useState('');
    const [open, setOpen] = useState(false);
    const [selectedName, setSelectedName] = useState('');
    const ref = useRef<HTMLDivElement>(null);

    const { data: leads } = useQuery({
        queryKey: ['leads-search', search, excludeConverted],
        queryFn: () => crmApi.getLeads({ page: 1, limit: 20, search: search || undefined }),
        select: (res) => {
            const all = (res.data?.data || []) as Lead[];
            return excludeConverted ? all.filter((l) => l.status !== 'CONVERTED') : all;
        },
        enabled: open,
    });

    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    return (
        <div ref={ref} className="relative">
            <label className="block text-sm font-medium text-gray-700 mb-1">
                {label} {required && '*'}
            </label>
            <input
                type="text"
                value={open ? search : selectedName || ''}
                onChange={(e) => {
                    setSearch(e.target.value);
                    if (!open) setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                placeholder="Search leads..."
                className="w-full border rounded-lg px-3 py-2 text-sm"
            />
            {value && (
                <button
                    type="button"
                    onClick={() => {
                        onChange('', '');
                        setSelectedName('');
                        setSearch('');
                    }}
                    className="absolute right-2 top-8 text-gray-400 hover:text-gray-600 text-sm"
                >
                    x
                </button>
            )}
            {open && leads && (
                <div className="absolute z-20 mt-1 w-full bg-white border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                    {leads.length === 0 ? (
                        <div className="px-3 py-2 text-sm text-gray-400">No leads found</div>
                    ) : (
                        leads.map((l) => (
                            <button
                                key={l.id}
                                type="button"
                                onClick={() => {
                                    onChange(l.id, l.name);
                                    setSelectedName(l.name);
                                    setSearch('');
                                    setOpen(false);
                                }}
                                className={`block w-full text-left px-3 py-2 text-sm hover:bg-blue-50 ${l.id === value ? 'bg-blue-50 font-medium' : ''
                                    }`}
                            >
                                <div className="font-medium">{l.name}</div>
                                <div className="text-xs text-gray-400">
                                    {l.status} {l.source ? ` - ${l.source}` : ''}
                                </div>
                            </button>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}

function OpportunitySearchSelect({
    value,
    onChange,
    label = 'Opportunity',
    required = false,
}: {
    value: string;
    onChange: (id: string, title: string) => void;
    label?: string;
    required?: boolean;
}) {
    const [search, setSearch] = useState('');
    const [open, setOpen] = useState(false);
    const [selectedTitle, setSelectedTitle] = useState('');
    const ref = useRef<HTMLDivElement>(null);

    const { data: opps } = useQuery({
        queryKey: ['opps-search', search],
        queryFn: () => crmApi.getOpportunities({ page: 1, limit: 20, search: search || undefined }),
        select: (res) => (res.data?.data || []) as Opportunity[],
        enabled: open,
    });

    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    return (
        <div ref={ref} className="relative">
            <label className="block text-sm font-medium text-gray-700 mb-1">
                {label} {required && '*'}
            </label>
            <input
                type="text"
                value={open ? search : selectedTitle || ''}
                onChange={(e) => {
                    setSearch(e.target.value);
                    if (!open) setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                placeholder="Search opportunities..."
                className="w-full border rounded-lg px-3 py-2 text-sm"
            />
            {value && (
                <button
                    type="button"
                    onClick={() => {
                        onChange('', '');
                        setSelectedTitle('');
                        setSearch('');
                    }}
                    className="absolute right-2 top-8 text-gray-400 hover:text-gray-600 text-sm"
                >
                    x
                </button>
            )}
            {open && opps && (
                <div className="absolute z-20 mt-1 w-full bg-white border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                    {opps.length === 0 ? (
                        <div className="px-3 py-2 text-sm text-gray-400">No opportunities found</div>
                    ) : (
                        opps.map((o) => (
                            <button
                                key={o.id}
                                type="button"
                                onClick={() => {
                                    onChange(o.id, o.title);
                                    setSelectedTitle(o.title);
                                    setSearch('');
                                    setOpen(false);
                                }}
                                className={`block w-full text-left px-3 py-2 text-sm hover:bg-blue-50 ${o.id === value ? 'bg-blue-50 font-medium' : ''
                                    }`}
                            >
                                <div className="font-medium line-clamp-1">{o.title}</div>
                                <div className="text-xs text-gray-400">
                                    {o.status}{' '}
                                    {o.estimatedValue != null ? ` - ${formatCurrency(o.estimatedValue)}` : ''}
                                </div>
                            </button>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}

// ============================================================================
// STATUS / DISPLAY HELPERS
// ============================================================================

const LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST'] as const;
const OPP_STATUSES = ['OPEN', 'BIDDING', 'SUBMITTED', 'WON', 'LOST'] as const;
const ACTIVITY_TYPES = ['CALL', 'EMAIL', 'MEETING', 'NOTE', 'TASK'] as const;

function statusBadge(status: string) {
    const map: Record<string, string> = {
        NEW: 'bg-blue-100 text-blue-800',
        CONTACTED: 'bg-yellow-100 text-yellow-800',
        QUALIFIED: 'bg-purple-100 text-purple-800',
        CONVERTED: 'bg-green-100 text-green-800',
        OPEN: 'bg-blue-100 text-blue-800',
        BIDDING: 'bg-yellow-100 text-yellow-800',
        SUBMITTED: 'bg-indigo-100 text-indigo-800',
        WON: 'bg-green-100 text-green-800',
        LOST: 'bg-red-100 text-red-800',
    };
    return map[status] || 'bg-gray-100 text-gray-800';
}

const STAGE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
    OPEN: { bg: 'bg-blue-50', border: 'border-blue-400', text: 'text-blue-700' },
    BIDDING: { bg: 'bg-amber-50', border: 'border-amber-400', text: 'text-amber-700' },
    SUBMITTED: { bg: 'bg-indigo-50', border: 'border-indigo-400', text: 'text-indigo-700' },
    WON: { bg: 'bg-emerald-50', border: 'border-emerald-400', text: 'text-emerald-700' },
    LOST: { bg: 'bg-red-50', border: 'border-red-400', text: 'text-red-700' },
};

function activityIcon(type: string) {
    const map: Record<string, string> = {
        CALL: 'Ph',
        EMAIL: 'Em',
        MEETING: 'Mt',
        NOTE: 'Nt',
        TASK: 'Tk',
    };
    return map[type] || 'Ac';
}

const ACTIVITY_ICON_COLORS: Record<string, string> = {
    CALL: 'bg-green-100 text-green-700',
    EMAIL: 'bg-blue-100 text-blue-700',
    MEETING: 'bg-purple-100 text-purple-700',
    NOTE: 'bg-yellow-100 text-yellow-700',
    TASK: 'bg-gray-100 text-gray-700',
};

// ============================================================================
// MAIN CRM PAGE — Router between Pipeline/Leads/Workspace views
// ============================================================================

type CrmView = 'pipeline' | 'leads';

export default function CRMPage() {
    const [view, setView] = useState<CrmView>('pipeline');
    const [activeOpportunityId, setActiveOpportunityId] = useState<string | null>(null);

    const openWorkspace = useCallback((id: string) => setActiveOpportunityId(id), []);
    const closeWorkspace = useCallback(() => setActiveOpportunityId(null), []);

    // If an opportunity is selected, show the full workspace
    if (activeOpportunityId) {
        return (
            <Layout>
                <OpportunityWorkspace
                    opportunityId={activeOpportunityId}
                    onBack={closeWorkspace}
                />
            </Layout>
        );
    }

    return (
        <Layout>
            <div className="p-4 lg:p-8 max-w-[1600px] mx-auto">
                {/* Header */}
                <div className="flex items-center justify-between mb-6">
                    <div>
                        <h1 className="text-2xl lg:text-3xl font-bold text-gray-900">CRM</h1>
                        <p className="text-gray-500 mt-1">Pipeline &amp; deal management</p>
                    </div>
                </div>

                {/* View toggle */}
                <div className="flex gap-1 mb-6 bg-gray-100 rounded-lg p-1 w-fit">
                    {(['pipeline', 'leads'] as CrmView[]).map((v) => (
                        <button
                            key={v}
                            onClick={() => setView(v)}
                            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${view === v
                                ? 'bg-white text-gray-900 shadow-sm'
                                : 'text-gray-600 hover:text-gray-900'
                                }`}
                        >
                            {v === 'pipeline' ? 'Pipeline' : 'Leads'}
                        </button>
                    ))}
                </div>

                {view === 'pipeline' && <PipelineView onOpenOpportunity={openWorkspace} />}
                {view === 'leads' && <LeadsTab />}
            </div>
        </Layout>
    );
}

// ============================================================================
// OPPORTUNITY WORKSPACE — Single-screen deal view
// ============================================================================

function OpportunityWorkspace({
    opportunityId,
    onBack,
}: {
    opportunityId: string;
    onBack: () => void;
}) {
    const queryClient = useQueryClient();
    const [showAddActivity, setShowAddActivity] = useState(false);

    const { data: detail, isLoading, error } = useQuery({
        queryKey: ['crm', 'opportunity', opportunityId],
        queryFn: () => crmApi.getOpportunityById(opportunityId),
        select: (res) => res.data?.data as OpportunityDetail | undefined,
    });

    const statusMutation = useMutation({
        mutationFn: ({ status, lostReason }: { status: string; lostReason?: string }) =>
            crmApi.updateOpportunityStatus(opportunityId, status, lostReason),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['crm', 'opportunity', opportunityId] });
            queryClient.invalidateQueries({ queryKey: ['crm', 'pipeline'] });
            queryClient.invalidateQueries({ queryKey: ['crm', 'opportunities'] });
        },
    });

    const toggleActivity = useMutation({
        mutationFn: ({ id, completed }: { id: string; completed: boolean }) =>
            crmApi.updateActivity(id, { completed }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['crm', 'opportunity', opportunityId] });
        },
    });

    if (isLoading) {
        return (
            <div className="p-8">
                <button onClick={onBack} className="text-blue-600 hover:text-blue-800 text-sm mb-4">
                    &larr; Back to Pipeline
                </button>
                <div className="text-center py-20 text-gray-400">Loading opportunity...</div>
            </div>
        );
    }

    if (error || !detail) {
        return (
            <div className="p-8">
                <button onClick={onBack} className="text-blue-600 hover:text-blue-800 text-sm mb-4">
                    &larr; Back to Pipeline
                </button>
                <div className="text-center py-20 text-red-500">Failed to load opportunity.</div>
            </div>
        );
    }

    const opp = detail.opportunity;
    const items = detail.items || [];
    const activities = detail.activities || [];
    const documents = detail.documents || [];
    const stageColor = STAGE_COLORS[opp.status] || STAGE_COLORS.OPEN;
    const isClosed = opp.status === 'WON' || opp.status === 'LOST';

    // BOQ total
    const boqTotal = items.reduce((sum, it) => sum + (it.lineTotal ?? 0), 0);

    // Advance to next stage
    const stageOrder = ['OPEN', 'BIDDING', 'SUBMITTED'];
    const currentIdx = stageOrder.indexOf(opp.status);
    const nextStage = currentIdx >= 0 && currentIdx < stageOrder.length - 1
        ? stageOrder[currentIdx + 1]
        : null;

    return (
        <div className="max-w-[1600px] mx-auto">
            {/* ── WORKSPACE HEADER ─────────────────────────────────────────── */}
            <div className={`border-b ${stageColor.bg}`}>
                <div className="px-4 lg:px-8 py-4">
                    {/* Back button */}
                    <button
                        onClick={onBack}
                        className="text-sm text-gray-500 hover:text-gray-800 mb-3 flex items-center gap-1"
                    >
                        <span>&larr;</span> Back to Pipeline
                    </button>

                    {/* Title row */}
                    <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                            <h1 className="text-xl lg:text-2xl font-bold text-gray-900 truncate">
                                {opp.title}
                            </h1>
                            <span
                                className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide border ${stageColor.border} ${stageColor.bg} ${stageColor.text}`}
                            >
                                {opp.status}
                            </span>
                        </div>

                        {/* Action buttons */}
                        {!isClosed && (
                            <div className="flex items-center gap-2 flex-shrink-0">
                                <button
                                    onClick={() => setShowAddActivity(true)}
                                    className="px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                                >
                                    + Activity
                                </button>
                                {nextStage && (
                                    <button
                                        onClick={() => statusMutation.mutate({ status: nextStage })}
                                        disabled={statusMutation.isPending}
                                        className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                                    >
                                        Advance to {nextStage}
                                    </button>
                                )}
                                {opp.status === 'SUBMITTED' && (
                                    <button
                                        onClick={() => statusMutation.mutate({ status: 'WON' })}
                                        disabled={statusMutation.isPending}
                                        className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                                    >
                                        Mark WON
                                    </button>
                                )}
                                <button
                                    onClick={() => {
                                        const reason = prompt('Reason for loss (optional):');
                                        statusMutation.mutate({ status: 'LOST', lostReason: reason || undefined });
                                    }}
                                    disabled={statusMutation.isPending}
                                    className="px-3 py-1.5 text-sm bg-white border border-red-300 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50"
                                >
                                    Mark LOST
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Metadata strip */}
                    <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-sm text-gray-600">
                        {opp.estimatedValue != null && (
                            <span className="font-semibold text-gray-900">
                                {formatCurrency(opp.estimatedValue)}
                            </span>
                        )}
                        <span>Probability: {opp.probability}%</span>
                        {opp.deadline && <span>Deadline: {opp.deadline}</span>}
                        {opp.assignedToName && <span>Assigned: {opp.assignedToName}</span>}
                        {opp.customerName && <span>Customer: {opp.customerName}</span>}
                        {opp.leadName && <span>Lead: {opp.leadName}</span>}
                    </div>

                    {/* Stage progress bar */}
                    <div className="flex items-center gap-1 mt-4">
                        {OPP_STATUSES.filter((s) => s !== 'LOST').map((stage) => {
                            const idx = OPP_STATUSES.indexOf(stage);
                            const currentStageIdx = OPP_STATUSES.indexOf(opp.status as typeof OPP_STATUSES[number]);
                            const isActive = idx <= currentStageIdx && opp.status !== 'LOST';
                            return (
                                <div key={stage} className="flex-1">
                                    <div
                                        className={`h-1.5 rounded-full ${isActive ? 'bg-blue-500' : 'bg-gray-200'
                                            }`}
                                    />
                                    <div className={`text-[10px] mt-0.5 text-center ${isActive ? 'text-blue-600 font-medium' : 'text-gray-400'
                                        }`}>
                                        {stage}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>

            {/* ── TWO-COLUMN LAYOUT: Activities (left) | Details (right) ──── */}
            <div className="px-4 lg:px-8 py-6">
                <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

                    {/* LEFT COLUMN — Activity Timeline (2/5) */}
                    <div className="lg:col-span-2">
                        <div className="bg-white rounded-xl border shadow-sm">
                            <div className="px-4 py-3 border-b flex items-center justify-between">
                                <h2 className="font-semibold text-gray-900">Activity Timeline</h2>
                                <button
                                    onClick={() => setShowAddActivity(true)}
                                    className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                                >
                                    + Add
                                </button>
                            </div>
                            <div className="divide-y max-h-[500px] overflow-y-auto">
                                {activities.length === 0 ? (
                                    <div className="text-center py-10 text-gray-400 text-sm">
                                        No activities yet. Start the conversation.
                                    </div>
                                ) : (
                                    activities.map((act) => (
                                        <div key={act.id} className="px-4 py-3 flex gap-3 items-start hover:bg-gray-50">
                                            {/* Toggle complete */}
                                            <button
                                                onClick={() =>
                                                    toggleActivity.mutate({
                                                        id: act.id,
                                                        completed: !act.completed,
                                                    })
                                                }
                                                className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 text-xs ${act.completed
                                                    ? 'bg-green-500 border-green-500 text-white'
                                                    : 'border-gray-300 hover:border-blue-500'
                                                    }`}
                                            >
                                                {act.completed && '\u2713'}
                                            </button>

                                            {/* Icon badge */}
                                            <div
                                                className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${ACTIVITY_ICON_COLORS[act.type] || 'bg-gray-100 text-gray-600'
                                                    }`}
                                            >
                                                {activityIcon(act.type)}
                                            </div>

                                            {/* Content */}
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <span
                                                        className={`text-sm font-medium ${act.completed ? 'line-through text-gray-400' : 'text-gray-900'
                                                            }`}
                                                    >
                                                        {act.title || act.type}
                                                    </span>
                                                    <span className="text-[10px] uppercase text-gray-400 font-medium">
                                                        {act.type}
                                                    </span>
                                                </div>
                                                {act.notes && (
                                                    <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{act.notes}</p>
                                                )}
                                                <div className="flex gap-3 mt-1 text-[11px] text-gray-400">
                                                    {act.dueDate && (
                                                        <span
                                                            className={
                                                                !act.completed && new Date(act.dueDate) < new Date()
                                                                    ? 'text-red-500 font-medium'
                                                                    : ''
                                                            }
                                                        >
                                                            Due: {formatTimestampDate(act.dueDate)}
                                                        </span>
                                                    )}
                                                    {act.createdByName && <span>by {act.createdByName}</span>}
                                                    <span>{formatTimestampDate(act.createdAt)}</span>
                                                </div>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    </div>

                    {/* RIGHT COLUMN — Opportunity Details (3/5) */}
                    <div className="lg:col-span-3 space-y-6">
                        {/* Details Card */}
                        <div className="bg-white rounded-xl border shadow-sm">
                            <div className="px-4 py-3 border-b">
                                <h2 className="font-semibold text-gray-900">Opportunity Details</h2>
                            </div>
                            <div className="p-4 space-y-4">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <DetailField label="Title" value={opp.title} />
                                    <DetailField label="Tender Reference" value={opp.tenderRef} />
                                    <DetailField label="Procuring Entity" value={opp.procuringEntity} />
                                    <DetailField
                                        label="Estimated Value"
                                        value={opp.estimatedValue != null ? formatCurrency(opp.estimatedValue) : null}
                                    />
                                    <DetailField label="Probability" value={`${opp.probability}%`} />
                                    <DetailField label="Deadline" value={opp.deadline} />
                                    <DetailField label="Customer" value={opp.customerName} />
                                    <DetailField label="Lead" value={opp.leadName} />
                                    <DetailField label="Assigned To" value={opp.assignedToName} />
                                    <DetailField
                                        label="Created"
                                        value={formatTimestampDate(opp.createdAt)}
                                    />
                                    {opp.wonAt && (
                                        <DetailField
                                            label="Won At"
                                            value={formatTimestampDate(opp.wonAt)}
                                        />
                                    )}
                                    {opp.quotationId && (
                                        <DetailField label="Quotation" value={opp.quotationId} />
                                    )}
                                    {opp.lostReason && (
                                        <DetailField label="Lost Reason" value={opp.lostReason} />
                                    )}
                                </div>
                                {opp.notes && (
                                    <div>
                                        <span className="text-xs font-medium text-gray-500 uppercase">Notes</span>
                                        <p className="text-sm text-gray-700 mt-1 whitespace-pre-wrap">{opp.notes}</p>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* ── BOQ / LINE ITEMS TABLE ──────────────────────────────── */}
                        <div className="bg-white rounded-xl border shadow-sm">
                            <div className="px-4 py-3 border-b flex items-center justify-between">
                                <h2 className="font-semibold text-gray-900">
                                    Line Items (BOQ)
                                    {items.length > 0 && (
                                        <span className="ml-2 text-xs font-normal text-gray-400">
                                            {items.length} item{items.length !== 1 && 's'}
                                        </span>
                                    )}
                                </h2>
                            </div>
                            {items.length === 0 ? (
                                <div className="text-center py-8 text-gray-400 text-sm">
                                    No line items added yet.
                                </div>
                            ) : (
                                <div className="overflow-x-auto">
                                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                                        <thead className="bg-gray-50">
                                            <tr>
                                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                                                    #
                                                </th>
                                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                                                    Description
                                                </th>
                                                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">
                                                    Qty
                                                </th>
                                                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">
                                                    Unit Price
                                                </th>
                                                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">
                                                    Line Total
                                                </th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-100">
                                            {items.map((item, idx) => (
                                                <tr key={item.id} className="hover:bg-gray-50">
                                                    <td className="px-4 py-2 text-gray-500">{idx + 1}</td>
                                                    <td className="px-4 py-2 text-gray-900">
                                                        {item.description || '--'}
                                                    </td>
                                                    <td className="px-4 py-2 text-right text-gray-700">
                                                        {item.quantity ?? '--'}
                                                    </td>
                                                    <td className="px-4 py-2 text-right text-gray-700">
                                                        {item.estimatedPrice != null
                                                            ? formatCurrency(item.estimatedPrice)
                                                            : '--'}
                                                    </td>
                                                    <td className="px-4 py-2 text-right font-medium text-gray-900">
                                                        {item.lineTotal != null
                                                            ? formatCurrency(item.lineTotal)
                                                            : '--'}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                        <tfoot>
                                            <tr className="bg-gray-50">
                                                <td colSpan={4} className="px-4 py-2 text-right font-semibold text-gray-700">
                                                    Total
                                                </td>
                                                <td className="px-4 py-2 text-right font-bold text-gray-900">
                                                    {formatCurrency(boqTotal)}
                                                </td>
                                            </tr>
                                        </tfoot>
                                    </table>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* ── DOCUMENTS — Full width bottom ────────────────────────── */}
                <div className="mt-6 bg-white rounded-xl border shadow-sm">
                    <div className="px-4 py-3 border-b flex items-center justify-between">
                        <h2 className="font-semibold text-gray-900">
                            Documents
                            {documents.length > 0 && (
                                <span className="ml-2 text-xs font-normal text-gray-400">
                                    {documents.length} file{documents.length !== 1 && 's'}
                                </span>
                            )}
                        </h2>
                    </div>
                    {documents.length === 0 ? (
                        <div className="text-center py-8 text-gray-400 text-sm">
                            No documents uploaded yet.
                        </div>
                    ) : (
                        <div className="divide-y">
                            {documents.map((doc) => (
                                <div key={doc.id} className="px-4 py-3 flex items-center gap-3 hover:bg-gray-50">
                                    <div className="w-8 h-8 bg-gray-100 rounded flex items-center justify-center text-xs font-bold text-gray-500 flex-shrink-0">
                                        {(doc.mimeType?.split('/')[1] || 'file').slice(0, 3).toUpperCase()}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <a
                                            href={doc.fileUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-sm font-medium text-blue-600 hover:underline truncate block"
                                        >
                                            {doc.fileName}
                                        </a>
                                        <div className="text-xs text-gray-400 flex gap-3">
                                            {doc.fileSize != null && (
                                                <span>{(doc.fileSize / 1024).toFixed(1)} KB</span>
                                            )}
                                            {doc.uploadedByName && <span>by {doc.uploadedByName}</span>}
                                            <span>{formatTimestampDate(doc.uploadedAt)}</span>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Add Activity modal (scoped to this opportunity) */}
            {showAddActivity && (
                <CreateActivityModal
                    prefilledOpportunityId={opportunityId}
                    onClose={() => setShowAddActivity(false)}
                    onCreated={() => {
                        setShowAddActivity(false);
                        queryClient.invalidateQueries({ queryKey: ['crm', 'opportunity', opportunityId] });
                    }}
                />
            )}
        </div>
    );
}

function DetailField({ label, value }: { label: string; value: string | null | undefined }) {
    return (
        <div>
            <span className="text-xs font-medium text-gray-500 uppercase">{label}</span>
            <p className="text-sm text-gray-900 mt-0.5">{value || '--'}</p>
        </div>
    );
}

// ============================================================================
// PIPELINE VIEW (Kanban board — cards open workspace on click)
// ============================================================================

function PipelineView({ onOpenOpportunity }: { onOpenOpportunity: (id: string) => void }) {
    const queryClient = useQueryClient();
    const [showCreate, setShowCreate] = useState(false);

    const { data: pipelineData } = useQuery({
        queryKey: ['crm', 'pipeline'],
        queryFn: () => crmApi.getPipeline(),
        select: (res) => (res.data?.data || []) as PipelineSummary[],
    });

    const { data: oppData, isLoading } = useQuery({
        queryKey: ['crm', 'opportunities'],
        queryFn: () => crmApi.getOpportunities({ limit: 100 }),
        select: (res) => (res.data?.data || []) as Opportunity[],
    });

    const columns = OPP_STATUSES.map((status) => ({
        status,
        opportunities: (oppData || []).filter((o) => o.status === status),
        summary: (pipelineData || []).find((p) => p.status === status),
    }));

    const columnColors: Record<string, string> = {
        OPEN: 'border-blue-300 bg-blue-50',
        BIDDING: 'border-yellow-300 bg-yellow-50',
        SUBMITTED: 'border-indigo-300 bg-indigo-50',
        WON: 'border-green-300 bg-green-50',
        LOST: 'border-red-300 bg-red-50',
    };

    return (
        <div>
            {/* Summary strip */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
                {columns.map((col) => (
                    <div key={col.status} className={`rounded-lg border-2 p-4 ${columnColors[col.status]}`}>
                        <div className="text-sm font-medium text-gray-700">{col.status}</div>
                        <div className="text-2xl font-bold">{col.summary?.count || 0}</div>
                        <div className="text-sm text-gray-500">
                            {formatCurrency(col.summary?.totalValue || 0)}
                        </div>
                    </div>
                ))}
            </div>

            <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-semibold">Opportunity Pipeline</h2>
                <button
                    onClick={() => setShowCreate(true)}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
                >
                    + New Opportunity
                </button>
            </div>

            {isLoading ? (
                <div className="text-center py-12 text-gray-500">Loading pipeline...</div>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 overflow-x-auto">
                    {columns.map((col) => (
                        <div key={col.status} className="min-w-[250px]">
                            <div className={`rounded-t-lg border-t-4 ${columnColors[col.status]} px-3 py-2`}>
                                <span className="font-semibold text-sm">{col.status}</span>
                                <span className="ml-2 text-xs text-gray-500">({col.opportunities.length})</span>
                            </div>
                            <div className="space-y-2 bg-gray-50 rounded-b-lg p-2 min-h-[200px]">
                                {col.opportunities.map((opp) => (
                                    <OpportunityCard
                                        key={opp.id}
                                        opportunity={opp}
                                        onClick={() => onOpenOpportunity(opp.id)}
                                    />
                                ))}
                                {col.opportunities.length === 0 && (
                                    <div className="text-center text-gray-400 text-sm py-8">No opportunities</div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {showCreate && (
                <CreateOpportunityModal
                    onClose={() => setShowCreate(false)}
                    onCreated={() => {
                        setShowCreate(false);
                        queryClient.invalidateQueries({ queryKey: ['crm'] });
                    }}
                />
            )}
        </div>
    );
}

// ============================================================================
// OPPORTUNITY CARD — Clickable, opens workspace
// ============================================================================

function OpportunityCard({
    opportunity,
    onClick,
}: {
    opportunity: Opportunity;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            className="w-full text-left bg-white rounded-lg shadow-sm border p-3 hover:shadow-md hover:border-blue-300 transition-all cursor-pointer"
        >
            <h3 className="font-medium text-sm text-gray-900 line-clamp-2">{opportunity.title}</h3>
            {opportunity.customerName && (
                <div className="text-xs text-gray-500 mt-1">{opportunity.customerName}</div>
            )}
            {opportunity.procuringEntity && (
                <div className="text-xs text-gray-500">{opportunity.procuringEntity}</div>
            )}
            {opportunity.estimatedValue != null && (
                <div className="text-sm font-semibold text-gray-800 mt-2">
                    {formatCurrency(opportunity.estimatedValue)}
                </div>
            )}
            <div className="flex items-center justify-between mt-2">
                {opportunity.deadline && (
                    <span className="text-xs text-gray-400">{opportunity.deadline}</span>
                )}
                {opportunity.probability > 0 && (
                    <span className="text-xs bg-gray-100 px-2 py-0.5 rounded">
                        {opportunity.probability}%
                    </span>
                )}
            </div>
            {opportunity.assignedToName && (
                <div className="text-xs text-gray-400 mt-1">{opportunity.assignedToName}</div>
            )}
        </button>
    );
}

// ============================================================================
// CREATE OPPORTUNITY MODAL
// ============================================================================

function CreateOpportunityModal({
    onClose,
    onCreated,
}: {
    onClose: () => void;
    onCreated: () => void;
}) {
    const [form, setForm] = useState({
        title: '',
        tenderRef: '',
        procuringEntity: '',
        deadline: '',
        estimatedValue: '',
        probability: '50',
        notes: '',
        customerId: '',
        leadId: '',
    });
    const [error, setError] = useState('');

    const mutation = useMutation({
        mutationFn: (data: Record<string, unknown>) => crmApi.createOpportunity(data),
        onSuccess: () => onCreated(),
        onError: (err: Error) => setError(err.message),
    });

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!form.customerId && !form.leadId) {
            setError('An opportunity must be linked to a customer or a lead.');
            return;
        }
        mutation.mutate({
            title: form.title,
            customerId: form.customerId || null,
            leadId: form.leadId || null,
            tenderRef: form.tenderRef || null,
            procuringEntity: form.procuringEntity || null,
            deadline: form.deadline || null,
            estimatedValue: form.estimatedValue ? parseFloat(form.estimatedValue) : null,
            probability: parseInt(form.probability),
            notes: form.notes || null,
        });
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
            <div
                className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="Create Opportunity"
            >
                <h2 className="text-xl font-bold mb-4">New Opportunity</h2>
                {error && <div className="bg-red-50 text-red-600 p-3 rounded mb-4 text-sm">{error}</div>}
                <form onSubmit={handleSubmit} className="space-y-3">
                    <div className="bg-gray-50 rounded-lg p-3 space-y-3">
                        <p className="text-xs text-gray-500 font-medium uppercase">Link to Customer or Lead *</p>
                        <CustomerSearchSelect
                            value={form.customerId}
                            onChange={(id) => setForm({ ...form, customerId: id })}
                        />
                        <div className="text-center text-xs text-gray-400">-- or --</div>
                        <LeadSearchSelect
                            value={form.leadId}
                            onChange={(id) => setForm({ ...form, leadId: id })}
                            excludeConverted
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
                        <input
                            value={form.title}
                            onChange={(e) => setForm({ ...form, title: e.target.value })}
                            className="w-full border rounded-lg px-3 py-2 text-sm"
                            required
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Tender Ref</label>
                            <input
                                value={form.tenderRef}
                                onChange={(e) => setForm({ ...form, tenderRef: e.target.value })}
                                className="w-full border rounded-lg px-3 py-2 text-sm"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Procuring Entity</label>
                            <input
                                value={form.procuringEntity}
                                onChange={(e) => setForm({ ...form, procuringEntity: e.target.value })}
                                className="w-full border rounded-lg px-3 py-2 text-sm"
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Deadline</label>
                            <DatePicker
                                value={form.deadline}
                                onChange={(v) => setForm({ ...form, deadline: v })}
                                placeholder="Deadline"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Value</label>
                            <input
                                type="number"
                                step="1"
                                value={form.estimatedValue}
                                onChange={(e) => setForm({ ...form, estimatedValue: e.target.value })}
                                className="w-full border rounded-lg px-3 py-2 text-sm"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Probability %</label>
                            <input
                                type="number"
                                max="100"
                                value={form.probability}
                                onChange={(e) => setForm({ ...form, probability: e.target.value })}
                                className="w-full border rounded-lg px-3 py-2 text-sm"
                            />
                        </div>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                        <textarea
                            value={form.notes}
                            onChange={(e) => setForm({ ...form, notes: e.target.value })}
                            className="w-full border rounded-lg px-3 py-2 text-sm"
                            rows={2}
                        />
                    </div>
                    <div className="flex justify-end gap-3 pt-2">
                        <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={mutation.isPending}
                            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm disabled:opacity-50"
                        >
                            {mutation.isPending ? 'Creating...' : 'Create'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

// ============================================================================
// LEADS TAB
// ============================================================================

function LeadsTab() {
    const queryClient = useQueryClient();
    const [page, setPage] = useState(1);
    const [statusFilter, setStatusFilter] = useState<string>('ALL');
    const [search, setSearch] = useState('');
    const [showCreate, setShowCreate] = useState(false);
    const [convertingLeadId, setConvertingLeadId] = useState<string | null>(null);

    const { data, isLoading } = useQuery({
        queryKey: ['crm', 'leads', page, statusFilter, search],
        queryFn: () =>
            crmApi.getLeads({
                page,
                limit: 20,
                status: statusFilter === 'ALL' ? undefined : statusFilter,
                search: search || undefined,
            }),
        select: (res) => ({
            leads: (res.data?.data || []) as Lead[],
            pagination: res.data?.pagination as {
                page: number;
                limit: number;
                total: number;
                totalPages: number;
            } | undefined,
        }),
    });

    const deleteMutation = useMutation({
        mutationFn: (id: string) => crmApi.deleteLead(id),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['crm', 'leads'] }),
    });

    const leads = data?.leads || [];
    const pagination = data?.pagination;

    return (
        <div>
            <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-3 mb-4">
                <div className="flex gap-2 items-center flex-wrap">
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => {
                            setSearch(e.target.value);
                            setPage(1);
                        }}
                        placeholder="Search leads..."
                        className="border rounded-lg px-3 py-2 text-sm w-52"
                    />
                    <select
                        value={statusFilter}
                        onChange={(e) => {
                            setStatusFilter(e.target.value);
                            setPage(1);
                        }}
                        className="border rounded-lg px-3 py-2 text-sm"
                    >
                        <option value="ALL">All Statuses</option>
                        {LEAD_STATUSES.map((s) => (
                            <option key={s} value={s}>
                                {s}
                            </option>
                        ))}
                    </select>
                </div>
                <button
                    onClick={() => setShowCreate(true)}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
                >
                    + New Lead
                </button>
            </div>

            {isLoading ? (
                <div className="text-center py-12 text-gray-500">Loading leads...</div>
            ) : leads.length === 0 ? (
                <div className="text-center py-12 text-gray-400">
                    <p className="text-lg font-medium mb-1">No leads found</p>
                    <p className="text-sm">Create your first lead to get started.</p>
                </div>
            ) : (
                <div className="bg-white rounded-lg shadow overflow-hidden">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                                    Name
                                </th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                                    Contact
                                </th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                                    Source
                                </th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                                    Status
                                </th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                                    Created
                                </th>
                                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                                    Actions
                                </th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                            {leads.map((lead) => (
                                <tr key={lead.id} className="hover:bg-gray-50">
                                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{lead.name}</td>
                                    <td className="px-4 py-3 text-sm text-gray-500">
                                        {lead.phone && <div>{lead.phone}</div>}
                                        {lead.email && <div>{lead.email}</div>}
                                    </td>
                                    <td className="px-4 py-3 text-sm text-gray-500">{lead.source || '--'}</td>
                                    <td className="px-4 py-3">
                                        <span
                                            className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge(
                                                lead.status,
                                            )}`}
                                        >
                                            {lead.status}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-sm text-gray-500">
                                        {formatTimestampDate(lead.createdAt)}
                                    </td>
                                    <td className="px-4 py-3 text-right space-x-2">
                                        {lead.status !== 'CONVERTED' && lead.status !== 'LOST' && (
                                            <button
                                                onClick={() => setConvertingLeadId(lead.id)}
                                                className="text-green-600 hover:text-green-800 text-sm font-medium"
                                            >
                                                Convert
                                            </button>
                                        )}
                                        {lead.status === 'CONVERTED' && (
                                            <span className="text-xs text-green-600">Customer</span>
                                        )}
                                        <button
                                            onClick={() => {
                                                if (confirm(`Delete lead "${lead.name}"?`)) {
                                                    deleteMutation.mutate(lead.id);
                                                }
                                            }}
                                            className="text-red-600 hover:text-red-800 text-sm"
                                        >
                                            Delete
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {pagination && pagination.totalPages > 1 && (
                <div className="flex justify-center gap-2 mt-4">
                    <button
                        disabled={page <= 1}
                        onClick={() => setPage(page - 1)}
                        className="px-3 py-1 text-sm border rounded disabled:opacity-50"
                    >
                        Previous
                    </button>
                    <span className="px-3 py-1 text-sm text-gray-600">
                        Page {page} of {pagination.totalPages}
                    </span>
                    <button
                        disabled={page >= pagination.totalPages}
                        onClick={() => setPage(page + 1)}
                        className="px-3 py-1 text-sm border rounded disabled:opacity-50"
                    >
                        Next
                    </button>
                </div>
            )}

            {showCreate && (
                <CreateLeadModal
                    onClose={() => setShowCreate(false)}
                    onCreated={() => {
                        setShowCreate(false);
                        queryClient.invalidateQueries({ queryKey: ['crm', 'leads'] });
                    }}
                />
            )}

            {convertingLeadId && (
                <ConvertLeadModal
                    leadId={convertingLeadId}
                    onClose={() => setConvertingLeadId(null)}
                    onConverted={() => {
                        setConvertingLeadId(null);
                        queryClient.invalidateQueries({ queryKey: ['crm', 'leads'] });
                    }}
                />
            )}
        </div>
    );
}

// ============================================================================
// CONVERT LEAD MODAL
// ============================================================================

function ConvertLeadModal({
    leadId,
    onClose,
    onConverted,
}: {
    leadId: string;
    onClose: () => void;
    onConverted: () => void;
}) {
    const [customerId, setCustomerId] = useState('');
    const [error, setError] = useState('');

    const mutation = useMutation({
        mutationFn: () => crmApi.convertLead(leadId, customerId),
        onSuccess: () => onConverted(),
        onError: (err: Error) => setError(err.message),
    });

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
            <div
                className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="Convert Lead to Customer"
            >
                <h2 className="text-xl font-bold mb-2">Convert Lead</h2>
                <p className="text-sm text-gray-500 mb-4">
                    Link this lead to an existing customer. The lead status will change to CONVERTED.
                </p>
                {error && <div className="bg-red-50 text-red-600 p-3 rounded mb-4 text-sm">{error}</div>}
                <CustomerSearchSelect
                    value={customerId}
                    onChange={(id) => setCustomerId(id)}
                    label="Select Customer"
                    required
                />
                <div className="flex justify-end gap-3 pt-4">
                    <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
                        Cancel
                    </button>
                    <button
                        onClick={() => {
                            if (!customerId) {
                                setError('Please select a customer.');
                                return;
                            }
                            mutation.mutate();
                        }}
                        disabled={mutation.isPending || !customerId}
                        className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm disabled:opacity-50"
                    >
                        {mutation.isPending ? 'Converting...' : 'Convert'}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ============================================================================
// CREATE LEAD MODAL
// ============================================================================

function CreateLeadModal({
    onClose,
    onCreated,
}: {
    onClose: () => void;
    onCreated: () => void;
}) {
    const [form, setForm] = useState({ name: '', phone: '', email: '', source: '', notes: '' });
    const [error, setError] = useState('');

    const mutation = useMutation({
        mutationFn: (data: Record<string, unknown>) => crmApi.createLead(data),
        onSuccess: () => onCreated(),
        onError: (err: Error) => setError(err.message),
    });

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        mutation.mutate({
            name: form.name,
            phone: form.phone || null,
            email: form.email || null,
            source: form.source || null,
            notes: form.notes || null,
        });
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
            <div
                className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="Create Lead"
            >
                <h2 className="text-xl font-bold mb-4">New Lead</h2>
                {error && <div className="bg-red-50 text-red-600 p-3 rounded mb-4 text-sm">{error}</div>}
                <form onSubmit={handleSubmit} className="space-y-3">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                        <input
                            value={form.name}
                            onChange={(e) => setForm({ ...form, name: e.target.value })}
                            className="w-full border rounded-lg px-3 py-2 text-sm"
                            required
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                            <input
                                value={form.phone}
                                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                                className="w-full border rounded-lg px-3 py-2 text-sm"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                            <input
                                type="email"
                                value={form.email}
                                onChange={(e) => setForm({ ...form, email: e.target.value })}
                                className="w-full border rounded-lg px-3 py-2 text-sm"
                            />
                        </div>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Source</label>
                        <select
                            value={form.source}
                            onChange={(e) => setForm({ ...form, source: e.target.value })}
                            className="w-full border rounded-lg px-3 py-2 text-sm"
                        >
                            <option value="">Select...</option>
                            <option value="Website">Website</option>
                            <option value="Referral">Referral</option>
                            <option value="Walk-in">Walk-in</option>
                            <option value="Phone">Phone</option>
                            <option value="Social Media">Social Media</option>
                            <option value="Tender Portal">Tender Portal</option>
                            <option value="Other">Other</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                        <textarea
                            value={form.notes}
                            onChange={(e) => setForm({ ...form, notes: e.target.value })}
                            className="w-full border rounded-lg px-3 py-2 text-sm"
                            rows={2}
                        />
                    </div>
                    <div className="flex justify-end gap-3 pt-2">
                        <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={mutation.isPending}
                            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm disabled:opacity-50"
                        >
                            {mutation.isPending ? 'Creating...' : 'Create'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

// ============================================================================
// CREATE ACTIVITY MODAL (supports pre-filled opportunity)
// ============================================================================

function CreateActivityModal({
    prefilledOpportunityId,
    onClose,
    onCreated,
}: {
    prefilledOpportunityId?: string;
    onClose: () => void;
    onCreated: () => void;
}) {
    const [form, setForm] = useState({
        type: 'TASK' as string,
        title: '',
        notes: '',
        dueDate: '',
        activityDate: '',
        opportunityId: prefilledOpportunityId || '',
        leadId: '',
    });
    const [error, setError] = useState('');

    const mutation = useMutation({
        mutationFn: (data: Record<string, unknown>) => crmApi.createActivity(data),
        onSuccess: () => onCreated(),
        onError: (err: Error) => setError(err.message),
    });

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!form.opportunityId && !form.leadId) {
            setError('An activity must be linked to an opportunity or a lead.');
            return;
        }
        mutation.mutate({
            type: form.type,
            title: form.title || null,
            notes: form.notes || null,
            dueDate: form.dueDate || null,
            activityDate: form.activityDate || null,
            opportunityId: form.opportunityId || null,
            leadId: form.leadId || null,
        });
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
            <div
                className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6 max-h-[90vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="Create Activity"
            >
                <h2 className="text-xl font-bold mb-4">New Activity</h2>
                {error && <div className="bg-red-50 text-red-600 p-3 rounded mb-4 text-sm">{error}</div>}
                <form onSubmit={handleSubmit} className="space-y-3">
                    {/* Parent: Opportunity or Lead */}
                    {!prefilledOpportunityId && (
                        <div className="bg-gray-50 rounded-lg p-3 space-y-3">
                            <p className="text-xs text-gray-500 font-medium uppercase">
                                Link to Opportunity or Lead *
                            </p>
                            <OpportunitySearchSelect
                                value={form.opportunityId}
                                onChange={(id) => setForm({ ...form, opportunityId: id })}
                            />
                            <div className="text-center text-xs text-gray-400">-- or --</div>
                            <LeadSearchSelect
                                value={form.leadId}
                                onChange={(id) => setForm({ ...form, leadId: id })}
                            />
                        </div>
                    )}

                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Type *</label>
                            <select
                                value={form.type}
                                onChange={(e) => setForm({ ...form, type: e.target.value })}
                                className="w-full border rounded-lg px-3 py-2 text-sm"
                            >
                                {ACTIVITY_TYPES.map((t) => (
                                    <option key={t} value={t}>
                                        {t}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                            <input
                                value={form.title}
                                onChange={(e) => setForm({ ...form, title: e.target.value })}
                                className="w-full border rounded-lg px-3 py-2 text-sm"
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Activity Date</label>
                            <DatePicker
                                value={form.activityDate}
                                onChange={(v) => setForm({ ...form, activityDate: v })}
                                placeholder="Activity date"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Due Date</label>
                            <DatePicker
                                value={form.dueDate}
                                onChange={(v) => setForm({ ...form, dueDate: v })}
                                placeholder="Due date"
                            />
                        </div>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                        <textarea
                            value={form.notes}
                            onChange={(e) => setForm({ ...form, notes: e.target.value })}
                            className="w-full border rounded-lg px-3 py-2 text-sm"
                            rows={3}
                        />
                    </div>
                    <div className="flex justify-end gap-3 pt-2">
                        <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={mutation.isPending}
                            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm disabled:opacity-50"
                        >
                            {mutation.isPending ? 'Creating...' : 'Create'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}