import { useState, useEffect } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiResponse } from '../../../services/api';
import { useRegisters, useCreateRegister, useUpdateRegister } from '../../../hooks/useCashRegister';
import type { CashRegister } from '../../../types/cashRegister';
import { TransferPolicySettingsPanel } from '../../../components/inventory/TransferPolicySettingsPanel';
import {
    invalidateMultistoreModeQueries,
    multistoreKeys,
    setMultistoreEnabledOptimistic,
} from '../../../hooks/useMultistore';
import ReceiptPrintingSettings from './ReceiptPrintingSettings';
import {
    POS_SESSION_POLICY_DEFINITIONS,
    POS_SESSION_POLICY_STORAGE_KEY,
    getPosSessionPolicyDefinition,
    parsePosSessionPolicy,
    type PosSessionPolicy,
} from '@shared/pos/posSessionPolicySsot';

interface TaxRate {
    name: string;
    rate: number;
    default?: boolean;
    description?: string;
}

interface SystemSettings {
    id: string;
    businessName: string;
    currencyCode: string;
    currencySymbol: string;
    dateFormat: string;
    timeFormat: string;
    timezone: string;
    taxEnabled: boolean;
    defaultTaxRate: number;
    taxName: string;
    taxNumber?: string;
    taxInclusive: boolean;
    taxRates: TaxRate[];
    /** DocumentTax: output VAT only for VAT-registered customers when true */
    vatOutputRequiresRegisteredCustomer?: boolean;
    receiptPrinterEnabled: boolean;
    receiptPrinterName?: string;
    receiptPaperWidth: number;
    receiptAutoPrint: boolean;
    receiptShowLogo: boolean;
    receiptLogoUrl?: string;
    receiptHeaderText?: string;
    receiptFooterText?: string;
    receiptShowTaxBreakdown: boolean;
    receiptShowQrCode: boolean;
    invoicePrinterEnabled: boolean;
    invoicePrinterName?: string;
    invoicePaperSize: string;
    invoiceTemplate: string;
    invoiceShowLogo: boolean;
    invoiceShowPaymentTerms: boolean;
    invoiceDefaultPaymentTerms?: string;
    lowStockAlertsEnabled: boolean;
    lowStockThreshold: number;
    posSessionPolicy: PosSessionPolicy;
    posTransactionMode: 'DirectSale' | 'OrderToPayment';
    isMultistoreEnabled?: boolean;
    transferPolicyRequireApprovalAll?: boolean;
    transferPolicyAllowDirect?: boolean;
    transferPolicyValueThreshold?: number | null;
    transferPolicyQtyThreshold?: number | null;
    transferPolicySpecialStoresRequireApproval?: boolean;
    transferAssortmentExpansionPolicy?: 'PROMPT' | 'ALWAYS_EXPAND' | 'TRANSFER_ONLY';
    expiryAutomationEnabled?: boolean;
    quarantineAutoDisposeEnabled?: boolean;
    quarantineAutoDisposeMinAgeDays?: number;
    /** ADR-003 — Treasury Document domain (cash/bank liquidity documents) */
    treasuryDocumentEnabled?: boolean;
    /** Restaurant FOH module (tables, KOT, SambaPOS-style ordering) */
    restaurantModeEnabled?: boolean;
    /** ADR-005 Kitchen Production cook-to-stock batches */
    kitchenProductionEnabled?: boolean;
}

async function fetchSettings(): Promise<SystemSettings> {
    const response = await api.get<ApiResponse<SystemSettings>>('/system-settings');
    if (!response.data.success) throw new Error(response.data.error);
    return response.data.data!;
}

async function updateSettings(updates: Partial<SystemSettings>): Promise<{
    settings: SystemSettings;
    multistoreBootstrap?: {
        enabled: boolean;
        storesEnsured: boolean;
        warnings?: string[];
    };
}> {
    const response = await api.patch<
        ApiResponse<SystemSettings> & {
            meta?: {
                multistoreBootstrap?: {
                    enabled: boolean;
                    storesEnsured: boolean;
                    warnings?: string[];
                };
            };
        }
    >('/system-settings', updates);
    if (!response.data.success) throw new Error(response.data.error);
    return {
        settings: response.data.data!,
        multistoreBootstrap: response.data.meta?.multistoreBootstrap,
    };
}

interface SettingsComponentProps {
    settings: SystemSettings;
    onSave: (updates: Partial<SystemSettings>) => void;
    isSaving: boolean;
}

