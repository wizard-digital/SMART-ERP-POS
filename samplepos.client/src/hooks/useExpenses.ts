import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Expense,
  CreateExpenseData,
  UpdateExpenseData,
  ExpenseFilter
} from '@shared/types/expense';
import { api } from '../services/api';

type ApiEnvelope<T> = { success?: boolean; data?: T; error?: string };

const expenseApi = {
  // Get all expenses with optional filters
  getExpenses: async (filter: ExpenseFilter = {}): Promise<{
    expenses: Expense[];
    total: number;
    summary?: { totalAmount: number; count: number; byStatus?: Record<string, { count: number; total: number }>; byCategory?: Record<string, { count: number; total: number }> };
    pagination: {
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    };
  }> => {
    const params = new URLSearchParams();

    if (filter.status) params.append('status', filter.status);
    if (filter.categoryId) params.append('categoryId', filter.categoryId);
    else if (filter.category) params.append('category', filter.category);
    if (filter.startDate) params.append('startDate', filter.startDate);
    if (filter.endDate) params.append('endDate', filter.endDate);
    if (filter.minAmount) params.append('minAmount', filter.minAmount.toString());
    if (filter.maxAmount) params.append('maxAmount', filter.maxAmount.toString());
    if (filter.search) params.append('search', filter.search);
    if (filter.employeeId) params.append('employeeId', filter.employeeId);
    if (filter.page) params.append('page', filter.page.toString());
    if (filter.limit) params.append('limit', filter.limit.toString());
    if (filter.includeSummary) params.append('includeSummary', 'true');

    const { data: result } = await api.get(`/expenses?${params}`);
    const envelope = result as {
      data?: {
        data: Expense[];
        pagination?: { total: number; page: number; limit: number; totalPages: number };
        summary?: { totalAmount: number; count: number; byStatus?: Record<string, { count: number; total: number }>; byCategory?: Record<string, { count: number; total: number }> };
      };
    };
    const responseData = envelope.data ?? (result as { data: Expense[]; pagination?: { total: number; page: number; limit: number; totalPages: number }; summary?: { totalAmount: number; count: number } });
    return {
      expenses: responseData.data || [],
      total: responseData.pagination?.total || 0,
      summary: responseData.summary,
      pagination: responseData.pagination || { total: 0, page: 1, limit: 20, totalPages: 0 }
    };
  },

  getExpense: async (id: string): Promise<Expense> => {
    const { data: result } = await api.get<ApiEnvelope<Expense>>(`/expenses/${id}`);
    return (result.data ?? result) as Expense;
  },

  createExpense: async (data: CreateExpenseData): Promise<Expense> => {
    const { data: result } = await api.post<ApiEnvelope<Expense>>('/expenses', data);
    return (result.data ?? result) as Expense;
  },

  updateExpense: async (id: string, data: UpdateExpenseData): Promise<Expense> => {
    const { data: result } = await api.put<ApiEnvelope<Expense>>(`/expenses/${id}`, data);
    return (result.data ?? result) as Expense;
  },

  deleteExpense: async (id: string): Promise<void> => {
    await api.delete(`/expenses/${id}`);
  },

  submitExpense: async (id: string): Promise<Expense> => {
    const { data: result } = await api.post<ApiEnvelope<Expense>>(`/expenses/${id}/submit`);
    return (result.data ?? result) as Expense;
  },

  approveExpense: async (id: string, comments?: string): Promise<Expense> => {
    const { data: result } = await api.post<ApiEnvelope<Expense>>(`/expenses/${id}/approve`, { comments });
    return (result.data ?? result) as Expense;
  },

  rejectExpense: async (id: string, reason: string): Promise<Expense> => {
    const { data: result } = await api.post<ApiEnvelope<Expense>>(`/expenses/${id}/reject`, { reason });
    return (result.data ?? result) as Expense;
  },

  markAsPaid: async ({ id, paymentAccountId }: { id: string; paymentAccountId?: string }): Promise<Expense> => {
    const { data: result } = await api.post<ApiEnvelope<Expense>>(`/expenses/${id}/mark-paid`, {
      payment_account_id: paymentAccountId
    });
    return (result.data ?? result) as Expense;
  },

  reverseExpense: async ({ id, reason }: { id: string; reason: string }): Promise<Expense> => {
    const { data: result } = await api.post<ApiEnvelope<Expense>>(`/expenses/${id}/reverse`, { reason });
    return (result.data ?? result) as Expense;
  },

  getExpensesByCategory: async (startDate?: string, endDate?: string): Promise<{
    category: string;
    total: number;
    count: number;
  }[]> => {
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);

    const { data: result } = await api.get<ApiEnvelope<{ category: string; total: number; count: number }[]>>(
      `/expenses/reports/by-category?${params}`
    );
    return (result.data ?? result) as { category: string; total: number; count: number }[];
  },

  getExpensesByMonth: async (year: number): Promise<{
    month: number;
    total: number;
    count: number;
  }[]> => {
    const { data: result } = await api.get<ApiEnvelope<{ month: number; total: number; count: number }[]>>(
      `/expenses/reports/trends?year=${year}`
    );
    return (result.data ?? result) as { month: number; total: number; count: number }[];
  },

  getExpensesSummary: async (filter: ExpenseFilter = {}): Promise<{
    totalAmount: number;
    count: number;
    byStatus: Record<string, { count: number; total: number }>;
    byCategory: Record<string, { count: number; total: number }>;
  }> => {
    const params = new URLSearchParams();

    if (filter.status) params.append('status', filter.status);
    if (filter.categoryId) params.append('categoryId', filter.categoryId);
    else if (filter.category) params.append('category', filter.category);
    if (filter.startDate) params.append('startDate', filter.startDate);
    if (filter.endDate) params.append('endDate', filter.endDate);
    if (filter.minAmount) params.append('minAmount', filter.minAmount.toString());
    if (filter.maxAmount) params.append('maxAmount', filter.maxAmount.toString());

    const { data: result } = await api.get<ApiEnvelope<{
      totalAmount: number;
      count: number;
      byStatus: Record<string, { count: number; total: number }>;
      byCategory: Record<string, { count: number; total: number }>;
    }>>(`/expenses/summary?${params}`);
    return (result.data ?? result) as {
      totalAmount: number;
      count: number;
      byStatus: Record<string, { count: number; total: number }>;
      byCategory: Record<string, { count: number; total: number }>;
    };
  },

  getExpenseCategories: async (): Promise<{
    id: string;
    code: string;
    name: string;
    description?: string;
    isActive: boolean;
  }[]> => {
    const { data: result } = await api.get<ApiEnvelope<Array<{
      id: string; code: string; name: string; description?: string; is_active?: boolean; isActive?: boolean;
    }>>>('/expenses/categories');
    const rows = (result.data ?? result) as Array<{
      id: string; code: string; name: string; description?: string; is_active?: boolean; isActive?: boolean;
    }>;
    return (rows || []).map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      description: c.description,
      isActive: c.isActive ?? c.is_active ?? true,
    }));
  },

  getPaymentAccounts: async (): Promise<{
    id: string;
    code: string;
    name: string;
    type: string;
    systemAccountTag?: string | null;
    currentBalance: number;
    hasFunds: boolean;
  }[]> => {
    const { data: result } = await api.get<ApiEnvelope<Array<{
      id: string;
      account_code?: string;
      code?: string;
      account_name?: string;
      name?: string;
      account_type?: string;
      type?: string;
      systemAccountTag?: string | null;
      currentBalance?: number | string;
      current_balance?: number | string;
      hasFunds?: boolean;
    }>>>('/expenses/payment-accounts');
    const rows = (result.data ?? result) as Array<{
      id: string;
      account_code?: string;
      code?: string;
      account_name?: string;
      name?: string;
      account_type?: string;
      type?: string;
      systemAccountTag?: string | null;
      currentBalance?: number | string;
      current_balance?: number | string;
      hasFunds?: boolean;
    }>;
    return (rows || []).map((acc) => {
      const balance = Number(acc.currentBalance ?? acc.current_balance ?? 0);
      return {
        id: acc.id,
        code: acc.account_code || acc.code || '',
        name: acc.account_name || acc.name || '',
        type: acc.account_type || acc.type || '',
        systemAccountTag: acc.systemAccountTag ?? null,
        currentBalance: balance,
        hasFunds: acc.hasFunds ?? balance > 0.0001,
      };
    });
  },

  getStaffOptions: async (): Promise<Array<{ id: string; firstName: string; lastName: string; fullName: string }>> => {
    const { data: result } = await api.get<ApiEnvelope<Array<{
      id: string;
      firstName?: string;
      lastName?: string;
      fullName?: string;
      first_name?: string;
      last_name?: string;
    }>>>('/expenses/staff-options');
    const rows = (result.data ?? result) as Array<{
      id: string;
      firstName?: string;
      lastName?: string;
      fullName?: string;
      first_name?: string;
      last_name?: string;
    }>;
    return (rows || []).map((r) => {
      const firstName = r.firstName || r.first_name || '';
      const lastName = r.lastName || r.last_name || '';
      return {
        id: r.id,
        firstName,
        lastName,
        fullName: r.fullName || `${firstName} ${lastName}`.trim(),
      };
    });
  },
};

