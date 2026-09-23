import { useState, useEffect } from 'react';
import { pickHrDisbursementAccount } from '@shared/hr/hrDisbursementAccount';
import {
    buildHrActiveEmployeePickerParams,
    buildHrEmployeeListParams,
    HR_EMPLOYEE_LIST_PAGE_LIMIT,
} from '@shared/hr/employeeListQuerySsot';
import {
    EMPLOYEE_GENDERS,
    EMPLOYEE_MARITAL_STATUSES,
    EMPLOYEE_MOMO_PROVIDERS,
    EMPLOYEE_PAYMENT_METHODS,
} from '@shared/hr/employeeMasterSsot';
import {
    EMPLOYMENT_TYPES,
    CONTRACT_CONVERT_TARGETS,
    requiresContractEndDate,
    type EmploymentType,
} from '@shared/hr/employmentContractSsot';
import {
    EMPLOYEE_FORM_SECTIONS,
    EMPLOYEE_FORM_SECTIONS_STORAGE_KEY,
} from '@shared/hr/employeeFormSections';
import { FormSection, FormSectionCatalog } from '../../components/ui/FormSection';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatTimestampDate } from '../../utils/businessDate';
import Layout from '../../components/Layout';
import { DatePicker } from '../../components/ui/date-picker';
import { apiClient, getErrorMessage } from '../../utils/api';
import type { ApiResponse } from '../../utils/api';
import { downloadFile } from '../../utils/download';

// ============================================================================
// TYPES
// ============================================================================

interface Department {
    id: string;
    name: string;
    createdAt: string;
}

interface Position {
    id: string;
    title: string;
    baseSalary: number | null;
    createdAt: string;
}

interface Employee {
    id: string;
    userId: string | null;
    firstName: string;
    lastName: string;
    phone: string | null;
    email: string | null;
    departmentId: string | null;
    positionId: string | null;
    hireDate: string;
    endDate: string | null;
    employmentType: EmploymentType;
    status: string;
    ledgerAccountId: string | null;
    ledgerAccountCode: string | null;
    advanceAccountId: string | null;
    advanceAccountCode: string | null;
    monthlyAllowance: number;
    bankName?: string | null;
    bankAccountNumber?: string | null;
    nssfNumber?: string | null;
    tinNumber?: string | null;
    employeeNumber?: string | null;
    nationalId?: string | null;
    dateOfBirth?: string | null;
    gender?: string | null;
    nationality?: string | null;
    maritalStatus?: string | null;
    addressLine1?: string | null;
    addressDistrict?: string | null;
    nextOfKinName?: string | null;
    nextOfKinPhone?: string | null;
    nextOfKinRelation?: string | null;
    bankBranch?: string | null;
    bankAccountName?: string | null;
    mobileMoneyNumber?: string | null;
    mobileMoneyProvider?: string | null;
    preferredPaymentMethod?: string | null;
    createdAt: string;
    departmentName?: string;
    positionTitle?: string;
    positionBaseSalary?: number | null;
    userFullName?: string;
    userEmail?: string | null;
    userIsActive?: boolean | null;
}

const emptyEmployeeForm = () => ({
    firstName: '',
    lastName: '',
    phone: '',
    email: '',
    departmentId: '',
    positionId: '',
    hireDate: '',
    endDate: '',
    employmentType: 'PERMANENT' as EmploymentType,
    userId: '',
    status: 'ACTIVE',
    monthlyAllowance: '',
    employeeNumber: '',
    nationalId: '',
    dateOfBirth: '',
    gender: '',
    nationality: '',
    maritalStatus: '',
    addressLine1: '',
    addressDistrict: '',
    nextOfKinName: '',
    nextOfKinPhone: '',
    nextOfKinRelation: '',
    nssfNumber: '',
    tinNumber: '',
    bankName: '',
    bankBranch: '',
    bankAccountNumber: '',
    bankAccountName: '',
    mobileMoneyNumber: '',
    mobileMoneyProvider: '',
    preferredPaymentMethod: '',
    probationEndDate: '',
    contractNumber: '',
    signContract: true,
});

function employeeToForm(e: Employee) {
    return {
        firstName: e.firstName,
        lastName: e.lastName,
        phone: e.phone ?? '',
        email: e.email ?? '',
        departmentId: e.departmentId ?? '',
        positionId: e.positionId ?? '',
        hireDate: e.hireDate,
        endDate: e.endDate ?? '',
        employmentType: (e.employmentType || 'PERMANENT') as EmploymentType,
        userId: e.userId ?? '',
        status: e.status,
        monthlyAllowance:
            e.monthlyAllowance != null && e.monthlyAllowance > 0 ? String(e.monthlyAllowance) : '',
        employeeNumber: e.employeeNumber ?? '',
        nationalId: e.nationalId ?? '',
        dateOfBirth: e.dateOfBirth ?? '',
        gender: e.gender ?? '',
        nationality: e.nationality ?? '',
        maritalStatus: e.maritalStatus ?? '',
        addressLine1: e.addressLine1 ?? '',
        addressDistrict: e.addressDistrict ?? '',
        nextOfKinName: e.nextOfKinName ?? '',
        nextOfKinPhone: e.nextOfKinPhone ?? '',
        nextOfKinRelation: e.nextOfKinRelation ?? '',
        nssfNumber: e.nssfNumber ?? '',
        tinNumber: e.tinNumber ?? '',
        bankName: e.bankName ?? '',
        bankBranch: e.bankBranch ?? '',
        bankAccountNumber: e.bankAccountNumber ?? '',
        bankAccountName: e.bankAccountName ?? '',
        mobileMoneyNumber: e.mobileMoneyNumber ?? '',
        mobileMoneyProvider: e.mobileMoneyProvider ?? '',
        preferredPaymentMethod: e.preferredPaymentMethod ?? '',
        probationEndDate: '',
        contractNumber: '',
        signContract: false,
    };
}

interface LinkableUser {
    id: string;
    fullName: string;
    email: string;
    role: string;
    isActive: boolean;
}

interface PayrollPeriod {
    id: string;
    startDate: string;
    endDate: string;
    status: string;
    createdAt: string;
    entryCount: number;
    totalNetPay: number;
}

interface PayrollEntry {
    id: string;
    payrollPeriodId: string;
    employeeId: string;
    basicSalary: number;
    allowances: number;
    overtimePay?: number;
    bonus?: number;
    unpaidLeaveDays?: number;
    leaveDeduction?: number;
    nssfEmployee?: number;
    paye?: number;
    nssfEmployer?: number;
    deductions: number;
    advanceRecovered: number;
    netPay: number;
    amountPaid?: number;
    remainingPayable?: number;
    journalEntryId: string | null;
    journalTransactionNumber: string | null;
    paymentJournalEntryId: string | null;
    paymentTransactionNumber: string | null;
    paidAt: string | null;
    createdAt: string;
    employeeFirstName?: string;
    employeeLastName?: string;
    departmentName?: string;
    positionTitle?: string;
}

interface EmployeeAdvance {
    id: string;
    employeeId: string;
    advanceDate: string;
    amount: number;
    remainingAmount: number;
    reason: string;
    status: string;
    paymentAccountCode: string;
    journalTransactionNumber: string | null;
    notes: string | null;
    employeeFirstName?: string;
    employeeLastName?: string;
    advanceAccountCode?: string | null;
}

interface EmployeeBalance {
    employeeId: string;
    firstName: string;
    lastName: string;
    status: string;
    payableAccountCode: string | null;
    advanceAccountCode: string | null;
    salariesPayable: number;
    advancesOutstanding: number;
    registerAdvancesOutstanding: number;
    advanceSsotDrift: boolean;
}

interface PaymentAccount {
    id: string;
    code: string;
    name: string;
    balance: number;
    tag: string | null;
}

type HrView = 'employees' | 'departments' | 'positions' | 'payroll' | 'advances' | 'balances' | 'leave' | 'statutory';

// ============================================================================
// API HELPERS
// ============================================================================

const hrApi = {
    getDepartments: () => apiClient.get<ApiResponse>('hr/departments'),
    createDepartment: (data: { name: string }) => apiClient.post<ApiResponse>('hr/departments', data),
    updateDepartment: (id: string, data: { name: string }) => apiClient.put<ApiResponse>(`hr/departments/${id}`, data),
    deleteDepartment: (id: string) => apiClient.delete<ApiResponse>(`hr/departments/${id}`),

    getPositions: () => apiClient.get<ApiResponse>('hr/positions'),
    createPosition: (data: { title: string; baseSalary?: number | null }) => apiClient.post<ApiResponse>('hr/positions', data),
    updatePosition: (id: string, data: { title?: string; baseSalary?: number | null }) => apiClient.put<ApiResponse>(`hr/positions/${id}`, data),
    deletePosition: (id: string) => apiClient.delete<ApiResponse>(`hr/positions/${id}`),

    getEmployees: (params: Record<string, unknown>) => apiClient.get<ApiResponse>('hr/employees', { params }),
    getLinkableUsers: (params?: Record<string, unknown>) => apiClient.get<ApiResponse>('hr/linkable-users', { params }),
    createEmployee: (data: Record<string, unknown>) => apiClient.post<ApiResponse>('hr/employees', data),
    updateEmployee: (id: string, data: Record<string, unknown>) => apiClient.put<ApiResponse>(`hr/employees/${id}`, data),
    createRelatedUser: (id: string, data: Record<string, unknown>) =>
        apiClient.post<ApiResponse>(`hr/employees/${id}/related-user`, data),
    endEmployment: (id: string, data?: Record<string, unknown>) =>
        apiClient.post<ApiResponse>(`hr/employees/${id}/end-employment`, data ?? {}),
    getEmployeeContracts: (id: string) => apiClient.get<ApiResponse>(`hr/employees/${id}/contracts`),
    signEmployeeContract: (id: string, contractId: string, data?: Record<string, unknown>) =>
        apiClient.post<ApiResponse>(`hr/employees/${id}/contracts/${contractId}/sign`, data ?? {}),
    renewEmployeeContract: (id: string, contractId: string, data: Record<string, unknown>) =>
        apiClient.post<ApiResponse>(`hr/employees/${id}/contracts/${contractId}/renew`, data),
    convertEmployeeEngagement: (id: string, contractId: string, data: Record<string, unknown>) =>
        apiClient.post<ApiResponse>(`hr/employees/${id}/contracts/${contractId}/convert`, data),
    expireEmployeeContract: (id: string, contractId: string, data?: Record<string, unknown>) =>
        apiClient.post<ApiResponse>(`hr/employees/${id}/contracts/${contractId}/expire`, data ?? {}),
    listExpiringContracts: (params?: Record<string, unknown>) =>
        apiClient.get<ApiResponse>('hr/contracts/expiring', { params }),
    deleteEmployee: (id: string) => apiClient.delete<ApiResponse>(`hr/employees/${id}`),
    getSalaryHistory: (id: string) => apiClient.get<ApiResponse>(`hr/employees/${id}/salary-history`),
    salaryChange: (id: string, data: Record<string, unknown>) =>
        apiClient.post<ApiResponse>(`hr/employees/${id}/salary-change`, data),

    getPayrollPeriods: () => apiClient.get<ApiResponse>('hr/payroll-periods'),
    createPayrollPeriod: (data: { startDate: string; endDate: string }) => apiClient.post<ApiResponse>('hr/payroll-periods', data),
    deletePayrollPeriod: (id: string) => apiClient.delete<ApiResponse>(`hr/payroll-periods/${id}`),
    getPayrollEntries: (periodId: string) => apiClient.get<ApiResponse>(`hr/payroll-periods/${periodId}/entries`),
    processPayroll: (periodId: string) => apiClient.post<ApiResponse>(`hr/payroll-periods/${periodId}/process`),
    postPayroll: (periodId: string) => apiClient.post<ApiResponse>(`hr/payroll-periods/${periodId}/post`),
    payPayroll: (periodId: string, data: { paymentAccountCode: string; paymentDate?: string; notes?: string }) =>
        apiClient.post<ApiResponse>(`hr/payroll-periods/${periodId}/pay`, data),
    getPeriodAdjustments: (periodId: string) =>
        apiClient.get<ApiResponse>(`hr/payroll-periods/${periodId}/adjustments`),
    upsertPeriodAdjustment: (periodId: string, data: Record<string, unknown>) =>
        apiClient.put<ApiResponse>(`hr/payroll-periods/${periodId}/adjustments`, data),

    getPaymentAccounts: () => apiClient.get<ApiResponse>('hr/payment-accounts'),
    getEmployeeBalances: () => apiClient.get<ApiResponse>('hr/employee-balances'),
    getAdvances: (params?: Record<string, unknown>) => apiClient.get<ApiResponse>('hr/advances', { params }),
    createAdvance: (data: Record<string, unknown>) => apiClient.post<ApiResponse>('hr/advances', data),

    getLeaveTypes: () => apiClient.get<ApiResponse>('hr/leave-types'),
    createLeaveType: (data: { name: string; isPaid: boolean }) => apiClient.post<ApiResponse>('hr/leave-types', data),
    getLeaveRequests: (params?: Record<string, unknown>) => apiClient.get<ApiResponse>('hr/leave-requests', { params }),
    createLeaveRequest: (data: Record<string, unknown>) => apiClient.post<ApiResponse>('hr/leave-requests', data),
    setLeaveStatus: (id: string, status: string) =>
        apiClient.post<ApiResponse>(`hr/leave-requests/${id}/status`, { status }),

    getStatutorySettings: () => apiClient.get<ApiResponse>('hr/statutory-settings'),
    updateStatutorySettings: (data: Record<string, unknown>) =>
        apiClient.put<ApiResponse>('hr/statutory-settings', data),
};

