/**
 * Exception traceability — resolves workspace inbox IDs to document chains.
 * Phase 2D: Issue → Control Account → Journal → Business Document → Batch → Party → Audit
 */
import type { Pool, PoolClient } from 'pg';
import { LEDGER_NET_ACTIVE_SQL } from '../../utils/ledgerNetActive.js';
import { getBusinessDate } from '../../utils/dateRange.js';
import { getLedgerTransactionById } from '../../repositories/accountingRepository.js';
import { getFinancialLane } from './financialLaneService.js';
import type { FinancialDomain } from './types.js';
import { tableHasColumn } from '../../db/schemaColumnCache.js';
import { AR_OPEN_DOCUMENT_TYPE_IN_SQL } from '../customer-payments/arReconciliationEngine.js';

type Db = Pool | PoolClient;

export type TraceDomain = 'ap' | 'ar' | 'inventory' | 'cash' | 'wht' | 'vat';
export type TraceLane = 'integrity' | 'cache' | 'warning';

export interface TraceAction {
    label: string;
    path: string;
}

export interface TraceJournalRow {
    transactionId: string;
    transactionNumber: string;
    referenceType: string;
    referenceId: string | null;
    referenceNumber: string | null;
    transactionDate: string;
    description: string | null;
    impact: number;
    postedBy: string | null;
    documentLabel: string | null;
    documentPath: string | null;
}

export interface TraceOpenDocument {
    id: string;
    documentType: string;
    documentNumber: string;
    amount: number;
    date: string;
    status: string | null;
    path: string | null;
}

export interface TraceBatchRow {
    batchId: string;
    batchNumber: string | null;
    quantity: number;
    unitCost: number;
    value: number;
    receivedDate: string | null;
    goodsReceiptId: string | null;
    goodsReceiptNumber: string | null;
    goodsReceiptLabel: string | null;
    warehouseId: string | null;
    warehouseName: string | null;
    warehouseCode: string | null;
}

export interface TraceChainStep {
    level: 'issue' | 'control_account' | 'journal' | 'document' | 'batch' | 'party' | 'audit';
    id: string;
    label: string;
    detail: string | null;
    amount: number | null;
    date: string | null;
    actor: string | null;
    navigateTo: string | null;
}

export interface ExceptionTraceResult {
    exceptionId: string;
    domain: TraceDomain;
    lane: TraceLane;
    title: string;
    entityName: string;
    entityId: string;
    asOfDate: string;
    cause: string;
    summary: {
        glLabel: string;
        glBalance: number;
        subledgerLabel: string;
        subledgerBalance: number;
        difference: number;
    };
    chain: TraceChainStep[];
    journals: TraceJournalRow[];
    openDocuments: TraceOpenDocument[];
    batches: TraceBatchRow[];
    actions: TraceAction[];
}

export interface ParsedExceptionId {
    exceptionId: string;
    domain: TraceDomain;
    lane: TraceLane;
    entityId: string | null;
    isDomainLevel: boolean;
}

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DOMAIN_TITLES: Record<TraceDomain, string> = {
    ap: 'Suppliers',
    ar: 'Customers',
    inventory: 'Inventory',
    cash: 'Cash',
    wht: 'Withholding Tax',
    vat: 'VAT',
};

const DOMAIN_ACCOUNT: Record<TraceDomain, string> = {
    ap: '2100',
    ar: '1200',
    inventory: '1300',
    cash: '1010',
    wht: '2350',
    vat: '2300',
};

export function formatGrLabel(receiptNumber: string | null): string | null {
    if (!receiptNumber) return null;
    return receiptNumber.startsWith('GR') ? receiptNumber : `GR-${receiptNumber}`;
}

function domainWorkspacePath(domain: TraceDomain): string {
    switch (domain) {
        case 'ap':
            return '/accounting/supplier-payments';
        case 'ar':
            return '/accounting/customer-payments';
        case 'inventory':
            return '/reports/inventory/reconciliation';
        case 'cash':
            return '/accounting/banking';
        case 'wht':
            return '/accounting/withholding-tax';
        case 'vat':
            return '/accounting/vat-remittance';
    }
}

function entityExceptionPath(domain: TraceDomain, entityId: string): string | null {
    switch (domain) {
        case 'ap':
            return `/accounting/supplier-payments?supplier=${entityId}`;
        case 'ar':
            return `/accounting/customer-payments?customer=${entityId}`;
        case 'inventory':
            return `/inventory/products?highlight=${entityId}`;
        case 'wht':
            return '/accounting/withholding-tax';
        case 'vat':
            return '/accounting/vat-remittance';
        case 'cash':
            return '/accounting/banking';
        default:
            return null;
    }
}

