import React, { useState, useEffect, useRef } from 'react';
import { useTransactionGuard, ZINDEX } from '../../hooks/useTransactionGuard';
import type { GuardHandle } from '../../hooks/useTransactionGuard';
import { Plus, FileText, Eye, CheckCircle, XCircle, Send, DollarSign, Wallet, Loader2, BarChart3, RotateCcw } from 'lucide-react';
import { useExpenses, useSubmitExpense, useApproveExpense, useRejectExpense, useMarkAsPaid, useReverseExpense, useDeleteExpense, usePaymentAccounts, useExpenseCategories, useExpenseStaffOptions } from '../../hooks/useExpenses';
import { ExpenseFilter, Expense } from '@shared/types/expense';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../components/ui/temp-ui-components';
import { DatePicker } from '../../components/ui/date-picker';
import { CreateExpenseForm } from '../../components/expenses/CreateExpenseForm';
import { formatCurrency } from '../../utils/currency';
import { EXPENSE_STATUSES } from '@shared/types/expense';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Link } from 'react-router-dom';
import { useCanAccess } from '../../components/auth/ProtectedRoute';
import { formatTimestamp } from '../../utils/businessDate';
import { useSubmitOnEnter } from '../../hooks/useSubmitOnEnter';
import { toast } from 'sonner';
import { getErrorMessage } from '../../utils/api';
import {
  AdaptivePage,
  AdaptiveSearch,
  AdaptiveToolbar,
} from '../../components/adaptive';