export default function SystemSettingsTab() {
    const queryClient = useQueryClient();
    const [activeTab, setActiveTab] = useState('general');
    const [isSaving, setIsSaving] = useState(false);
    const [saveMessage, setSaveMessage] = useState('');

    const { data: settings, isLoading } = useQuery({
        queryKey: ['systemSettings'],
        queryFn: fetchSettings,
    });

    const mutation = useMutation({
        mutationFn: updateSettings,
        onSuccess: (result, variables) => {
            queryClient.setQueryData(['systemSettings'], result.settings);
            if (variables.isMultistoreEnabled !== undefined) {
                setMultistoreEnabledOptimistic(queryClient, variables.isMultistoreEnabled);
                invalidateMultistoreModeQueries(queryClient);
                if (variables.isMultistoreEnabled && result.multistoreBootstrap?.storesEnsured) {
                    const warn = result.multistoreBootstrap.warnings?.[0];
                    setSaveMessage(
                        warn
                            ? `Multi-store enabled (MAIN/TRANSIT/SELLING ready). Inventory heal still needed: ${warn}`
                            : 'Multi-store warehouse enabled. MAIN, TRANSIT, and SELLING stores are ready.',
                    );
                } else if (variables.isMultistoreEnabled === false) {
                    setSaveMessage('Multi-store warehouse disabled. Legacy single-store inventory is active.');
                } else {
                    setSaveMessage('Settings saved successfully!');
                }
            } else {
                queryClient.invalidateQueries({ queryKey: ['systemSettings'] });
                setSaveMessage('Settings saved successfully!');
            }
            if (variables.treasuryDocumentEnabled !== undefined) {
                void queryClient.invalidateQueries({ queryKey: ['treasury', 'enabled'] });
            }
            if (variables.restaurantModeEnabled !== undefined) {
                void queryClient.invalidateQueries({ queryKey: ['restaurant', 'enabled'] });
            }
            if (variables.kitchenProductionEnabled !== undefined) {
                void queryClient.invalidateQueries({ queryKey: ['kitchen-production', 'enabled'] });
            }
            // Immediately write transaction mode to localStorage so that:
            // 1. Same-tab POS page picks it up on next render (via cache read)
            // 2. Other tabs receive a 'storage' event and invalidate their query
            if (variables.posTransactionMode) {
                localStorage.setItem('pos_transaction_mode', variables.posTransactionMode);
            }
            if (variables.posSessionPolicy) {
                localStorage.setItem(POS_SESSION_POLICY_STORAGE_KEY, variables.posSessionPolicy);
            }
            // Invalidate cash register session so POS refetches from server immediately
            queryClient.invalidateQueries({ queryKey: ['cash-register-session', 'current'] });
            setIsSaving(false);
            setTimeout(() => setSaveMessage(''), 5000);
        },
        onError: (error: Error, variables) => {
            if (variables.isMultistoreEnabled !== undefined) {
                void queryClient.invalidateQueries({ queryKey: multistoreKeys.settings() });
                invalidateMultistoreModeQueries(queryClient);
            }
            setIsSaving(false);
            setSaveMessage(`Error: ${error.message}`);
            setTimeout(() => setSaveMessage(''), 5000);
        },
    });

    const handleSave = (updates: Partial<SystemSettings>) => {
        setIsSaving(true);
        mutation.mutate(updates);
    };

    if (isLoading) {
        return (
            <div className="bg-white rounded-lg shadow-sm p-6">
                <p className="text-gray-600">Loading settings...</p>
            </div>
        );
    }

    if (!settings) {
        return (
            <div className="bg-white rounded-lg shadow-sm p-6">
                <p className="text-red-600">Failed to load settings</p>
            </div>
        );
    }

    return (
        <div className="bg-white rounded-lg shadow-sm">
            {saveMessage && (
                <div
                    className={`mb-4 p-4 rounded ${saveMessage.startsWith('Error') ? 'bg-red-50 text-red-800' : 'bg-green-50 text-green-800'
                        }`}
                >
                    {saveMessage}
                </div>
            )}

            <Tabs.Root value={activeTab} onValueChange={setActiveTab}>
                <Tabs.List className="flex border-b border-gray-200 overflow-x-auto">
                    <Tabs.Trigger
                        value="general"
                        className="px-3 sm:px-6 py-3 text-sm font-medium text-gray-600 border-b-2 border-transparent hover:text-gray-900 hover:border-gray-300 data-[state=active]:text-blue-600 data-[state=active]:border-blue-600 whitespace-nowrap"
                    >
                        General
                    </Tabs.Trigger>
                    <Tabs.Trigger
                        value="tax"
                        className="px-3 sm:px-6 py-3 text-sm font-medium text-gray-600 border-b-2 border-transparent hover:text-gray-900 hover:border-gray-300 data-[state=active]:text-blue-600 data-[state=active]:border-blue-600 whitespace-nowrap"
                    >
                        Tax
                    </Tabs.Trigger>
                    <Tabs.Trigger
                        value="printing"
                        className="px-3 sm:px-6 py-3 text-sm font-medium text-gray-600 border-b-2 border-transparent hover:text-gray-900 hover:border-gray-300 data-[state=active]:text-blue-600 data-[state=active]:border-blue-600 whitespace-nowrap"
                    >
                        Printing
                    </Tabs.Trigger>
                    <Tabs.Trigger
                        value="alerts"
                        className="px-3 sm:px-6 py-3 text-sm font-medium text-gray-600 border-b-2 border-transparent hover:text-gray-900 hover:border-gray-300 data-[state=active]:text-blue-600 data-[state=active]:border-blue-600 whitespace-nowrap"
                    >
                        Alerts
                    </Tabs.Trigger>
                    <Tabs.Trigger
                        value="inventory"
                        className="px-3 sm:px-6 py-3 text-sm font-medium text-gray-600 border-b-2 border-transparent hover:text-gray-900 hover:border-gray-300 data-[state=active]:text-blue-600 data-[state=active]:border-blue-600 whitespace-nowrap"
                    >
                        Inventory
                    </Tabs.Trigger>
                    <Tabs.Trigger
                        value="registers"
                        className="px-3 sm:px-6 py-3 text-sm font-medium text-gray-600 border-b-2 border-transparent hover:text-gray-900 hover:border-gray-300 data-[state=active]:text-blue-600 data-[state=active]:border-blue-600 whitespace-nowrap"
                    >
                        Registers
                    </Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="general" className="p-6">
                    <GeneralSettings settings={settings} onSave={handleSave} isSaving={isSaving} />
                </Tabs.Content>

                <Tabs.Content value="tax" className="p-6">
                    <TaxSettings settings={settings} onSave={handleSave} isSaving={isSaving} />
                </Tabs.Content>

                <Tabs.Content value="printing" className="p-6">
                    <ReceiptPrintingSettings settings={settings} onSave={handleSave} isSaving={isSaving} />
                </Tabs.Content>

                <Tabs.Content value="alerts" className="p-6">
                    <AlertSettings settings={settings} onSave={handleSave} isSaving={isSaving} />
                </Tabs.Content>

                <Tabs.Content value="inventory" className="p-6">
                    <InventorySettings settings={settings} onSave={handleSave} isSaving={isSaving} />
                </Tabs.Content>

                <Tabs.Content value="registers" className="p-6">
                    <RegisterManagement settings={settings} onSave={handleSave} isSaving={isSaving} />
                </Tabs.Content>
            </Tabs.Root>
        </div>
    );
}

