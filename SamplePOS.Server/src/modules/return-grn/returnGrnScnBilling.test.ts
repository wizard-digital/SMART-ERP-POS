/**
 * Proof: RGRN → SCN requires supplier bill first (ERR_RETURN_GRN_001).
 * Proof: cancelled SCN does not block re-create; active SCN still conflicts.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

type AnyMock = jest.Mock<(...args: unknown[]) => Promise<unknown>>;

const mockRgrn = {
    id: 'rgrn-uuid',
    returnGrnNumber: 'RGRN-2026-0099',
    grnId: 'grn-uuid',
    supplierId: 'sup-1',
    supplierName: 'Test Supplier',
    grNumber: 'GR-2026-0001',
    returnDate: '2026-06-01',
    status: 'POSTED' as const,
    reason: 'Damaged',
    createdBy: 'user-1',
    createdAt: '2026-06-01',
    updatedAt: '2026-06-01',
};

const mockLines = [{
    id: 'line-1',
    rgrnId: 'rgrn-uuid',
    productId: 'prod-1',
    productName: 'Item',
    batchId: null,
    batchNumber: null,
    uomId: null,
    uomName: null,
    uomSymbol: null,
    conversionFactor: 1,
    quantity: 2,
    baseQuantity: 2,
    unitCost: 1000,
    lineTotal: 2000,
}];

const mockClientQuery = jest.fn<(...args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>();

jest.unstable_mockModule('../../db/unitOfWork.js', () => ({
    UnitOfWork: {
        run: jest.fn(async (_pool: unknown, fn: (client: PoolClient) => Promise<unknown>) =>
            fn({ query: mockClientQuery } as unknown as PoolClient),
        ),
    },
}));

jest.unstable_mockModule('./returnGrnRepository.js', () => ({
    returnGrnRepository: {
        getById: jest.fn<AnyMock>().mockResolvedValue(mockRgrn),
        getLines: jest.fn<AnyMock>().mockResolvedValue(mockLines),
    },
}));

jest.unstable_mockModule('../credit-debit-notes/creditDebitNoteRepository.js', () => ({
    supplierCreditDebitNoteRepository: {},
}));

jest.unstable_mockModule('../credit-debit-notes/creditDebitNoteService.js', () => ({
    supplierCreditDebitNoteService: {},
}));

jest.unstable_mockModule('../document-flow/documentFlowService.js', () => ({
    linkDocuments: jest.fn<AnyMock>().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../../services/glEntryService.js', () => ({
    recordSupplierCreditNoteToGL: jest.fn<AnyMock>(),
    AccountCodes: { GRIR_CLEARING: '2150' },
}));

const { returnGrnService } = await import('./returnGrnService.js');
const { BusinessError } = await import('../../middleware/errorHandler.js');
const {
    SUPPLIER_BILL_REQUIRED_FOR_SCN_CODE,
    SUPPLIER_BILL_REQUIRED_FOR_SCN_MESSAGE,
} = await import('./returnGrnMessages.js');

/** Active SCN gate shared by create + worklist (cancelled can re-issue). */
function isActiveScnExistenceSql(sql: string): boolean {
    return (
        sql.includes('return_grn_id = $1') &&
        sql.includes('SUPPLIER_CREDIT_NOTE') &&
        sql.includes('CANCELLED')
    );
}

