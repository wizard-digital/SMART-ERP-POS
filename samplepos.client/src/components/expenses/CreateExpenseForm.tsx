import React, { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CreateExpenseSchema } from '@shared/zod/expense';
import {
  CreateExpenseData,
  PAYMENT_METHODS,
  Expense,
} from '@shared/types/expense';
import { useCreateExpense, useExpenseCategories, useExpenseStaffOptions } from '../../hooks/useExpenses';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { DatePicker } from '@/components/ui/date-picker';
import { formatCurrency } from '../../utils/currency';
import { Loader2, Receipt, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { getStructuredErrorMessage } from '../../utils/errorHandler';

interface CreateExpenseFormProps {
  onSuccess?: (expense: Expense) => void;
  onCancel?: () => void;
}

export const CreateExpenseForm: React.FC<CreateExpenseFormProps> = ({ onSuccess, onCancel }) => {
  const createExpense = useCreateExpense();
  const { data: dbCategories = [], isLoading: categoriesLoading } = useExpenseCategories();
  const { data: staffOptions = [] } = useExpenseStaffOptions();
  const [uploadedDocuments] = useState<string[]>([]);

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isValid },
  } = useForm<CreateExpenseData>({
    resolver: zodResolver(CreateExpenseSchema),
    defaultValues: {
      expenseDate: new Date().toLocaleDateString('en-CA'),
      receiptRequired: false,
      documentIds: [],
      employeeId: null,
      // Always create unpaid — pay after approval via Mark as paid (create API ignores PAID today)
      paymentStatus: 'UNPAID',
      paymentAccountId: null,
    },
    mode: 'onChange',
  });

  const watchedAmount = watch('amount');
  const watchedCategory = watch('category');
  const staffRequired = String(watchedCategory || '').toUpperCase() === 'ALLOWANCE';

  const onSubmit = async (data: CreateExpenseData) => {
    try {
      const expenseData = {
        ...data,
        paymentStatus: 'UNPAID' as const,
        paymentAccountId: null,
        documentIds: uploadedDocuments.length > 0 ? uploadedDocuments : undefined,
      };

      const expense = await createExpense.mutateAsync(expenseData);

      toast.success('Expense created successfully', {
        description: `Expense ${expense.expenseNumber} has been created as unpaid — submit for approval, then mark paid from bank or cash.`,
      });

      onSuccess?.(expense);
    } catch (error) {
      toast.error('Failed to create expense', {
        description: getStructuredErrorMessage(error, 'Please try again'),
      });
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {/* Single Compact Card */}
        <Card className="shadow-md">
          <CardHeader className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white pb-3">
            <CardTitle className="text-lg font-semibold">Create expense voucher</CardTitle>
            <p className="text-sm text-blue-100">
              Creates an unpaid voucher for approval. Pay from bank or cash after approval — not from
              the petty float.
            </p>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            <div className="rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-900 md:col-span-2">
              Need to spend from the petty cash float instead? Use Banking → Petty cash, or Cash Out →
              Spend from petty float on an open register.
            </div>
            {/* Compact Grid Layout */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* Title */}
              <div className="md:col-span-2">
                <Label htmlFor="title" className="text-sm font-medium">
                  Expense Title *
                </Label>
                <Input
                  id="title"
                  placeholder="Enter expense title"
                  {...register('title')}
                  className={errors.title ? 'border-red-500 h-9' : 'h-9'}
                />
                {errors.title && (
                  <p className="text-xs text-red-600 mt-0.5">{errors.title.message}</p>
                )}
              </div>

              {/* Amount */}
              <div>
                <Label htmlFor="amount" className="text-sm font-medium">
                  Amount *
                </Label>
                <Input
                  id="amount"
                  type="number"
                  step="1"
                  placeholder="0.00"
                  {...register('amount', { valueAsNumber: true })}
                  className={errors.amount ? 'border-red-500 h-9' : 'h-9'}
                />
                {errors.amount && (
                  <p className="text-xs text-red-600 mt-0.5">{errors.amount.message}</p>
                )}
                {watchedAmount > 0 && (
                  <p className="text-xs text-gray-600 mt-0.5">{formatCurrency(watchedAmount)}</p>
                )}
              </div>

              {/* Date */}
              <div>
                <Label htmlFor="expenseDate" className="text-sm font-medium">
                  Date *
                </Label>
                <Controller
                  name="expenseDate"
                  control={control}
                  render={({ field }) => (
                    <DatePicker
                      value={field.value}
                      onChange={field.onChange}
                      maxDate={new Date()}
                      placeholder="Select date"
                      className={errors.expenseDate ? 'border-red-500' : ''}
                    />
                  )}
                />
                {errors.expenseDate && (
                  <p className="text-xs text-red-600 mt-0.5">{errors.expenseDate.message}</p>
                )}
              </div>

              {/* Category */}
              <div>
                <Label className="text-sm font-medium">Category *</Label>
                <Controller
                  name="category"
                  control={control}
                  render={({ field }) => (
                    <Select
                      value={field.value ?? ''}
                      onValueChange={(code) => {
                        field.onChange(code);
                        const cat = dbCategories.find((c) => c.code === code);
                        setValue('categoryId', cat?.id, { shouldValidate: true });
                      }}
                    >
                      <SelectTrigger className={errors.category ? 'border-red-500 h-9' : 'h-9'}>
                        <SelectValue placeholder={categoriesLoading ? 'Loading...' : 'Select category'} />
                      </SelectTrigger>
                      <SelectContent>
                        {dbCategories.map((cat) => (
                          <SelectItem key={cat.id} value={cat.code}>
                            {cat.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors.category && (
                  <p className="text-xs text-red-600 mt-0.5">{errors.category.message}</p>
                )}
              </div>

              {/* Payment Method */}
              <div>
                <Label className="text-sm font-medium">Payment Method *</Label>
                <Controller
                  name="paymentMethod"
                  control={control}
                  render={({ field }) => (
                    <Select value={field.value ?? ''} onValueChange={field.onChange}>
                      <SelectTrigger
                        className={errors.paymentMethod ? 'border-red-500 h-9' : 'h-9'}
                      >
                        <SelectValue placeholder="Select method" />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(PAYMENT_METHODS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors.paymentMethod && (
                  <p className="text-xs text-red-600 mt-0.5">{errors.paymentMethod.message}</p>
                )}
              </div>

              {/* Vendor */}
              <div>
                <Label htmlFor="vendor" className="text-sm font-medium">
                  Vendor
                </Label>
                <Input
                  id="vendor"
                  placeholder="Vendor name"
                  {...register('vendor')}
                  className="h-9"
                />
              </div>

              {/* Employee (audit) */}
              <div className="md:col-span-2">
                <Label className="text-sm font-medium">
                  Staff / employee {staffRequired ? '*' : '(optional)'}
                </Label>
                <Controller
                  name="employeeId"
                  control={control}
                  render={({ field }) => (
                    <Select
                      value={field.value ?? '__none__'}
                      onValueChange={(v) => field.onChange(v === '__none__' ? null : v)}
                    >
                      <SelectTrigger className={errors.employeeId ? 'border-red-500 h-9' : 'h-9'}>
                        <SelectValue placeholder="Who received / claimed this payout?" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">— Not linked (vendor / general) —</SelectItem>
                        {staffOptions.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.fullName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors.employeeId && (
                  <p className="text-xs text-red-600 mt-0.5">{errors.employeeId.message}</p>
                )}
                <p className="text-[11px] text-gray-500 mt-1 leading-snug">
                  Audit only — who took the money. Does not add to payroll, NSSF, or advances.
                  {staffRequired ? ' Required for Employee Allowances.' : ' Recommended for daily transport paid to staff.'}
                </p>
              </div>

              {/* Description */}
              <div className="md:col-span-2">
                <Label htmlFor="description" className="text-sm font-medium">
                  Description
                </Label>
                <Textarea
                  id="description"
                  placeholder="Enter description (optional)"
                  rows={2}
                  {...register('description')}
                  className="resize-none"
                />
              </div>

              {/* Notes */}
              <div className="md:col-span-2">
                <Label htmlFor="notes" className="text-sm font-medium">
                  Notes
                </Label>
                <Textarea
                  id="notes"
                  placeholder="Additional notes (optional)"
                  rows={2}
                  {...register('notes')}
                  className="resize-none"
                />
              </div>
            </div>

            {/* Receipt Alert (compact) */}
            {(watchedCategory === 'FUEL' ||
              watchedCategory === 'MEALS' ||
              watchedCategory === 'ACCOMMODATION' ||
              watchedCategory === 'EQUIPMENT' ||
              watchedCategory === 'MAINTENANCE' ||
              (watchedAmount && watchedAmount > 50)) && (
                <Alert className="py-2">
                  <Receipt className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    Receipt required for this category/amount
                  </AlertDescription>
                </Alert>
              )}

            {/* Document Upload (compact) */}
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-4 text-center bg-gray-50">
              <Receipt className="h-8 w-8 mx-auto text-gray-400 mb-1" />
              <p className="text-xs text-gray-500">Document upload (Coming soon)</p>
            </div>
          </CardContent>
        </Card>

        {/* Form Actions */}
        <div className="flex justify-end gap-4 pt-6 border-t-2 sticky bottom-0 bg-white -mx-6 px-6 pb-2">
          {onCancel && (
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={createExpense.isPending}
              size="lg"
            >
              Cancel
            </Button>
          )}

          <Button
            type="submit"
            disabled={!isValid || createExpense.isPending}
            className="min-w-[160px] bg-blue-600 hover:bg-blue-700"
            size="lg"
          >
            {createExpense.isPending ? (
              <>
                <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <FileText className="h-5 w-5 mr-2" />
                Create Expense
              </>
            )}
          </Button>
        </div>
      </form>
    </div>
  );
};