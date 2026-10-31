import { describe, expect, it } from '@jest/globals';
import {
  permissionsForDocumentType,
  permissionsForEntityFlow,
} from '@shared/authorization/documentPolicy.js';

describe('documentPolicy', () => {
  it('maps invoice PDFs to sales/customer read permissions', () => {
    expect(permissionsForDocumentType('INVOICE')).toEqual(
      expect.arrayContaining(['sales.read', 'customers.read'])
    );
  });

  it('maps financial reports to accounting permissions', () => {
    expect(permissionsForDocumentType('PROFIT_LOSS')).toEqual(
      expect.arrayContaining(['reports.financial_view', 'accounting.read'])
    );
  });

  it('maps store issue PDFs to kitchen/inventory read', () => {
    expect(permissionsForDocumentType('STORE_ISSUE')).toEqual(
      expect.arrayContaining(['kitchen.production.read', 'inventory.read']),
    );
  });

  it('maps document flow entities to module read permissions', () => {
    expect(permissionsForEntityFlow('PURCHASE_ORDER')).toContain('purchasing.read');
    expect(permissionsForEntityFlow('SALE')).toContain('sales.read');
  });

  it('falls back to reports.read for unknown types', () => {
    expect(permissionsForDocumentType('UNKNOWN_DOC')).toContain('reports.read');
  });
});