// React Query hooks
export const useExpenses = (filter: ExpenseFilter = {}) => {
  return useQuery({
    queryKey: ['expenses', filter],
    queryFn: () => expenseApi.getExpenses(filter),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};

export const useExpense = (id: string) => {
  return useQuery({
    queryKey: ['expense', id],
    queryFn: () => expenseApi.getExpense(id),
    enabled: !!id,
  });
};

export const usePaymentAccounts = () => {
  return useQuery({
    queryKey: ['payment-accounts'],
    queryFn: expenseApi.getPaymentAccounts,
    staleTime: 30 * 1000, // balances change when paying expenses
  });
};

export const useExpenseStaffOptions = () => {
  return useQuery({
    queryKey: ['expenses', 'staff-options'],
    queryFn: expenseApi.getStaffOptions,
    staleTime: 5 * 60 * 1000,
  });
};

export const useCreateExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: expenseApi.createExpense,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
    },
  });
};

export const useUpdateExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateExpenseData }) =>
      expenseApi.updateExpense(id, data),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
      queryClient.invalidateQueries({ queryKey: ['expense', id] });
    },
  });
};

export const useDeleteExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: expenseApi.deleteExpense,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
    },
  });
};

export const useSubmitExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: expenseApi.submitExpense,
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
      queryClient.invalidateQueries({ queryKey: ['expense', id] });
    },
  });
};