// ============================================================================
// HELPERS
// ============================================================================

function fmtCurrency(n: number | null | undefined): string {
    if (n == null) return '-';
    return new Intl.NumberFormat('en-UG', { style: 'currency', currency: 'UGX', minimumFractionDigits: 0 }).format(n);
}

async function exportHr(apiPath: string, filename: string): Promise<void> {
    await downloadFile(apiPath, filename);
}

function ExportButtons({
    pdfPath,
    csvPath,
    pdfName,
    csvName,
    disabled,
}: {
    pdfPath: string;
    csvPath: string;
    pdfName: string;
    csvName: string;
    disabled?: boolean;
}) {
    const [busy, setBusy] = useState<'pdf' | 'csv' | null>(null);
    const [error, setError] = useState<string | null>(null);

    const run = async (format: 'pdf' | 'csv') => {
        setBusy(format);
        setError(null);
        try {
            await exportHr(format === 'pdf' ? pdfPath : csvPath, format === 'pdf' ? pdfName : csvName);
        } catch (err) {
            setError(err instanceof Error ? err.message : `Export ${format.toUpperCase()} failed`);
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="flex flex-col items-end gap-1">
            <div className="flex gap-2">
                <button
                    type="button"
                    disabled={disabled || busy !== null}
                    onClick={() => void run('csv')}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                    {busy === 'csv' ? 'CSV?' : 'Export CSV'}
                </button>
                <button
                    type="button"
                    disabled={disabled || busy !== null}
                    onClick={() => void run('pdf')}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                    {busy === 'pdf' ? 'PDF?' : 'Export PDF'}
                </button>
            </div>
            {error && <p className="text-xs text-red-600 max-w-xs text-right">{error}</p>}
        </div>
    );
}

function statusBadge(status: string): string {
    const colors: Record<string, string> = {
        ACTIVE: 'bg-green-100 text-green-700',
        INACTIVE: 'bg-gray-100 text-gray-600',
        OPEN: 'bg-blue-100 text-blue-700',
        PROCESSED: 'bg-amber-100 text-amber-700',
        POSTED: 'bg-indigo-100 text-indigo-700',
        PARTIALLY_PAID: 'bg-amber-100 text-amber-800',
        PAID: 'bg-green-100 text-green-700',
        PARTIAL: 'bg-amber-100 text-amber-700',
        CLEARED: 'bg-green-100 text-green-700',
    };
    return colors[status] || 'bg-gray-100 text-gray-600';
}

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

// ---------- Departments Tab ----------
function DepartmentsTab() {
    const qc = useQueryClient();
    const [showForm, setShowForm] = useState(false);
    const [editId, setEditId] = useState<string | null>(null);
    const [name, setName] = useState('');

    const { data: departments = [], isLoading } = useQuery({
        queryKey: ['hr', 'departments'],
        queryFn: () => hrApi.getDepartments(),
        select: (res) => (res.data?.data ?? []) as Department[],
    });

    const saveMut = useMutation({
        mutationFn: () => editId ? hrApi.updateDepartment(editId, { name }) : hrApi.createDepartment({ name }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ['hr', 'departments'] }); resetForm(); },
    });

    const delMut = useMutation({
        mutationFn: (id: string) => hrApi.deleteDepartment(id),
        onSuccess: () => qc.invalidateQueries({ queryKey: ['hr', 'departments'] }),
    });

    function resetForm() { setShowForm(false); setEditId(null); setName(''); }
    function startEdit(d: Department) { setEditId(d.id); setName(d.name); setShowForm(true); }

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-900">Departments</h2>
                <button onClick={() => { resetForm(); setShowForm(true); }} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">
                    + New Department
                </button>
            </div>

            {showForm && (
                <div className="bg-white rounded-xl border p-4 shadow-sm">
                    <div className="flex gap-3 items-end">
                        <div className="flex-1">
                            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                            <input value={name} onChange={(e) => setName(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" placeholder="Department name" />
                        </div>
                        <button onClick={() => saveMut.mutate()} disabled={!name.trim() || saveMut.isPending} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                            {saveMut.isPending ? 'Saving...' : editId ? 'Update' : 'Create'}
                        </button>
                        <button onClick={resetForm} className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">Cancel</button>
                    </div>
                </div>
            )}

            <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
                {isLoading ? (
                    <div className="p-8 text-center text-gray-500">Loading...</div>
                ) : departments.length === 0 ? (
                    <div className="p-8 text-center text-gray-400">No departments yet</div>
                ) : (
                    <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-gray-600">
                            <tr>
                                <th className="text-left px-4 py-3 font-medium">Name</th>
                                <th className="text-left px-4 py-3 font-medium">Created</th>
                                <th className="text-right px-4 py-3 font-medium">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {departments.map((d) => (
                                <tr key={d.id} className="hover:bg-gray-50">
                                    <td className="px-4 py-3 font-medium text-gray-900">{d.name}</td>
                                    <td className="px-4 py-3 text-gray-500">{formatTimestampDate(d.createdAt)}</td>
                                    <td className="px-4 py-3 text-right space-x-2">
                                        <button onClick={() => startEdit(d)} className="text-indigo-600 hover:text-indigo-800 text-xs font-medium">Edit</button>
                                        <button onClick={() => { if (confirm('Delete this department?')) delMut.mutate(d.id); }} className="text-red-600 hover:text-red-800 text-xs font-medium">Delete</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}

// ---------- Positions Tab ----------
function PositionsTab() {
    const qc = useQueryClient();
    const [showForm, setShowForm] = useState(false);
    const [editId, setEditId] = useState<string | null>(null);
    const [title, setTitle] = useState('');
    const [baseSalary, setBaseSalary] = useState('');

    const { data: positions = [], isLoading } = useQuery({
        queryKey: ['hr', 'positions'],
        queryFn: () => hrApi.getPositions(),
        select: (res) => (res.data?.data ?? []) as Position[],
    });

    const saveMut = useMutation({
        mutationFn: () => {
            const salary = baseSalary.trim() ? parseFloat(baseSalary) : null;
            return editId
                ? hrApi.updatePosition(editId, { title: title || undefined, baseSalary: salary })
                : hrApi.createPosition({ title, baseSalary: salary });
        },
        onSuccess: () => { qc.invalidateQueries({ queryKey: ['hr', 'positions'] }); resetForm(); },
    });

    const delMut = useMutation({
        mutationFn: (id: string) => hrApi.deletePosition(id),
        onSuccess: () => qc.invalidateQueries({ queryKey: ['hr', 'positions'] }),
    });

    function resetForm() { setShowForm(false); setEditId(null); setTitle(''); setBaseSalary(''); }
    function startEdit(p: Position) { setEditId(p.id); setTitle(p.title); setBaseSalary(p.baseSalary != null ? String(p.baseSalary) : ''); setShowForm(true); }

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-900">Positions</h2>
                <button onClick={() => { resetForm(); setShowForm(true); }} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">
                    + New Position
                </button>
            </div>

            {showForm && (
                <div className="bg-white rounded-xl border p-4 shadow-sm">
                    <div className="flex gap-3 items-end">
                        <div className="flex-1">
                            <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                            <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" placeholder="Position title" />
                        </div>
                        <div className="w-48">
                            <label className="block text-sm font-medium text-gray-700 mb-1">Base Salary</label>
                            <input value={baseSalary} onChange={(e) => setBaseSalary(e.target.value)} type="number" min="0" step="1000" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" placeholder="0" />
                        </div>
                        <button onClick={() => saveMut.mutate()} disabled={!title.trim() || saveMut.isPending} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                            {saveMut.isPending ? 'Saving...' : editId ? 'Update' : 'Create'}
                        </button>
                        <button onClick={resetForm} className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">Cancel</button>
                    </div>
                </div>
            )}

            <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
                {isLoading ? (
                    <div className="p-8 text-center text-gray-500">Loading...</div>
                ) : positions.length === 0 ? (
                    <div className="p-8 text-center text-gray-400">No positions yet</div>
                ) : (
                    <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-gray-600">
                            <tr>
                                <th className="text-left px-4 py-3 font-medium">Title</th>
                                <th className="text-right px-4 py-3 font-medium">Base Salary</th>
                                <th className="text-left px-4 py-3 font-medium">Created</th>
                                <th className="text-right px-4 py-3 font-medium">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {positions.map((p) => (
                                <tr key={p.id} className="hover:bg-gray-50">
                                    <td className="px-4 py-3 font-medium text-gray-900">{p.title}</td>
                                    <td className="px-4 py-3 text-right text-gray-700">{fmtCurrency(p.baseSalary)}</td>
                                    <td className="px-4 py-3 text-gray-500">{formatTimestampDate(p.createdAt)}</td>
                                    <td className="px-4 py-3 text-right space-x-2">
                                        <button onClick={() => startEdit(p)} className="text-indigo-600 hover:text-indigo-800 text-xs font-medium">Edit</button>
                                        <button onClick={() => { if (confirm('Delete this position?')) delMut.mutate(p.id); }} className="text-red-600 hover:text-red-800 text-xs font-medium">Delete</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}

// ---------- Employees Tab ----------
interface EmpContractRow {
    id: string;
    employmentType: string;
    startDate: string;
    endDate: string | null;
    probationEndDate: string | null;
    status: string;
    signedAt: string | null;
    contractNumber: string | null;
    daysUntilEnd: number | null;
}

function EmployeeContractsPanel({ employeeId, onClose }: { employeeId: string; onClose: () => void }) {
    const qc = useQueryClient();
    const [renewForm, setRenewForm] = useState({ startDate: '', endDate: '', notes: '' });
    const [convertTo, setConvertTo] = useState<'PERMANENT' | 'CONTRACT'>('PERMANENT');
    const [convertEnd, setConvertEnd] = useState('');
    const [convertEffective, setConvertEffective] = useState(new Date().toISOString().slice(0, 10));

    const { data: contracts = [], isLoading } = useQuery({
        queryKey: ['hr', 'contracts', employeeId],
        queryFn: () => hrApi.getEmployeeContracts(employeeId),
        select: (res) => (res.data?.data ?? []) as EmpContractRow[],
    });

    const open = contracts.find((c) => c.status === 'DRAFT' || c.status === 'ACTIVE');

    const signMut = useMutation({
        mutationFn: (contractId: string) => hrApi.signEmployeeContract(employeeId, contractId),
        onSuccess: () => qc.invalidateQueries({ queryKey: ['hr', 'contracts', employeeId] }),
    });
    const renewMut = useMutation({
        mutationFn: () =>
            hrApi.renewEmployeeContract(employeeId, open!.id, {
                startDate: renewForm.startDate,
                endDate: renewForm.endDate,
                notes: renewForm.notes || null,
                signNow: true,
            }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['hr', 'contracts', employeeId] });
            qc.invalidateQueries({ queryKey: ['hr', 'employees'] });
            setRenewForm({ startDate: '', endDate: '', notes: '' });
        },
    });
    const convertMut = useMutation({
        mutationFn: () =>
            hrApi.convertEmployeeEngagement(employeeId, open!.id, {
                toType: convertTo,
                effectiveDate: convertEffective,
                endDate: convertTo === 'CONTRACT' ? convertEnd : null,
                signNow: true,
            }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['hr', 'contracts', employeeId] });
            qc.invalidateQueries({ queryKey: ['hr', 'employees'] });
        },
    });
    const expireMut = useMutation({
        mutationFn: () => hrApi.expireEmployeeContract(employeeId, open!.id, {}),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['hr', 'contracts', employeeId] });
            qc.invalidateQueries({ queryKey: ['hr', 'employees'] });
        },
    });

    const convertTargets = open
        ? (CONTRACT_CONVERT_TARGETS[open.employmentType as EmploymentType] ?? [])
        : [];

    return (
        <div className="bg-white rounded-xl border p-4 shadow-sm space-y-3">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-700">Employment contracts</h3>
                <button type="button" onClick={onClose} className="text-xs text-gray-500 hover:text-gray-800">Close</button>
            </div>
            <p className="text-[11px] text-gray-500">
                Versioned engagements (Odoo/SAP style). Sign ? Active ? Renew / Convert / Expire. Ending employment terminates the open contract.
            </p>
            {isLoading ? (
                <p className="text-sm text-gray-500">Loading?</p>
            ) : contracts.length === 0 ? (
                <p className="text-sm text-gray-400">No contracts yet</p>
            ) : (
                <table className="w-full text-xs">
                    <thead className="text-gray-500">
                        <tr>
                            <th className="text-left py-1">Type</th>
                            <th className="text-left py-1">Term</th>
                            <th className="text-left py-1">Status</th>
                            <th className="text-left py-1">Signed</th>
                            <th className="text-left py-1">Days left</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {contracts.map((c) => (
                            <tr key={c.id}>
                                <td className="py-1.5 font-medium">{c.employmentType}</td>
                                <td className="py-1.5 text-gray-600">
                                    {c.startDate} ? {c.endDate ?? 'open'}
                                    {c.contractNumber ? ` ? ${c.contractNumber}` : ''}
                                </td>
                                <td className="py-1.5">{c.status}</td>
                                <td className="py-1.5 text-gray-500">{c.signedAt ? 'Yes' : '?'}</td>
                                <td className="py-1.5">{c.daysUntilEnd == null ? '?' : c.daysUntilEnd}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            {open && (
                <div className="border-t pt-3 space-y-3">
                    <p className="text-xs font-medium text-gray-700">
                        Open: {open.employmentType} ? {open.status}
                        {open.status === 'DRAFT' || !open.signedAt ? (
                            <button
                                type="button"
                                className="ml-2 text-indigo-600 font-medium"
                                onClick={() => signMut.mutate(open.id)}
                                disabled={signMut.isPending}
                            >
                                Sign / activate
                            </button>
                        ) : null}
                    </p>

                    {open.status === 'ACTIVE' && open.employmentType !== 'PERMANENT' && (
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-2 items-end">
                            <div>
                                <label className="block text-[11px] text-gray-500 mb-0.5">Renew from</label>
                                <DatePicker value={renewForm.startDate} onChange={(v) => setRenewForm((f) => ({ ...f, startDate: v }))} placeholder="Start" />
                            </div>
                            <div>
                                <label className="block text-[11px] text-gray-500 mb-0.5">New end *</label>
                                <DatePicker value={renewForm.endDate} onChange={(v) => setRenewForm((f) => ({ ...f, endDate: v }))} placeholder="End" />
                            </div>
                            <div className="md:col-span-2">
                                <button
                                    type="button"
                                    disabled={!renewForm.startDate || !renewForm.endDate || renewMut.isPending}
                                    onClick={() => renewMut.mutate()}
                                    className="px-3 py-2 bg-indigo-600 text-white rounded-lg text-xs font-medium disabled:opacity-50"
                                >
                                    Renew contract
                                </button>
                            </div>
                            {renewMut.isError && <p className="md:col-span-4 text-xs text-red-600">{getErrorMessage(renewMut.error)}</p>}
                        </div>
                    )}

                    {open.status === 'ACTIVE' && convertTargets.length > 0 && (
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-2 items-end">
                            <div>
                                <label className="block text-[11px] text-gray-500 mb-0.5">Convert to</label>
                                <select
                                    value={convertTo}
                                    onChange={(e) => setConvertTo(e.target.value as 'PERMANENT' | 'CONTRACT')}
                                    className="w-full border border-gray-300 rounded-lg px-2 py-2 text-xs"
                                >
                                    {convertTargets.map((t) => (
                                        <option key={t} value={t}>{t}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="block text-[11px] text-gray-500 mb-0.5">Effective</label>
                                <DatePicker value={convertEffective} onChange={setConvertEffective} placeholder="Date" />
                            </div>
                            {convertTo === 'CONTRACT' && (
                                <div>
                                    <label className="block text-[11px] text-gray-500 mb-0.5">Contract end *</label>
                                    <DatePicker value={convertEnd} onChange={setConvertEnd} placeholder="End" />
                                </div>
                            )}
                            <div>
                                <button
                                    type="button"
                                    disabled={convertMut.isPending || (convertTo === 'CONTRACT' && !convertEnd)}
                                    onClick={() => convertMut.mutate()}
                                    className="px-3 py-2 bg-emerald-600 text-white rounded-lg text-xs font-medium disabled:opacity-50"
                                >
                                    Convert engagement
                                </button>
                            </div>
                            {convertMut.isError && <p className="md:col-span-4 text-xs text-red-600">{getErrorMessage(convertMut.error)}</p>}
                        </div>
                    )}

                    {open.status === 'ACTIVE' && open.endDate && (open.daysUntilEnd ?? 1) < 0 && (
                        <button
                            type="button"
                            onClick={() => expireMut.mutate()}
                            disabled={expireMut.isPending}
                            className="px-3 py-2 border border-amber-500 text-amber-700 rounded-lg text-xs font-medium"
                        >
                            Mark expired
                        </button>
                    )}
                    {expireMut.isError && <p className="text-xs text-red-600">{getErrorMessage(expireMut.error)}</p>}
                    {signMut.isError && <p className="text-xs text-red-600">{getErrorMessage(signMut.error)}</p>}
                </div>
            )}
        </div>
    );
}

function EmployeesTab() {
    const qc = useQueryClient();
    const [showForm, setShowForm] = useState(false);
    const [editId, setEditId] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<string>('');
    const [typeFilter, setTypeFilter] = useState<string>('');
    const [createLoginForId, setCreateLoginForId] = useState<string | null>(null);
    const [loginForm, setLoginForm] = useState({ email: '', password: '', role: 'CASHIER' });
    const [form, setForm] = useState(emptyEmployeeForm);
    const [contractsForId, setContractsForId] = useState<string | null>(null);

    const { data: departments = [] } = useQuery({
        queryKey: ['hr', 'departments'],
        queryFn: () => hrApi.getDepartments(),
        select: (res) => (res.data?.data ?? []) as Department[],
    });

    const { data: positions = [] } = useQuery({
        queryKey: ['hr', 'positions'],
        queryFn: () => hrApi.getPositions(),
        select: (res) => (res.data?.data ?? []) as Position[],
    });

    const { data: linkableUsers = [] } = useQuery({
        queryKey: ['hr', 'linkable-users', form.userId || null],
        queryFn: () => hrApi.getLinkableUsers(form.userId ? { includeUserId: form.userId } : undefined),
        select: (res) => (res.data?.data ?? []) as LinkableUser[],
        enabled: showForm,
    });

    const params = buildHrEmployeeListParams({
        page: 1,
        limit: HR_EMPLOYEE_LIST_PAGE_LIMIT,
        ...(search ? { search } : {}),
        ...(statusFilter === 'ACTIVE' || statusFilter === 'INACTIVE'
            ? { status: statusFilter }
            : {}),
        ...(typeFilter === 'PERMANENT' || typeFilter === 'CASUAL' || typeFilter === 'CONTRACT'
            ? { employmentType: typeFilter }
            : {}),
    });

    const { data: employeesResp, isLoading } = useQuery({
        queryKey: ['hr', 'employees', search, statusFilter, typeFilter],
        queryFn: () => hrApi.getEmployees(params),
        select: (res) => res.data as { data: Employee[]; pagination: { total: number } } | undefined,
    });
    const employees = employeesResp?.data ?? [];

    const saveMut = useMutation({
        mutationFn: () => {
            const allowanceRaw = form.monthlyAllowance.trim();
            const allowanceNum = allowanceRaw === '' ? 0 : Number(allowanceRaw);
            if (!Number.isFinite(allowanceNum) || allowanceNum < 0) {
                throw new Error('Monthly allowance must be a non-negative number');
            }
            const payload: Record<string, unknown> = {
                firstName: form.firstName,
                lastName: form.lastName,
                phone: form.phone || null,
                email: form.email || null,
                departmentId: form.departmentId || null,
                positionId: form.positionId || null,
                hireDate: form.hireDate,
                employmentType: form.employmentType,
                endDate: form.endDate || null,
                userId: form.userId || null,
                monthlyAllowance: allowanceNum,
                employeeNumber: form.employeeNumber || null,
                nationalId: form.nationalId || null,
                dateOfBirth: form.dateOfBirth || null,
                gender: form.gender || null,
                nationality: form.nationality || null,
                maritalStatus: form.maritalStatus || null,
                addressLine1: form.addressLine1 || null,
                addressDistrict: form.addressDistrict || null,
                nextOfKinName: form.nextOfKinName || null,
                nextOfKinPhone: form.nextOfKinPhone || null,
                nextOfKinRelation: form.nextOfKinRelation || null,
                nssfNumber: form.nssfNumber || null,
                tinNumber: form.tinNumber || null,
                bankName: form.bankName || null,
                bankBranch: form.bankBranch || null,
                bankAccountNumber: form.bankAccountNumber || null,
                bankAccountName: form.bankAccountName || null,
                mobileMoneyNumber: form.mobileMoneyNumber || null,
                mobileMoneyProvider: form.mobileMoneyProvider || null,
                preferredPaymentMethod: form.preferredPaymentMethod || null,
            };
            if (!editId) {
                payload.probationEndDate = form.probationEndDate || null;
                payload.contractNumber = form.contractNumber || null;
                payload.signContract = form.signContract;
            }
            if (editId) payload.status = form.status;
            return editId ? hrApi.updateEmployee(editId, payload) : hrApi.createEmployee(payload);
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['hr', 'employees'] });
            qc.invalidateQueries({ queryKey: ['hr', 'linkable-users'] });
            resetForm();
        },
    });

    const delMut = useMutation({
        mutationFn: (id: string) => hrApi.deleteEmployee(id),
        onSuccess: () => qc.invalidateQueries({ queryKey: ['hr', 'employees'] }),
    });

    const endMut = useMutation({
        mutationFn: (id: string) => hrApi.endEmployment(id, { deactivateLogin: true }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['hr', 'employees'] });
            qc.invalidateQueries({ queryKey: ['hr', 'linkable-users'] });
        },
    });

    const createLoginMut = useMutation({
        mutationFn: () =>
            hrApi.createRelatedUser(createLoginForId!, {
                email: loginForm.email,
                password: loginForm.password,
                role: loginForm.role,
            }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['hr', 'employees'] });
            qc.invalidateQueries({ queryKey: ['hr', 'linkable-users'] });
            setCreateLoginForId(null);
            setLoginForm({ email: '', password: '', role: 'CASHIER' });
        },
    });

    function resetForm() {
        setShowForm(false);
        setEditId(null);
        setForm(emptyEmployeeForm());
    }

    function startEdit(e: Employee) {
        setEditId(e.id);
        setForm(employeeToForm(e));
        setShowForm(true);
    }

    const field = (key: keyof ReturnType<typeof emptyEmployeeForm>, label: string, node: ReactNode) => (
        <div key={String(key)}>
            <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
            {node}
        </div>
    );

    const textInput = (key: keyof ReturnType<typeof emptyEmployeeForm>, placeholder = '') => (
        <input
            value={form[key]}
            onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            placeholder={placeholder}
        />
    );

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-semibold text-gray-900">Employees</h2>
                    <p className="text-xs text-gray-500 mt-0.5">
                        Enterprise HR master (identity, next of kin, NSSF/TIN, bank/MoMo). Monthly allowance is contractual payroll gross ? daily transport stays in Expenses.
                    </p>
                </div>
                <button onClick={() => { resetForm(); setShowForm(true); }} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">
                    + New Employee
                </button>
            </div>

            <div className="flex gap-3 flex-wrap">
                <input value={search} onChange={(e) => setSearch(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-64" placeholder="Search employees..." />
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">All Statuses</option>
                    <option value="ACTIVE">Active</option>
                    <option value="INACTIVE">Inactive</option>
                </select>
                <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">All Types</option>
                    {EMPLOYMENT_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
                    ))}
                </select>
            </div>

            {showForm && (
                <div className="bg-white rounded-xl border p-4 shadow-sm space-y-3">
                    <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-gray-700">{editId ? 'Edit Employee' : 'New Employee'}</h3>
                        <p className="text-[11px] text-gray-500">Bundles from shared form-section SSOT ? expand as needed</p>
                    </div>

                    <FormSectionCatalog
                        sections={EMPLOYEE_FORM_SECTIONS}
                        persistKey={EMPLOYEE_FORM_SECTIONS_STORAGE_KEY}
                    >
                    <FormSection id="employment">
                        {field('firstName', 'First Name *', textInput('firstName'))}
                        {field('lastName', 'Last Name *', textInput('lastName'))}
                        {field('employeeNumber', 'Employee No.', textInput('employeeNumber', 'Badge / staff code'))}
                        {field('hireDate', 'Hire Date *', <DatePicker value={form.hireDate} onChange={(v) => setForm((f) => ({ ...f, hireDate: v }))} placeholder="Hire date" />)}
                        {field(
                            'employmentType',
                            'Employment Type',
                            <select
                                value={form.employmentType}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        employmentType: e.target.value as EmploymentType,
                                        endDate:
                                            e.target.value === 'PERMANENT' ? '' : f.endDate,
                                    }))
                                }
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                            >
                                {EMPLOYMENT_TYPES.map((t) => (
                                    <option key={t} value={t}>{t}</option>
                                ))}
                            </select>
                        )}
                        {field(
                            'endDate',
                            requiresContractEndDate(form.employmentType)
                                ? 'Contract end date *'
                                : form.employmentType === 'PERMANENT'
                                  ? 'End date (use End Employment)'
                                  : 'Planned end (optional)',
                            <DatePicker
                                value={form.endDate}
                                onChange={(v) => setForm((f) => ({ ...f, endDate: v }))}
                                placeholder={
                                    requiresContractEndDate(form.employmentType)
                                        ? 'Required for fixed-term'
                                        : 'Optional'
                                }
                            />
                        )}
                        {field(
                            'departmentId',
                            'Department',
                            <select value={form.departmentId} onChange={(e) => setForm((f) => ({ ...f, departmentId: e.target.value }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                                <option value="">-- None --</option>
                                {departments.map((d) => (
                                    <option key={d.id} value={d.id}>{d.name}</option>
                                ))}
                            </select>
                        )}
                        {field(
                            'positionId',
                            'Position',
                            <select value={form.positionId} onChange={(e) => setForm((f) => ({ ...f, positionId: e.target.value }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                                <option value="">-- None --</option>
                                {positions.map((p) => (
                                    <option key={p.id} value={p.id}>{p.title} {p.baseSalary != null ? `(${fmtCurrency(p.baseSalary)})` : ''}</option>
                                ))}
                            </select>
                        )}
                        {field(
                            'monthlyAllowance',
                            'Monthly Allowance (payroll)',
                            <>
                                <input type="number" step="1" value={form.monthlyAllowance} onChange={(e) => setForm((f) => ({ ...f, monthlyAllowance: e.target.value }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" placeholder="0" />
                                <p className="mt-1 text-[11px] text-gray-500">Contractual gross add-on. Daily transport ? Expenses, not here.</p>
                            </>
                        )}
                        {field(
                            'userId',
                            'Related Login (optional)',
                            <select value={form.userId} onChange={(e) => setForm((f) => ({ ...f, userId: e.target.value }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                                <option value="">? No login (casual/intern OK) ?</option>
                                {linkableUsers.map((u) => (
                                    <option key={u.id} value={u.id}>{u.fullName} ({u.email})</option>
                                ))}
                            </select>
                        )}
                        {editId &&
                            field(
                                'status',
                                'Status',
                                <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                                    <option value="ACTIVE">Active</option>
                                    <option value="INACTIVE">Inactive</option>
                                </select>
                            )}
                    </FormSection>

                    {!editId && (
                        <FormSection id="contract">
                            {field('contractNumber', 'Contract ref #', textInput('contractNumber', 'Optional paper/PDF ref'))}
                            {field(
                                'probationEndDate',
                                'Probation end',
                                <DatePicker value={form.probationEndDate} onChange={(v) => setForm((f) => ({ ...f, probationEndDate: v }))} placeholder="Optional" />
                            )}
                            <div className="md:col-span-3 flex items-center gap-2 text-sm text-gray-700">
                                <input
                                    id="signContract"
                                    type="checkbox"
                                    checked={form.signContract}
                                    onChange={(e) => setForm((f) => ({ ...f, signContract: e.target.checked }))}
                                    className="rounded border-gray-300"
                                />
                                <label htmlFor="signContract">
                                    Mark engagement signed on create (otherwise starts as DRAFT until Sign)
                                </label>
                            </div>
                            <p className="md:col-span-3 text-[11px] text-gray-500">
                                Fixed-term (CONTRACT / INTERN) requires an end date. Renew / convert after hire from the Contracts panel.
                            </p>
                        </FormSection>
                    )}

                    <FormSection id="identity">
                        {field('nationalId', 'National ID (NIN)', textInput('nationalId'))}
                        {field('dateOfBirth', 'Date of Birth', <DatePicker value={form.dateOfBirth} onChange={(v) => setForm((f) => ({ ...f, dateOfBirth: v }))} placeholder="DOB" />)}
                        {field(
                            'gender',
                            'Gender',
                            <select value={form.gender} onChange={(e) => setForm((f) => ({ ...f, gender: e.target.value }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                                <option value="">?</option>
                                {EMPLOYEE_GENDERS.map((g) => (
                                    <option key={g} value={g}>{g}</option>
                                ))}
                            </select>
                        )}
                        {field('nationality', 'Nationality', textInput('nationality', 'e.g. Ugandan'))}
                        {field(
                            'maritalStatus',
                            'Marital Status',
                            <select value={form.maritalStatus} onChange={(e) => setForm((f) => ({ ...f, maritalStatus: e.target.value }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                                <option value="">?</option>
                                {EMPLOYEE_MARITAL_STATUSES.map((m) => (
                                    <option key={m} value={m}>{m}</option>
                                ))}
                            </select>
                        )}
                    </FormSection>

                    <FormSection id="contact">
                        {field('phone', 'Phone', textInput('phone'))}
                        {field('email', 'Email', <input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />)}
                        {field('addressDistrict', 'District', textInput('addressDistrict'))}
                        {field('addressLine1', 'Address', textInput('addressLine1', 'Village / street / parish'))}
                    </FormSection>

                    <FormSection id="nextOfKin">
                        {field('nextOfKinName', 'Name', textInput('nextOfKinName'))}
                        {field('nextOfKinPhone', 'Phone', textInput('nextOfKinPhone'))}
                        {field('nextOfKinRelation', 'Relation', textInput('nextOfKinRelation', 'Spouse / Parent / Sibling?'))}
                    </FormSection>

                    <FormSection id="compliance">
                        {field('nssfNumber', 'NSSF Number', textInput('nssfNumber'))}
                        {field('tinNumber', 'TIN', textInput('tinNumber'))}
                    </FormSection>

                    <FormSection id="payment">
                        {field(
                            'preferredPaymentMethod',
                            'Preferred method',
                            <select value={form.preferredPaymentMethod} onChange={(e) => setForm((f) => ({ ...f, preferredPaymentMethod: e.target.value }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                                <option value="">?</option>
                                {EMPLOYEE_PAYMENT_METHODS.map((m) => (
                                    <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>
                                ))}
                            </select>
                        )}
                        {field('bankName', 'Bank name', textInput('bankName'))}
                        {field('bankBranch', 'Bank branch', textInput('bankBranch'))}
                        {field('bankAccountName', 'Account name', textInput('bankAccountName'))}
                        {field('bankAccountNumber', 'Account number', textInput('bankAccountNumber'))}
                        {field(
                            'mobileMoneyProvider',
                            'MoMo provider',
                            <select value={form.mobileMoneyProvider} onChange={(e) => setForm((f) => ({ ...f, mobileMoneyProvider: e.target.value }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                                <option value="">?</option>
                                {EMPLOYEE_MOMO_PROVIDERS.map((m) => (
                                    <option key={m} value={m}>{m}</option>
                                ))}
                            </select>
                        )}
                        {field('mobileMoneyNumber', 'MoMo number', textInput('mobileMoneyNumber'))}
                    </FormSection>
                    </FormSectionCatalog>

                    <div className="flex gap-2 pt-1">
                        <button
                            onClick={() => saveMut.mutate()}
                            disabled={
                                !form.firstName.trim() ||
                                !form.lastName.trim() ||
                                !form.hireDate ||
                                (!editId && requiresContractEndDate(form.employmentType) && !form.endDate) ||
                                saveMut.isPending
                            }
                            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
                        >
                            {saveMut.isPending ? 'Saving...' : editId ? 'Update Employee' : 'Create Employee'}
                        </button>
                        <button onClick={resetForm} className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">Cancel</button>
                    </div>
                    {saveMut.isError && (
                        <p className="mt-2 text-xs text-red-600">{getErrorMessage(saveMut.error)}</p>
                    )}
                </div>
            )}

            {contractsForId && (
                <EmployeeContractsPanel
                    employeeId={contractsForId}
                    onClose={() => setContractsForId(null)}
                />
            )}

            {createLoginForId && (
                <div className="bg-white rounded-xl border p-4 shadow-sm">
                    <h3 className="text-sm font-semibold text-gray-700 mb-3">Create related login</h3>
                    <p className="text-xs text-gray-500 mb-3">Creates a POS/RBAC user and links it 1:1 to this employee. Casuals can skip this.</p>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">Login Email *</label>
                            <input type="email" value={loginForm.email} onChange={(e) => setLoginForm(f => ({ ...f, email: e.target.value }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">Temp Password *</label>
                            <input type="password" value={loginForm.password} onChange={(e) => setLoginForm(f => ({ ...f, password: e.target.value }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" placeholder="Min 8 chars, mixed case, digit, special" />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">Role</label>
                            <select value={loginForm.role} onChange={(e) => setLoginForm(f => ({ ...f, role: e.target.value }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                                <option value="CASHIER">Cashier</option>
                                <option value="STAFF">Staff</option>
                                <option value="MANAGER">Manager</option>
                                <option value="ADMIN">Admin</option>
                            </select>
                        </div>
                    </div>
                    <div className="flex gap-2 mt-4">
                        <button
                            onClick={() => createLoginMut.mutate()}
                            disabled={!loginForm.email.trim() || loginForm.password.length < 8 || createLoginMut.isPending}
                            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
                        >
                            {createLoginMut.isPending ? 'Creating...' : 'Create & Link Login'}
                        </button>
                        <button onClick={() => setCreateLoginForId(null)} className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">Cancel</button>
                    </div>
                    {createLoginMut.isError && (
                        <p className="mt-2 text-xs text-red-600">{(createLoginMut.error as Error)?.message || 'Create login failed'}</p>
                    )}
                </div>
            )}

            <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
                {isLoading ? (
                    <div className="p-8 text-center text-gray-500">Loading...</div>
                ) : employees.length === 0 ? (
                    <div className="p-8 text-center text-gray-400">No employees found</div>
                ) : (
                    <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-gray-600">
                            <tr>
                                <th className="text-left px-4 py-3 font-medium">Name</th>
                                <th className="text-left px-4 py-3 font-medium">Type</th>
                                <th className="text-left px-4 py-3 font-medium">Related Login</th>
                                <th className="text-left px-4 py-3 font-medium">Department</th>
                                <th className="text-left px-4 py-3 font-medium">Position</th>
                                <th className="text-right px-4 py-3 font-medium">Base Salary</th>
                                <th className="text-right px-4 py-3 font-medium">Allowance</th>
                                <th className="text-left px-4 py-3 font-medium">Sub-Ledger</th>
                                <th className="text-left px-4 py-3 font-medium">Hire / End</th>
                                <th className="text-center px-4 py-3 font-medium">Status</th>
                                <th className="text-right px-4 py-3 font-medium">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {employees.map((e) => (
                                <tr key={e.id} className="hover:bg-gray-50">
                                    <td className="px-4 py-3 font-medium text-gray-900">{e.firstName} {e.lastName}</td>
                                    <td className="px-4 py-3 text-gray-600 text-xs">{e.employmentType || 'PERMANENT'}</td>
                                    <td className="px-4 py-3 text-gray-600 text-xs">
                                        {e.userFullName || e.userEmail
                                            ? `${e.userFullName || e.userEmail}${e.userIsActive === false ? ' (inactive)' : ''}`
                                            : '?'}
                                    </td>
                                    <td className="px-4 py-3 text-gray-600">{e.departmentName || '-'}</td>
                                    <td className="px-4 py-3 text-gray-600">{e.positionTitle || '-'}</td>
                                    <td className="px-4 py-3 text-right text-gray-700">{fmtCurrency(e.positionBaseSalary)}</td>
                                    <td className="px-4 py-3 text-right text-gray-700">{fmtCurrency(e.monthlyAllowance ?? 0)}</td>
                                    <td className="px-4 py-3 text-gray-600 font-mono text-xs">{e.ledgerAccountCode || '-'}</td>
                                    <td className="px-4 py-3 text-gray-500 text-xs">
                                        {e.hireDate}{e.endDate ? ` ? ${e.endDate}` : ''}
                                    </td>
                                    <td className="px-4 py-3 text-center">
                                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge(e.status)}`}>{e.status}</span>
                                    </td>
                                    <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                                        <button onClick={() => startEdit(e)} className="text-indigo-600 hover:text-indigo-800 text-xs font-medium">Edit</button>
                                        <button onClick={() => setContractsForId(e.id)} className="text-indigo-600 hover:text-indigo-800 text-xs font-medium">Contracts</button>
                                        <button
                                            onClick={() => {
                                                const basic = prompt(
                                                    `New basic salary for ${e.firstName} ${e.lastName} (effective today)`,
                                                    String(e.positionBaseSalary ?? 0)
                                                );
                                                if (basic == null) return;
                                                const allow = prompt('Monthly allowance', String(e.monthlyAllowance ?? 0));
                                                if (allow == null) return;
                                                const effectiveFrom = prompt('Effective from (YYYY-MM-DD)', new Date().toISOString().slice(0, 10));
                                                if (!effectiveFrom) return;
                                                hrApi
                                                    .salaryChange(e.id, {
                                                        effectiveFrom,
                                                        basicSalary: Number(basic),
                                                        monthlyAllowance: Number(allow),
                                                        reason: 'PROMOTION',
                                                    })
                                                    .then(() => qc.invalidateQueries({ queryKey: ['hr', 'employees'] }))
                                                    .catch((err: Error) => alert(err.message || 'Salary change failed'));
                                            }}
                                            className="text-violet-600 hover:text-violet-800 text-xs font-medium"
                                        >
                                            Promote
                                        </button>
                                        {!e.userId && e.status === 'ACTIVE' && (
                                            <button
                                                onClick={() => {
                                                    setCreateLoginForId(e.id);
                                                    setLoginForm({
                                                        email: e.email || '',
                                                        password: '',
                                                        role: 'CASHIER',
                                                    });
                                                }}
                                                className="text-emerald-600 hover:text-emerald-800 text-xs font-medium"
                                            >
                                                Create login
                                            </button>
                                        )}
                                        {e.status === 'ACTIVE' && (
                                            <button
                                                onClick={() => {
                                                    if (confirm(`End employment for ${e.firstName} ${e.lastName}? Related login will be deactivated.`)) {
                                                        endMut.mutate(e.id);
                                                    }
                                                }}
                                                className="text-amber-600 hover:text-amber-800 text-xs font-medium"
                                            >
                                                End
                                            </button>
                                        )}
                                        <button onClick={() => { if (confirm(`Delete ${e.firstName} ${e.lastName}?`)) delMut.mutate(e.id); }} className="text-red-600 hover:text-red-800 text-xs font-medium">Delete</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}

// ---------- Payroll Tab ----------
function PayrollTab() {
    const qc = useQueryClient();
    const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null);
    const [showCreateForm, setShowCreateForm] = useState(false);
    const [periodForm, setPeriodForm] = useState({ startDate: '', endDate: '' });
    const [showPayForm, setShowPayForm] = useState(false);
    const [payAccountCode, setPayAccountCode] = useState('');
    const [payMode, setPayMode] = useState<'ALL' | 'SELECTED' | 'PARTIAL'>('ALL');
    const [paySelectedIds, setPaySelectedIds] = useState<string[]>([]);
    const [payPartialAmounts, setPayPartialAmounts] = useState<Record<string, string>>({});
    const [adjForm, setAdjForm] = useState({ employeeId: '', overtimePay: '', bonus: '' });

    const { data: periods = [], isLoading } = useQuery({
        queryKey: ['hr', 'payroll-periods'],
        queryFn: () => hrApi.getPayrollPeriods(),
        select: (res) => (res.data?.data ?? []) as PayrollPeriod[],
    });

    const { data: paymentAccounts = [] } = useQuery({
        queryKey: ['hr', 'payment-accounts'],
        queryFn: () => hrApi.getPaymentAccounts(),
        select: (res) => (res.data?.data ?? []) as PaymentAccount[],
    });

    useEffect(() => {
        if (paymentAccounts.length === 0) return;
        if (paymentAccounts.some((a) => a.code === payAccountCode)) return;
        try {
            setPayAccountCode(pickHrDisbursementAccount(paymentAccounts));
        } catch {
            setPayAccountCode(paymentAccounts[0]?.code ?? '');
        }
    }, [paymentAccounts, payAccountCode]);

    const selectedPeriod = periods.find((p) => p.id === selectedPeriodId);

    const { data: entries = [] } = useQuery({
        queryKey: ['hr', 'payroll-entries', selectedPeriodId],
        queryFn: () => hrApi.getPayrollEntries(selectedPeriodId!),
        select: (res) => (res.data?.data ?? []) as PayrollEntry[],
        enabled: !!selectedPeriodId,
    });

    const { data: adjEmployees = [] } = useQuery({
        queryKey: ['hr', 'employees', 'adj-picker'],
        queryFn: () => hrApi.getEmployees(buildHrActiveEmployeePickerParams()),
        select: (res) => {
            const payload = res.data?.data as { data?: Employee[] } | Employee[] | undefined;
            if (Array.isArray(payload)) return payload;
            return (payload?.data ?? []) as Employee[];
        },
        enabled: !!selectedPeriodId,
    });

    const adjMut = useMutation({
        mutationFn: () =>
            hrApi.upsertPeriodAdjustment(selectedPeriodId!, {
                employeeId: adjForm.employeeId,
                overtimePay: Number(adjForm.overtimePay || 0),
                bonus: Number(adjForm.bonus || 0),
            }),
        onSuccess: () => {
            setAdjForm({ employeeId: '', overtimePay: '', bonus: '' });
            alert('OT/bonus saved ? re-Process the period to include it.');
        },
    });

    const createPeriodMut = useMutation({
        mutationFn: () => hrApi.createPayrollPeriod(periodForm),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['hr', 'payroll-periods'] });
            setShowCreateForm(false);
            setPeriodForm({ startDate: '', endDate: '' });
        },
    });

    const deletePeriodMut = useMutation({
        mutationFn: (id: string) => hrApi.deletePayrollPeriod(id),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['hr', 'payroll-periods'] });
            setSelectedPeriodId(null);
        },
    });

    const invalidatePayroll = () => {
        qc.invalidateQueries({ queryKey: ['hr', 'payroll-periods'] });
        qc.invalidateQueries({ queryKey: ['hr', 'payroll-entries', selectedPeriodId] });
        qc.invalidateQueries({ queryKey: ['hr', 'employee-balances'] });
        qc.invalidateQueries({ queryKey: ['hr', 'advances'] });
    };

    const processMut = useMutation({
        mutationFn: () => hrApi.processPayroll(selectedPeriodId!),
        onSuccess: invalidatePayroll,
    });

    const postMut = useMutation({
        mutationFn: () => hrApi.postPayroll(selectedPeriodId!),
        onSuccess: invalidatePayroll,
    });

    const payMut = useMutation({
        mutationFn: () => {
            const payload: Record<string, unknown> = {
                paymentAccountCode: payAccountCode,
                mode: payMode,
            };
            if (payMode === 'SELECTED') {
                payload.employeeIds = paySelectedIds;
            }
            if (payMode === 'PARTIAL') {
                payload.lines = paySelectedIds.map((employeeId) => ({
                    employeeId,
                    amount: Number(payPartialAmounts[employeeId] || 0),
                }));
            }
            return hrApi.payPayroll(selectedPeriodId!, payload);
        },
        onSuccess: () => {
            setShowPayForm(false);
            setPaySelectedIds([]);
            setPayPartialAmounts({});
            setPayMode('ALL');
            invalidatePayroll();
        },
    });

    const workflow = ['OPEN', 'PROCESSED', 'POSTED', 'PARTIALLY_PAID', 'PAID'];
    const canPay =
        selectedPeriod?.status === 'POSTED' || selectedPeriod?.status === 'PARTIALLY_PAID';
    const payableEntries = entries.filter((e) => (e.remainingPayable ?? e.netPay) > 0);
    const payRunTotal =
        payMode === 'ALL'
            ? payableEntries.reduce((s, e) => s + (e.remainingPayable ?? e.netPay), 0)
            : payMode === 'SELECTED'
              ? payableEntries
                    .filter((e) => paySelectedIds.includes(e.employeeId))
                    .reduce((s, e) => s + (e.remainingPayable ?? e.netPay), 0)
              : paySelectedIds.reduce((s, id) => s + Number(payPartialAmounts[id] || 0), 0);

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                    <h2 className="text-lg font-semibold text-gray-900">Payroll</h2>
                    <p className="text-sm text-gray-500">Process ? Post accrual ? Pay from petty cash / bank / MoMo</p>
                </div>
                <div className="flex gap-2 items-start flex-wrap">
                    {selectedPeriod && (
                        <ExportButtons
                            pdfPath={`/hr/payroll-periods/${selectedPeriod.id}/export?format=pdf`}
                            csvPath={`/hr/payroll-periods/${selectedPeriod.id}/export?format=csv`}
                            pdfName={`payroll-${selectedPeriod.startDate}_${selectedPeriod.endDate}.pdf`}
                            csvName={`payroll-${selectedPeriod.startDate}_${selectedPeriod.endDate}.csv`}
                            disabled={entries.length === 0}
                        />
                    )}
                    <button onClick={() => setShowCreateForm(true)} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">
                        + New Period
                    </button>
                </div>
            </div>

            {showCreateForm && (
                <div className="bg-white rounded-xl border p-4 shadow-sm">
                    <h3 className="text-sm font-semibold text-gray-700 mb-3">Create Payroll Period</h3>
                    <div className="flex gap-3 items-end flex-wrap">
                        <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">Start Date</label>
                            <DatePicker value={periodForm.startDate} onChange={(v) => setPeriodForm((f) => ({ ...f, startDate: v }))} placeholder="Start date" />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">End Date</label>
                            <DatePicker value={periodForm.endDate} onChange={(v) => setPeriodForm((f) => ({ ...f, endDate: v }))} placeholder="End date" />
                        </div>
                        <button onClick={() => createPeriodMut.mutate()} disabled={!periodForm.startDate || !periodForm.endDate || createPeriodMut.isPending} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                            {createPeriodMut.isPending ? 'Creating...' : 'Create'}
                        </button>
                        <button onClick={() => setShowCreateForm(false)} className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">Cancel</button>
                    </div>
                    {createPeriodMut.isError && (
                        <p className="mt-2 text-sm text-red-600">{(createPeriodMut.error as Error)?.message || 'Failed to create period'}</p>
                    )}
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="lg:col-span-1 bg-white rounded-xl border shadow-sm overflow-hidden">
                    <div className="px-4 py-3 bg-gray-50 border-b">
                        <span className="text-sm font-medium text-gray-700">Payroll Periods</span>
                    </div>
                    {isLoading ? (
                        <div className="p-6 text-center text-gray-400 text-sm">Loading...</div>
                    ) : periods.length === 0 ? (
                        <div className="p-6 text-center text-gray-400 text-sm">No periods created</div>
                    ) : (
                        <div className="divide-y divide-gray-100">
                            {periods.map((p) => (
                                <button
                                    key={p.id}
                                    onClick={() => {
                                        setSelectedPeriodId(p.id);
                                        setShowPayForm(false);
                                    }}
                                    className={`w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors ${selectedPeriodId === p.id ? 'bg-indigo-50 border-l-2 border-indigo-600' : ''}`}
                                >
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm font-medium text-gray-900">{p.startDate} - {p.endDate}</span>
                                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge(p.status)}`}>{p.status}</span>
                                    </div>
                                    <div className="flex items-center justify-between mt-1">
                                        <span className="text-xs text-gray-500">{p.entryCount} employees</span>
                                        <span className="text-xs font-medium text-gray-700">{fmtCurrency(p.totalNetPay)}</span>
                                    </div>
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                <div className="lg:col-span-2">
                    {!selectedPeriod ? (
                        <div className="bg-white rounded-xl border shadow-sm p-12 text-center text-gray-400">Select a payroll period to view details</div>
                    ) : (
                        <div className="space-y-4">
                            {(() => {
                                const entryGross = (e: PayrollEntry) =>
                                    e.basicSalary +
                                    e.allowances +
                                    (e.overtimePay ?? 0) +
                                    (e.bonus ?? 0) -
                                    (e.leaveDeduction ?? 0);
                                const totalBasic = entries.reduce((s, e) => s + e.basicSalary, 0);
                                const totalAllow = entries.reduce((s, e) => s + e.allowances, 0);
                                const totalGross = entries.reduce((s, e) => s + entryGross(e), 0);
                                const totalRecovered = entries.reduce((s, e) => s + e.advanceRecovered, 0);
                                const totalNssf = entries.reduce((s, e) => s + (e.nssfEmployee ?? 0), 0);
                                const totalPaye = entries.reduce((s, e) => s + (e.paye ?? 0), 0);
                                const totalNet = entries.reduce((s, e) => s + e.netPay, 0);
                                const staffWithRecovery = entries.filter((e) => e.advanceRecovered > 0).length;

                                return (
                            <>
                            <div className="bg-white rounded-xl border shadow-sm p-4">
                                <div className="flex items-start justify-between gap-3 flex-wrap">
                                    <div>
                                        <h3 className="text-base font-semibold text-gray-900">
                                            Period: {selectedPeriod.startDate} to {selectedPeriod.endDate}
                                        </h3>
                                        <div className="flex items-center gap-3 mt-1 flex-wrap">
                                            <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge(selectedPeriod.status)}`}>{selectedPeriod.status}</span>
                                            <span className="text-sm text-gray-500">{selectedPeriod.entryCount} entries</span>
                                        </div>
                                    </div>
                                    <div className="flex gap-2 flex-wrap">
                                        {(selectedPeriod.status === 'OPEN' || selectedPeriod.status === 'PROCESSED') && (
                                            <button onClick={() => processMut.mutate()} disabled={processMut.isPending} className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50">
                                                {processMut.isPending ? 'Processing...' : selectedPeriod.status === 'PROCESSED' ? 'Re-process' : 'Process'}
                                            </button>
                                        )}
                                        {selectedPeriod.status === 'PROCESSED' && (
                                            <button
                                                onClick={() => {
                                                    if (
                                                        confirm(
                                                            totalRecovered > 0
                                                                ? `Post accrual to GL?\n\nGross ${fmtCurrency(totalGross)}\nAdvances auto-deducted ${fmtCurrency(totalRecovered)}\nNet payable ${fmtCurrency(totalNet)}\n\nIrreversible.`
                                                                : `Post accrual to GL?\n\nGross = net ${fmtCurrency(totalNet)} (no advances to deduct).\n\nIrreversible.`
                                                        )
                                                    ) {
                                                        postMut.mutate();
                                                    }
                                                }}
                                                disabled={postMut.isPending}
                                                className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
                                            >
                                                {postMut.isPending ? 'Posting...' : 'Post accrual'}
                                            </button>
                                        )}
                                        {canPay && (
                                            <button onClick={() => setShowPayForm(true)} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">
                                                Pay salaries
                                            </button>
                                        )}
                                        {selectedPeriod.status !== 'POSTED' &&
                                            selectedPeriod.status !== 'PARTIALLY_PAID' &&
                                            selectedPeriod.status !== 'PAID' && (
                                            <button
                                                onClick={() => {
                                                    if (confirm('Delete this payroll period and all entries?')) deletePeriodMut.mutate(selectedPeriod.id);
                                                }}
                                                disabled={deletePeriodMut.isPending}
                                                className="px-4 py-2 border border-red-300 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50 disabled:opacity-50"
                                            >
                                                Delete
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {entries.length > 0 && (
                                    <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
                                        <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                                            <div className="text-[11px] uppercase tracking-wide text-gray-500">Gross salary</div>
                                            <div className="text-lg font-semibold text-gray-900">{fmtCurrency(totalGross)}</div>
                                            <div className="text-[11px] text-gray-500">Basic + allowances</div>
                                        </div>
                                        <div className={`rounded-lg border px-3 py-2 ${totalRecovered > 0 ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-gray-50'}`}>
                                            <div className="text-[11px] uppercase tracking-wide text-gray-500">Advances auto-deducted</div>
                                            <div className={`text-lg font-semibold ${totalRecovered > 0 ? 'text-amber-900' : 'text-gray-900'}`}>
                                                - {fmtCurrency(totalRecovered)}
                                            </div>
                                            <div className="text-[11px] text-gray-500">
                                                {totalRecovered > 0
                                                    ? `${staffWithRecovery} staff ? already taken off cash pay`
                                                    : 'None on this run (record on Advances before Process)'}
                                            </div>
                                        </div>
                                        <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2">
                                            <div className="text-[11px] uppercase tracking-wide text-emerald-800">Cash to pay employees</div>
                                            <div className="text-lg font-semibold text-emerald-900">{fmtCurrency(totalNet)}</div>
                                            <div className="text-[11px] text-emerald-800">Gross - advances = net</div>
                                        </div>
                                    </div>
                                )}

                                <div className="mt-4 flex items-center gap-2 flex-wrap">
                                    {workflow.map((step, i) => (
                                        <div key={step} className="flex items-center gap-2">
                                            {i > 0 && <div className="w-6 h-px bg-gray-300" />}
                                            <div
                                                className={`px-3 py-1 rounded-full text-xs font-medium ${
                                                    step === selectedPeriod.status
                                                        ? 'bg-indigo-100 text-indigo-700 ring-2 ring-indigo-300'
                                                        : workflow.indexOf(step) < workflow.indexOf(selectedPeriod.status)
                                                          ? 'bg-green-100 text-green-700'
                                                          : 'bg-gray-100 text-gray-400'
                                                }`}
                                            >
                                                {step}
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                {showPayForm && (
                                    <div className="mt-4 p-4 rounded-lg border border-green-300 bg-green-50 space-y-3">
                                        <div>
                                            <p className="text-sm text-green-950 font-semibold">Pay cash salaries (advances already deducted)</p>
                                            <p className="text-xs text-green-900 mt-1">
                                                Pay whole remaining period, selected employees, or a partial amount per person. Residual stays on 2400 until fully paid.
                                            </p>
                                        </div>
                                        <div className="flex flex-wrap gap-2 text-xs">
                                            {(['ALL', 'SELECTED', 'PARTIAL'] as const).map((m) => (
                                                <button
                                                    key={m}
                                                    type="button"
                                                    onClick={() => {
                                                        setPayMode(m);
                                                        if (m === 'ALL') setPaySelectedIds([]);
                                                    }}
                                                    className={`px-3 py-1.5 rounded-lg border font-medium ${
                                                        payMode === m
                                                            ? 'bg-green-700 text-white border-green-800'
                                                            : 'bg-white text-gray-700 border-gray-300'
                                                    }`}
                                                >
                                                    {m === 'ALL' ? 'All remaining' : m === 'SELECTED' ? 'Selected staff' : 'Partial amounts'}
                                                </button>
                                            ))}
                                        </div>
                                        {(payMode === 'SELECTED' || payMode === 'PARTIAL') && (
                                            <div className="max-h-48 overflow-y-auto rounded-md border border-green-200 bg-white divide-y">
                                                {payableEntries.length === 0 ? (
                                                    <p className="p-3 text-xs text-gray-500">No remaining payable</p>
                                                ) : (
                                                    payableEntries.map((e) => {
                                                        const rem = e.remainingPayable ?? e.netPay;
                                                        const checked = paySelectedIds.includes(e.employeeId);
                                                        return (
                                                            <label key={e.id} className="flex items-center gap-2 px-3 py-2 text-xs cursor-pointer hover:bg-gray-50">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={checked}
                                                                    onChange={(ev) => {
                                                                        setPaySelectedIds((ids) =>
                                                                            ev.target.checked
                                                                                ? [...ids, e.employeeId]
                                                                                : ids.filter((id) => id !== e.employeeId)
                                                                        );
                                                                        if (ev.target.checked && payMode === 'PARTIAL') {
                                                                            setPayPartialAmounts((m) => ({
                                                                                ...m,
                                                                                [e.employeeId]: m[e.employeeId] || String(rem),
                                                                            }));
                                                                        }
                                                                    }}
                                                                />
                                                                <span className="flex-1 font-medium text-gray-800">
                                                                    {e.employeeFirstName} {e.employeeLastName}
                                                                </span>
                                                                <span className="text-gray-500">remain {fmtCurrency(rem)}</span>
                                                                {payMode === 'PARTIAL' && checked && (
                                                                    <input
                                                                        type="number"
                                                                        min={0.01}
                                                                        max={rem}
                                                                        step="1"
                                                                        value={payPartialAmounts[e.employeeId] ?? ''}
                                                                        onChange={(ev) =>
                                                                            setPayPartialAmounts((m) => ({
                                                                                ...m,
                                                                                [e.employeeId]: ev.target.value,
                                                                            }))
                                                                        }
                                                                        className="w-24 border border-gray-300 rounded px-2 py-1"
                                                                        placeholder="Amount"
                                                                    />
                                                                )}
                                                            </label>
                                                        );
                                                    })
                                                )}
                                            </div>
                                        )}
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
                                            <div className="rounded-md bg-white/80 border border-green-200 px-3 py-2">
                                                <div className="text-[11px] text-gray-500">Period net</div>
                                                <div className="font-semibold">{fmtCurrency(totalNet)}</div>
                                            </div>
                                            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2">
                                                <div className="text-[11px] text-amber-900">Still unpaid (all)</div>
                                                <div className="font-semibold text-amber-950">
                                                    {fmtCurrency(
                                                        payableEntries.reduce((s, e) => s + (e.remainingPayable ?? e.netPay), 0)
                                                    )}
                                                </div>
                                            </div>
                                            <div className="rounded-md bg-emerald-100 border border-emerald-300 px-3 py-2">
                                                <div className="text-[11px] text-emerald-900">This run</div>
                                                <div className="font-semibold text-emerald-950">{fmtCurrency(payRunTotal)}</div>
                                            </div>
                                        </div>
                                        <div className="flex gap-3 items-end flex-wrap">
                                            <div className="min-w-[220px] flex-1">
                                                <label className="block text-xs font-medium text-gray-600 mb-1">Pay from</label>
                                                <select value={payAccountCode} onChange={(e) => setPayAccountCode(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
                                                    {paymentAccounts.map((a) => (
                                                        <option key={a.id} value={a.code}>
                                                            {a.code} - {a.name} ({fmtCurrency(a.balance)})
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                            <button
                                                onClick={() => {
                                                    const msg =
                                                        `Confirm salary payment (${payMode})?\n\n` +
                                                        `Cash this run: ${fmtCurrency(payRunTotal)}\n` +
                                                        `From account ${payAccountCode}.`;
                                                    if (confirm(msg)) payMut.mutate();
                                                }}
                                                disabled={
                                                    payMut.isPending ||
                                                    !payAccountCode ||
                                                    payRunTotal <= 0 ||
                                                    ((payMode === 'SELECTED' || payMode === 'PARTIAL') &&
                                                        paySelectedIds.length === 0)
                                                }
                                                className="px-4 py-2 bg-green-700 text-white rounded-lg text-sm font-medium hover:bg-green-800 disabled:opacity-50"
                                            >
                                                {payMut.isPending ? 'Paying...' : `Confirm pay ${fmtCurrency(payRunTotal)}`}
                                            </button>
                                            <button onClick={() => setShowPayForm(false)} className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-white">
                                                Cancel
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {(processMut.isError || postMut.isError || payMut.isError) && (
                                    <p className="mt-3 text-sm text-red-600">{((processMut.error || postMut.error || payMut.error) as Error)?.message || 'Operation failed'}</p>
                                )}
                            </div>

                            {(selectedPeriod.status === 'OPEN' || selectedPeriod.status === 'PROCESSED') && (
                                <div className="bg-white rounded-xl border p-4 space-y-2">
                                    <div className="text-sm font-medium text-gray-800">Period OT / bonus (before Process)</div>
                                    <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                                        <select
                                            value={adjForm.employeeId}
                                            onChange={(e) => setAdjForm((f) => ({ ...f, employeeId: e.target.value }))}
                                            className="border rounded-lg px-3 py-2 text-sm"
                                        >
                                            <option value="">Employee?</option>
                                            {adjEmployees.map((e) => (
                                                <option key={e.id} value={e.id}>
                                                    {e.firstName} {e.lastName}
                                                </option>
                                            ))}
                                        </select>
                                        <input
                                            type="number"
                                            placeholder="Overtime"
                                            value={adjForm.overtimePay}
                                            onChange={(e) => setAdjForm((f) => ({ ...f, overtimePay: e.target.value }))}
                                            className="border rounded-lg px-3 py-2 text-sm"
                                        />
                                        <input
                                            type="number"
                                            placeholder="Bonus"
                                            value={adjForm.bonus}
                                            onChange={(e) => setAdjForm((f) => ({ ...f, bonus: e.target.value }))}
                                            className="border rounded-lg px-3 py-2 text-sm"
                                        />
                                        <button
                                            onClick={() => adjMut.mutate()}
                                            disabled={!adjForm.employeeId || adjMut.isPending}
                                            className="px-3 py-2 bg-slate-800 text-white rounded-lg text-sm disabled:opacity-50"
                                        >
                                            Save OT/bonus
                                        </button>
                                    </div>
                                </div>
                            )}

                            {entries.length > 0 && (
                                <div className="bg-white rounded-xl border shadow-sm overflow-hidden overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead className="bg-gray-50 text-gray-600">
                                            <tr>
                                                <th className="text-left px-4 py-3 font-medium">Employee</th>
                                                <th className="text-right px-4 py-3 font-medium">Basic</th>
                                                <th className="text-right px-4 py-3 font-medium">Allow</th>
                                                <th className="text-right px-4 py-3 font-medium">OT/Bonus</th>
                                                <th className="text-right px-4 py-3 font-medium">Gross</th>
                                                <th className="text-right px-4 py-3 font-medium">NSSF</th>
                                                <th className="text-right px-4 py-3 font-medium">PAYE</th>
                                                <th className="text-right px-4 py-3 font-medium">Advance</th>
                                                <th className="text-right px-4 py-3 font-medium">Cash (net)</th>
                                                <th className="text-center px-4 py-3 font-medium">JE</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-100">
                                            {entries.map((entry) => {
                                                const gross = entryGross(entry);
                                                const hasAdv = entry.advanceRecovered > 0;
                                                return (
                                                <tr key={entry.id} className="hover:bg-gray-50">
                                                    <td className="px-4 py-3 font-medium text-gray-900">
                                                        {entry.employeeFirstName} {entry.employeeLastName}
                                                        {(entry.unpaidLeaveDays ?? 0) > 0 && (
                                                            <div className="text-[10px] text-amber-700">
                                                                Unpaid leave {entry.unpaidLeaveDays}d (-{fmtCurrency(entry.leaveDeduction ?? 0)})
                                                            </div>
                                                        )}
                                                    </td>
                                                    <td className="px-4 py-3 text-right text-gray-700">{fmtCurrency(entry.basicSalary)}</td>
                                                    <td className="px-4 py-3 text-right text-gray-700">{fmtCurrency(entry.allowances)}</td>
                                                    <td className="px-4 py-3 text-right text-gray-700">
                                                        {fmtCurrency((entry.overtimePay ?? 0) + (entry.bonus ?? 0))}
                                                    </td>
                                                    <td className="px-4 py-3 text-right text-gray-800">{fmtCurrency(gross)}</td>
                                                    <td className="px-4 py-3 text-right text-gray-600">{fmtCurrency(entry.nssfEmployee ?? 0)}</td>
                                                    <td className="px-4 py-3 text-right text-gray-600">{fmtCurrency(entry.paye ?? 0)}</td>
                                                    <td className={`px-4 py-3 text-right font-medium ${hasAdv ? 'text-amber-800 bg-amber-50/50' : 'text-gray-500'}`}>
                                                        {hasAdv ? `- ${fmtCurrency(entry.advanceRecovered)}` : fmtCurrency(0)}
                                                    </td>
                                                    <td className="px-4 py-3 text-right font-semibold text-emerald-900">{fmtCurrency(entry.netPay)}</td>
                                                    <td className="px-4 py-3 text-center text-xs text-green-700">
                                                        {entry.paymentTransactionNumber || entry.journalTransactionNumber || '-'}
                                                    </td>
                                                </tr>
                                                );
                                            })}
                                        </tbody>
                                        <tfoot className="bg-gray-50">
                                            <tr>
                                                <td className="px-4 py-3 text-sm font-semibold text-gray-700">Totals</td>
                                                <td className="px-4 py-3 text-right text-sm font-semibold">{fmtCurrency(totalBasic)}</td>
                                                <td className="px-4 py-3 text-right text-sm font-semibold">{fmtCurrency(totalAllow)}</td>
                                                <td />
                                                <td className="px-4 py-3 text-right text-sm font-semibold">{fmtCurrency(totalGross)}</td>
                                                <td className="px-4 py-3 text-right text-sm font-semibold">{fmtCurrency(totalNssf)}</td>
                                                <td className="px-4 py-3 text-right text-sm font-semibold">{fmtCurrency(totalPaye)}</td>
                                                <td className="px-4 py-3 text-right text-sm font-semibold text-amber-900">- {fmtCurrency(totalRecovered)}</td>
                                                <td className="px-4 py-3 text-right text-sm font-semibold text-emerald-900">{fmtCurrency(totalNet)}</td>
                                                <td />
                                            </tr>
                                        </tfoot>
                                    </table>
                                </div>
                            )}
                            </>
                                );
                            })()}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function AdvancesTab() {
    const qc = useQueryClient();
    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState({
        employeeId: '',
        amount: '',
        reason: 'SALARY_ADVANCE',
        paymentAccountCode: '',
        notes: '',
    });

    const { data: advances = [], isLoading } = useQuery({
        queryKey: ['hr', 'advances'],
        queryFn: () => hrApi.getAdvances(),
        select: (res) => (res.data?.data ?? []) as EmployeeAdvance[],
    });

    const { data: employees = [] } = useQuery({
        queryKey: ['hr', 'employees', 'active-all'],
        queryFn: () => hrApi.getEmployees(buildHrActiveEmployeePickerParams({ limit: HR_EMPLOYEE_LIST_PAGE_LIMIT })),
        select: (res) => ((res.data as { data?: Employee[] } | undefined)?.data ?? []) as Employee[],
    });

    const { data: paymentAccounts = [] } = useQuery({
        queryKey: ['hr', 'payment-accounts'],
        queryFn: () => hrApi.getPaymentAccounts(),
        select: (res) => (res.data?.data ?? []) as PaymentAccount[],
    });

    useEffect(() => {
        if (paymentAccounts.length === 0) return;
        if (paymentAccounts.some((a) => a.code === form.paymentAccountCode)) return;
        try {
            setForm((f) => ({ ...f, paymentAccountCode: pickHrDisbursementAccount(paymentAccounts) }));
        } catch {
            setForm((f) => ({ ...f, paymentAccountCode: paymentAccounts[0]?.code ?? '' }));
        }
    }, [paymentAccounts, form.paymentAccountCode]);

    const createMut = useMutation({
        mutationFn: () =>
            hrApi.createAdvance({
                employeeId: form.employeeId,
                amount: parseFloat(form.amount),
                reason: form.reason,
                paymentAccountCode: form.reason === 'CASH_SHORTAGE' ? '1010' : form.paymentAccountCode,
                notes: form.notes || null,
            }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['hr', 'advances'] });
            qc.invalidateQueries({ queryKey: ['hr', 'employee-balances'] });
            setShowForm(false);
            setForm({ employeeId: '', amount: '', reason: 'SALARY_ADVANCE', paymentAccountCode: '', notes: '' });
        },
    });

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                    <h2 className="text-lg font-semibold text-gray-900">Advances &amp; shortages</h2>
                    <p className="text-sm text-gray-500">
                        DR Employee Advances (1410) / CR petty cash, bank, or MoMo. Not cash drawer 1010.
                        Recovery is calculated on <span className="font-medium">Process</span> and applied to GL on{' '}
                        <span className="font-medium">Post</span> (net salary = gross - recovered).
                        Daily transport via Expenses is not an advance and will not reduce net pay.
                    </p>
                </div>
                <div className="flex gap-2 items-start flex-wrap">
                    <ExportButtons
                        pdfPath="/hr/advances/export?format=pdf"
                        csvPath="/hr/advances/export?format=csv"
                        pdfName="staff-advances.pdf"
                        csvName="staff-advances.csv"
                        disabled={advances.length === 0}
                    />
                    <button onClick={() => setShowForm(true)} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">
                        + Record advance
                    </button>
                </div>
            </div>

            {showForm && (
                <div className="bg-white rounded-xl border p-4 shadow-sm space-y-3">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">Employee</label>
                            <select value={form.employeeId} onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                                <option value="">Select...</option>
                                {employees.map((e) => (
                                    <option key={e.id} value={e.id}>
                                        {e.firstName} {e.lastName}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">Reason</label>
                            <select value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                                <option value="SALARY_ADVANCE">Salary advance (cash out)</option>
                                <option value="CASH_SHORTAGE">Cash shortage (charge till to employee)</option>
                                <option value="OTHER">Other (cash out)</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">Amount</label>
                            <input type="number" min="1" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                        </div>
                        {form.reason === 'CASH_SHORTAGE' ? (
                            <div className="md:col-span-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                                Charges till shortfall to the employee: DR Employee Advances (1410) / CR Cash Drawer (1010).
                                Does not take extra cash from petty cash or bank.
                            </div>
                        ) : (
                            <div>
                                <label className="block text-xs font-medium text-gray-600 mb-1">Pay from (petty cash / bank / MoMo)</label>
                                <select value={form.paymentAccountCode} onChange={(e) => setForm((f) => ({ ...f, paymentAccountCode: e.target.value }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                                    {paymentAccounts.map((a) => (
                                        <option key={a.id} value={a.code}>
                                            {a.code} - {a.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}
                        <div className="md:col-span-2">
                            <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
                            <input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" placeholder="Optional" />
                        </div>
                    </div>
                    <div className="flex gap-2">
                        <button onClick={() => createMut.mutate()} disabled={!form.employeeId || !form.amount || createMut.isPending} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                            {createMut.isPending ? 'Saving...' : 'Post to GL'}
                        </button>
                        <button onClick={() => setShowForm(false)} className="px-4 py-2 border border-gray-300 rounded-lg text-sm">
                            Cancel
                        </button>
                    </div>
                    {createMut.isError && <p className="text-sm text-red-600">{(createMut.error as Error)?.message}</p>}
                </div>
            )}

            <div className="bg-white rounded-xl border shadow-sm overflow-hidden overflow-x-auto">
                {isLoading ? (
                    <div className="p-8 text-center text-gray-500">Loading...</div>
                ) : advances.length === 0 ? (
                    <div className="p-8 text-center text-gray-400">No advances yet</div>
                ) : (
                    <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-gray-600">
                            <tr>
                                <th className="text-left px-4 py-3 font-medium">Date</th>
                                <th className="text-left px-4 py-3 font-medium">Employee</th>
                                <th className="text-left px-4 py-3 font-medium">Reason</th>
                                <th className="text-right px-4 py-3 font-medium">Amount</th>
                                <th className="text-right px-4 py-3 font-medium">Remaining</th>
                                <th className="text-left px-4 py-3 font-medium">Status</th>
                                <th className="text-left px-4 py-3 font-medium">JE</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {advances.map((a) => (
                                <tr key={a.id} className="hover:bg-gray-50">
                                    <td className="px-4 py-3 text-gray-600">{a.advanceDate}</td>
                                    <td className="px-4 py-3 font-medium text-gray-900">
                                        {a.employeeFirstName} {a.employeeLastName}
                                    </td>
                                    <td className="px-4 py-3 text-gray-600">{a.reason.replace(/_/g, ' ')}</td>
                                    <td className="px-4 py-3 text-right">{fmtCurrency(a.amount)}</td>
                                    <td className="px-4 py-3 text-right font-medium">{fmtCurrency(a.remainingAmount)}</td>
                                    <td className="px-4 py-3">
                                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge(a.status)}`}>{a.status}</span>
                                    </td>
                                    <td className="px-4 py-3 text-xs text-green-700">{a.journalTransactionNumber || '-'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}

function BalancesTab() {
    const { data: balances = [], isLoading } = useQuery({
        queryKey: ['hr', 'employee-balances'],
        queryFn: () => hrApi.getEmployeeBalances(),
        select: (res) => (res.data?.data ?? []) as EmployeeBalance[],
    });

    const totalPayable = balances.reduce((s, b) => s + b.salariesPayable, 0);
    const totalAdvancesGl = balances.reduce((s, b) => s + b.advancesOutstanding, 0);
    const totalAdvancesReg = balances.reduce((s, b) => s + (b.registerAdvancesOutstanding ?? 0), 0);
    const driftCount = balances.filter((b) => b.advanceSsotDrift).length;

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                    <h2 className="text-lg font-semibold text-gray-900">Employee ledger balances</h2>
                    <p className="text-sm text-gray-500">
                        Salaries Payable (2400) from GL. Advances: register (Process SSOT) must match GL 1410 ? drift blocks Process.
                    </p>
                </div>
                <ExportButtons
                    pdfPath="/hr/employee-balances/export?format=pdf"
                    csvPath="/hr/employee-balances/export?format=csv"
                    pdfName="staff-balances.pdf"
                    csvName="staff-balances.csv"
                    disabled={balances.length === 0}
                />
            </div>
            {driftCount > 0 && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    {driftCount} employee(s) have advance register ? GL. Record salary advances on the Advances tab
                    (not Expenses) or heal the register before Process ? otherwise net pay will ignore the asset.
                </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="bg-white rounded-xl border p-4">
                    <div className="text-xs text-gray-500 uppercase tracking-wide">Salaries payable (liability)</div>
                    <div className="text-xl font-semibold text-gray-900 mt-1">{fmtCurrency(totalPayable)}</div>
                </div>
                <div className="bg-white rounded-xl border p-4">
                    <div className="text-xs text-gray-500 uppercase tracking-wide">Advances GL (1410)</div>
                    <div className="text-xl font-semibold text-gray-900 mt-1">{fmtCurrency(totalAdvancesGl)}</div>
                </div>
                <div className="bg-white rounded-xl border p-4">
                    <div className="text-xs text-gray-500 uppercase tracking-wide">Advances register (recoverable)</div>
                    <div className="text-xl font-semibold text-gray-900 mt-1">{fmtCurrency(totalAdvancesReg)}</div>
                </div>
            </div>
            <div className="bg-white rounded-xl border shadow-sm overflow-hidden overflow-x-auto">
                {isLoading ? (
                    <div className="p-8 text-center text-gray-500">Loading...</div>
                ) : (
                    <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-gray-600">
                            <tr>
                                <th className="text-left px-4 py-3 font-medium">Employee</th>
                                <th className="text-left px-4 py-3 font-medium">Payable acct</th>
                                <th className="text-right px-4 py-3 font-medium">Salaries payable</th>
                                <th className="text-left px-4 py-3 font-medium">Advance acct</th>
                                <th className="text-right px-4 py-3 font-medium">Advances GL</th>
                                <th className="text-right px-4 py-3 font-medium">Register</th>
                                <th className="text-center px-4 py-3 font-medium">Drift</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {balances.map((b) => (
                                <tr key={b.employeeId} className="hover:bg-gray-50">
                                    <td className="px-4 py-3 font-medium text-gray-900">
                                        {b.firstName} {b.lastName}
                                    </td>
                                    <td className="px-4 py-3 text-xs text-gray-500">{b.payableAccountCode || '-'}</td>
                                    <td className="px-4 py-3 text-right">{fmtCurrency(b.salariesPayable)}</td>
                                    <td className="px-4 py-3 text-xs text-gray-500">{b.advanceAccountCode || '-'}</td>
                                    <td className="px-4 py-3 text-right font-medium">{fmtCurrency(b.advancesOutstanding)}</td>
                                    <td className="px-4 py-3 text-right font-medium">{fmtCurrency(b.registerAdvancesOutstanding ?? 0)}</td>
                                    <td className="px-4 py-3 text-center">
                                        {b.advanceSsotDrift ? (
                                            <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">DRIFT</span>
                                        ) : (
                                            <span className="text-xs text-gray-400">?</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}

function LeaveTab() {
    const qc = useQueryClient();
    const [form, setForm] = useState({
        employeeId: '',
        leaveTypeId: '',
        startDate: '',
        endDate: '',
        notes: '',
    });

    const { data: types = [] } = useQuery({
        queryKey: ['hr', 'leave-types'],
        queryFn: () => hrApi.getLeaveTypes(),
        select: (res) => (res.data?.data ?? []) as Array<{ id: string; name: string; isPaid: boolean }>,
    });
    const { data: employees = [] } = useQuery({
        queryKey: ['hr', 'employees', 'leave-picker'],
        queryFn: () => hrApi.getEmployees(buildHrActiveEmployeePickerParams()),
        select: (res) => {
            const payload = res.data?.data as { data?: Employee[] } | Employee[] | undefined;
            if (Array.isArray(payload)) return payload;
            return (payload?.data ?? []) as Employee[];
        },
    });
    const { data: requests = [], isLoading } = useQuery({
        queryKey: ['hr', 'leave-requests'],
        queryFn: () => hrApi.getLeaveRequests(),
        select: (res) =>
            (res.data?.data ?? []) as Array<{
                id: string;
                employeeFirstName?: string;
                employeeLastName?: string;
                leaveTypeName?: string;
                leaveIsPaid?: boolean;
                startDate: string;
                endDate: string;
                days: number;
                status: string;
            }>,
    });

    const createMut = useMutation({
        mutationFn: () => hrApi.createLeaveRequest(form),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['hr', 'leave-requests'] });
            setForm({ employeeId: '', leaveTypeId: '', startDate: '', endDate: '', notes: '' });
        },
    });
    const statusMut = useMutation({
        mutationFn: ({ id, status }: { id: string; status: string }) => hrApi.setLeaveStatus(id, status),
        onSuccess: () => qc.invalidateQueries({ queryKey: ['hr', 'leave-requests'] }),
    });

    return (
        <div className="space-y-4">
            <div>
                <h2 className="text-lg font-semibold text-gray-900">Leave</h2>
                <p className="text-sm text-gray-500">
                    Approved unpaid leave overlapping a payroll period reduces basic pay on Process (prorata).
                </p>
            </div>
            <div className="bg-white rounded-xl border p-4 grid grid-cols-1 md:grid-cols-5 gap-3">
                <select
                    value={form.employeeId}
                    onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))}
                    className="border rounded-lg px-3 py-2 text-sm"
                >
                    <option value="">Employee?</option>
                    {employees.map((e) => (
                        <option key={e.id} value={e.id}>
                            {e.firstName} {e.lastName}
                        </option>
                    ))}
                </select>
                <select
                    value={form.leaveTypeId}
                    onChange={(e) => setForm((f) => ({ ...f, leaveTypeId: e.target.value }))}
                    className="border rounded-lg px-3 py-2 text-sm"
                >
                    <option value="">Leave type?</option>
                    {types.map((t) => (
                        <option key={t.id} value={t.id}>
                            {t.name} ({t.isPaid ? 'paid' : 'unpaid'})
                        </option>
                    ))}
                </select>
                <DatePicker value={form.startDate} onChange={(v) => setForm((f) => ({ ...f, startDate: v }))} />
                <DatePicker value={form.endDate} onChange={(v) => setForm((f) => ({ ...f, endDate: v }))} />
                <button
                    onClick={() => createMut.mutate()}
                    disabled={!form.employeeId || !form.leaveTypeId || !form.startDate || !form.endDate || createMut.isPending}
                    className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
                >
                    Request leave
                </button>
            </div>
            <div className="bg-white rounded-xl border overflow-hidden">
                {isLoading ? (
                    <div className="p-8 text-center text-gray-500">Loading?</div>
                ) : (
                    <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-gray-600">
                            <tr>
                                <th className="text-left px-4 py-3">Employee</th>
                                <th className="text-left px-4 py-3">Type</th>
                                <th className="text-left px-4 py-3">Dates</th>
                                <th className="text-right px-4 py-3">Days</th>
                                <th className="text-left px-4 py-3">Status</th>
                                <th className="text-right px-4 py-3">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y">
                            {requests.map((r) => (
                                <tr key={r.id}>
                                    <td className="px-4 py-3">
                                        {r.employeeFirstName} {r.employeeLastName}
                                    </td>
                                    <td className="px-4 py-3">
                                        {r.leaveTypeName}
                                        {r.leaveIsPaid === false && (
                                            <span className="ml-1 text-[10px] text-amber-700">unpaid</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-xs text-gray-600">
                                        {r.startDate} ? {r.endDate}
                                    </td>
                                    <td className="px-4 py-3 text-right">{r.days}</td>
                                    <td className="px-4 py-3">{r.status}</td>
                                    <td className="px-4 py-3 text-right space-x-2">
                                        {r.status === 'PENDING' && (
                                            <>
                                                <button
                                                    className="text-green-700 text-xs font-medium"
                                                    onClick={() => statusMut.mutate({ id: r.id, status: 'APPROVED' })}
                                                >
                                                    Approve
                                                </button>
                                                <button
                                                    className="text-red-600 text-xs font-medium"
                                                    onClick={() => statusMut.mutate({ id: r.id, status: 'REJECTED' })}
                                                >
                                                    Reject
                                                </button>
                                            </>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}

function StatutoryTab() {
    const qc = useQueryClient();
    const { data: settings, isLoading } = useQuery({
        queryKey: ['hr', 'statutory'],
        queryFn: () => hrApi.getStatutorySettings(),
        select: (res) =>
            res.data?.data as {
                enabled: boolean;
                nssfEmployeeRate: number;
                nssfEmployerRate: number;
                payeEnabled: boolean;
                workingDaysPerMonth: number;
            },
    });
    const [form, setForm] = useState({
        enabled: true,
        nssfEmployeeRate: 5,
        nssfEmployerRate: 10,
        payeEnabled: true,
        workingDaysPerMonth: 26,
    });

    useEffect(() => {
        if (!settings) return;
        setForm({
            enabled: settings.enabled,
            nssfEmployeeRate: Math.round(settings.nssfEmployeeRate * 10000) / 100,
            nssfEmployerRate: Math.round(settings.nssfEmployerRate * 10000) / 100,
            payeEnabled: settings.payeEnabled,
            workingDaysPerMonth: settings.workingDaysPerMonth,
        });
    }, [settings]);

    const saveMut = useMutation({
        mutationFn: () =>
            hrApi.updateStatutorySettings({
                enabled: form.enabled,
                nssfEmployeeRate: form.nssfEmployeeRate / 100,
                nssfEmployerRate: form.nssfEmployerRate / 100,
                payeEnabled: form.payeEnabled,
                workingDaysPerMonth: form.workingDaysPerMonth,
            }),
        onSuccess: () => qc.invalidateQueries({ queryKey: ['hr', 'statutory'] }),
    });

    if (isLoading || !settings) {
        return <div className="p-8 text-center text-gray-500">Loading statutory settings?</div>;
    }

    return (
        <div className="space-y-4 max-w-xl">
            <div>
                <h2 className="text-lg font-semibold text-gray-900">NSSF / PAYE</h2>
                <p className="text-sm text-gray-500">
                    Uganda defaults (5% / 10% NSSF + progressive PAYE). Applied on Process; liabilities 2410 / 2420 on Post.
                    Turn off to keep legacy gross - advance = net.
                </p>
            </div>
            <div className="bg-white rounded-xl border p-4 space-y-3">
                <label className="flex items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={form.enabled}
                        onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                    />
                    Enable statutory deductions
                </label>
                <label className="flex items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={form.payeEnabled}
                        onChange={(e) => setForm((f) => ({ ...f, payeEnabled: e.target.checked }))}
                    />
                    Enable PAYE
                </label>
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label className="text-xs text-gray-600">NSSF employee %</label>
                        <input
                            type="number"
                            className="w-full border rounded-lg px-3 py-2 text-sm"
                            value={form.nssfEmployeeRate}
                            onChange={(e) => setForm((f) => ({ ...f, nssfEmployeeRate: Number(e.target.value) }))}
                        />
                    </div>
                    <div>
                        <label className="text-xs text-gray-600">NSSF employer %</label>
                        <input
                            type="number"
                            className="w-full border rounded-lg px-3 py-2 text-sm"
                            value={form.nssfEmployerRate}
                            onChange={(e) => setForm((f) => ({ ...f, nssfEmployerRate: Number(e.target.value) }))}
                        />
                    </div>
                    <div>
                        <label className="text-xs text-gray-600">Working days / month</label>
                        <input
                            type="number"
                            className="w-full border rounded-lg px-3 py-2 text-sm"
                            value={form.workingDaysPerMonth}
                            onChange={(e) => setForm((f) => ({ ...f, workingDaysPerMonth: Number(e.target.value) }))}
                        />
                    </div>
                </div>
                <button
                    onClick={() => saveMut.mutate()}
                    disabled={saveMut.isPending}
                    className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
                >
                    Save settings
                </button>
                {saveMut.isError && (
                    <p className="text-sm text-red-600">{getErrorMessage(saveMut.error)}</p>
                )}
            </div>
        </div>
    );
}

export default function HRPage() {
    const [view, setView] = useState<HrView>('payroll');

    const tabs: { key: HrView; label: string }[] = [
        { key: 'payroll', label: 'Payroll' },
        { key: 'advances', label: 'Advances' },
        { key: 'balances', label: 'Balances' },
        { key: 'leave', label: 'Leave' },
        { key: 'statutory', label: 'NSSF/PAYE' },
        { key: 'employees', label: 'Employees' },
        { key: 'departments', label: 'Departments' },
        { key: 'positions', label: 'Positions' },
    ];

    return (
        <Layout>
            <div className="p-4 lg:p-8 max-w-[1600px] mx-auto">
                <div className="flex items-center justify-between mb-6">
                    <div>
                        <h1 className="text-2xl lg:text-3xl font-bold text-gray-900">HR & Payroll</h1>
                        <p className="text-gray-500 mt-1">
                            Gross ? NSSF/PAYE ? advances ? cash net ? promotions & leave feed Process
                        </p>
                    </div>
                </div>

                <div className="flex gap-1 mb-6 bg-gray-100 rounded-lg p-1 w-fit flex-wrap">
                    {tabs.map((t) => (
                        <button
                            key={t.key}
                            onClick={() => setView(t.key)}
                            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                                view === t.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                            }`}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>

                {view === 'payroll' && <PayrollTab />}
                {view === 'advances' && <AdvancesTab />}
                {view === 'balances' && <BalancesTab />}
                {view === 'leave' && <LeaveTab />}
                {view === 'statutory' && <StatutoryTab />}
                {view === 'employees' && <EmployeesTab />}
                {view === 'departments' && <DepartmentsTab />}
                {view === 'positions' && <PositionsTab />}
            </div>
        </Layout>
    );
}