async function inventoryBatchSelectSql(pool: Db): Promise<string> {
    const hasTargetStore = await tableHasColumn(pool, 'goods_receipt_items', 'target_store_location_id');
    const hasStoreLocations = await tableHasColumn(pool, 'store_locations', 'id');
    if (!hasTargetStore || !hasStoreLocations) {
        return `
        SELECT ib.id::text AS batch_id,
            ib.batch_number,
            ib.remaining_quantity::numeric AS qty,
            ib.cost_price::numeric AS unit_cost,
            (ib.remaining_quantity * ib.cost_price)::numeric AS value,
            ib.received_date::text AS received_date,
            cl.goods_receipt_id::text AS gr_id,
            gr.receipt_number AS gr_number,
            NULL::text AS warehouse_id,
            NULL::text AS warehouse_name,
            NULL::text AS warehouse_code
        FROM inventory_batches ib
        LEFT JOIN cost_layers cl ON cl.product_id = ib.product_id
            AND (cl.batch_number = ib.batch_number OR cl.batch_number IS NULL)
            AND cl.goods_receipt_id IS NOT NULL
        LEFT JOIN goods_receipts gr ON gr.id = cl.goods_receipt_id
        WHERE ib.product_id = $1::uuid AND ib.remaining_quantity > 0
        ORDER BY ib.received_date DESC NULLS LAST
        LIMIT 10`;
    }

    return `
        SELECT ib.id::text AS batch_id,
            ib.batch_number,
            ib.remaining_quantity::numeric AS qty,
            ib.cost_price::numeric AS unit_cost,
            (ib.remaining_quantity * ib.cost_price)::numeric AS value,
            ib.received_date::text AS received_date,
            cl.goods_receipt_id::text AS gr_id,
            gr.receipt_number AS gr_number,
            sl.id::text AS warehouse_id,
            sl.name AS warehouse_name,
            sl.code AS warehouse_code
        FROM inventory_batches ib
        LEFT JOIN cost_layers cl ON cl.product_id = ib.product_id
            AND (cl.batch_number = ib.batch_number OR cl.batch_number IS NULL)
            AND cl.goods_receipt_id IS NOT NULL
        LEFT JOIN goods_receipts gr ON gr.id = cl.goods_receipt_id
        LEFT JOIN LATERAL (
            SELECT gri.target_store_location_id
            FROM goods_receipt_items gri
            WHERE gri.goods_receipt_id = gr.id
              AND gri.product_id = ib.product_id
              AND gri.target_store_location_id IS NOT NULL
            ORDER BY gri.id
            LIMIT 1
        ) gr_line ON TRUE
        LEFT JOIN store_locations sl ON sl.id = gr_line.target_store_location_id
        WHERE ib.product_id = $1::uuid AND ib.remaining_quantity > 0
        ORDER BY ib.received_date DESC NULLS LAST
        LIMIT 10`;
}

export function parseExceptionId(id: string): ParsedExceptionId {
    if (id === 'exc-cash-summary') {
        return { exceptionId: id, domain: 'cash', lane: 'integrity', entityId: 'cash', isDomainLevel: true };
    }

    const cacheMatch = id.match(/^warn-cache-(ap|ar|inventory|cash)$/);
    if (cacheMatch) {
        return {
            exceptionId: id,
            domain: cacheMatch[1] as TraceDomain,
            lane: 'cache',
            entityId: cacheMatch[1],
            isDomainLevel: true,
        };
    }

    const domainMatch = id.match(/^exc-(ap|ar|inventory|cash|wht)-domain$/);
    if (domainMatch) {
        return {
            exceptionId: id,
            domain: domainMatch[1] as TraceDomain,
            lane: 'integrity',
            entityId: domainMatch[1],
            isDomainLevel: true,
        };
    }

    const entityMatch = id.match(/^exc-(ap|ar|inventory|wht)-(.+)$/);
    if (entityMatch) {
        const domain = entityMatch[1] as TraceDomain;
        const entityId = entityMatch[2];
        if (!UUID_RE.test(entityId)) {
            throw new Error(`Invalid exception entity id: ${entityId}`);
        }
        return {
            exceptionId: id,
            domain,
            lane: id.startsWith('warn-') ? 'cache' : 'integrity',
            entityId,
            isDomainLevel: false,
        };
    }

    throw new Error(`Unknown exception id format: ${id}`);
}

function referenceDocumentPath(referenceType: string, referenceId: string | null): { label: string; path: string } | null {
    if (!referenceId) return null;
    switch (referenceType) {
        case 'GOODS_RECEIPT':
            return { label: 'Goods Receipt', path: `/inventory/goods-receipts?highlight=${referenceId}` };
        case 'SUPPLIER_INVOICE':
            return { label: 'Supplier Bill', path: `/accounting/supplier-payments?invoice=${referenceId}` };
        case 'SUPPLIER_PAYMENT':
            return { label: 'Supplier Payment', path: `/accounting/supplier-payments?payment=${referenceId}` };
        case 'INVOICE':
        case 'INVOICE_PAYMENT':
            return { label: 'Customer Invoice', path: `/accounting/customer-payments?invoice=${referenceId}` };
        case 'CUSTOMER_PAYMENT':
            return { label: 'Customer Payment', path: `/accounting/customer-payments?payment=${referenceId}` };
        case 'SALE':
        case 'SALE_COGS':
        case 'SALE_REFUND':
            return { label: 'Sale', path: `/sales?highlight=${referenceId}` };
        case 'STOCK_MOVEMENT':
        case 'STOCK_ADJUSTMENT':
            return { label: 'Stock Movement', path: `/inventory/stock-movements?highlight=${referenceId}` };
        case 'JOURNAL_ENTRY':
            return { label: 'Journal Entry', path: `/accounting/journal-entries?highlight=${referenceId}` };
        default:
            return { label: referenceType.replace(/_/g, ' '), path: `/accounting/general-ledger?txn=${referenceId}` };
    }
}