export const useApproveExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, notes }: { id: string; notes?: string }) =>
      expenseApi.approveExpense(id, notes),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
      queryClient.invalidateQueries({ queryKey: ['expense', id] });
    },
  });
};

export const useRejectExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      expenseApi.rejectExpense(id, reason),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
      queryClient.invalidateQueries({ queryKey: ['expense', id] });
    },
  });
};

export const useMarkAsPaid = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: expenseApi.markAsPaid,
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
      queryClient.invalidateQueries({ queryKey: ['expense', id] });
      queryClient.invalidateQueries({ queryKey: ['payment-accounts'] });
    },
  });
};

export const useReverseExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: expenseApi.reverseExpense,
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
      queryClient.invalidateQueries({ queryKey: ['expense', id] });
      queryClient.invalidateQueries({ queryKey: ['payment-accounts'] });
    },
  });
};

export const useExpensesByCategory = (startDate?: string, endDate?: string) => {
  return useQuery({
    queryKey: ['expenses-by-category', startDate, endDate],
    queryFn: () => expenseApi.getExpensesByCategory(startDate, endDate),
    staleTime: 10 * 60 * 1000, // 10 minutes
  });
};

export const useExpensesByMonth = (year: number) => {
  return useQuery({
    queryKey: ['expenses-by-month', year],
    queryFn: () => expenseApi.getExpensesByMonth(year),
    staleTime: 30 * 60 * 1000, // 30 minutes
  });
};

export const useExpensesSummary = (filter: ExpenseFilter = {}) => {
  return useQuery({
    queryKey: ['expenses-summary', filter],
    queryFn: () => expenseApi.getExpensesSummary(filter),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};

export const useExpenseCategories = () => {
  return useQuery({
    queryKey: ['expense-categories'],
    queryFn: expenseApi.getExpenseCategories,
    staleTime: 30 * 60 * 1000, // 30 minutes
  });
};