// General Settings Tab
function GeneralSettings({
    settings,
    onSave,
    isSaving,
}: {
    settings: SystemSettings;
    onSave: (updates: Partial<SystemSettings>) => void;
    isSaving: boolean;
}) {
    const [formData, setFormData] = useState({
        businessName: settings.businessName,
        currencyCode: settings.currencyCode,
        currencySymbol: settings.currencySymbol,
        dateFormat: settings.dateFormat,
        timeFormat: settings.timeFormat,
        timezone: settings.timezone,
    });

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(formData);
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-6">
            <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Business Information</h3>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                            Business Name
                        </label>
                        <input
                            type="text"
                            value={formData.businessName}
                            onChange={(e) => setFormData({ ...formData, businessName: e.target.value })}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                            aria-label="Business Name"
                            required
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Currency Code
                            </label>
                            <input
                                type="text"
                                value={formData.currencyCode}
                                onChange={(e) => setFormData({ ...formData, currencyCode: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                                placeholder="UGX"
                                required
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Currency Symbol
                            </label>
                            <input
                                type="text"
                                value={formData.currencySymbol}
                                onChange={(e) => setFormData({ ...formData, currencySymbol: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                                placeholder="UGX"
                                required
                            />
                        </div>
                    </div>
                </div>
            </div>

            <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Regional Settings</h3>

                <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Date Format
                            </label>
                            <select
                                value={formData.dateFormat}
                                onChange={(e) => setFormData({ ...formData, dateFormat: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                                aria-label="Date Format"
                            >
                                <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                                <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                                <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                            </select>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Time Format
                            </label>
                            <select
                                value={formData.timeFormat}
                                onChange={(e) => setFormData({ ...formData, timeFormat: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                                aria-label="Time Format"
                            >
                                <option value="24h">24 Hour</option>
                                <option value="12h">12 Hour (AM/PM)</option>
                            </select>
                        </div>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                            Timezone
                        </label>
                        <select
                            value={formData.timezone}
                            onChange={(e) => setFormData({ ...formData, timezone: e.target.value })}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                            aria-label="Timezone"
                        >
                            <option value="Africa/Kampala">Africa/Kampala (EAT)</option>
                            <option value="Africa/Nairobi">Africa/Nairobi (EAT)</option>
                            <option value="Africa/Lagos">Africa/Lagos (WAT)</option>
                            <option value="UTC">UTC</option>
                        </select>
                    </div>
                </div>
            </div>

            <div className="flex justify-end">
                <button
                    type="submit"
                    disabled={isSaving}
                    className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isSaving ? 'Saving...' : 'Save General Settings'}
                </button>
            </div>
        </form>
    );
}

// Tax Settings Tab
function TaxSettings({
    settings,
    onSave,
    isSaving,
}: {
    settings: SystemSettings;
    onSave: (updates: Partial<SystemSettings>) => void;
    isSaving: boolean;
}) {
    const [formData, setFormData] = useState({
        taxEnabled: settings.taxEnabled,
        taxName: settings.taxName,
        taxNumber: settings.taxNumber || '',
        defaultTaxRate: settings.defaultTaxRate,
        taxInclusive: settings.taxInclusive,
        taxRates: settings.taxRates || [],
        vatOutputRequiresRegisteredCustomer:
            settings.vatOutputRequiresRegisteredCustomer ?? false,
        treasuryDocumentEnabled: settings.treasuryDocumentEnabled ?? false,
        restaurantModeEnabled: settings.restaurantModeEnabled ?? false,
        kitchenProductionEnabled: settings.kitchenProductionEnabled ?? false,
    });

    const [newRate, setNewRate] = useState({ name: '', rate: 0, description: '' });

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(formData);
    };

    const addTaxRate = () => {
        if (newRate.name && newRate.rate >= 0) {
            setFormData({
                ...formData,
                taxRates: [...formData.taxRates, { ...newRate, default: formData.taxRates.length === 0 }],
            });
            setNewRate({ name: '', rate: 0, description: '' });
        }
    };

    const removeTaxRate = (index: number) => {
        setFormData({
            ...formData,
            taxRates: formData.taxRates.filter((_, i) => i !== index),
        });
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-6">
            <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Tax Configuration</h3>

                <div className="space-y-4">
                    <div className="flex items-center">
                        <input
                            type="checkbox"
                            id="taxEnabled"
                            checked={formData.taxEnabled}
                            onChange={(e) => setFormData({ ...formData, taxEnabled: e.target.checked })}
                            className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <label htmlFor="taxEnabled" className="ml-2 block text-sm text-gray-900">
                            Enable Tax System
                        </label>
                    </div>

                    <div className="flex items-start">
                        <input
                            type="checkbox"
                            id="vatOutputRequiresRegisteredCustomer"
                            checked={formData.vatOutputRequiresRegisteredCustomer}
                            onChange={(e) =>
                                setFormData({
                                    ...formData,
                                    vatOutputRequiresRegisteredCustomer: e.target.checked,
                                })
                            }
                            className="mt-0.5 h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <div className="ml-2">
                            <label
                                htmlFor="vatOutputRequiresRegisteredCustomer"
                                className="block text-sm font-medium text-gray-900"
                            >
                                VAT only for registered customers
                            </label>
                            <p className="mt-0.5 text-xs text-gray-600">
                                Walk-in and non-VAT-registered customers get 0% output VAT. VAT-registered
                                customers use product / mapping / profile rates.
                            </p>
                        </div>
                    </div>

                    <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-3">
                        <div className="flex items-start">
                            <input
                                type="checkbox"
                                id="treasuryDocumentEnabled"
                                checked={formData.treasuryDocumentEnabled}
                                onChange={(e) =>
                                    setFormData({
                                        ...formData,
                                        treasuryDocumentEnabled: e.target.checked,
                                    })
                                }
                                className="mt-0.5 h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                            />
                            <div className="ml-2">
                                <label
                                    htmlFor="treasuryDocumentEnabled"
                                    className="block text-sm font-medium text-gray-900"
                                >
                                    Enable Treasury Documents
                                </label>
                                <p className="mt-0.5 text-xs text-gray-600">
                                    Authorize cash and bank liquidity movements through treasury
                                    documents. Existing cash and banking workflows stay available
                                    until you switch over.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-3">
                        <div className="flex items-start">
                            <input
                                type="checkbox"
                                id="restaurantModeEnabled"
                                checked={formData.restaurantModeEnabled}
                                onChange={(e) =>
                                    setFormData({
                                        ...formData,
                                        restaurantModeEnabled: e.target.checked,
                                        // Kitchen is restaurant-domain — auto-off when restaurant is off
                                        kitchenProductionEnabled: e.target.checked
                                            ? formData.kitchenProductionEnabled
                                            : false,
                                    })
                                }
                                className="mt-0.5 h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                            />
                            <div className="ml-2">
                                <label
                                    htmlFor="restaurantModeEnabled"
                                    className="block text-sm font-medium text-gray-900"
                                >
                                    Enable Restaurant Module
                                </label>
                                <p className="mt-0.5 text-xs text-gray-600">
                                    Tables, kitchen tickets (KOT), Kitchen Display, Kitchen Production,
                                    and SambaPOS-style restaurant POS. Pure retail tenants leave this
                                    off — no restaurant UI or kitchen modules.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-3">
                        <div className="flex items-start">
                            <input
                                type="checkbox"
                                id="kitchenProductionEnabled"
                                checked={
                                    Boolean(formData.restaurantModeEnabled) &&
                                    Boolean(formData.kitchenProductionEnabled)
                                }
                                disabled={!formData.restaurantModeEnabled}
                                onChange={(e) =>
                                    setFormData({
                                        ...formData,
                                        kitchenProductionEnabled: e.target.checked,
                                    })
                                }
                                className="mt-0.5 h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 disabled:opacity-50"
                            />
                            <div className="ml-2">
                                <label
                                    htmlFor="kitchenProductionEnabled"
                                    className={`block text-sm font-medium ${
                                        formData.restaurantModeEnabled
                                            ? 'text-gray-900'
                                            : 'text-gray-400'
                                    }`}
                                >
                                    Enable Kitchen Production
                                </label>
                                <p className="mt-0.5 text-xs text-gray-600">
                                    Cook-to-stock prep batches under Restaurant mode (issue ingredients,
                                    receive finished food). Requires Restaurant Module above. Does not
                                    replace cook-to-order recipe explosion at payment.
                                </p>
                            </div>
                        </div>
                    </div>

                    {formData.taxEnabled && (
                        <>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">
                                        Tax Name
                                    </label>
                                    <input
                                        type="text"
                                        value={formData.taxName}
                                        onChange={(e) => setFormData({ ...formData, taxName: e.target.value })}
                                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                                        placeholder="VAT, GST, Sales Tax"
                                        required
                                    />
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">
                                        Tax Registration Number
                                    </label>
                                    <input
                                        type="text"
                                        value={formData.taxNumber}
                                        onChange={(e) => setFormData({ ...formData, taxNumber: e.target.value })}
                                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                                        placeholder="TIN/VAT Number"
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Default Tax Rate (%)
                                </label>
                                <input
                                    type="number"
                                    step="0.01"
                                    value={formData.defaultTaxRate}
                                    onChange={(e) => setFormData({ ...formData, defaultTaxRate: parseFloat(e.target.value) })}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                                    aria-label="Default Tax Rate"
                                    required
                                />
                            </div>
                        </>
                    )}

                    {/* Price-mode SSOT — independent of restaurant tax master; retail product VAT uses it too. */}
                    <div className="flex items-start rounded-md border border-gray-200 bg-gray-50 px-3 py-3">
                        <input
                            type="checkbox"
                            id="taxInclusive"
                            checked={formData.taxInclusive}
                            onChange={(e) => setFormData({ ...formData, taxInclusive: e.target.checked })}
                            className="mt-0.5 h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <div className="ml-2">
                            <label htmlFor="taxInclusive" className="block text-sm font-medium text-gray-900">
                                Tax inclusive with price
                            </label>
                            <p className="mt-0.5 text-xs text-gray-600">
                                Tenant price-mode SSOT. Mark each product VAT liable (or map in Tax Engine);
                                POS posts tax from that + this flag only.
                            </p>
                            <ul className="mt-1.5 text-xs text-gray-600 list-disc list-inside space-y-0.5">
                                <li>
                                    <strong>Unticked (exclusive):</strong> selling price is net — add output
                                    VAT on top when the product is liable.
                                </li>
                                <li>
                                    <strong>Ticked (inclusive):</strong> selling price already includes VAT —
                                    extract for receipt/GL; charge stays the shelf total.
                                </li>
                            </ul>
                        </div>
                    </div>
                </div>
            </div>

            {formData.taxEnabled && (
                <div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-4">Multiple Tax Rates</h3>

                    <div className="space-y-4">
                        {formData.taxRates.map((rate, index) => (
                            <div key={index} className="flex items-center gap-4 p-3 bg-gray-50 rounded-md">
                                <div className="flex-1">
                                    <span className="font-medium">{rate.name}</span> - {rate.rate}%
                                    {rate.description && (
                                        <span className="text-sm text-gray-600 ml-2">({rate.description})</span>
                                    )}
                                    {rate.default && (
                                        <span className="ml-2 px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded">
                                            Default
                                        </span>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    onClick={() => removeTaxRate(index)}
                                    className="text-red-600 hover:text-red-800"
                                >
                                    Remove
                                </button>
                            </div>
                        ))}

                        <div className="flex gap-2">
                            <input
                                type="text"
                                placeholder="Rate name"
                                value={newRate.name}
                                onChange={(e) => setNewRate({ ...newRate, name: e.target.value })}
                                className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                            />
                            <input
                                type="number"
                                step="0.01"
                                placeholder="Rate %"
                                value={newRate.rate}
                                onChange={(e) => setNewRate({ ...newRate, rate: parseFloat(e.target.value) })}
                                className="w-32 px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                            />
                            <button
                                type="button"
                                onClick={addTaxRate}
                                className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700"
                            >
                                Add Rate
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="flex justify-end">
                <button
                    type="submit"
                    disabled={isSaving}
                    className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isSaving ? 'Saving...' : 'Save Tax Settings'}
                </button>
            </div>
        </form>
    );
}

// Alert Settings Tab
function AlertSettings({
    settings,
    onSave,
    isSaving,
}: {
    settings: SystemSettings;
    onSave: (updates: Partial<SystemSettings>) => void;
    isSaving: boolean;
}) {
    const [formData, setFormData] = useState({
        lowStockAlertsEnabled: settings.lowStockAlertsEnabled,
        lowStockThreshold: settings.lowStockThreshold,
    });

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(formData);
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-6">
            <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Low Stock Alerts</h3>

                <div className="space-y-4">
                    <div className="flex items-center">
                        <input
                            type="checkbox"
                            id="lowStockAlertsEnabled"
                            checked={formData.lowStockAlertsEnabled}
                            onChange={(e) => setFormData({ ...formData, lowStockAlertsEnabled: e.target.checked })}
                            className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <label htmlFor="lowStockAlertsEnabled" className="ml-2 block text-sm text-gray-900">
                            Enable low stock alerts
                        </label>
                    </div>

                    {formData.lowStockAlertsEnabled && (
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Alert Threshold (units)
                            </label>
                            <input
                                type="number"
                                value={formData.lowStockThreshold}
                                onChange={(e) => setFormData({ ...formData, lowStockThreshold: parseInt(e.target.value) })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                                aria-label="Low Stock Alert Threshold"
                                min="0"
                            />
                            <p className="mt-1 text-sm text-gray-500">
                                Alert when product quantity falls below this threshold
                            </p>
                        </div>
                    )}
                </div>
            </div>

            <div className="flex justify-end">
                <button
                    type="submit"
                    disabled={isSaving}
                    className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isSaving ? 'Saving...' : 'Save Alert Settings'}
                </button>
            </div>
        </form>
    );
}

// POS Session Policy (inline within Registers tab)
function POSSessionPolicyInline({
    settings,
    onSave,
    isSaving,
}: SettingsComponentProps) {
    const [policy, setPolicy] = useState<PosSessionPolicy>(
        parsePosSessionPolicy(settings.posSessionPolicy)
    );

    useEffect(() => {
        setPolicy(parsePosSessionPolicy(settings.posSessionPolicy));
    }, [settings.posSessionPolicy]);

    const selected = getPosSessionPolicyDefinition(policy);

    const handleSave = () => {
        onSave({ posSessionPolicy: policy });
    };

    return (
        <div className="space-y-6">
            <div>
                <h3 className="text-lg font-semibold text-gray-900">POS Session Policy</h3>
                <p className="text-sm text-gray-500 mt-1">
                    One policy for cashiers, registers, and sales. Opening a drawer, joining a counter,
                    and whether a sale is allowed all follow this setting.
                </p>
            </div>

            <div className="space-y-3">
                {POS_SESSION_POLICY_DEFINITIONS.map((p) => (
                    <label
                        key={p.value}
                        className={`flex items-start gap-3 p-4 border rounded-lg cursor-pointer transition-colors ${policy === p.value
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-gray-200 hover:border-gray-300'
                            }`}
                    >
                        <input
                            type="radio"
                            name="posSessionPolicy"
                            value={p.value}
                            checked={policy === p.value}
                            onChange={() => setPolicy(p.value)}
                            className="mt-1"
                        />
                        <div>
                            <div className="font-medium text-gray-900">{p.label}</div>
                            <div className="text-sm text-gray-500 mt-0.5">{p.description}</div>
                        </div>
                    </label>
                ))}
            </div>

            <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
                <p className="font-medium">How {selected.label} works with registers</p>
                <ul className="mt-2 space-y-1 list-disc list-inside text-blue-700">
                    {selected.howRegistersWork.map((line) => (
                        <li key={line}>{line}</li>
                    ))}
                </ul>
            </div>

            <div className="flex justify-end">
                <button
                    onClick={handleSave}
                    disabled={isSaving || policy === parsePosSessionPolicy(settings.posSessionPolicy)}
                    className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium py-2 px-6 rounded-lg transition-colors"
                >
                    {isSaving ? 'Saving...' : 'Save Policy'}
                </button>
            </div>
        </div>
    );
}

// POS Transaction Mode (inline within Registers tab)
function POSTransactionModeInline({
    settings,
    onSave,
    isSaving,
}: SettingsComponentProps) {
    const [mode, setMode] = useState<'DirectSale' | 'OrderToPayment'>(
        settings.posTransactionMode || 'DirectSale'
    );

    const modes = [
        {
            value: 'DirectSale' as const,
            label: 'Direct Sale',
            description: 'Standard POS flow. Cashier scans items and processes payment in one step.',
        },
        {
            value: 'OrderToPayment' as const,
            label: 'Order → Payment',
            description: 'Two-step flow. Dispenser/staff creates an order, then cashier processes payment separately. Ideal for pharmacies and split-role workflows.',
        },
    ];

    const handleSave = () => {
        onSave({ posTransactionMode: mode } as Partial<SystemSettings>);
    };

    const currentMode = settings.posTransactionMode || 'DirectSale';

    return (
        <div className="space-y-6 mt-8 pt-8 border-t border-gray-200">
            <div>
                <h3 className="text-lg font-semibold text-gray-900">POS Transaction Mode</h3>
                <p className="text-sm text-gray-500 mt-1">
                    Controls whether the POS creates sales directly or uses a two-step order→payment workflow.
                </p>
            </div>

            <div className="space-y-3">
                {modes.map((m) => (
                    <label
                        key={m.value}
                        className={`flex items-start gap-3 p-4 border rounded-lg cursor-pointer transition-colors ${mode === m.value
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-gray-200 hover:border-gray-300'
                            }`}
                    >
                        <input
                            type="radio"
                            name="posTransactionMode"
                            value={m.value}
                            checked={mode === m.value}
                            onChange={() => setMode(m.value)}
                            className="mt-1"
                        />
                        <div>
                            <div className="font-medium text-gray-900">{m.label}</div>
                            <div className="text-sm text-gray-500 mt-0.5">{m.description}</div>
                        </div>
                    </label>
                ))}
            </div>

            <div className="flex justify-end">
                <button
                    onClick={handleSave}
                    disabled={isSaving || mode === currentMode}
                    className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium py-2 px-6 rounded-lg transition-colors"
                >
                    {isSaving ? 'Saving...' : 'Save Mode'}
                </button>
            </div>
        </div>
    );
}

function InventorySettings({
    settings,
    onSave,
    isSaving,
}: SettingsComponentProps) {
    const queryClient = useQueryClient();
    const [formData, setFormData] = useState({
        isMultistoreEnabled: settings.isMultistoreEnabled ?? false,
        transferPolicyRequireApprovalAll: settings.transferPolicyRequireApprovalAll ?? true,
        transferPolicyAllowDirect: settings.transferPolicyAllowDirect ?? true,
        transferPolicyValueThreshold: settings.transferPolicyValueThreshold ?? null,
        transferPolicyQtyThreshold: settings.transferPolicyQtyThreshold ?? null,
        transferPolicySpecialStoresRequireApproval:
            settings.transferPolicySpecialStoresRequireApproval ?? true,
        transferAssortmentExpansionPolicy: settings.transferAssortmentExpansionPolicy ?? 'PROMPT',
    });

    useEffect(() => {
        setFormData({
            isMultistoreEnabled: settings.isMultistoreEnabled ?? false,
            transferPolicyRequireApprovalAll: settings.transferPolicyRequireApprovalAll ?? true,
            transferPolicyAllowDirect: settings.transferPolicyAllowDirect ?? true,
            transferPolicyValueThreshold: settings.transferPolicyValueThreshold ?? null,
            transferPolicyQtyThreshold: settings.transferPolicyQtyThreshold ?? null,
            transferPolicySpecialStoresRequireApproval:
                settings.transferPolicySpecialStoresRequireApproval ?? true,
            transferAssortmentExpansionPolicy: settings.transferAssortmentExpansionPolicy ?? 'PROMPT',
        });
    }, [settings]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(formData);
    };

    const patchPolicy = (updates: Partial<typeof formData>) => {
        const next = { ...formData, ...updates };
        setFormData(next);
        onSave({
            transferPolicyRequireApprovalAll: next.transferPolicyRequireApprovalAll,
            transferPolicyAllowDirect: next.transferPolicyAllowDirect,
            transferPolicyValueThreshold: next.transferPolicyValueThreshold,
            transferPolicyQtyThreshold: next.transferPolicyQtyThreshold,
            transferPolicySpecialStoresRequireApproval: next.transferPolicySpecialStoresRequireApproval,
            transferAssortmentExpansionPolicy: next.transferAssortmentExpansionPolicy,
        });
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-6">
            <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Warehouse Network</h3>
                <label className="flex items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={formData.isMultistoreEnabled}
                        disabled={isSaving}
                        onChange={(e) => {
                            const isMultistoreEnabled = e.target.checked;
                            setFormData((prev) => ({ ...prev, isMultistoreEnabled }));
                            setMultistoreEnabledOptimistic(queryClient, isMultistoreEnabled);
                            onSave({ isMultistoreEnabled });
                        }}
                        className="h-4 w-4 text-blue-600 border-gray-300 rounded"
                    />
                    Enable multi-store warehouse network
                </label>
                <p className="mt-1 text-sm text-gray-500">
                    Required for inter-store transfers, per-store stock, and warehouse dashboards.
                </p>
            </div>

            <TransferPolicySettingsPanel
                requireApprovalAll={formData.transferPolicyRequireApprovalAll}
                allowDirect={formData.transferPolicyAllowDirect}
                valueThreshold={formData.transferPolicyValueThreshold}
                qtyThreshold={formData.transferPolicyQtyThreshold}
                specialStoresRequireApproval={formData.transferPolicySpecialStoresRequireApproval}
                assortmentExpansionPolicy={formData.transferAssortmentExpansionPolicy}
                onChange={patchPolicy}
                isSaving={isSaving}
            />

            <div className="border-t border-gray-200 pt-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-1">Expiry automation</h3>
                <p className="text-sm text-gray-500 mb-4">
                    Nightly quarantine of calendar-expired stock (soft status or hard EXPIRED store).
                    Default off. Does not post P&amp;L — dispose from Quarantine workqueue.
                </p>
                <label className="flex items-start gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={Boolean(settings.expiryAutomationEnabled)}
                        disabled={isSaving}
                        onChange={(e) => {
                            onSave({ expiryAutomationEnabled: e.target.checked });
                        }}
                        className="mt-0.5 h-4 w-4 text-blue-600 border-gray-300 rounded"
                    />
                    <span>
                        <span className="font-medium text-gray-900">Enable nightly expiry processing</span>
                        <span className="block text-gray-500">
                            Runs at 04:00. Preview / run now: Inventory → Quarantine or Store Network settings.
                        </span>
                    </span>
                </label>
            </div>

            <div className="border-t border-gray-200 pt-6" data-settings-quarantine-auto-dispose="true">
                <h3 className="text-lg font-semibold text-gray-900 mb-1">Quarantine auto-dispose</h3>
                <p className="text-sm text-gray-500 mb-4">
                    After EXPIRED stock has aged in quarantine, optionally write it off automatically
                    (same dispose gateway — posts P&amp;L). Separate from expiry quarantine. Default off.
                </p>
                <label className="flex items-start gap-2 text-sm mb-4">
                    <input
                        type="checkbox"
                        checked={Boolean(settings.quarantineAutoDisposeEnabled)}
                        disabled={isSaving}
                        onChange={(e) => {
                            onSave({ quarantineAutoDisposeEnabled: e.target.checked });
                        }}
                        className="mt-0.5 h-4 w-4 text-blue-600 border-gray-300 rounded"
                    />
                    <span>
                        <span className="font-medium text-gray-900">Enable nightly auto-dispose</span>
                        <span className="block text-gray-500">
                            Runs at 04:30 for EXPIRED lines older than the age below. DAMAGE/RETURN stay manual.
                        </span>
                    </span>
                </label>
                <label className="block text-sm max-w-xs">
                    <span className="block text-gray-600 mb-1">Minimum age (days)</span>
                    <input
                        type="number"
                        min={0}
                        max={3650}
                        value={settings.quarantineAutoDisposeMinAgeDays ?? 30}
                        disabled={isSaving}
                        onChange={(e) => {
                            const n = Number(e.target.value);
                            if (!Number.isFinite(n)) return;
                            onSave({
                                quarantineAutoDisposeMinAgeDays: Math.min(
                                    3650,
                                    Math.max(0, Math.trunc(n)),
                                ),
                            });
                        }}
                        className="w-full border border-gray-300 rounded-md px-3 py-2"
                    />
                </label>
            </div>

            <div className="flex justify-end">
                <button
                    type="submit"
                    disabled={isSaving}
                    className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
                >
                    {isSaving ? 'Saving...' : 'Save Inventory Settings'}
                </button>
            </div>
        </form>
    );
}

// Register Management Tab (includes Session Policy)
function RegisterManagement({ settings, onSave, isSaving }: SettingsComponentProps) {
    const { data: registers, isLoading } = useRegisters();
    const createRegister = useCreateRegister();
    const updateRegister = useUpdateRegister();

    const [showCreateForm, setShowCreateForm] = useState(false);
    const [newName, setNewName] = useState('');
    const [newLocation, setNewLocation] = useState('');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState('');
    const [editLocation, setEditLocation] = useState('');

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newName.trim()) return;
        await createRegister.mutateAsync({
            name: newName.trim(),
            location: newLocation.trim() || undefined,
        });
        setNewName('');
        setNewLocation('');
        setShowCreateForm(false);
    };

    const handleUpdate = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!editingId || !editName.trim()) return;
        await updateRegister.mutateAsync({
            id: editingId,
            name: editName.trim(),
            location: editLocation.trim() || undefined,
        });
        setEditingId(null);
    };

    const handleToggleActive = async (register: CashRegister) => {
        await updateRegister.mutateAsync({
            id: register.id,
            isActive: !register.isActive,
        });
    };

    const startEditing = (register: CashRegister) => {
        setEditingId(register.id);
        setEditName(register.name);
        setEditLocation(register.location || '');
    };

    if (isLoading) {
        return <p className="text-gray-600">Loading registers...</p>;
    }

    const allRegisters = registers || [];
    const policyDef = getPosSessionPolicyDefinition(parsePosSessionPolicy(settings.posSessionPolicy));

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-lg font-semibold text-gray-900">Cash Registers</h3>
                    <p className="text-sm text-gray-600 mt-1">
                        {policyDef.registerSubtitle}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => setShowCreateForm(true)}
                    className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 text-sm font-medium"
                >
                    + Add Register
                </button>
            </div>

            {/* Create Form */}
            {showCreateForm && (
                <form onSubmit={handleCreate} className="p-4 bg-green-50 border border-green-200 rounded-lg space-y-3">
                    <h4 className="font-medium text-green-900">New Cash Register</h4>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Register Name *
                            </label>
                            <input
                                type="text"
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-green-500 focus:border-green-500"
                                placeholder="e.g., Register 3"
                                required
                                maxLength={100}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Location
                            </label>
                            <input
                                type="text"
                                value={newLocation}
                                onChange={(e) => setNewLocation(e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-green-500 focus:border-green-500"
                                placeholder="e.g., Front Counter"
                                maxLength={255}
                            />
                        </div>
                    </div>
                    {createRegister.error && (
                        <p className="text-sm text-red-600">
                            {createRegister.error instanceof Error ? createRegister.error.message : 'Failed to create register'}
                        </p>
                    )}
                    <div className="flex gap-2">
                        <button
                            type="submit"
                            disabled={createRegister.isPending || !newName.trim()}
                            className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 text-sm"
                        >
                            {createRegister.isPending ? 'Creating...' : 'Create Register'}
                        </button>
                        <button
                            type="button"
                            onClick={() => { setShowCreateForm(false); setNewName(''); setNewLocation(''); }}
                            className="px-4 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 text-sm"
                        >
                            Cancel
                        </button>
                    </div>
                </form>
            )}

            {/* Register List */}
            {allRegisters.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                    <p className="text-lg font-medium">No registers configured</p>
                    <p className="text-sm mt-1">Click &quot;Add Register&quot; to create your first cash register.</p>
                </div>
            ) : (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Location</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Current Session</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {allRegisters.map((register) => (
                                <tr key={register.id} className={!register.isActive ? 'bg-gray-50 opacity-60' : ''}>
                                    {editingId === register.id ? (
                                        <>
                                            <td className="px-6 py-3">
                                                <input
                                                    type="text"
                                                    value={editName}
                                                    onChange={(e) => setEditName(e.target.value)}
                                                    className="w-full px-2 py-1 border border-gray-300 rounded text-sm focus:ring-blue-500 focus:border-blue-500"
                                                    maxLength={100}
                                                />
                                            </td>
                                            <td className="px-6 py-3">
                                                <input
                                                    type="text"
                                                    value={editLocation}
                                                    onChange={(e) => setEditLocation(e.target.value)}
                                                    className="w-full px-2 py-1 border border-gray-300 rounded text-sm focus:ring-blue-500 focus:border-blue-500"
                                                    maxLength={255}
                                                />
                                            </td>
                                            <td className="px-6 py-3" />
                                            <td className="px-6 py-3" />
                                            <td className="px-6 py-3 text-right space-x-2">
                                                <button
                                                    type="button"
                                                    onClick={(e) => { e.preventDefault(); handleUpdate(e); }}
                                                    disabled={updateRegister.isPending}
                                                    className="text-sm text-blue-600 hover:text-blue-800 font-medium"
                                                >
                                                    Save
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setEditingId(null)}
                                                    className="text-sm text-gray-600 hover:text-gray-800"
                                                >
                                                    Cancel
                                                </button>
                                            </td>
                                        </>
                                    ) : (
                                        <>
                                            <td className="px-6 py-3 text-sm font-medium text-gray-900">{register.name}</td>
                                            <td className="px-6 py-3 text-sm text-gray-600">{register.location || '—'}</td>
                                            <td className="px-6 py-3">
                                                <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${register.isActive
                                                    ? 'bg-green-100 text-green-800'
                                                    : 'bg-gray-100 text-gray-600'
                                                    }`}>
                                                    <span className={`w-1.5 h-1.5 rounded-full ${register.isActive ? 'bg-green-500' : 'bg-gray-400'}`} />
                                                    {register.isActive ? 'Active' : 'Inactive'}
                                                </span>
                                            </td>
                                            <td className="px-6 py-3 text-sm text-gray-600">
                                                {register.currentSessionId ? (
                                                    <span className="text-amber-600 font-medium">
                                                        {register.currentSessionUserName || 'In use'} ({register.currentSessionNumber})
                                                    </span>
                                                ) : (
                                                    <span className="text-gray-400">Available</span>
                                                )}
                                            </td>
                                            <td className="px-6 py-3 text-right space-x-3">
                                                <button
                                                    type="button"
                                                    onClick={() => startEditing(register)}
                                                    className="text-sm text-blue-600 hover:text-blue-800 font-medium"
                                                >
                                                    Edit
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => handleToggleActive(register)}
                                                    disabled={updateRegister.isPending}
                                                    className={`text-sm font-medium ${register.isActive
                                                        ? 'text-red-600 hover:text-red-800'
                                                        : 'text-green-600 hover:text-green-800'
                                                        }`}
                                                >
                                                    {register.isActive ? 'Deactivate' : 'Activate'}
                                                </button>
                                            </td>
                                        </>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Session Policy */}
            <POSSessionPolicyInline settings={settings} onSave={onSave} isSaving={isSaving} />

            {/* POS Transaction Mode */}
            <POSTransactionModeInline settings={settings} onSave={onSave} isSaving={isSaving} />
        </div>
    );
}