async function resolvePostedBy(pool: Db, userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const res = await pool.query(
        `SELECT COALESCE(full_name, email, id::text) AS name FROM users WHERE id = $1 LIMIT 1`,
        [userId],
    );
    return res.rows[0]?.name ?? null;
}

async function fetchControlAccountJournals(
    pool: Db,
    accountCode: string,
    entityType: string,
    entityId: string,
    asOfDate: string,
    impactExpr: string,
): Promise<TraceJournalRow[]> {
    const res = await pool.query(
        `
        SELECT lt."Id"::text AS transaction_id,
            lt."TransactionNumber" AS transaction_number,
            lt."ReferenceType" AS reference_type,
            lt."ReferenceId"::text AS reference_id,
            lt."ReferenceNumber" AS reference_number,
            lt."TransactionDate"::text AS transaction_date,
            lt."Description" AS description,
            lt."CreatedById"::text AS created_by_id,
            ${impactExpr}::numeric AS impact
        FROM ledger_entries le
        JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
        JOIN accounts a ON a."Id" = le."AccountId"
        WHERE a."AccountCode" = $1
          AND UPPER(le."EntityType") = $2
          AND le."EntityId" = $3
          AND ${LEDGER_NET_ACTIVE_SQL}
          AND lt."TransactionDate"::DATE <= $4::date
        GROUP BY lt."Id", lt."TransactionNumber", lt."ReferenceType", lt."ReferenceId",
            lt."ReferenceNumber", lt."TransactionDate", lt."Description", lt."CreatedById"
        ORDER BY ABS(${impactExpr}) DESC
        LIMIT 20
        `,
        [accountCode, entityType, entityId, asOfDate],
    );

    const rows: TraceJournalRow[] = [];
    for (const row of res.rows) {
        const doc = referenceDocumentPath(row.reference_type, row.reference_id);
        rows.push({
            transactionId: row.transaction_id,
            transactionNumber: row.transaction_number,
            referenceType: row.reference_type,
            referenceId: row.reference_id,
            referenceNumber: row.reference_number,
            transactionDate: row.transaction_date,
            description: row.description,
            impact: Number(row.impact),
            postedBy: await resolvePostedBy(pool, row.created_by_id),
            documentLabel: doc?.label ?? null,
            documentPath: doc?.path ?? null,
        });
    }
    return rows;
}

