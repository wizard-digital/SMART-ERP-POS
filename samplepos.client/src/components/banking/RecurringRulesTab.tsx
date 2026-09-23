/**
 * RECURRING RULES TAB
 * 
 * Manage recurring transaction rules for automatic detection
 * and alert generation for expected transactions.
 */

import React, { useState } from 'react';
import { Plus, Edit2, Trash2, Clock, Calendar, AlertTriangle, Check, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import {
    useRecurringRules,
    useCreateRecurringRule,
    useUpdateRecurringRule,
    useDeleteRecurringRule,
    useCheckOverdueRecurring,
    useBankAccounts,
    useBankCategories,
    BankRecurringRule,
} from '../../hooks/useBanking';
import { formatCurrency } from '../../utils/currency';
import { formatTimestampDate } from '../../utils/businessDate';

interface RuleFormData {
    name: string;
    bankAccountId: string;
    frequency: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
    expectedDay: number;
    expectedAmount: number;
    tolerancePercent: number;
    categoryId: string;
    descriptionContains: string;
}

const defaultFormData: RuleFormData = {
    name: '',
    bankAccountId: '',
    frequency: 'MONTHLY',
    expectedDay: 1,
    expectedAmount: 0,
    tolerancePercent: 10,
    categoryId: '',
    descriptionContains: '',
};

export const RecurringRulesTab: React.FC = () => {
    const [showForm, setShowForm] = useState(false);
    const [editingRule, setEditingRule] = useState<BankRecurringRule | null>(null);
    const [formData, setFormData] = useState<RuleFormData>(defaultFormData);

    const { data: rules = [], isLoading } = useRecurringRules();
    const { data: accounts = [] } = useBankAccounts();
    const { data: categories = [] } = useBankCategories();

    const createMutation = useCreateRecurringRule();
    const updateMutation = useUpdateRecurringRule();
    const deleteMutation = useDeleteRecurringRule();
    const checkOverdueMutation = useCheckOverdueRecurring();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        const payload = {
            name: formData.name,
            bankAccountId: formData.bankAccountId,
            matchRules: {
                descriptionContains: formData.descriptionContains ? [formData.descriptionContains] : undefined,
            },
            frequency: formData.frequency,
            expectedDay: formData.expectedDay,
            expectedAmount: formData.expectedAmount,
            tolerancePercent: formData.tolerancePercent,
            categoryId: formData.categoryId || undefined,
        };

        try {
            if (editingRule) {
                await updateMutation.mutateAsync({ id: editingRule.id, data: payload });
            } else {
                await createMutation.mutateAsync(payload);
            }
            resetForm();
        } catch (error) {
            console.error('Failed to save rule:', error);
        }
    };

    const resetForm = () => {
        setFormData(defaultFormData);
        setEditingRule(null);
        setShowForm(false);
    };

    const startEdit = (rule: BankRecurringRule) => {
        setEditingRule(rule);
        setFormData({
            name: rule.name,
            bankAccountId: rule.bankAccountId,
            frequency: rule.frequency,
            expectedDay: rule.expectedDay,
            expectedAmount: rule.expectedAmount,
            tolerancePercent: rule.tolerancePercent,
            categoryId: rule.categoryId || '',
            descriptionContains: rule.matchRules?.descriptionContains?.[0] || '',
        });
        setShowForm(true);
    };

    const handleDelete = async (id: string) => {
        if (window.confirm('Are you sure you want to delete this recurring rule?')) {
            await deleteMutation.mutateAsync(id);
        }
    };

    const handleCheckOverdue = async () => {
        const result = await checkOverdueMutation.mutateAsync();
        alert(`Created ${result.alertsCreated} overdue alert(s)`);
    };

    const getFrequencyLabel = (freq: string) => {
        const labels: Record<string, string> = {
            WEEKLY: 'Weekly',
            BIWEEKLY: 'Bi-weekly',
            MONTHLY: 'Monthly',
            QUARTERLY: 'Quarterly',
            YEARLY: 'Yearly',
        };
        return labels[freq] || freq;
    };

    const getDayLabel = (day: number, freq: string) => {
        if (freq === 'WEEKLY' || freq === 'BIWEEKLY') {
            const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            return days[day] || `Day ${day}`;
        }
        return `Day ${day}`;
    };

    if (isLoading) {
        return <div className="p-4">Loading recurring rules...</div>;
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-2xl font-bold">Recurring Transactions</h2>
                    <p className="text-muted-foreground">
                        Set up rules to automatically detect expected recurring transactions
                    </p>
                </div>
                <div className="flex gap-2">
                    <Button variant="outline" onClick={handleCheckOverdue} disabled={checkOverdueMutation.isPending}>
                        <AlertTriangle className="h-4 w-4 mr-2" />
                        Check Overdue
                    </Button>
                    <Button onClick={() => setShowForm(true)}>
                        <Plus className="h-4 w-4 mr-2" />
                        Add Rule
                    </Button>
                </div>
            </div>

            {/* Create/Edit Form */}
            {showForm && (
                <Card>
                    <CardHeader>
                        <CardTitle>{editingRule ? 'Edit Rule' : 'New Recurring Rule'}</CardTitle>
                        <CardDescription>
                            Define a recurring transaction pattern to monitor
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={handleSubmit} className="space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label htmlFor="name">Rule Name</Label>
                                    <Input
                                        id="name"
                                        value={formData.name}
                                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                        placeholder="e.g., Monthly Rent Payment"
                                        required
                                    />
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="bankAccountId">Bank Account</Label>
                                    <select
                                        id="bankAccountId"
                                        aria-label="Bank Account"
                                        className="w-full h-10 px-3 border rounded-md bg-background"
                                        value={formData.bankAccountId}
                                        onChange={(e) => setFormData({ ...formData, bankAccountId: e.target.value })}
                                        required
                                    >
                                        <option value="">Select account...</option>
                                        {accounts.map((acc) => (
                                            <option key={acc.id} value={acc.id}>{acc.name}</option>
                                        ))}
                                    </select>
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="frequency">Frequency</Label>
                                    <select
                                        id="frequency"
                                        aria-label="Frequency"
                                        className="w-full h-10 px-3 border rounded-md bg-background"
                                        value={formData.frequency}
                                        onChange={(e) => setFormData({ ...formData, frequency: e.target.value as RuleFormData['frequency'] })}
                                    >
                                        <option value="WEEKLY">Weekly</option>
                                        <option value="BIWEEKLY">Bi-weekly</option>
                                        <option value="MONTHLY">Monthly</option>
                                        <option value="QUARTERLY">Quarterly</option>
                                        <option value="YEARLY">Yearly</option>
                                    </select>
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="expectedDay">
                                        Expected Day {formData.frequency === 'WEEKLY' || formData.frequency === 'BIWEEKLY' ? '(0=Sun, 6=Sat)' : 'of Month'}
                                    </Label>
                                    <Input
                                        id="expectedDay"
                                        type="number"
                                        min={formData.frequency === 'WEEKLY' || formData.frequency === 'BIWEEKLY' ? 0 : 1}
                                        max={formData.frequency === 'WEEKLY' || formData.frequency === 'BIWEEKLY' ? 6 : 31}
                                        value={formData.expectedDay}
                                        onChange={(e) => setFormData({ ...formData, expectedDay: parseInt(e.target.value) || 1 })}
                                    />
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="expectedAmount">Expected Amount</Label>
                                    <Input
                                        id="expectedAmount"
                                        type="number"
                                        step="1"
                                        value={formData.expectedAmount}
                                        onChange={(e) => setFormData({ ...formData, expectedAmount: parseFloat(e.target.value) || 0 })}
                                        required
                                    />
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="tolerancePercent">Tolerance %</Label>
                                    <Input
                                        id="tolerancePercent"
                                        type="number"
                                        min={0}
                                        max={100}
                                        value={formData.tolerancePercent}
                                        onChange={(e) => setFormData({ ...formData, tolerancePercent: parseInt(e.target.value) || 10 })}
                                    />
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="categoryId">Category (Optional)</Label>
                                    <select
                                        id="categoryId"
                                        aria-label="Category"
                                        className="w-full h-10 px-3 border rounded-md bg-background"
                                        value={formData.categoryId}
                                        onChange={(e) => setFormData({ ...formData, categoryId: e.target.value })}
                                    >
                                        <option value="">No category</option>
                                        {categories.map((cat) => (
                                            <option key={cat.id} value={cat.id}>{cat.name}</option>
                                        ))}
                                    </select>
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="descriptionContains">Description Contains</Label>
                                    <Input
                                        id="descriptionContains"
                                        value={formData.descriptionContains}
                                        onChange={(e) => setFormData({ ...formData, descriptionContains: e.target.value })}
                                        placeholder="e.g., RENT PAYMENT"
                                    />
                                </div>
                            </div>

                            <div className="flex gap-2 justify-end">
                                <Button type="button" variant="outline" onClick={resetForm}>
                                    Cancel
                                </Button>
                                <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                                    {editingRule ? 'Update Rule' : 'Create Rule'}
                                </Button>
                            </div>
                        </form>
                    </CardContent>
                </Card>
            )}

            {/* Rules Table */}
            <Card>
                <CardHeader>
                    <CardTitle>Active Rules</CardTitle>
                    <CardDescription>
                        {rules.length} recurring rule{rules.length !== 1 ? 's' : ''} configured
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {rules.length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground">
                            <Clock className="h-12 w-12 mx-auto mb-4 opacity-50" />
                            <p>No recurring rules configured</p>
                            <p className="text-sm">Create a rule to monitor expected transactions</p>
                        </div>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Name</TableHead>
                                    <TableHead>Account</TableHead>
                                    <TableHead>Frequency</TableHead>
                                    <TableHead>Expected</TableHead>
                                    <TableHead>Last Matched</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead className="text-right">Actions</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rules.map((rule) => (
                                    <TableRow key={rule.id}>
                                        <TableCell className="font-medium">{rule.name}</TableCell>
                                        <TableCell>{rule.bankAccountName || 'Unknown'}</TableCell>
                                        <TableCell>
                                            <div className="flex items-center gap-1">
                                                <Calendar className="h-4 w-4 text-muted-foreground" />
                                                {getFrequencyLabel(rule.frequency)} ({getDayLabel(rule.expectedDay, rule.frequency)})
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            {formatCurrency(rule.expectedAmount)}
                                            <span className="text-muted-foreground text-xs ml-1">±{rule.tolerancePercent}%</span>
                                        </TableCell>
                                        <TableCell>
                                            {rule.lastMatchedAt ? (
                                                <span title={rule.lastMatchedAt}>
                                                    {formatTimestampDate(rule.lastMatchedAt)}
                                                </span>
                                            ) : (
                                                <span className="text-muted-foreground">Never</span>
                                            )}
                                        </TableCell>
                                        <TableCell>
                                            {rule.isActive ? (
                                                <Badge variant="default" className="bg-green-600">
                                                    <Check className="h-3 w-3 mr-1" />
                                                    Active
                                                </Badge>
                                            ) : (
                                                <Badge variant="secondary">
                                                    <X className="h-3 w-3 mr-1" />
                                                    Inactive
                                                </Badge>
                                            )}
                                            {rule.missCount > 0 && (
                                                <Badge variant="destructive" className="ml-1">
                                                    {rule.missCount} missed
                                                </Badge>
                                            )}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <Button variant="ghost" size="sm" onClick={() => startEdit(rule)}>
                                                <Edit2 className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => handleDelete(rule.id)}
                                                disabled={deleteMutation.isPending}
                                            >
                                                <Trash2 className="h-4 w-4 text-destructive" />
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>
        </div>
    );
};

export default RecurringRulesTab;
