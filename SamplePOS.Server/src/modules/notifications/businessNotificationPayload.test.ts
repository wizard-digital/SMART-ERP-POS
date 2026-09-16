import { describe, expect, it } from '@jest/globals';
import {
  buildBusinessNotificationPayload,
  buildProductLineNotificationPayload,
  expenseDetailLabel,
} from './businessNotificationPayload.js';

describe('business notification payload SSOT', () => {
  it('builds expense / payment payloads with business facts, not permission prose', () => {
    const expense = buildBusinessNotificationPayload({
      action: 'Expense paid',
      detail: 'Staff transport',
      documentRef: 'EXP-202609-2015',
      amount: 80000,
    });
    expect(expense.summary).toBe('Expense paid Staff transport');
    expect(expense.detailSummary).toBe('Staff transport');
    expect(expense.documentRef).toBe('EXP-202609-2015');
    expect(expense.amount).toBe(80000);
    expect(JSON.stringify(expense)).not.toMatch(/supervise|permission|why you|view expenses/i);

    const customer = buildBusinessNotificationPayload({
      action: 'Customer paid',
      detail: 'Zam Zam Pharmacy',
      documentRef: 'CRP-000123',
      amount: 4500000,
    });
    expect(customer.detailSummary).toBe('Zam Zam Pharmacy');
    expect(customer.summary).toContain('Zam Zam Pharmacy');

    const supplier = buildBusinessNotificationPayload({
      action: 'Supplier paid',
      detail: 'Salud Supplies',
      documentRef: 'SP-000088',
      amount: 1200000,
    });
    expect(supplier.detailSummary).toBe('Salud Supplies');
  });

  it('builds sale / return / void payloads from product lines', () => {
    const sold = buildProductLineNotificationPayload({
      action: 'Sold',
      items: [
        { productName: 'Paracetamol 500mg', quantity: 2 },
        { productName: 'Amoxil', quantity: 1 },
      ],
      documentRef: 'SALE-2026-14467',
      amount: 18500,
    });
    expect(sold.detailSummary).toBe('Paracetamol 500mg ×2, Amoxil');
    expect(sold.productSummary).toBe(sold.detailSummary);
    expect(sold.summary).toBe('Sold Paracetamol 500mg ×2, Amoxil');
    expect(sold.itemCount).toBe(2);

    const returned = buildProductLineNotificationPayload({
      action: 'Returned',
      items: [{ productName: 'Paracetamol 500mg', quantity: 1 }],
      documentRef: 'SALE-2026-14467',
      amount: 5000,
    });
    expect(returned.summary).toBe('Returned Paracetamol 500mg');
  });

  it('picks expense title before category', () => {
    expect(expenseDetailLabel({ title: 'Taxi', categoryName: 'Travel' })).toBe('Taxi');
    expect(expenseDetailLabel({ title: null, categoryName: 'Travel' })).toBe('Travel');
    expect(expenseDetailLabel({ title: '  ', category: 'OTHER' })).toBe('OTHER');
  });
});