async function traceApSupplier(
    pool: Db,
    supplierId: string,
    asOfDate: string,
    parsed: ParsedExceptionId,
): Promise<ExceptionTraceResult> {
    const supplierRes = await pool.query(
        `SELECT "Id"::text AS id, "CompanyName" AS name FROM suppliers WHERE "Id" = $1`,
        [supplierId],
    );
    const supplier = supplierRes.rows[0];
    if (!supplier) throw new Error('Supplier not found');

    const balanceRes = await pool.query(
        `
        WITH gl AS (
            SELECT COALESCE(SUM(le."CreditAmount" - le."DebitAmount"), 0) AS bal
            FROM ledger_entries le
            JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
            JOIN accounts a ON a."Id" = le."AccountId"
            WHERE a."AccountCode" = '2100'
              AND UPPER(le."EntityType") = 'SUPPLIER'
              AND le."EntityId" = $1
              AND lt."ReferenceType" NOT IN ('EXPENSE', 'EXPENSE_PAYMENT')
              AND ${LEDGER_NET_ACTIVE_SQL}
              AND lt."TransactionDate"::DATE <= $2::date
        ),
        open_item AS (
            SELECT COALESCE(SUM(
                CASE WHEN si.document_type = 'SUPPLIER_CREDIT_NOTE'
                  THEN -COALESCE(si."OutstandingBalance", 0)
                  ELSE COALESCE(si."OutstandingBalance", 0) END
            ), 0) AS bal
            FROM supplier_invoices si
            WHERE si."SupplierId" = $1::uuid
              AND si.deleted_at IS NULL
              AND UPPER(si."Status") NOT IN ('PAID', 'CANCELLED', 'DELETED', 'DRAFT')
              AND COALESCE(si.is_posted_to_gl, FALSE) = TRUE
              AND si."InvoiceDate"::DATE <= $2::date
        )
        SELECT g.bal AS gl_bal, o.bal AS open_bal FROM gl g, open_item o
        `,
        [supplierId, asOfDate],
    );
    const glBal = Number(balanceRes.rows[0]?.gl_bal ?? 0);
    const openBal = Number(balanceRes.rows[0]?.open_bal ?? 0);
    const diff = glBal - openBal;

    const journals = await fetchControlAccountJournals(
        pool,
        '2100',
        'SUPPLIER',
        supplierId,
        asOfDate,
        'SUM(le."CreditAmount" - le."DebitAmount")',
    );

    const openDocsRes = await pool.query(
        `
        SELECT si."Id"::text AS id,
            si.document_type,
            si."SupplierInvoiceNumber" AS document_number,
            COALESCE(si."OutstandingBalance", 0)::numeric AS amount,
            si."InvoiceDate"::text AS doc_date,
            si."Status" AS status
        FROM supplier_invoices si
        WHERE si."SupplierId" = $1::uuid
          AND si.deleted_at IS NULL
          AND UPPER(si."Status") NOT IN ('PAID', 'CANCELLED', 'DELETED', 'DRAFT')
          AND COALESCE(si.is_posted_to_gl, FALSE) = TRUE
          AND ABS(COALESCE(si."OutstandingBalance", 0)) > 0.01
        ORDER BY si."InvoiceDate" DESC
        LIMIT 15
        `,
        [supplierId],
    );

    const openDocuments: TraceOpenDocument[] = openDocsRes.rows.map((r) => ({
        id: r.id,
        documentType: r.document_type,
        documentNumber: r.document_number,
        amount: Number(r.amount),
        date: r.doc_date,
        status: r.status,
        path: `/accounting/supplier-payments?invoice=${r.id}`,
    }));

    const topJournal = journals[0];
    const cause = topJournal
        ? `${topJournal.referenceType.replace(/_/g, ' ')} ${topJournal.referenceNumber ?? topJournal.transactionNumber} may not match open supplier balance`
        : 'General ledger supplier balance does not match outstanding supplier bills';

    const chain: TraceChainStep[] = [
        {
            level: 'issue',
            id: parsed.exceptionId,
            label: 'Supplier balance mismatch',
            detail: cause,
            amount: diff,
            date: asOfDate,
            actor: null,
            navigateTo: null,
        },
        {
            level: 'control_account',
            id: '2100',
            label: 'Accounts Payable (2100)',
            detail: `Ledger ${glBal.toFixed(2)} vs outstanding ${openBal.toFixed(2)}`,
            amount: diff,
            date: null,
            actor: null,
            navigateTo: '/accounting/general-ledger?account=2100',
        },
        {
            level: 'party',
            id: supplierId,
            label: supplier.name,
            detail: 'Supplier account',
            amount: diff,
            date: null,
            actor: null,
            navigateTo: `/accounting/supplier-payments?supplier=${supplierId}`,
        },
    ];

    for (const j of journals.slice(0, 5)) {
        chain.push({
            level: 'journal',
            id: j.transactionId,
            label: j.transactionNumber,
            detail: j.description,
            amount: j.impact,
            date: j.transactionDate,
            actor: j.postedBy,
            navigateTo: `/accounting/journal-entries?highlight=${j.transactionId}`,
        });
        if (j.referenceId && j.documentPath) {
            chain.push({
                level: 'document',
                id: j.referenceId,
                label: j.documentLabel ?? j.referenceType,
                detail: j.referenceNumber,
                amount: j.impact,
                date: j.transactionDate,
                actor: j.postedBy,
                navigateTo: j.documentPath,
            });
        }
    }

    return {
        exceptionId: parsed.exceptionId,
        domain: 'ap',
        lane: parsed.lane,
        title: `Supplier balance — ${supplier.name}`,
        entityName: supplier.name,
        entityId: supplierId,
        asOfDate,
        cause,
        summary: {
            glLabel: 'General Ledger Balance',
            glBalance: glBal,
            subledgerLabel: 'Outstanding Supplier Balance',
            subledgerBalance: openBal,
            difference: diff,
        },
        chain,
        journals,
        openDocuments,
        batches: [],
        actions: [
            { label: 'Open supplier payments', path: `/accounting/supplier-payments?supplier=${supplierId}` },
            { label: 'Create journal entry', path: '/accounting/journal-entries' },
            { label: 'View ledger', path: '/accounting/general-ledger?account=2100' },
        ],
    };
}