describe('returnGrnService — SCN requires supplier bill', () => {
    const pool = {} as Pool;

    beforeEach(() => {
        jest.clearAllMocks();
        mockClientQuery.mockImplementation(async (sql: unknown) => {
            const s = String(sql);
            if (isActiveScnExistenceSql(s)) {
                return { rows: [] };
            }
            if (s.includes('FROM goods_receipts g') && s.includes('supplier')) {
                return { rows: [{ supplier_id: 'sup-1', supplier_name: 'Test Supplier' }] };
            }
            if (s.includes('document_type = \'SUPPLIER_INVOICE\'')) {
                return { rows: [] };
            }
            return { rows: [] };
        });
    });

    it('throws ERR_SCN_FULL_REVERSE when parent GR links this RGRN as counter-document', async () => {
        const { returnGrnRepository } = await import('./returnGrnRepository.js');
        (returnGrnRepository.getById as AnyMock).mockResolvedValueOnce({
            ...mockRgrn,
            reason: 'Damaged goods return',
        });
        mockClientQuery.mockImplementation(async (sql: unknown) => {
            const s = String(sql);
            if (s.includes('reversed_by_return_grn_id')) {
                return { rows: [{ reversed_by_return_grn_id: 'rgrn-uuid' }] };
            }
            if (isActiveScnExistenceSql(s)) {
                return { rows: [] };
            }
            return { rows: [] };
        });

        await expect(
            returnGrnService.createCreditNoteFromReturn(pool, 'rgrn-uuid'),
        ).rejects.toMatchObject({ errorCode: 'ERR_SCN_FULL_REVERSE' });
    });

    it('throws ERR_SCN_FULL_REVERSE for orchestrated full/uninvoiced reverse', async () => {
        const { returnGrnRepository } = await import('./returnGrnRepository.js');
        (returnGrnRepository.getById as AnyMock).mockResolvedValueOnce({
            ...mockRgrn,
            reason: '[Uninvoiced reversal] test reverse',
        });

        await expect(
            returnGrnService.createCreditNoteFromReturn(pool, 'rgrn-uuid'),
        ).rejects.toMatchObject({ errorCode: 'ERR_SCN_FULL_REVERSE' });
    });

    it('resolves bill via GRN link even when InternalReference is INV-GR-… (Henber pattern)', async () => {
        mockClientQuery.mockImplementation(async (sql: unknown) => {
            const s = String(sql);
            if (isActiveScnExistenceSql(s)) {
                return { rows: [] };
            }
            if (s.includes('reversed_by_return_grn_id')) {
                return { rows: [{ reversed_by_return_grn_id: null }] };
            }
            if (s.includes('FROM goods_receipts g') && s.includes('supplier')) {
                return { rows: [{ supplier_id: 'sup-1', supplier_name: 'Test Supplier' }] };
            }
            // Bill lookup must accept junction without requiring empty InternalReference
            if (
                s.includes("document_type = 'SUPPLIER_INVOICE'") &&
                s.includes('supplier_invoice_grn_links') &&
                s.includes("'INV-' ||")
            ) {
                return { rows: [{ Id: 'bill-uuid' }] };
            }
            if (s.includes('FROM supplier_invoices') && s.includes('"TotalAmount"')) {
                return { rows: [{ TotalAmount: '2000.00', Subtotal: '2000.00', Status: 'Pending' }] };
            }
            return { rows: [] };
        });

        // Will fail later without full SCN mocks — but must NOT be ERR_RETURN_GRN_001
        await expect(
            returnGrnService.createCreditNoteFromReturn(pool, 'rgrn-uuid'),
        ).rejects.not.toMatchObject({ errorCode: SUPPLIER_BILL_REQUIRED_FOR_SCN_CODE });
    });

    it('throws BusinessError ERR_RETURN_GRN_001 when GR has no supplier bill', async () => {
        await expect(
            returnGrnService.createCreditNoteFromReturn(pool, 'rgrn-uuid'),
        ).rejects.toMatchObject({
            errorCode: SUPPLIER_BILL_REQUIRED_FOR_SCN_CODE,
            message: SUPPLIER_BILL_REQUIRED_FOR_SCN_MESSAGE,
        });

        await expect(
            returnGrnService.createCreditNoteFromReturn(pool, 'rgrn-uuid'),
        ).rejects.toBeInstanceOf(BusinessError);
    });

    it('conflicts when an active SCN still links the Return GRN', async () => {
        mockClientQuery.mockImplementation(async (sql: unknown) => {
            const s = String(sql);
            if (isActiveScnExistenceSql(s)) {
                return { rows: [{ Id: 'scn-active', Status: 'POSTED' }] };
            }
            return { rows: [] };
        });

        await expect(
            returnGrnService.createCreditNoteFromReturn(pool, 'rgrn-uuid'),
        ).rejects.toThrow(/already exists for this Return GRN/i);
    });

    it('ignores cancelled SCN so gate reaches bill check (cancel → re-create path)', async () => {
        // SQL itself filters CANCELLED; only active rows are returned. Empty = cancelled/soft-del free.
        mockClientQuery.mockImplementation(async (sql: unknown) => {
            const s = String(sql);
            if (isActiveScnExistenceSql(s)) {
                return { rows: [] };
            }
            if (s.includes('FROM goods_receipts g') && s.includes('supplier')) {
                return { rows: [{ supplier_id: 'sup-1', supplier_name: 'Test Supplier' }] };
            }
            if (s.includes('document_type = \'SUPPLIER_INVOICE\'')) {
                return { rows: [] };
            }
            return { rows: [] };
        });

        await expect(
            returnGrnService.createCreditNoteFromReturn(pool, 'rgrn-uuid'),
        ).rejects.toMatchObject({ errorCode: SUPPLIER_BILL_REQUIRED_FOR_SCN_CODE });
    });
});

describe('returnGrnService — active SCN SQL SSOT (cancel re-create)', () => {
    it('createCreditNoteFromReturn excludes CANCELLED/VOID SCN like worklist hasActiveScn', () => {
        const dir = path.dirname(fileURLToPath(import.meta.url));
        const serviceSrc = readFileSync(path.join(dir, 'returnGrnService.ts'), 'utf8');
        const repoSrc = readFileSync(path.join(dir, 'returnGrnRepository.ts'), 'utf8');
        expect(serviceSrc).toMatch(
            /NOT IN \('CANCELLED', 'VOID', 'VOIDED', 'DELETED'\)/,
        );
        expect(repoSrc).toMatch(
            /NOT IN \('CANCELLED', 'VOID', 'VOIDED', 'DELETED'\)/,
        );
        // Must not reintroduce soft-delete-only duplicate gate
        const gateBlock = serviceSrc.slice(
            serviceSrc.indexOf('Prevent duplicate'),
            serviceSrc.indexOf('Prevent duplicate') + 600,
        );
        expect(gateBlock).toContain('CANCELLED');
        expect(gateBlock).toContain('return_grn_id');
    });
});

describe('returnGrnService — under-bill SCN ceiling (Henber 88004 vs 88000)', () => {
    it('caps SCN at bill TotalAmount when return ≤ Subtotal; skips open-balance gate', () => {
        const dir = path.dirname(fileURLToPath(import.meta.url));
        const serviceSrc = readFileSync(path.join(dir, 'returnGrnService.ts'), 'utf8');
        const createBlock = serviceSrc.slice(
            serviceSrc.indexOf('async createCreditNoteFromReturn'),
            serviceSrc.indexOf('return { creditNoteId: postedScn.id'),
        );
        expect(createBlock).toContain('billSubtotal');
        expect(createBlock).toContain('scnAmount = billTotal');
        expect(createBlock).toContain('ERR_SCN_EXCEEDS_BILL');
        expect(createBlock).not.toContain('ERR_SCN_EXCEEDS_BILL_OPEN');
        expect(createBlock).toMatch(/totalAmount:\s*scnAmount/);
        expect(createBlock).toMatch(/subtotal:\s*returnTotalNum/);
    });
});
