import { describe, expect, it } from '@jest/globals';
import { toStoreIssueBodyData } from './storeIssueBody.js';
import type { StoreIssueDocument } from '../../../../../shared/store-issue/index.js';

function doc(over: Partial<StoreIssueDocument> = {}): StoreIssueDocument {
  return {
    id: 'd1',
    documentNumber: 'GI-2026-00002',
    documentType: 'INGREDIENT_ISSUE',
    postingIntent: 'EXPENSE',
    status: 'POSTED',
    issueDate: '2026-10-31',
    storeLocationId: 's1',
    storeLocationName: 'MAIN',
    issuedTo: 'KITCHEN',
    requestedByName: 'Chef',
    notes: null,
    expenseAccountCode: '5150',
    totalCost: 9000,
    journalEntryId: 'j1',
    createdBy: 'u1',
    createdAt: '2026-10-31T07:00:00.000Z',
    postedBy: 'u1',
    postedAt: '2026-10-31T07:05:00.000Z',
    reversedBy: null,
    reversedAt: null,
    reversalJournalId: null,
    reversalReason: null,
    lines: [
      {
        id: 'l1',
        documentId: 'd1',
        productId: 'p1',
        productName: 'Abchlor eye droped',
        sku: 'AB-01',
        requestedQtyBase: 5,
        issuedQtyBase: 5,
        actualUnitCost: 1800,
        actualLineCost: 9000,
        sortOrder: 0,
        notes: null,
        uomId: '11111111-1111-1111-1111-111111111111',
        uomName: 'BTL',
        conversionFactor: 1,
      },
    ],
    ...over,
  };
}

describe('store issue PDF body', () => {
  it('maps a posted goods issue for print (number, store, issued qty, 5150)', () => {
    const body = toStoreIssueBodyData(doc());
    expect(body.header.documentNumber).toBe('GI-2026-00002');
    expect(body.header.issuedTo).toBe('Kitchen');
    expect(body.header.storeName).toBe('MAIN');
    expect(body.header.expenseAccountCode).toBe('5150');
    expect(body.header.posted).toBe(true);
    expect(body.items).toEqual([
      expect.objectContaining({
        productName: 'Abchlor eye droped',
        requestedQty: 5,
        issuedQty: 5,
        uomName: 'BTL',
        lineCost: 9000,
      }),
    ]);
  });

  it('prints requested and issued in the unit of entry (not only base qty)', () => {
    const body = toStoreIssueBodyData(
      doc({
        lines: [
          {
            id: 'l1',
            documentId: 'd1',
            productId: 'p1',
            productName: 'Cooking oil',
            sku: 'OIL-01',
            requestedQtyBase: 60,
            issuedQtyBase: 48,
            actualUnitCost: 100,
            actualLineCost: 4800,
            sortOrder: 0,
            notes: null,
            uomId: '22222222-2222-2222-2222-222222222222',
            uomName: 'BOX',
            conversionFactor: 12,
          },
        ],
      }),
    );
    expect(body.items[0]).toMatchObject({
      requestedQty: 5,
      issuedQty: 4,
      uomName: 'BOX',
    });
  });

  it('draft print has no posted total', () => {
    const body = toStoreIssueBodyData(doc({ status: 'DRAFT', totalCost: 0 }));
    expect(body.header.posted).toBe(false);
  });

  it('reversed reprint carries the reverse reason', () => {
    const body = toStoreIssueBodyData(
      doc({
        status: 'REVERSED',
        reversalReason: 'Entered wrong qty',
      }),
    );
    expect(body.header.posted).toBe(true);
    expect(body.header.reversalReason).toBe('Entered wrong qty');
  });
});