async function traceArCustomer(
    pool: Db,
    customerId: string,
    asOfDate: string,
    parsed: ParsedExceptionId,
): Promise<ExceptionTraceResult> {
    const customerRes = await pool.query(
        `SELECT id::text, name FROM customers WHERE id = $1`,
        [customerId],
    );
    const customer = customerRes.rows[0];
    if (!customer) throw new Error('Customer not found');

    const balanceRes = await pool.query(
        `
        WITH gl AS (
            SELECT COALESCE(SUM(le."DebitAmount" - le."CreditAmount"), 0) AS bal
            FROM ledger_entries le
            JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
            JOIN accounts a ON a."Id" = le."AccountId"
            WHERE a."AccountCode" = '1200'
              AND UPPER(le."EntityType") = 'CUSTOMER'
              AND le."EntityId" = $1
              AND ${LEDGER_NET_ACTIVE_SQL}
              AND lt."TransactionDate"::DATE <= $2::date
        ),
        open_item AS (
            SELECT GREATEST(0,
                COALESCE((SELECT SUM(i.amount_due) FROM invoices i
                  WHERE i.customer_id = $1::uuid
                    AND COALESCE(i.document_type, 'INVOICE') IN (${AR_OPEN_DOCUMENT_TYPE_IN_SQL})
                    AND i.status NOT IN ('CANCELLED', 'VOIDED', 'DRAFT')
                    AND i.issue_date::DATE <= $2::date), 0)
                - COALESCE((SELECT SUM(p.unallocated_amount) FROM ar_customer_payments p
                  WHERE p.customer_id = $1::uuid
                    AND p.status IN ('POSTED', 'PARTIALLY_ALLOCATED', 'FULLY_ALLOCATED')
                    AND p.payment_date::DATE <= $2::date), 0)
            ) AS bal
        )
        SELECT g.bal AS gl_bal, o.bal AS open_bal FROM gl g, open_item o
        `,
        [customerId, asOfDate],
    );
    const glBal = Number(balanceRes.rows[0]?.gl_bal ?? 0);
    const openBal = Number(balanceRes.rows[0]?.open_bal ?? 0);
    const diff = glBal - openBal;

    const journals = await fetchControlAccountJournals(
        pool,
        '1200',
        'CUSTOMER',
        customerId,
        asOfDate,
        'SUM(le."DebitAmount" - le."CreditAmount")',
    );

    const openDocsRes = await pool.query(
        `
        SELECT i.id::text,
            COALESCE(i.document_type, 'INVOICE') AS document_type,
            i.invoice_number AS document_number,
            COALESCE(i.amount_due, 0)::numeric AS amount,
            i.issue_date::text AS doc_date,
            i.status
        FROM invoices i
        WHERE i.customer_id = $1::uuid
          AND COALESCE(i.document_type, 'INVOICE') IN (${AR_OPEN_DOCUMENT_TYPE_IN_SQL})
          AND i.status NOT IN ('CANCELLED', 'VOIDED', 'DRAFT')
          AND ABS(COALESCE(i.amount_due, 0)) > 0.01
        ORDER BY i.issue_date DESC
        LIMIT 15
        `,
        [customerId],
    );

    const openDocuments: TraceOpenDocument[] = openDocsRes.rows.map((r) => ({
        id: r.id,
        documentType: r.document_type,
        documentNumber: r.document_number,
        amount: Number(r.amount),
        date: r.doc_date,
        status: r.status,
        path: `/accounting/customer-payments?invoice=${r.id}`,
    }));

    const topJournal = journals[0];
    const cause = topJournal
        ? `Customer invoice or payment ${topJournal.referenceNumber ?? topJournal.transactionNumber} may not be posted correctly`
        : 'Customer ledger balance does not match outstanding invoices';

    const chain: TraceChainStep[] = [
        {
            level: 'issue',
            id: parsed.exceptionId,
            label: 'Customer balance mismatch',
            detail: cause,
            amount: diff,
            date: asOfDate,
            actor: null,
            navigateTo: null,
        },
        {
            level: 'control_account',
            id: '1200',
            label: 'Accounts Receivable (1200)',
            detail: `Ledger ${glBal.toFixed(2)} vs outstanding ${openBal.toFixed(2)}`,
            amount: diff,
            date: null,
            actor: null,
            navigateTo: '/accounting/general-ledger?account=1200',
        },
        {
            level: 'party',
            id: customerId,
            label: customer.name,
            detail: 'Customer account',
            amount: diff,
            date: null,
            actor: null,
            navigateTo: `/accounting/customer-payments?customer=${customerId}`,
        },
    ];

    for (const j of journals.slice(0, 5)) {
        chain.push({
            level: 'journal',
            id: j.transactionId,
            label: j.transactionNumber,
            detail: j.description,
            amount: j.impact,
            date: j.transactionDate,
            actor: j.postedBy,
            navigateTo: `/accounting/journal-entries?highlight=${j.transactionId}`,
        });
        if (j.referenceId && j.documentPath) {
            chain.push({
                level: 'document',
                id: j.referenceId,
                label: j.documentLabel ?? j.referenceType,
                detail: j.referenceNumber,
                amount: j.impact,
                date: j.transactionDate,
                actor: j.postedBy,
                navigateTo: j.documentPath,
            });
        }
    }

    return {
        exceptionId: parsed.exceptionId,
        domain: 'ar',
        lane: parsed.lane,
        title: `Customer balance — ${customer.name}`,
        entityName: customer.name,
        entityId: customerId,
        asOfDate,
        cause,
        summary: {
            glLabel: 'General Ledger Balance',
            glBalance: glBal,
            subledgerLabel: 'Outstanding Customer Balance',
            subledgerBalance: openBal,
            difference: diff,
        },
        chain,
        journals,
        openDocuments,
        batches: [],
        actions: [
            { label: 'Review customer payments', path: `/accounting/customer-payments?customer=${customerId}` },
            { label: 'Create journal entry', path: '/accounting/journal-entries' },
            { label: 'View ledger', path: '/accounting/general-ledger?account=1200' },
        ],
    };
}