const ExpensesPage: React.FC = () => {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [selectedExpense, setSelectedExpense] = useState<Expense | null>(null);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [reverseDialogOpen, setReverseDialogOpen] = useState(false);
  const [reversalReason, setReversalReason] = useState('');

  // ── Transaction Guard ──────────────────────────────────────────────────
  const { openGuard, closeGuard } = useTransactionGuard();
  const createGuardRef = useRef<GuardHandle | null>(null);
  const viewGuardRef = useRef<GuardHandle | null>(null);
  const rejectGuardRef = useRef<GuardHandle | null>(null);
  const paymentGuardRef = useRef<GuardHandle | null>(null);
  const reverseGuardRef = useRef<GuardHandle | null>(null);

  useEffect(() => {
    if (isCreateModalOpen) {
      createGuardRef.current = openGuard({ cancellable: true, label: 'Create expense' });
      return () => { if (createGuardRef.current) { closeGuard(createGuardRef.current.id); createGuardRef.current = null; } };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCreateModalOpen]);

  useEffect(() => {
    if (selectedExpense) {
      viewGuardRef.current = openGuard({ cancellable: true, label: 'View expense' });
      return () => { if (viewGuardRef.current) { closeGuard(viewGuardRef.current.id); viewGuardRef.current = null; } };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedExpense]);

  useEffect(() => {
    if (rejectDialogOpen) {
      rejectGuardRef.current = openGuard({ cancellable: false, label: 'Reject expense' });
      return () => { if (rejectGuardRef.current) { closeGuard(rejectGuardRef.current.id); rejectGuardRef.current = null; } };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rejectDialogOpen]);

  useEffect(() => {
    if (paymentDialogOpen) {
      paymentGuardRef.current = openGuard({ cancellable: false, label: 'Mark expense as paid' });
      return () => { if (paymentGuardRef.current) { closeGuard(paymentGuardRef.current.id); paymentGuardRef.current = null; } };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentDialogOpen]);
  useEffect(() => {
    if (reverseDialogOpen) {
      reverseGuardRef.current = openGuard({ cancellable: false, label: 'Reverse expense' });
      return () => { if (reverseGuardRef.current) { closeGuard(reverseGuardRef.current.id); reverseGuardRef.current = null; } };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reverseDialogOpen]);
  const [selectedPaymentAccountId, setSelectedPaymentAccountId] = useState<string>('');
  const [filter, setFilter] = useState<ExpenseFilter>({
    page: 1,
    limit: 20,
    includeSummary: true
  });

  const { data, isLoading, error, refetch } = useExpenses(filter);
  const { data: paymentAccounts } = usePaymentAccounts();
  const { data: dbCategories = [] } = useExpenseCategories();
  const { data: staffOptions = [] } = useExpenseStaffOptions();

  // Permission gating
  const canCreateExpense = useCanAccess([], ['expenses.create']);
  const canApproveExpense = useCanAccess([], ['expenses.approve']);
  const canDeleteExpense = useCanAccess([], ['expenses.delete']);
  const canViewExpenseReports = useCanAccess([], ['reports.read', 'reports.financial_view', 'expenses.read']);

  // Action mutations
  const submitMutation = useSubmitExpense();
  const approveMutation = useApproveExpense();
  const rejectMutation = useRejectExpense();
  const markPaidMutation = useMarkAsPaid();
  const reverseMutation = useReverseExpense();
  const deleteMutation = useDeleteExpense();

  // Action handlers
  const handleSubmitForApproval = async () => {
    if (!selectedExpense) return;
    try {
      await submitMutation.mutateAsync(selectedExpense.id);
      setSelectedExpense(null);
      refetch();
    } catch (err) {
      console.error('Failed to submit expense:', err);
    }
  };

  const handleApprove = async () => {
    if (!selectedExpense) return;
    try {
      await approveMutation.mutateAsync({ id: selectedExpense.id });
      toast.success('Expense approved');
      setSelectedExpense(null);
      refetch();
    } catch (err) {
      toast.error('Failed to approve expense', { description: getErrorMessage(err) });
    }
  };

  const handleReject = async () => {
    if (!selectedExpense || !rejectionReason.trim()) return;
    try {
      await rejectMutation.mutateAsync({ id: selectedExpense.id, reason: rejectionReason });
      setRejectDialogOpen(false);
      setRejectionReason('');
      setSelectedExpense(null);
      refetch();
    } catch (err) {
      console.error('Failed to reject expense:', err);
    }
  };

  const handleOpenPaymentDialog = () => {
    if (!selectedExpense) return;
    const amount = selectedExpense.amount;
    const funded =
      paymentAccounts?.filter((a) => a.currentBalance + 0.0001 >= amount) ?? [];
    setSelectedPaymentAccountId(funded[0]?.id ?? '');
    setPaymentDialogOpen(true);
  };

  const handleMarkPaid = async () => {
    if (!selectedExpense || !selectedPaymentAccountId) return;
    try {
      await markPaidMutation.mutateAsync({
        id: selectedExpense.id,
        paymentAccountId: selectedPaymentAccountId
      });
      toast.success('Expense marked as paid');
      setPaymentDialogOpen(false);
      setSelectedPaymentAccountId('');
      setSelectedExpense(null);
      refetch();
    } catch (err) {
      toast.error('Failed to mark expense as paid', { description: getErrorMessage(err) });
    }
  };

  const handleReverse = async () => {
    if (!selectedExpense || reversalReason.trim().length < 3) return;
    try {
      await reverseMutation.mutateAsync({
        id: selectedExpense.id,
        reason: reversalReason.trim(),
      });
      toast.success('Expense reversed');
      setReverseDialogOpen(false);
      setReversalReason('');
      setSelectedExpense(null);
      refetch();
    } catch (err) {
      toast.error('Failed to reverse expense', { description: getErrorMessage(err) });
    }
  };

  const handleCancel = async () => {
    if (!selectedExpense) return;
    if (!confirm('Are you sure you want to cancel this expense?')) return;
    try {
      await deleteMutation.mutateAsync(selectedExpense.id);
      setSelectedExpense(null);
      refetch();
    } catch (err) {
      console.error('Failed to cancel expense:', err);
    }
  };

  const handleFilterChange = (key: keyof ExpenseFilter, value: ExpenseFilter[keyof ExpenseFilter]) => {
    setFilter(prev => ({
      ...prev,
      [key]: value,
      page: 1 // Reset to first page when filtering
    }));
  };

  const handleSearch = (value: string) => {
    setFilter(prev => ({
      ...prev,
      search: value || undefined,
      page: 1
    }));
  };

  const getStatusColor = (status: string) => {
    const colors = {
      'DRAFT': 'bg-gray-100 text-gray-800',
      'PENDING_APPROVAL': 'bg-yellow-100 text-yellow-800',
      'APPROVED': 'bg-green-100 text-green-800',
      'REJECTED': 'bg-red-100 text-red-800',
      'PAID': 'bg-blue-100 text-blue-800',
      'CANCELLED': 'bg-gray-100 text-gray-800',
      'REVERSED': 'bg-orange-100 text-orange-800'
    };
    return colors[status as keyof typeof colors] || 'bg-gray-100 text-gray-800';
  };

  const handlePageChange = (page: number) => {
    setFilter(prev => ({ ...prev, page }));
  };

  useSubmitOnEnter(rejectDialogOpen, !rejectMutation.isPending, handleReject);
  useSubmitOnEnter(paymentDialogOpen, !markPaidMutation.isPending, handleMarkPaid);
  useSubmitOnEnter(reverseDialogOpen, !reverseMutation.isPending && reversalReason.trim().length >= 3, handleReverse);

  if (error) {
    return (
      <div className="p-4 lg:p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800">Error loading expenses: {error.message}</p>
        </div>
      </div>
    );
  }

  return (
    <AdaptivePage
      className="p-4 lg:p-6"
      title="Expenses"
      description="Create expense vouchers for approval, then mark them paid from bank or cash. Daily staff transport and similar operating payouts go here (e.g. Employee Allowances category) — not HR payroll. Spending from the petty float belongs under Banking → Petty cash."
      primaryActions={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {canViewExpenseReports ? (
            <Link to="/reports/expenses">
              <Button variant="outline" className="flex items-center gap-2 min-h-[var(--layout-touch-target)]">
                <BarChart3 className="h-4 w-4" />
                View Reports
              </Button>
            </Link>
          ) : null}
          {canCreateExpense && (
            <Button
              onClick={() => setIsCreateModalOpen(true)}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 min-h-[var(--layout-touch-target)]"
            >
              <Plus className="h-4 w-4" />
              New Expense
            </Button>
          )}
        </div>
      }
      toolbar={
        <div className="bg-white rounded-lg border border-gray-200 p-4" data-expense-filters="true">
          <AdaptiveToolbar
            leading={
              <AdaptiveSearch
                value={filter.search || ''}
                onChange={handleSearch}
                placeholder="Search expenses..."
                label="Search expenses"
              />
            }
            secondaryLabel="Filters"
            secondary={
              <div className="grid grid-cols-1 gap-3 min-w-[14rem] sm:grid-cols-2">
                <Select onValueChange={(value) => handleFilterChange('status', value === 'all' ? undefined : value)}>
                  <SelectTrigger>
                    <SelectValue placeholder="All Statuses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    {Object.entries(EXPENSE_STATUSES).map(([key, label]) => (
                      <SelectItem key={key} value={key}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select onValueChange={(value) => {
                  if (value === 'all') {
                    setFilter((prev) => ({
                      ...prev,
                      categoryId: undefined,
                      category: undefined,
                      page: 1,
                    }));
                    return;
                  }
                  const cat = dbCategories.find((c) => c.id === value || c.code === value);
                  setFilter((prev) => ({
                    ...prev,
                    categoryId: cat?.id,
                    category: cat?.code,
                    page: 1,
                  }));
                }}>
                  <SelectTrigger>
                    <SelectValue placeholder="All Categories" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {dbCategories.map((cat) => (
                      <SelectItem key={cat.id} value={cat.id}>{cat.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={filter.employeeId || 'all'}
                  onValueChange={(value) =>
                    handleFilterChange('employeeId', value === 'all' ? undefined : value)
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="All Staff" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Staff</SelectItem>
                    {staffOptions.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.fullName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <DatePicker
                  value={filter.startDate || ''}
                  onChange={(date) => handleFilterChange('startDate', date || undefined)}
                  placeholder="Start Date"
                />
              </div>
            }
          />
        </div>
      }
    >
      {/* Summary Cards */}
      {data?.summary && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-600">Total Amount</p>
                  <p className="text-base sm:text-2xl font-bold text-gray-900">
                    {formatCurrency(data.summary.totalAmount)}
                  </p>
                </div>
                <FileText className="h-8 w-8 text-blue-600 flex-shrink-0" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-600">Total Expenses</p>
                  <p className="text-base sm:text-2xl font-bold text-gray-900">{data.summary.count}</p>
                </div>
                <FileText className="h-8 w-8 text-green-600 flex-shrink-0" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-600">Pending Approval</p>
                  <p className="text-base sm:text-2xl font-bold text-gray-900">
                    {data.summary.byStatus?.['PENDING_APPROVAL']?.count || 0}
                  </p>
                </div>
                <FileText className="h-8 w-8 text-yellow-600 flex-shrink-0" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-600">Paid</p>
                  <p className="text-base sm:text-2xl font-bold text-gray-900">
                    {formatCurrency(data.summary.byStatus?.['PAID']?.total || 0)}
                  </p>
                </div>
                <FileText className="h-8 w-8 text-blue-600 flex-shrink-0" />
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Expenses Table */}
      <Card>
        <CardHeader>
          <CardTitle>Expense List</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
          ) : data?.expenses && data.expenses.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-3 px-4 font-medium text-gray-900">Expense #</th>
                      <th className="text-left py-3 px-4 font-medium text-gray-900">Title</th>
                      <th className="text-left py-3 px-4 font-medium text-gray-900">Amount</th>
                      <th className="text-left py-3 px-4 font-medium text-gray-900">Category</th>
                      <th className="text-left py-3 px-4 font-medium text-gray-900">Staff</th>
                      <th className="text-left py-3 px-4 font-medium text-gray-900">Date</th>
                      <th className="text-left py-3 px-4 font-medium text-gray-900">Status</th>
                      <th className="text-left py-3 px-4 font-medium text-gray-900">Created By</th>
                      <th className="text-right py-3 px-4 font-medium text-gray-900">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.expenses.map((expense) => (
                      <tr key={expense.id} className="border-b hover:bg-gray-50">
                        <td className="py-3 px-4">
                          <span className="font-mono text-sm">{expense.expenseNumber}</span>
                        </td>
                        <td className="py-3 px-4">
                          <div>
                            <p className="font-medium text-gray-900">{expense.title}</p>
                            {expense.vendor && (
                              <p className="text-sm text-gray-500">{expense.vendor}</p>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <span className="font-medium text-gray-900">
                            {formatCurrency(expense.amount)}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <span className="text-sm text-gray-600">
                            {expense.categoryName || dbCategories.find(c => c.code === expense.category)?.name || expense.category}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <span className="text-sm text-gray-600">
                            {expense.employeeName || '—'}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <span className="text-sm text-gray-600">
                            {expense.expenseDate}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <Badge className={`${getStatusColor(expense.status)} border-0`}>
                            {EXPENSE_STATUSES[expense.status]}
                          </Badge>
                        </td>
                        <td className="py-3 px-4">
                          <span className="text-sm text-gray-600">
                            {expense.createdByName || 'Unknown'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setSelectedExpense(expense)}
                          >
                            <Eye className="h-4 w-4 mr-1" />
                            View
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {data.pagination && data.pagination.totalPages > 1 && (
                <div className="flex items-center justify-between mt-6 pt-4 border-t">
                  <div className="text-sm text-gray-700">
                    Showing {((data.pagination.page - 1) * data.pagination.limit) + 1} to{' '}
                    {Math.min(data.pagination.page * data.pagination.limit, data.pagination.total)} of{' '}
                    {data.pagination.total} expenses
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePageChange(data.pagination.page - 1)}
                      disabled={data.pagination.page === 1}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePageChange(data.pagination.page + 1)}
                      disabled={data.pagination.page === data.pagination.totalPages}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-8">
              <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No expenses found</h3>
              <p className="text-gray-500 mb-4">Get started by creating your first expense.</p>
              {canCreateExpense && (
                <Button onClick={() => setIsCreateModalOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  New Expense
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Expense Modal */}
      <Dialog open={isCreateModalOpen} onOpenChange={setIsCreateModalOpen} zIndex={createGuardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
        <DialogContent className="max-w-5xl max-h-[95vh] overflow-hidden flex flex-col animate-in fade-in-0 zoom-in-95 duration-200">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="text-2xl flex items-center gap-2">
              <Plus className="h-6 w-6 text-blue-600" />
              Create New Expense
            </DialogTitle>
            <DialogDescription className="text-base">
              Fill in the details below to record a new expense.
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-y-auto flex-1 -mx-6 px-6">
            <CreateExpenseForm
              onSuccess={() => {
                setIsCreateModalOpen(false);
                refetch(); // Refetch expenses list
              }}
              onCancel={() => setIsCreateModalOpen(false)}
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* View Expense Modal */}
      <Dialog open={!!selectedExpense} onOpenChange={(open) => !open && setSelectedExpense(null)} zIndex={viewGuardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col animate-in fade-in-0 zoom-in-95 duration-200">
          <DialogHeader className="flex-shrink-0 pb-4 border-b">
            <DialogTitle className="text-2xl">Expense Details</DialogTitle>
            <DialogDescription className="text-base font-mono">
              {selectedExpense?.expenseNumber}
            </DialogDescription>
          </DialogHeader>
          {selectedExpense && (
            <div className="space-y-6 overflow-y-auto flex-1 -mx-6 px-6 py-4">
              {/* Status Badge */}
              <div className="flex justify-between items-center bg-gradient-to-r from-gray-50 to-blue-50 -mx-6 px-6 -mt-4 pt-4 pb-4 mb-4">
                <Badge className={`${getStatusColor(selectedExpense.status)} border-0 text-sm px-3 py-1`}>
                  {EXPENSE_STATUSES[selectedExpense.status]}
                </Badge>
                <div className="text-right">
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Amount</p>
                  <span className="text-3xl font-bold text-gray-900">
                    {formatCurrency(selectedExpense.amount)}
                  </span>
                </div>
              </div>

              {/* Main Info */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-gray-500 uppercase tracking-wide flex items-center gap-1">
                    <FileText className="h-3 w-3" />
                    Title
                  </label>
                  <p className="text-gray-900 font-semibold text-lg">{selectedExpense.title}</p>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Category</label>
                  <p className="text-gray-900 font-medium">{selectedExpense.categoryName || dbCategories.find(c => c.code === selectedExpense.category)?.name || selectedExpense.category}</p>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Date</label>
                  <p className="text-gray-900 font-medium">{selectedExpense.expenseDate}</p>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Vendor</label>
                  <p className="text-gray-900 font-medium">{selectedExpense.vendor || '-'}</p>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Staff / employee</label>
                  <p className="text-gray-900 font-medium">{selectedExpense.employeeName || '—'}</p>
                  <p className="text-[11px] text-gray-500">Audit link only — not payroll / NSSF</p>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Payment Method</label>
                  <p className="text-gray-900 font-medium">{selectedExpense.paymentMethod || '-'}</p>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Created By</label>
                  <p className="text-gray-900 font-medium">{selectedExpense.createdByName || 'Unknown'}</p>
                </div>
              </div>

              {/* Description */}
              {selectedExpense.description && (
                <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                  <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Description</label>
                  <p className="text-gray-900 mt-2 leading-relaxed">{selectedExpense.description}</p>
                </div>
              )}

              {/* Notes */}
              {selectedExpense.notes && (
                <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
                  <label className="text-xs font-medium text-blue-700 uppercase tracking-wide">Notes</label>
                  <p className="text-gray-900 mt-2 leading-relaxed">{selectedExpense.notes}</p>
                </div>
              )}

              {/* Approval Info */}
              {selectedExpense.approvedAt && (
                <div className="bg-green-50 rounded-lg p-4 border border-green-200">
                  <h4 className="font-semibold text-green-900 mb-3 flex items-center gap-2">
                    <CheckCircle className="h-4 w-4" />
                    Approval Information
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-xs text-green-700 uppercase tracking-wide">Approved By</label>
                      <p className="text-gray-900 font-medium">{selectedExpense.approvedByName || '-'}</p>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-green-700 uppercase tracking-wide">Approved At</label>
                      <p className="text-gray-900 font-medium">{selectedExpense.approvedAt ? formatTimestamp(selectedExpense.approvedAt) : '-'}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Rejection Info */}
              {selectedExpense.rejectedAt && (
                <div className="bg-red-50 rounded-lg p-4 border border-red-200">
                  <h4 className="font-semibold text-red-900 mb-3 flex items-center gap-2">
                    <XCircle className="h-4 w-4" />
                    Rejection Information
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-3">
                    <div className="space-y-1">
                      <label className="text-xs text-red-700 uppercase tracking-wide">Rejected By</label>
                      <p className="text-gray-900 font-medium">{selectedExpense.rejectedByName || '-'}</p>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-red-700 uppercase tracking-wide">Rejected At</label>
                      <p className="text-gray-900 font-medium">{selectedExpense.rejectedAt ? formatTimestamp(selectedExpense.rejectedAt) : '-'}</p>
                    </div>
                  </div>
                  {selectedExpense.rejectionReason && (
                    <div className="mt-3 pt-3 border-t border-red-200 space-y-1">
                      <label className="text-xs text-red-700 uppercase tracking-wide">Reason</label>
                      <p className="text-red-900 font-medium leading-relaxed">{selectedExpense.rejectionReason}</p>
                    </div>
                  )}
                </div>
              )}

              {selectedExpense.status === 'REVERSED' && (
                <div className="p-4 bg-orange-50 rounded-lg border border-orange-200 space-y-3">
                  <p className="text-sm font-semibold text-orange-800 uppercase tracking-wide">Reversal</p>
                  <p className="text-orange-900 font-medium leading-relaxed">
                    {selectedExpense.reversalReason || 'Reversed'}
                  </p>
                  {selectedExpense.reversedAt && (
                    <p className="text-sm text-gray-700">{formatTimestamp(selectedExpense.reversedAt)}</p>
                  )}
                </div>
              )}

              {/* Actions */}
              <div className="flex justify-between pt-6 mt-4 border-t-2 sticky bottom-0 bg-white -mx-6 px-6 pb-2">
                <div className="flex gap-3">
                  {/* Cancel button - only for DRAFT */}
                  {selectedExpense.status === 'DRAFT' && canDeleteExpense && (
                    <Button
                      variant="destructive"
                      onClick={handleCancel}
                      disabled={deleteMutation.isPending}
                      size="lg"
                    >
                      {deleteMutation.isPending ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Cancelling...
                        </>
                      ) : (
                        <>
                          <XCircle className="h-4 w-4 mr-2" />
                          Cancel Expense
                        </>
                      )}
                    </Button>
                  )}
                </div>

                <div className="flex gap-3">
                  {/* Submit for Approval - only for DRAFT */}
                  {selectedExpense.status === 'DRAFT' && canCreateExpense && (
                    <Button
                      onClick={handleSubmitForApproval}
                      disabled={submitMutation.isPending}
                      className="bg-blue-600 hover:bg-blue-700"
                      size="lg"
                    >
                      {submitMutation.isPending ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Submitting...
                        </>
                      ) : (
                        <>
                          <Send className="h-4 w-4 mr-2" />
                          Submit for Approval
                        </>
                      )}
                    </Button>
                  )}

                  {/* Approve/Reject - only for PENDING_APPROVAL */}
                  {selectedExpense.status === 'PENDING_APPROVAL' && canApproveExpense && (
                    <>
                      <Button
                        variant="destructive"
                        onClick={() => setRejectDialogOpen(true)}
                        disabled={rejectMutation.isPending}
                        size="lg"
                      >
                        <XCircle className="h-4 w-4 mr-2" />
                        Reject
                      </Button>
                      <Button
                        onClick={handleApprove}
                        disabled={approveMutation.isPending}
                        className="bg-green-600 hover:bg-green-700"
                        size="lg"
                      >
                        {approveMutation.isPending ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Approving...
                          </>
                        ) : (
                          <>
                            <CheckCircle className="h-4 w-4 mr-2" />
                            Approve
                          </>
                        )}
                      </Button>
                    </>
                  )}

                  {/* Mark as Paid - only for APPROVED */}
                  {selectedExpense.status === 'APPROVED' && canApproveExpense && (
                    <Button
                      onClick={handleOpenPaymentDialog}
                      disabled={markPaidMutation.isPending}
                      className="bg-green-600 hover:bg-green-700"
                      size="lg"
                    >
                      <DollarSign className="h-4 w-4 mr-2" />
                      Mark as Paid
                    </Button>
                  )}

                  {(selectedExpense.status === 'APPROVED' || selectedExpense.status === 'PAID') && canApproveExpense && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setReversalReason('');
                        setReverseDialogOpen(true);
                      }}
                      disabled={reverseMutation.isPending}
                      size="lg"
                      className="border-orange-300 text-orange-800 hover:bg-orange-50"
                    >
                      <RotateCcw className="h-4 w-4 mr-2" />
                      Reverse
                    </Button>
                  )}

                  <Button variant="outline" onClick={() => setSelectedExpense(null)} size="lg">
                    Close
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Rejection Reason Dialog */}
      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen} zIndex={rejectGuardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
        <DialogContent className="max-w-lg animate-in fade-in-0 zoom-in-95 duration-200">
          <DialogHeader>
            <DialogTitle className="text-xl flex items-center gap-2 text-red-600">
              <XCircle className="h-5 w-5" />
              Reject Expense
            </DialogTitle>
            <DialogDescription className="text-base">
              Please provide a clear reason for rejecting this expense. This will be visible to the requester.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label htmlFor="rejection-reason" className="text-base font-medium">Rejection Reason *</Label>
              <Textarea
                id="rejection-reason"
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                placeholder="e.g., Missing receipt, incorrect amount, outside budget..."
                rows={4}
                className="mt-2 resize-none"
              />
              <p className="text-xs text-gray-500 mt-2">
                {rejectionReason.length}/500 characters
              </p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setRejectDialogOpen(false);
                setRejectionReason('');
              }}
              size="lg"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={!rejectionReason.trim() || rejectMutation.isPending}
              size="lg"
            >
              {rejectMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Rejecting...
                </>
              ) : (
                <>
                  <XCircle className="h-4 w-4 mr-2" />
                  Reject Expense
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Payment Account Selection Dialog */}
      <Dialog open={paymentDialogOpen} onOpenChange={setPaymentDialogOpen} zIndex={paymentGuardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
        <DialogContent className="max-w-lg animate-in fade-in-0 zoom-in-95 duration-200">
          <DialogHeader>
            <DialogTitle className="text-xl flex items-center gap-2 text-green-600">
              <Wallet className="h-5 w-5" />
              Mark Expense as Paid
            </DialogTitle>
            <DialogDescription className="text-base">
              Select the account from which this expense was paid.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            {selectedExpense && (
              <div className="p-4 bg-gradient-to-r from-green-50 to-blue-50 rounded-lg border border-green-200">
                <div className="flex justify-between items-center">
                  <div>
                    <p className="text-xs text-gray-600 uppercase tracking-wide">Expense</p>
                    <p className="font-semibold text-gray-900 text-lg">{selectedExpense.title}</p>
                    <p className="text-sm text-gray-600 mt-1">{selectedExpense.expenseNumber}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-gray-600 uppercase tracking-wide">Amount</p>
                    <p className="text-2xl font-bold text-green-600">{formatCurrency(selectedExpense.amount)}</p>
                  </div>
                </div>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="payment-account" className="text-base font-medium flex items-center gap-2">
                <DollarSign className="h-4 w-4" />
                Pay From Account *
              </Label>
              <Select
                value={selectedPaymentAccountId}
                onValueChange={setSelectedPaymentAccountId}
              >
                <SelectTrigger id="payment-account" className="h-12">
                  <SelectValue placeholder="Select payment account with available funds" />
                </SelectTrigger>
                <SelectContent>
                  {(paymentAccounts ?? []).map((account) => {
                    const amount = selectedExpense?.amount ?? 0;
                    const canCover = account.currentBalance + 0.0001 >= amount;
                    const tag = account.systemAccountTag
                      ? ` · ${account.systemAccountTag.replace(/_/g, ' ')}`
                      : '';
                    return (
                      <SelectItem
                        key={account.id}
                        value={account.id}
                        disabled={!canCover}
                        className="py-3"
                      >
                        <div className="flex w-full items-center justify-between gap-4">
                          <span className="font-medium">
                            {account.code} - {account.name}{tag}
                          </span>
                          <span className={canCover ? 'text-green-700 font-semibold' : 'text-gray-400'}>
                            {formatCurrency(account.currentBalance)}
                            {!canCover ? ' (insufficient)' : ''}
                          </span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {selectedExpense && (paymentAccounts ?? []).every(
                (a) => a.currentBalance + 0.0001 < selectedExpense.amount
              ) && (
                <p className="text-sm text-red-600">
                  No Cash, Bank, MoMo, or Petty Cash account has enough balance for{' '}
                  {formatCurrency(selectedExpense.amount)}. Fund an account first.
                </p>
              )}
              <p className="text-xs text-gray-500">
                Only accounts with enough available balance can be selected. The amount is deducted from that account.
              </p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setPaymentDialogOpen(false);
                setSelectedPaymentAccountId('');
              }}
              size="lg"
            >
              Cancel
            </Button>
            <Button
              className="bg-green-600 hover:bg-green-700"
              onClick={handleMarkPaid}
              disabled={!selectedPaymentAccountId || markPaidMutation.isPending}
              size="lg"
            >
              {markPaidMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <DollarSign className="h-4 w-4 mr-2" />
                  Confirm Payment
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={reverseDialogOpen} onOpenChange={setReverseDialogOpen} zIndex={reverseGuardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
        <DialogContent className="max-w-lg animate-in fade-in-0 zoom-in-95 duration-200">
          <DialogHeader>
            <DialogTitle className="text-xl flex items-center gap-2 text-orange-700">
              <RotateCcw className="h-5 w-5" />
              Reverse Expense
            </DialogTitle>
            <DialogDescription className="text-base">
              Posts opposite GL to undo a mistaken approval or payment. Original journals are kept.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {selectedExpense && (
              <div className="p-4 bg-orange-50 rounded-lg border border-orange-200">
                <p className="font-semibold text-gray-900">{selectedExpense.title}</p>
                <p className="text-sm text-gray-600">{selectedExpense.expenseNumber}</p>
                <p className="text-lg font-bold text-orange-800 mt-1">{formatCurrency(selectedExpense.amount)}</p>
              </div>
            )}
            <div>
              <Label htmlFor="reversal-reason" className="text-base font-medium">Reason *</Label>
              <Textarea
                id="reversal-reason"
                value={reversalReason}
                onChange={(e) => setReversalReason(e.target.value)}
                placeholder="e.g. Paid from the wrong account, duplicate voucher..."
                rows={4}
                className="mt-2 resize-none"
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setReverseDialogOpen(false);
                setReversalReason('');
              }}
              size="lg"
            >
              Cancel
            </Button>
            <Button
              onClick={handleReverse}
              disabled={reversalReason.trim().length < 3 || reverseMutation.isPending}
              className="bg-orange-600 hover:bg-orange-700"
              size="lg"
            >
              {reverseMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Reversing...
                </>
              ) : (
                <>
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Confirm Reverse
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdaptivePage>
  );
};

export default ExpensesPage;
