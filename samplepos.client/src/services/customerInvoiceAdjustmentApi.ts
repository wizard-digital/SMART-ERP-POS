/**
 * Customer Invoice Adjustment API
 */

import { api } from './api';

export interface OverchargeLine {
    saleItemId: string;
    productId: string;
    productName: string;
    quantity: number;
    unitPriceCharged: number;
    batchUnitCost: number;
    suggestedCorrectUnitPrice: number;
    suggestedCreditPerUnit: number;
    suggestedLineCredit: number;
    pricingScope: string | null;
}

export interface ReturnableSaleLine {
    saleItemId: string;
    productId: string;
    productName: string;
    quantity: number;
    returnableQuantity: number;
    refundedQuantity: number;
    unitPrice: number;
    taxRate: number;
    uomSymbol: string | null;
    uomName: string | null;
    baseUomSymbol: string | null;
    conversionFactor: number;
}

export interface AdjustmentContext {
    invoice: {
        id: string;
        invoiceNumber: string;
        customerId: string;
        customerName: string;
        totalAmount: number;
        amountPaid: number;
        outstandingBalance: number;
        status: string;
        saleId: string | null;
        saleNumber: string | null;
        saleStatus: string | null;
    };
    customerPricingMode: 'STANDARD' | 'AT_COST';
    overchargeLines: OverchargeLine[];
    returnableLines: ReturnableSaleLine[];
    existingCreditNoteTotal: number;
    totalSuggestedCredit: number;
    remainingOverchargeCredit: number;
    maxAdditionalCredit: number;
    suggestedIntent: 'PRICE_CORRECTION' | 'RETURN_GOODS' | 'NONE';
}

export interface AdjustPriceCorrectionRequest {
    intent: 'PRICE_CORRECTION';
    invoiceId: string;
    reason: string;
    notes?: string;
    lines: { saleItemId: string }[];
}

export interface AdjustReturnRequest {
    intent: 'RETURN_GOODS';
    invoiceId: string;
    reason: string;
    notes?: string;
    lines: { saleItemId: string; quantity: number }[];
}

export type AdjustRequest = AdjustPriceCorrectionRequest | AdjustReturnRequest;

export interface AdjustmentResult {
    intent: 'PRICE_CORRECTION' | 'RETURN_GOODS';
    creditNoteId: string;
    creditNoteNumber: string;
    totalCredit: number;
}

export const customerInvoiceAdjustmentApi = {
    getContext: (invoiceId: string) =>
        api.get<{ success: boolean; data: AdjustmentContext }>(
            `/customer-invoice-adjustments/invoice/${invoiceId}/context`,
        ),

    adjust: (data: AdjustRequest) =>
        api.post<{ success: boolean; data: AdjustmentResult }>(
            '/customer-invoice-adjustments/adjust',
            data,
        ),
};