async function traceInventoryProduct(
    pool: Db,
    productId: string,
    asOfDate: string,
    parsed: ParsedExceptionId,
): Promise<ExceptionTraceResult> {
    const productRes = await pool.query(
        `SELECT id::text, name FROM products WHERE id = $1`,
        [productId],
    );
    const product = productRes.rows[0];
    if (!product) throw new Error('Product not found');

    const batchRes = await pool.query(
        `
        SELECT COALESCE(SUM(ib.remaining_quantity * ib.cost_price), 0)::numeric AS batch_val
        FROM inventory_batches ib
        WHERE ib.product_id = $1::uuid AND ib.remaining_quantity > 0
        `,
        [productId],
    );
    const cacheRes = await pool.query(
        `
        SELECT (COALESCE(quantity_on_hand, 0) * COALESCE(cost_price, 0))::numeric AS cache_val
        FROM products WHERE id = $1
        `,
        [productId],
    );
    const batchVal = Number(batchRes.rows[0]?.batch_val ?? 0);
    const cacheVal = Number(cacheRes.rows[0]?.cache_val ?? 0);
    const diff = batchVal - cacheVal;

    const batchSql = await inventoryBatchSelectSql(pool);
    const batchesRes = await pool.query(batchSql, [productId]);

    const batches: TraceBatchRow[] = batchesRes.rows.map((r) => ({
        batchId: r.batch_id,
        batchNumber: r.batch_number,
        quantity: Number(r.qty),
        unitCost: Number(r.unit_cost),
        value: Number(r.value),
        receivedDate: r.received_date,
        goodsReceiptId: r.gr_id,
        goodsReceiptNumber: r.gr_number,
        goodsReceiptLabel: formatGrLabel(r.gr_number),
        warehouseId: r.warehouse_id,
        warehouseName: r.warehouse_name,
        warehouseCode: r.warehouse_code,
    }));

    const journalsRes = await pool.query(
        `
        SELECT DISTINCT lt."Id"::text AS transaction_id,
            lt."TransactionNumber" AS transaction_number,
            lt."ReferenceType" AS reference_type,
            lt."ReferenceId"::text AS reference_id,
            lt."ReferenceNumber" AS reference_number,
            lt."TransactionDate"::text AS transaction_date,
            lt."Description" AS description,
            lt."CreatedById"::text AS created_by_id,
            SUM(le."DebitAmount" - le."CreditAmount")::numeric AS impact
        FROM ledger_entries le
        JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
        JOIN accounts a ON a."Id" = le."AccountId"
        WHERE a."AccountCode" = '1300'
          AND ${LEDGER_NET_ACTIVE_SQL}
          AND lt."TransactionDate"::DATE <= $2::date
          AND (
            lt."ReferenceId" IN (
              SELECT sm.id::text FROM stock_movements sm WHERE sm.product_id = $1::uuid
            )
            OR lt."ReferenceId" IN (
              SELECT cl.goods_receipt_id::text FROM cost_layers cl
              WHERE cl.product_id = $1::uuid AND cl.goods_receipt_id IS NOT NULL
            )
          )
        GROUP BY lt."Id", lt."TransactionNumber", lt."ReferenceType", lt."ReferenceId",
            lt."ReferenceNumber", lt."TransactionDate", lt."Description", lt."CreatedById"
        ORDER BY ABS(SUM(le."DebitAmount" - le."CreditAmount")) DESC
        LIMIT 10
        `,
        [productId, asOfDate],
    );

    const journals: TraceJournalRow[] = [];
    for (const row of journalsRes.rows) {
        const doc = referenceDocumentPath(row.reference_type, row.reference_id);
        journals.push({
            transactionId: row.transaction_id,
            transactionNumber: row.transaction_number,
            referenceType: row.reference_type,
            referenceId: row.reference_id,
            referenceNumber: row.reference_number,
            transactionDate: row.transaction_date,
            description: row.description,
            impact: Number(row.impact),
            postedBy: await resolvePostedBy(pool, row.created_by_id),
            documentLabel: doc?.label ?? null,
            documentPath: doc?.path ?? null,
        });
    }

    const topBatch = batches[0];
    const grLabel = topBatch?.goodsReceiptLabel;
    const warehouseLabel = topBatch?.warehouseName ?? topBatch?.warehouseCode;
    const cause = grLabel
        ? warehouseLabel
            ? `${grLabel} at ${warehouseLabel} — batch valuation differs from stored product value`
            : `${grLabel} — batch valuation differs from stored product value`
        : 'Inventory batch valuation does not match stored product balance';

    const chain: TraceChainStep[] = [
        {
            level: 'issue',
            id: parsed.exceptionId,
            label: 'Inventory valuation difference',
            detail: cause,
            amount: diff,
            date: asOfDate,
            actor: null,
            navigateTo: null,
        },
        {
            level: 'control_account',
            id: '1300',
            label: 'Inventory (1300)',
            detail: `Batch subledger ${batchVal.toFixed(2)} vs stored ${cacheVal.toFixed(2)}`,
            amount: diff,
            date: null,
            actor: null,
            navigateTo: '/accounting/general-ledger?account=1300',
        },
        {
            level: 'party',
            id: productId,
            label: product.name,
            detail: 'Product',
            amount: diff,
            date: null,
            actor: null,
            navigateTo: `/inventory/products?highlight=${productId}`,
        },
    ];

    for (const b of batches.slice(0, 3)) {
        const batchDetail = [
            `${b.quantity} @ ${b.unitCost}`,
            b.warehouseName ? `Warehouse: ${b.warehouseName}` : null,
            b.goodsReceiptLabel ? `Source: ${b.goodsReceiptLabel}` : null,
        ]
            .filter(Boolean)
            .join(' · ');

        chain.push({
            level: 'batch',
            id: b.batchId,
            label: b.batchNumber ?? `Batch ${b.batchId.slice(0, 8)}`,
            detail: batchDetail,
            amount: b.value,
            date: b.receivedDate,
            actor: null,
            navigateTo: `/inventory/batches?highlight=${b.batchId}`,
        });
        if (b.goodsReceiptId) {
            chain.push({
                level: 'document',
                id: b.goodsReceiptId,
                label: b.goodsReceiptLabel ?? 'Goods Receipt',
                detail: b.warehouseName
                    ? `Received at ${b.warehouseName}`
                    : 'Source receipt for batch',
                amount: b.value,
                date: b.receivedDate,
                actor: null,
                navigateTo: `/inventory/goods-receipts?highlight=${b.goodsReceiptId}`,
            });
        }
    }

    for (const j of journals.slice(0, 3)) {
        chain.push({
            level: 'journal',
            id: j.transactionId,
            label: j.transactionNumber,
            detail: j.description,
            amount: j.impact,
            date: j.transactionDate,
            actor: j.postedBy,
            navigateTo: `/accounting/journal-entries?highlight=${j.transactionId}`,
        });
    }

    return {
        exceptionId: parsed.exceptionId,
        domain: 'inventory',
        lane: parsed.lane,
        title: `Inventory valuation — ${product.name}`,
        entityName: product.name,
        entityId: productId,
        asOfDate,
        cause,
        summary: {
            glLabel: 'Batch Valuation',
            glBalance: batchVal,
            subledgerLabel: 'Stored Product Value',
            subledgerBalance: cacheVal,
            difference: diff,
        },
        chain,
        journals,
        openDocuments: [],
        batches,
        actions: [
            { label: 'Open goods receipt', path: topBatch?.goodsReceiptId
                ? `/inventory/goods-receipts?highlight=${topBatch.goodsReceiptId}`
                : '/inventory/goods-receipts' },
            { label: 'Generate journal entry', path: '/accounting/journal-entries' },
            { label: 'View ledger', path: '/accounting/general-ledger?account=1300' },
            { label: 'Inventory report', path: '/reports/inventory/reconciliation' },
        ],
    };
}

async function traceDomainLane(
    pool: Db,
    domain: TraceDomain,
    laneKind: 'integrity' | 'cache',
    asOfDate: string,
    parsed: ParsedExceptionId,
): Promise<ExceptionTraceResult> {
    const lane = await getFinancialLane(pool, domain, laneKind, asOfDate);
    const domainTitle = DOMAIN_TITLES[domain];
    const accountCode = DOMAIN_ACCOUNT[domain];
    const topExceptions = (lane.exceptions ?? [])
        .filter((ex) => Math.abs(ex.difference) > 0.01)
        .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference))
        .slice(0, 15);

    const cause =
        laneKind === 'cache'
            ? `${domainTitle} stored balances are out of date — refresh from source documents`
            : topExceptions.length > 0
              ? `${topExceptions.length} ${domainTitle.toLowerCase()} exception(s) drive a ${Math.abs(lane.difference).toFixed(2)} control account gap`
              : `${domainTitle} control account does not reconcile to the subledger`;

    const openDocuments: TraceOpenDocument[] = topExceptions.map((ex) => ({
        id: ex.entityId,
        documentType: 'ENTITY_EXCEPTION',
        documentNumber: ex.entityName,
        amount: ex.difference,
        date: asOfDate,
        status: 'OPEN',
        path: entityExceptionPath(domain, ex.entityId),
    }));

    const chain: TraceChainStep[] = [
        {
            level: 'issue',
            id: parsed.exceptionId,
            label: laneKind === 'cache' ? `${domainTitle} cache drift` : `${domainTitle} control account gap`,
            detail: cause,
            amount: lane.difference,
            date: asOfDate,
            actor: null,
            navigateTo: null,
        },
        {
            level: 'control_account',
            id: accountCode,
            label: `${domainTitle} (${accountCode})`,
            detail: `${lane.leftLabel} ${lane.leftAmount.toFixed(2)} vs ${lane.rightLabel} ${lane.rightAmount.toFixed(2)}`,
            amount: lane.difference,
            date: null,
            actor: null,
            navigateTo: `/accounting/general-ledger?account=${accountCode}`,
        },
    ];

    for (const ex of topExceptions.slice(0, 8)) {
        chain.push({
            level: 'party',
            id: ex.entityId,
            label: ex.entityName,
            detail: `Ledger ${ex.leftAmount.toFixed(2)} vs subledger ${ex.rightAmount.toFixed(2)}`,
            amount: ex.difference,
            date: null,
            actor: null,
            navigateTo: entityExceptionPath(domain, ex.entityId),
        });
    }

    const actions: TraceAction[] = [
        { label: `Open ${domainTitle.toLowerCase()} workspace`, path: domainWorkspacePath(domain) },
    ];
    if (laneKind === 'cache') {
        actions.push({ label: 'Run diagnostics', path: '/accounting/financial-diagnostics' });
    } else {
        actions.push({ label: 'Create journal entry', path: '/accounting/journal-entries' });
        actions.push({ label: 'View ledger', path: `/accounting/general-ledger?account=${accountCode}` });
    }

    return {
        exceptionId: parsed.exceptionId,
        domain,
        lane: parsed.lane,
        title: `${domainTitle} — ${laneKind === 'cache' ? 'balance refresh' : 'control account review'}`,
        entityName: domainTitle,
        entityId: domain,
        asOfDate,
        cause,
        summary: {
            glLabel: lane.leftLabel,
            glBalance: lane.leftAmount,
            subledgerLabel: lane.rightLabel,
            subledgerBalance: lane.rightAmount,
            difference: lane.difference,
        },
        chain,
        journals: [],
        openDocuments,
        batches: [],
        actions,
    };
}

async function traceCashSummary(
    pool: Db,
    asOfDate: string,
    parsed: ParsedExceptionId,
): Promise<ExceptionTraceResult> {
    const cashRes = await pool.query(
        `SELECT * FROM fn_reconcile_cash_account($1::DATE)`,
        [asOfDate],
    );

    const items = cashRes.rows.map((row) => ({
        source: String(row.source),
        description: String(row.description ?? ''),
        amount: Number(row.amount ?? 0),
        difference: Number(row.difference ?? 0),
        status: String(row.status ?? ''),
    }));

    const glBalance = items.find((i) => i.source === 'GL_BALANCE')?.amount ?? 0;
    const storedBalance = items.find((i) => i.source === 'STORED_BALANCE')?.amount ?? glBalance;
    const diff = glBalance - storedBalance;

    const discrepancies = items.filter(
        (i) =>
            i.source !== 'GL_BALANCE'
            && i.source !== 'STORED_BALANCE'
            && (i.status === 'DISCREPANCY' || i.status === 'ACTION_REQUIRED')
            && Math.abs(i.difference) > 0.01,
    );

    const cause =
        discrepancies.length > 0
            ? `${discrepancies[0].description || discrepancies[0].source} may explain the cash difference`
            : Math.abs(diff) > 0.01
              ? 'Stored cash balance has drifted from the general ledger'
              : 'Cash subledger items need review';

    const openDocuments: TraceOpenDocument[] = discrepancies.slice(0, 10).map((item, idx) => ({
        id: `cash-item-${idx}`,
        documentType: item.source,
        documentNumber: item.description || item.source,
        amount: item.difference,
        date: asOfDate,
        status: item.status,
        path: '/accounting/banking',
    }));

    const chain: TraceChainStep[] = [
        {
            level: 'issue',
            id: parsed.exceptionId,
            label: 'Cash account difference',
            detail: cause,
            amount: diff,
            date: asOfDate,
            actor: null,
            navigateTo: null,
        },
        {
            level: 'control_account',
            id: '1010',
            label: 'Cash (1010)',
            detail: `Ledger ${glBalance.toFixed(2)} vs stored ${storedBalance.toFixed(2)}`,
            amount: diff,
            date: null,
            actor: null,
            navigateTo: '/accounting/general-ledger?account=1010',
        },
    ];

    for (const item of discrepancies.slice(0, 5)) {
        chain.push({
            level: 'document',
            id: item.source,
            label: item.description || item.source,
            detail: item.status,
            amount: item.difference,
            date: asOfDate,
            actor: null,
            navigateTo: '/accounting/banking',
        });
    }

    return {
        exceptionId: parsed.exceptionId,
        domain: 'cash',
        lane: parsed.lane,
        title: 'Cash account — control review',
        entityName: 'Cash (1010)',
        entityId: 'cash',
        asOfDate,
        cause,
        summary: {
            glLabel: 'General Ledger Balance',
            glBalance,
            subledgerLabel: 'Stored Cash Balance',
            subledgerBalance: storedBalance,
            difference: diff,
        },
        chain,
        journals: [],
        openDocuments,
        batches: [],
        actions: [
            { label: 'Reconcile cash', path: '/accounting/banking' },
            { label: 'View ledger', path: '/accounting/general-ledger?account=1010' },
        ],
    };
}

export async function getExceptionTrace(
    pool: Db,
    exceptionId: string,
    asOfDate?: string,
): Promise<ExceptionTraceResult> {
    const parsed = parseExceptionId(exceptionId);
    const date = asOfDate || getBusinessDate();

    if (parsed.domain === 'ap' && parsed.entityId && !parsed.isDomainLevel) {
        return traceApSupplier(pool, parsed.entityId, date, parsed);
    }
    if (parsed.domain === 'ar' && parsed.entityId && !parsed.isDomainLevel) {
        return traceArCustomer(pool, parsed.entityId, date, parsed);
    }
    if (parsed.domain === 'inventory' && parsed.entityId && !parsed.isDomainLevel) {
        return traceInventoryProduct(pool, parsed.entityId, date, parsed);
    }

    if (parsed.exceptionId === 'exc-cash-summary' || (parsed.isDomainLevel && parsed.domain === 'cash')) {
        return traceCashSummary(pool, date, parsed);
    }

    if (parsed.isDomainLevel) {
        const laneKind = parsed.lane === 'cache' ? 'cache' : 'integrity';
        return traceDomainLane(pool, parsed.domain, laneKind, date, parsed);
    }

    throw new Error(`Unknown exception id format: ${exceptionId}`);
}

/** Load full journal detail for drill-down expand. */
export async function getTraceJournalDetail(pool: Db, transactionId: string) {
    return getLedgerTransactionById(transactionId, pool as Pool);
}
