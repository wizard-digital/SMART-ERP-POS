/**
 * Quotation Service
 * Business logic for quotation system
 * 
 * CRITICAL BUSINESS RULES:
 * BR-QUOTE-001: Quote can only be converted once (check converted_to_sale_id IS NULL)
 * BR-QUOTE-002: Expired quotes cannot be converted (check valid_until >= CURRENT_DATE)
 * BR-QUOTE-003: Conversion creates sale + invoice atomically (BEGIN TRANSACTION)
 * BR-QUOTE-004: Quote items copied exactly to sale items
 * BR-QUOTE-005: Quote total must match sale total
 * BR-QUOTE-006: Both quick and standard quotes follow same conversion rules
 * BR-QUOTE-011: GL entries must be posted on quotation→sale conversion
 * BR-QUOTE-012: Duplicate content hash prevents double-creation of *open* quotes
 * BR-QUOTE-013: Credit limit checked before credit-sale conversion
 * BR-QUOTE-014: Item-level acceptance/rejection (SAP-style)
 */

import { Pool } from 'pg';
import Decimal from 'decimal.js';
import { deductStockFEFO } from '../../utils/fefoDeduction.js';
import { isMultistoreEnabled } from '../inventory/warehouse/multistoreSettings.js';
import { warehouseSaleDeductionService } from '../inventory/warehouse/warehouseSaleDeductionService.js';
import { quotationRepository, QuotationDbRow, QuotationItemDbRow } from './quotationRepository.js';
import { salesService } from '../sales/salesService.js';
import { salesRepository, CreateSaleData, CreateSaleItemData } from '../sales/salesRepository.js';
import { invoiceService } from '../invoices/invoiceService.js';
import { UnitOfWork } from '../../db/unitOfWork.js';
import * as documentFlowService from '../document-flow/documentFlowService.js';
import { checkMaintenanceMode } from '../../utils/maintenanceGuard.js';
import {
  computeContentHash,
  TERMINAL_CONTENT_HASH_STATUSES,
} from './quotationContentHash.js';
import * as glEntryService from '../../services/glEntryService.js';
import { getBusinessDate, formatDateBusiness, addDaysToDateString } from '../../utils/dateRange.js';
import { buildQuoteConversionLineSnapshots } from './quotationSaleUom.js';
import { loadMasterUoms, normalizeQuotationLineUom } from './quotationUomResolver.js';
import { InventoryBusinessRules, SalesBusinessRules } from '../../middleware/businessRules.js';
import * as masterDataGuard from '../../services/masterDataGuard.js';
import { NotFoundError, ValidationError, BusinessError, ConflictError } from '../../middleware/errorHandler.js';
import { DocumentTaxService } from '../../services/documentTaxService.js';
import { createLogger } from '../../utils/logger.js';
import { assertEditableQuotation, assertStatusChangeable } from './quotationGuards.js';
import { assertSaleLineNotBelowAllocatedCost } from '../sales/saleBelowCostGuard.js';
import {
  allocatedCostPerSellingUnit,
  previewProductLineAllocatedCost,
} from '../sales/saleAllocatedCostPreview.js';
import { Money } from '../../utils/money.js';

const logger = createLogger('quotationService');

/** Input shared by createQuotation and createQuotationInTransaction (CRM bridge). */
export type CreateQuotationServiceInput = {
  quoteType: 'quick' | 'standard';
  customerId?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  reference?: string | null;
  description?: string | null;
  validFrom: string;
  validUntil: string;
  createdById?: string | null;
  assignedToId?: string | null;
  termsAndConditions?: string | null;
  paymentTerms?: string | null;
  deliveryTerms?: string | null;
  internalNotes?: string | null;
  requiresApproval?: boolean;
  fulfillmentMode?: 'RETAIL' | 'WHOLESALE';
  items: Array<{
    productId?: string | null;
    itemType: 'product' | 'service' | 'custom';
    sku?: string | null;
    description: string;
    notes?: string | null;
    quantity: number;
    unitPrice: number;
    discountAmount?: number;
    isTaxable?: boolean;
    taxRate?: number;
    uomId?: string | null;
    uomName?: string | null;
    unitCost?: number | null;
    productType?: string;
  }>;
};

// ============================================================================
// TYPE DEFINITIONS (camelCase for application layer)
// Re-declared locally because service returns Date objects for timestamps
// while shared/types uses string-only representation.
// ============================================================================

export interface Quotation {
  id: string;
  quoteNumber: string;
  quoteType: 'quick' | 'standard';
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  reference: string | null;
  description: string | null;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  totalAmount: number;
  status: string; // DB status; caller should normalizeStatus() for display
  validFrom: string;
  validUntil: string;
  convertedToSaleId: string | null;
  convertedToInvoiceId: string | null;
  convertedToSaleNumber: string | null;
  convertedToInvoiceNumber: string | null;
  convertedAt: Date | null;
  createdById: string | null;
  assignedToId: string | null;
  termsAndConditions: string | null;
  paymentTerms: string | null;
  deliveryTerms: string | null;
  internalNotes: string | null;
  rejectionReason: string | null;
  requiresApproval: boolean;
  approvedById: string | null;
  approvedAt: Date | null;
  parentQuoteId: string | null;
  revisionNumber: number;
  createdAt: Date;
  updatedAt: Date;
  version?: number;
  fulfillmentMode: 'RETAIL' | 'WHOLESALE';
}

export interface QuotationItem {
  id: string;
  quotationId: string;
  lineNumber: number;
  productId: string | null;
  itemType: 'product' | 'service' | 'custom';
  sku: string | null;
  description: string;
  notes: string | null;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  subtotal: number;
  isTaxable: boolean;
  taxRate: number;
  taxAmount: number;
  lineTotal: number;
  uomId: string | null;
  uomName: string | null;
  unitCost: number | null;
  costTotal: number | null;
  productType: string;
  itemStatus: 'OPEN' | 'ACCEPTED' | 'REJECTED';
  rejectionReason: string | null;
  deliveredQuantity: number;
  createdAt: Date;
}

export interface QuotationDetail {
  quotation: Quotation;
  items: QuotationItem[];
}

// ============================================================================
// NORMALIZATION UTILITIES
// ============================================================================

function normalizeQuotation(row: QuotationDbRow & { converted_to_sale_number?: string; converted_to_invoice_number?: string }): Quotation {
  return {
    id: row.id,
    quoteNumber: row.quote_number,
    quoteType: row.quote_type,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerEmail: row.customer_email,
    reference: row.reference,
    description: row.description,
    subtotal: parseFloat(row.subtotal),
    discountAmount: parseFloat(row.discount_amount),
    taxAmount: parseFloat(row.tax_amount),
    totalAmount: parseFloat(row.total_amount),
    status: row.status,
    validFrom: typeof row.valid_from === 'string' ? row.valid_from : formatDateBusiness(row.valid_from),
    validUntil: typeof row.valid_until === 'string' ? row.valid_until : formatDateBusiness(row.valid_until),
    convertedToSaleId: row.converted_to_sale_id,
    convertedToInvoiceId: row.converted_to_invoice_id,
    // Human-readable identifiers for display
    convertedToSaleNumber: row.converted_to_sale_number || null,
    convertedToInvoiceNumber: row.converted_to_invoice_number || null,
    convertedAt: row.converted_at,
    createdById: row.created_by_id,
    assignedToId: row.assigned_to_id,
    termsAndConditions: row.terms_and_conditions,
    paymentTerms: row.payment_terms,
    deliveryTerms: row.delivery_terms,
    internalNotes: row.internal_notes,
    rejectionReason: row.rejection_reason,
    requiresApproval: row.requires_approval,
    approvedById: row.approved_by_id,
    approvedAt: row.approved_at,
    parentQuoteId: row.parent_quote_id,
    revisionNumber: row.revision_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    fulfillmentMode: row.fulfillment_mode || 'RETAIL',
  };
}

function normalizeQuotationItem(row: QuotationItemDbRow): QuotationItem {
  return {
    id: row.id,
    quotationId: row.quotation_id,
    lineNumber: row.line_number,
    productId: row.product_id,
    itemType: row.item_type,
    sku: row.sku,
    description: row.description,
    notes: row.notes,
    quantity: parseFloat(row.quantity),
    unitPrice: parseFloat(row.unit_price),
    discountAmount: parseFloat(row.discount_amount),
    subtotal: parseFloat(row.subtotal),
    isTaxable: row.is_taxable,
    taxRate: parseFloat(row.tax_rate),
    taxAmount: parseFloat(row.tax_amount),
    lineTotal: parseFloat(row.line_total),
    uomId: row.uom_id,
    uomName: row.uom_name,
    unitCost: row.unit_cost ? parseFloat(row.unit_cost) : null,
    costTotal: row.cost_total ? parseFloat(row.cost_total) : null,
    productType: row.product_type,
    itemStatus: row.item_status || 'OPEN',
    rejectionReason: row.rejection_reason || null,
    deliveredQuantity: row.delivered_quantity ? parseFloat(row.delivered_quantity) : 0,
    createdAt: row.created_at,
  };
}

// ============================================================================
// SERVICE FUNCTIONS
// ============================================================================

export const quotationService = {
  /**
   * Create quotation with items (own transaction).
   */
  async createQuotation(
    pool: Pool,
    data: CreateQuotationServiceInput,
  ): Promise<QuotationDetail> {
    return UnitOfWork.run(pool, async (client) => this.createQuotationInTransaction(client, data));
  },

  /**
   * Core create path — callable inside an existing transaction (CRM WON bridge).
   */
  async createQuotationInTransaction(
    client: import('pg').PoolClient,
    data: CreateQuotationServiceInput,
  ): Promise<QuotationDetail> {
      const masterUoms = await loadMasterUoms(client);

      // DocumentTaxService — authoritative; prefer-line only when quote line makes an explicit decision
      const priced = await DocumentTaxService.priceDocumentLines(client, {
        customerId: data.customerId,
        scope: 'SALE',
        preferLineTaxOverrides: true,
        applyTenantDefaultWhenUnresolved: false,
        lines: data.items.map((item) => ({
          productId: item.productId || null,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discountAmount: item.discountAmount || 0,
          // undefined isTaxable → allow mapping/bridge; explicit false → NONE
          isTaxable: item.isTaxable === false ? false : item.isTaxable === true ? true : undefined,
          taxRate:
            item.taxRate !== undefined && item.taxRate !== null
              ? Number(item.taxRate)
              : undefined,
        })),
      });

      const subtotal = new Decimal(priced.subtotal);
      const taxAmount = new Decimal(priced.taxAmount);

      const itemsWithTotals = data.items.map((item, idx) => {
        const qty = new Decimal(item.quantity);
        const discount = new Decimal(item.discountAmount || 0);
        const taxLine = priced.lines[idx];

        const normalizedUom = normalizeQuotationLineUom(masterUoms, {
          itemType: item.itemType,
          productId: item.productId,
          uomId: item.uomId,
          uomName: item.uomName,
        });

        return {
          lineNumber: idx + 1,
          productId: item.productId || null,
          itemType: item.itemType,
          sku: item.sku || null,
          description: item.description,
          notes: item.notes || null,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discountAmount: discount.toNumber(),
          subtotal: taxLine.lineNetAmount,
          isTaxable: taxLine.isTaxable,
          taxRate: taxLine.taxRate,
          taxAmount: taxLine.taxAmount,
          lineTotal: taxLine.lineTotal,
          uomId: normalizedUom.uomId,
          uomName: normalizedUom.uomName,
          unitCost: item.unitCost || null,
          costTotal: item.unitCost ? new Decimal(item.unitCost).times(qty).toNumber() : null,
          productType: item.productType || 'inventory',
        };
      });

      const totalAmount = new Decimal(priced.totalAmount);

      // BR-QUOTE-012: Duplicate prevention via content hash (open quotes only).
      const contentHash = computeContentHash(
        data.customerId,
        data.customerName,
        data.items.map((i) => ({
          productId: i.productId,
          description: i.description,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          discountAmount: i.discountAmount,
          taxRate: i.taxRate,
          isTaxable: i.isTaxable,
          uomName: i.uomName,
        })),
        data.customerPhone,
      );

      const terminalStatuses = [...TERMINAL_CONTENT_HASH_STATUSES];
      const dupCheck = await client.query(
        `SELECT id, quote_number, status, customer_name, created_at
         FROM quotations
         WHERE content_hash = $1
           AND status <> ALL($2::quotation_status[])
         LIMIT 1`,
        [contentHash, terminalStatuses],
      );
      if (dupCheck.rows.length > 0) {
        const dup = dupCheck.rows[0] as {
          quote_number: string;
          status: string;
          customer_name: string | null;
          created_at: Date | string;
        };
        const when = dup.created_at
          ? new Date(dup.created_at).toISOString().slice(0, 10)
          : 'unknown date';
        throw new Error(
          `Duplicate quotation detected. Open quotation ${dup.quote_number} ` +
            `(status ${dup.status}, customer "${dup.customer_name || 'n/a'}", created ${when}) ` +
            `has the same customer and line items. Edit or cancel that quotation first.`,
        );
      }

      const quotation = await quotationRepository.createQuotation(client, {
        ...data,
        subtotal: subtotal.toNumber(),
        discountAmount: 0,
        taxAmount: taxAmount.toNumber(),
        totalAmount: totalAmount.toNumber(),
        contentHash,
      });

      const items = await quotationRepository.createQuotationItems(
        client,
        quotation.id,
        itemsWithTotals
      );

      return {
        quotation: normalizeQuotation(quotation),
        items: items.map(normalizeQuotationItem),
      };
  },

  /**
   * Get quotation by ID
   */
  async getQuotationById(pool: Pool, id: string): Promise<QuotationDetail | null> {
    const result = await quotationRepository.getQuotationById(pool, id);
    if (!result) return null;

    return {
      quotation: normalizeQuotation(result.quotation),
      items: result.items.map(normalizeQuotationItem),
    };
  },

  /**
   * Get quotation by quote number
   */
  async getQuotationByNumber(pool: Pool, quoteNumber: string): Promise<QuotationDetail | null> {
    const result = await quotationRepository.getQuotationByNumber(pool, quoteNumber);
    if (!result) return null;

    return {
      quotation: normalizeQuotation(result.quotation),
      items: result.items.map(normalizeQuotationItem),
    };
  },

  /**
   * List quotations
   */
  async listQuotations(
    pool: Pool,
    filters: {
      page: number;
      limit: number;
      customerId?: string;
      status?: string;
      quoteType?: 'quick' | 'standard';
      assignedToId?: string;
      createdById?: string;
      fromDate?: string;
      toDate?: string;
      searchTerm?: string;
      openOnly?: boolean;
    }
  ): Promise<{ quotations: Quotation[]; total: number; page: number; limit: number; totalPages: number }> {
    const result = await quotationRepository.listQuotations(pool, filters);

    return {
      quotations: result.quotations.map(normalizeQuotation),
      total: result.total,
      page: filters.page,
      limit: filters.limit,
      totalPages: Math.ceil(result.total / filters.limit),
    };
  },

  /**
   * Update quotation (DRAFT only)
   */
  async updateQuotation(
    pool: Pool,
    id: string,
    data: Record<string, unknown>
  ): Promise<Quotation> {
    await UnitOfWork.run(pool, async (client) => {
      // Get existing quotation — lock the row to avoid TOCTOU with concurrent
      // convertQuotationToSale / convertFromQuotation.
      const existing = await client.query(
        `SELECT status, quote_number, customer_id, customer_name,
                converted_to_sale_id, converted_to_so_id, converted_to_dn_id
           FROM quotations WHERE id = $1 FOR UPDATE`,
        [id]
      );

      if (existing.rows.length === 0) {
        throw new NotFoundError('Quotation not found');
      }

      // SSOT editability guard — covers terminal statuses AND either conversion FK.
      assertEditableQuotation(existing.rows[0]);

      // Update quotation header
      const updated = await quotationRepository.updateQuotation(client, id, data);

      // If items provided, update them
      if (data.items && Array.isArray(data.items)) {
        const masterUoms = await loadMasterUoms(client);

        // Delete existing items
        await client.query('DELETE FROM quotation_items WHERE quotation_id = $1', [id]);

        const customerId = (data as Record<string, unknown>).customerId as string | undefined || existing.rows[0].customer_id;
        const customerName = (data as Record<string, unknown>).customerName as string | undefined || existing.rows[0].customer_name;

        const rawItems = data.items as Record<string, unknown>[];
        const priced = await DocumentTaxService.priceDocumentLines(client, {
          customerId,
          scope: 'SALE',
          preferLineTaxOverrides: true,
          applyTenantDefaultWhenUnresolved: false,
          lines: rawItems.map((raw) => {
            const item = raw as Record<string, string | number | boolean | null>;
            const isTaxableRaw = item.isTaxable;
            return {
              productId: (item.productId as string | null) || null,
              quantity: Number(item.quantity),
              unitPrice: Number(item.unitPrice),
              discountAmount: Number(item.discountAmount || 0),
              isTaxable:
                isTaxableRaw === false ? false : isTaxableRaw === true ? true : undefined,
              taxRate:
                item.taxRate !== undefined && item.taxRate !== null
                  ? Number(item.taxRate)
                  : undefined,
            };
          }),
        });

        const subtotal = new Decimal(priced.subtotal);
        const taxAmount = new Decimal(priced.taxAmount);
        const totalAmount = new Decimal(priced.totalAmount);

        const itemsWithTotals = rawItems.map((raw: Record<string, unknown>, idx: number) => {
          const item = raw as Record<string, string | number | boolean | null>;
          const qty = new Decimal(item.quantity as number);
          const discount = new Decimal(item.discountAmount || 0);
          const taxLine = priced.lines[idx];

          const normalizedUom = normalizeQuotationLineUom(masterUoms, {
            itemType: String(item.itemType || 'product'),
            productId: (item.productId as string | null) || null,
            uomId: (item.uomId as string | null) || null,
            uomName: (item.uomName as string | null) || null,
          });

          return {
            lineNumber: idx + 1, // Auto-assign line numbers
            productId: (item.productId as string | null) || null,
            itemType: (item.itemType as 'product' | 'service' | 'custom') || 'product',
            sku: (item.sku as string | null) || null,
            description: String(item.description || ''),
            notes: (item.notes as string | null) || null,
            quantity: Number(item.quantity),
            unitPrice: Number(item.unitPrice),
            discountAmount: discount.toNumber(),
            subtotal: taxLine.lineNetAmount,
            isTaxable: taxLine.isTaxable,
            taxRate: taxLine.taxRate,
            taxAmount: taxLine.taxAmount,
            lineTotal: taxLine.lineTotal,
            uomId: normalizedUom.uomId,
            uomName: normalizedUom.uomName,
            unitCost: item.unitCost ? Number(item.unitCost) : null,
            costTotal: item.unitCost ? new Decimal(item.unitCost).times(qty).toNumber() : null,
            productType: String(item.productType || 'inventory'),
          };
        });

        // Update quotation totals + recompute content hash (BR-QUOTE-012)
        const newContentHash = computeContentHash(
          customerId,
          customerName,
          itemsWithTotals.map((i) => ({
            productId: i.productId,
            description: i.description,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            discountAmount: i.discountAmount,
            taxRate: i.taxRate,
            isTaxable: i.isTaxable,
            uomName: i.uomName,
          })),
          existing.rows[0].customer_phone,
        );

        await quotationRepository.updateQuotation(client, id, {
          subtotal: subtotal.toNumber(),
          taxAmount: taxAmount.toNumber(),
          totalAmount: totalAmount.toNumber(),
          contentHash: newContentHash,
        });

        // Insert new items
        await quotationRepository.createQuotationItems(client, id, itemsWithTotals);
      }

    });

    // Return full quotation with items (after commit)
    const result = await this.getQuotationById(pool, id);
    if (!result) {
      throw new Error('Failed to retrieve updated quotation');
    }

    return result.quotation;
  },

  /**
   * Update quotation status
   * SIMPLIFIED: Only CANCELLED is a valid manual status change.
   * CONVERTED is set automatically via convert endpoint.
   */
  async updateQuotationStatus(
    pool: Pool,
    id: string,
    status: string,
    notes?: string
  ): Promise<Quotation> {
    return UnitOfWork.run(pool, async (client) => {
      // CRITICAL: Check current quotation state before allowing status change.
      // Use FOR UPDATE via the transaction client (not pool) to prevent a concurrent
      // convertQuotationToSale from slipping between this read and the UPDATE below.
      // (Issue #3 forensic audit — TOCTOU race with pool-based read outside transaction)
      const lockRow = await client.query(
        `SELECT status, quote_number, converted_to_sale_id, converted_to_so_id, converted_to_dn_id
           FROM quotations WHERE id = $1 FOR UPDATE`,
        [id]
      );

      if (!lockRow.rows[0]) {
        throw new NotFoundError('Quotation not found');
      }

      // SSOT status-change guard — rejects CONVERTED source, FK-claimed quotes,
      // and manual target=CONVERTED writes.
      assertStatusChangeable(lockRow.rows[0], status);

      const quotation = await quotationRepository.updateQuotationStatus(client, id, status, notes);

      return normalizeQuotation(quotation);
    });
  },

  /**
   * CRITICAL: Convert quotation to sale + invoice
   * 
   * BR-QUOTE-003: Atomic transaction creating sale + invoice
   * BR-QUOTE-004: Quote items copied exactly to sale items
   * BR-QUOTE-005: Quote total must match sale total
   * 
   * Payment options:
   * - 'full': Complete payment (COMPLETED sale, PAID invoice)
   * - 'partial': Deposit payment (COMPLETED sale, PARTIALLY_PAID invoice)
   * - 'none': No payment (COMPLETED sale, UNPAID invoice)
   */
  /**
   * Formal API convert (sale + invoice). UI SSOT is POS load-quote → complete sale.
   * Prefer not wiring new UI here — pricing/stock (BR-QUOTE) can diverge from POS convert.
   */
  async convertQuotationToSale(
    pool: Pool,
    quotationId: string,
    data: {
      paymentOption: 'full' | 'partial' | 'none';
      depositAmount?: number;
      depositMethod?: 'CASH' | 'CARD' | 'MOBILE_MONEY';
      cashierId: string;
      notes?: string;
      cashRegisterSessionId?: string;
    }
  ): Promise<{
    sale: Record<string, unknown>;
    invoice: unknown;
    payment?: Record<string, unknown>;
  }> {
    // Phase 1: Transactional work - create sale, sale items, GL posting, mark converted
    const result = await UnitOfWork.run(pool, async (client) => {
      // Maintenance mode guard (replaces trg_maintenance_check_sales)
      await checkMaintenanceMode(client);

      // Lock quotation row first (TOCTOU with concurrent convert / status change).
      const lockRow = await client.query(
        `SELECT id FROM quotations WHERE id = $1 FOR UPDATE`,
        [quotationId],
      );
      if (lockRow.rows.length === 0) {
        throw new NotFoundError('Quotation');
      }

      const quoteData = await quotationRepository.getQuotationById(client, quotationId);
      if (!quoteData) {
        throw new NotFoundError('Quotation');
      }

      const { quotation, items } = quoteData;

      // BR-QUOTE-010: WHOLESALE quotations cannot be converted to a sale.
      // They follow the Delivery Note → Invoice path instead.
      if (quotation.fulfillment_mode === 'WHOLESALE') {
        throw new BusinessError(
          `Quotation ${quotation.quote_number} is WHOLESALE. ` +
          `Use Delivery Notes → Invoice instead of converting to a sale.`,
          'BR-QUOTE-010',
          { quotationId: quotation.id, quoteNumber: quotation.quote_number },
        );
      }

      // BR-QUOTE-001: Check conversion eligibility
      const canConvert = await quotationRepository.canConvertQuotation(client, quotationId);
      if (!canConvert.can) {
        throw new ConflictError(`Cannot convert quotation: ${canConvert.reason}`);
      }

      // BR-QUOTE-002: Verify not expired
      const today = getBusinessDate();
      if (String(quotation.valid_until) < today) {
        throw new ConflictError('Quotation has expired');
      }

      // Get default UOM for cases where quotation UOM doesn't exist
      const defaultUomResult = await client.query(
        `SELECT id FROM uoms WHERE name = 'Each' LIMIT 1`
      );
      const defaultUomId = defaultUomResult.rows[0]?.id;

      // Validate UOM IDs exist, use default if not
      const validatedUomIds = await Promise.all(
        items.map(async (item) => {
          if (!item.uom_id) return defaultUomId;

          const uomCheck = await client.query(
            `SELECT id FROM uoms WHERE id = $1`,
            [item.uom_id]
          );

          return uomCheck.rows.length > 0 ? item.uom_id : defaultUomId;
        })
      );

      // MUoM SSOT: resolve base quantities for inventory deduction (Wave 4 / Rule 2).
      const productLineMeta: Array<{
        itemIndex: number;
        productId: string;
        quantity: number;
        uomId: string | null;
        unitCost: number | null;
      }> = [];
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        if (!item.product_id || String(item.product_id).startsWith('custom_')) continue;

        // BR-SAL-005: product must be active. Catches the case where a quote
        // was raised against a product that was later archived/discontinued.
        await SalesBusinessRules.validateProductActive(client, item.product_id);
        // MDG-002: product must have a configured selling price.
        await masterDataGuard.assertItemHasSellingPrice(client, item.product_id);

        productLineMeta.push({
          itemIndex: idx,
          productId: item.product_id,
          quantity: parseFloat(item.quantity),
          uomId: validatedUomIds[idx] ?? null,
          unitCost: item.unit_cost ? parseFloat(item.unit_cost) : null,
        });
      }
      const quoteUomSnapshots = await buildQuoteConversionLineSnapshots(
        client,
        productLineMeta.map((m) => ({
          productId: m.productId,
          quantity: m.quantity,
          uomId: m.uomId,
          unitCost: m.unitCost,
        })),
      );
      const uomSnapshotByItemIndex = new Map(
        productLineMeta.map((m, i) => [m.itemIndex, quoteUomSnapshots[i]]),
      );

      // Prepare sale data
      // CRITICAL: Use unit_price * quantity (pre-tax) as lineTotal, NOT item.line_total.
      // Quotation items store line_total as TAX-INCLUSIVE (subtotal + tax).
      // The GL trigger fn_post_sale_to_ledger sums sale_items.total_price as revenue
      // and then adds sale.tax_amount separately. Using the tax-inclusive line_total
      // would double-count tax and cause GL BALANCE VIOLATION.
      const saleItems = items.map((item, index) => {
        const qty = new Decimal(item.quantity);
        const price = new Decimal(item.unit_price);
        const preTaxLineTotal = qty.times(price);
        const uomSnap = uomSnapshotByItemIndex.get(index);
        const costPerItem = uomSnap
          ? new Decimal(uomSnap.baseUnitCost)
          : item.unit_cost
            ? new Decimal(item.unit_cost)
            : new Decimal(0);
        const itemCost = uomSnap
          ? costPerItem.times(uomSnap.baseQuantity)
          : costPerItem.times(qty);

        return {
          productId: item.product_id,
          productName: item.description,
          quantity: parseFloat(item.quantity),
          unitPrice: parseFloat(item.unit_price),
          lineTotal: parseFloat(preTaxLineTotal.toFixed(2)),
          uomId: validatedUomIds[index],
          uomName: item.uom_name,
          costPrice: uomSnap ? uomSnap.baseUnitCost : item.unit_cost ? parseFloat(item.unit_cost) : 0,
          profit: parseFloat(preTaxLineTotal.minus(itemCost).toFixed(2)),
          uomSnapshot: uomSnap,
        };
      });

      // Same allocated-cost floor as salesService.createSale (saleAllocatedCostPreview SSOT).
      // Quote unit_cost is not the floor.
      const convertMultistore = await isMultistoreEnabled(client);
      const convertSellingStoreId = convertMultistore
        ? await warehouseSaleDeductionService.resolveSellingStoreId(client)
        : null;
      for (const item of saleItems) {
        if (!item.productId || String(item.productId).startsWith('custom_')) continue;
        const baseQty = item.uomSnapshot
          ? new Decimal(item.uomSnapshot.baseQuantity)
          : new Decimal(item.quantity);
        const productCost = await client.query<{
          min_days: string | number;
          cost_price: string;
          average_cost: string;
        }>(
          `SELECT COALESCE(p.min_days_before_expiry_sale, 0) AS min_days,
                  COALESCE(p.cost_price, 0)::text AS cost_price,
                  COALESCE(pv.average_cost, 0)::text AS average_cost
             FROM products p
             LEFT JOIN product_valuation pv ON pv.product_id = p.id
            WHERE p.id = $1`,
          [item.productId],
        );
        const minDays = parseInt(String(productCost.rows[0]?.min_days ?? '0'), 10);
        const masterCost = Money.parseDb(String(productCost.rows[0]?.cost_price ?? '0'));
        const averageCost = Money.parseDb(String(productCost.rows[0]?.average_cost ?? '0'));
        const { totalCost: allocatedCost } = await previewProductLineAllocatedCost(client, {
          productId: item.productId,
          baseQty,
          masterCost,
          averageCost,
          minDaysBeforeExpiry: minDays,
          sellingStoreId: convertSellingStoreId,
        });
        const allocated = Money.toNumber(allocatedCost);
        const costPerSelling = allocatedCostPerSellingUnit(allocatedCost, item.quantity);
        assertSaleLineNotBelowAllocatedCost({
          productId: item.productId,
          productName: item.productName,
          quantity: item.quantity,
          lineRevenue: item.lineTotal,
          totalAllocatedCost: allocated,
          costPerSellingUnit: costPerSelling,
          unitPrice: item.unitPrice,
        });
        item.costPrice = costPerSelling;
        item.profit = parseFloat(new Decimal(item.lineTotal).minus(allocatedCost).toFixed(2));
      }

      const totalAmount = parseFloat(quotation.total_amount);
      const totalCost = saleItems.reduce((sum, item) => {
        const cost = item.costPrice ? new Decimal(item.costPrice) : new Decimal(0);
        const qty = new Decimal(item.quantity);
        return sum + cost.times(qty).toNumber();
      }, 0);

      // Handle missing customer_id by looking up customer by name
      let customerId = quotation.customer_id;
      if (!customerId && quotation.customer_name) {
        const customerResult = await client.query(
          'SELECT id FROM customers WHERE name = $1 LIMIT 1',
          [quotation.customer_name]
        );
        if (customerResult.rows.length > 0) {
          customerId = customerResult.rows[0].id;
        }
      }

      if (!customerId) {
        throw new NotFoundError('Customer for quotation');
      }

      // ============================================================
      // VALIDATION: Prevent subtotal/total swap corruption
      // BR-QUOTE-005: Quote total must match sale total
      // This validation ensures data integrity during conversion
      // ============================================================
      const quoteSubtotal = new Decimal(quotation.subtotal);
      const quoteTax = new Decimal(quotation.tax_amount);
      const quoteDiscount = new Decimal(quotation.discount_amount);
      const quoteTotal = new Decimal(quotation.total_amount);

      // Validate quote internal consistency: subtotal - discount + tax = total
      const expectedTotal = quoteSubtotal.minus(quoteDiscount).plus(quoteTax);
      const tolerance = new Decimal('0.01'); // Allow 1 cent tolerance for floating point

      if (expectedTotal.minus(quoteTotal).abs().greaterThan(tolerance)) {
        console.error('Quote data integrity failure:', {
          quoteNumber: quotation.quote_number,
          subtotal: quoteSubtotal.toNumber(),
          discount: quoteDiscount.toNumber(),
          tax: quoteTax.toNumber(),
          storedTotal: quoteTotal.toNumber(),
          expectedTotal: expectedTotal.toNumber(),
          difference: expectedTotal.minus(quoteTotal).abs().toNumber(),
        });
        throw new ValidationError(
          `Quote ${quotation.quote_number} has inconsistent totals. ` +
          `Expected ${expectedTotal.toFixed(2)} but found ${quoteTotal.toFixed(2)}. ` +
          `Please verify the quotation before converting.`
        );
      }

      // Validate subtotal > 0 and total > subtotal (when tax exists)
      if (quoteSubtotal.lessThanOrEqualTo(0)) {
        throw new ValidationError('Quote subtotal must be greater than zero');
      }

      if (quoteTax.greaterThan(0) && quoteTotal.lessThanOrEqualTo(quoteSubtotal)) {
        console.error('Possible subtotal/total swap detected:', {
          quoteNumber: quotation.quote_number,
          subtotal: quoteSubtotal.toNumber(),
          total: quoteTotal.toNumber(),
          tax: quoteTax.toNumber(),
        });
        throw new ValidationError(
          `Quote ${quotation.quote_number} appears to have swapped subtotal/total values. ` +
          `Subtotal (${quoteSubtotal.toFixed(2)}) should be less than total (${quoteTotal.toFixed(2)}) when tax exists.`
        );
      }

      // BR-QUOTE-013 + BR-SAL-003: Credit limit enforcement via Sales SSOT.
      // Covers BOTH 'none' (full credit) and 'partial' (deposit + outstanding balance)
      // — the prior inline check only ran for 'none' and used a raw query.
      // For partial deposits the outstanding amount is what hits the customer's AR.
      if (data.paymentOption === 'none' || data.paymentOption === 'partial') {
        const outstandingAmount = data.paymentOption === 'partial'
          ? Math.max(0, totalAmount - (data.depositAmount || 0))
          : totalAmount;
        if (outstandingAmount > 0) {
          await SalesBusinessRules.validateCreditSale(
            client,
            customerId,
            outstandingAmount,
            'CREDIT',
          );
        }
      }

      // Log the values being used for audit trail
      logger.info('Quote to Sale conversion - verified values', {
        quoteNumber: quotation.quote_number,
        subtotal: quoteSubtotal,
        tax: quoteTax,
        discount: quoteDiscount,
        total: quoteTotal,
        totalAmount,
      });

      // ============================================================
      // SALES SSOT: route header insert through salesRepository.createSale
      // Gains (vs prior raw INSERT):
      //   - generateSaleNumber (pg_advisory_xact_lock) — no sale_number race
      //   - checkAccountingPeriodOpen — period control enforced
      //   - idempotency_key / offline_id / cash_register_session_id columns set
      //   - profit = (subtotal - discount) - totalCost  (tax-excluded, correct)
      //   - chk_sales_payment_valid → BusinessError mapping
      // Idempotency key "QC:<quoteId>" makes retry of a transiently-failed
      // conversion safe (advisory_lock+unique key prevents duplicate sales).
      // ============================================================
      const saleData: CreateSaleData = {
        customerId,
        subtotal: parseFloat(quotation.subtotal),
        totalAmount,
        totalCost,
        discountAmount: parseFloat(quotation.discount_amount),
        taxAmount: parseFloat(quotation.tax_amount) || 0,
        paymentMethod: data.paymentOption === 'none' ? 'CREDIT' : (data.depositMethod || 'CASH'),
        paymentReceived: data.paymentOption === 'full' ? totalAmount : (data.depositAmount || 0),
        changeAmount: 0,
        soldBy: data.cashierId,
        saleDate: getBusinessDate(),
        quoteId: quotation.id,
        idempotencyKey: `QC:${quotation.id}`,
        cashRegisterSessionId: data.cashRegisterSessionId,
      };

      const createdSale = await salesRepository.createSale(client, saleData);

      // Re-shape to the raw snake_case row the downstream GL/document-flow code expects.
      // (salesRepository returns camelCase via RETURNING aliases.)
      // SaleRecord type does not currently expose cash_register_session_id, so we
      // narrow via Record access — runtime field is set by the RETURNING clause.
      const createdSaleAny = createdSale as unknown as Record<string, unknown>;
      const saleRecord = {
        id: createdSale.id,
        sale_number: createdSale.saleNumber,
        customer_id: createdSale.customerId,
        sale_date: (createdSale.saleDate ?? getBusinessDate()) as string,
        subtotal: createdSale.subtotal,
        tax_amount: createdSale.taxAmount,
        discount_amount: createdSale.discountAmount,
        total_amount: createdSale.totalAmount,
        total_cost: createdSale.totalCost,
        profit: createdSale.profit,
        profit_margin: createdSale.profitMargin,
        payment_method: createdSale.paymentMethod,
        amount_paid: createdSale.amountPaid,
        change_amount: createdSale.changeAmount,
        cashier_id: createdSale.cashierId,
        quote_id: createdSale.quoteId,
        cash_register_session_id: createdSaleAny.cashRegisterSessionId as string | null,
        created_at: createdSale.createdAt,
      };

      // ============================================================
      // SALES SSOT: route line inserts through salesRepository.addSaleItems
      // Gains (vs prior raw per-line INSERT loop):
      //   - product_type + income_account_id auto-resolved (replaces trigger)
      //   - MUoM snapshot persisted on every line (base_qty/base_uom_id/conversion_factor)
      //   - Single batched INSERT (1 round trip vs N)
      //   - discount_amount column populated (default 0 — quotes have no cart discount;
      //     header-level discount is captured on sales.discount_amount)
      // ============================================================
      const saleItemData: CreateSaleItemData[] = saleItems.map((item, index) => {
        const snap = item.uomSnapshot;
        const quoteItem = items[index];
        // Custom/service lines have NULL product_id in quotations; sale SSOT expects custom_* id.
        let productId = item.productId;
        if (!productId || quoteItem.item_type === 'custom' || quoteItem.item_type === 'service') {
          productId = productId?.startsWith('custom_') ? productId : `custom_${quoteItem.id}`;
        }
        return {
          saleId: saleRecord.id,
          productId: productId as string,
          productName: item.productName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal,
          costPrice: item.costPrice,
          profit: item.profit,
          discountAmount: 0, // header-level discount lives on sales.discount_amount
          uomId: item.uomId,
          baseQty: snap ? snap.baseQuantity : null,
          baseUomId: snap ? snap.baseUomId : null,
          conversionFactor: snap ? snap.conversionFactor : 1,
        };
      });

      const postedSaleItems = await salesRepository.addSaleItems(client, saleItemData);

      const multistoreEnabled = convertMultistore;
      const sellingStoreId = convertSellingStoreId;

      // FEFO / multistore store deduction — base_quantity SSOT (Rule 2).
      // Movement numbers: doc_movement_number_seq only (never legacy MAX+1).
      for (let index = 0; index < saleItems.length; index++) {
        const item = saleItems[index];
        const isServiceItem = !item.productId || item.productId.startsWith('custom_');
        if (isServiceItem) continue;
        const snap = item.uomSnapshot;
        const deductQty = snap ? snap.deductQuantity : new Decimal(item.quantity);

        if (multistoreEnabled && sellingStoreId) {
          await warehouseSaleDeductionService.validateSellableAtStore(
            client,
            sellingStoreId,
            item.productId!,
            deductQty.toNumber(),
          );
        } else {
          await InventoryBusinessRules.validateStockAvailability(
            client,
            item.productId!,
            deductQty.toNumber(),
          );
        }

        if (multistoreEnabled && sellingStoreId) {
          const deductResult = await warehouseSaleDeductionService.deductForSaleLine(client, {
            storeLocationId: sellingStoreId,
            productId: item.productId!,
            productName: item.productName,
            baseQty: deductQty,
            saleId: saleRecord.id,
            saleNumber: saleRecord.sale_number,
            soldBy: data.cashierId,
            enteredQty: item.quantity,
            baseUomId: snap?.baseUomId ?? item.uomId ?? '',
            conversionFactor: snap ? String(snap.conversionFactor) : '1',
          });
          const posted = postedSaleItems[index];
          if (posted?.id) {
            await salesRepository.updateSaleItemWarehouseTrace(client, posted.id, {
              storeLocationId: deductResult.storeLocationId,
              productLotId: deductResult.primaryProductLotId,
              batchId: deductResult.primaryBatchId,
            });
          }
          continue;
        }

        await deductStockFEFO(client, {
          productId: item.productId!,
          quantity: deductQty,
          movementType: 'SALE',
          referenceType: 'SALE',
          referenceId: saleRecord.id,
          createdById: data.cashierId,
          productName: item.productName,
        });
      }

      // BR-QUOTE-011: GL posting for quotation→sale conversion
      // Same journal entries as regular POS sale (revenue, COGS, tax)
      const paymentMethod: glEntryService.SaleData['paymentMethod'] =
        data.paymentOption === 'none' ? 'CREDIT' : (data.depositMethod || 'CASH');
      try {
        // CRITICAL: pass `client` (the active UnitOfWork transaction) so GL journals
        // are atomic with the sale. Without it, GL opens its own inner transaction
        // and a phantom journal can survive if the outer TX rolls back.
        await glEntryService.recordSaleToGL(
          {
            saleId: saleRecord.id,
            saleNumber: saleRecord.sale_number,
            saleDate: saleRecord.sale_date || getBusinessDate(),
            totalAmount,
            costAmount: totalCost,
            paymentMethod,
            amountPaid: data.depositAmount || (data.paymentOption === 'full' ? totalAmount : 0),
            taxAmount: parseFloat(quotation.tax_amount) || 0,
            customerId: customerId || undefined,
            saleItems: saleItems.map((item) => ({
              productType: item.productId?.startsWith('custom_')
                ? ('service' as const)
                : ('inventory' as const),
              totalPrice: item.lineTotal,
              unitCost: item.costPrice || 0,
              quantity: item.quantity,
            })),
          },
          pool,
          client  // atomic: GL rolls back with sale if anything fails
        );
      } catch (glError: unknown) {
        console.error('GL posting failed for quote→sale conversion — transaction will rollback', {
          saleId: saleRecord.id,
          quoteNumber: quotation.quote_number,
          error: glError instanceof Error ? glError.message : String(glError),
        });
        throw glError;
      }

      // Document Flow: Quotation → Sale
      await documentFlowService.linkDocuments(client, 'QUOTATION', quotation.id, 'SALE', saleRecord.id, 'CREATED_FROM');

      // ============================================================
      // Phase 2 (now atomic with Phase 1): create invoice + apply payment.
      //
      // invoiceService.createInvoice and invoiceService.addPayment accept
      // `Pool | PoolClient` and route through UnitOfWork.runOrJoin, so they
      // JOIN this transaction instead of opening their own. Any failure here
      // rolls back the sale, GL, stock, and document-flow links atomically —
      // no orphan sales, no BR-QUOTE-PHASE2-FAIL recovery path needed.
      // ============================================================
      const dueDate = addDaysToDateString(getBusinessDate(), 30);
      const invoiceResult = await invoiceService.createInvoice(client, {
        saleId: saleRecord.id,
        customerId: customerId,
        quoteId: quotation.id,
        dueDate: dueDate,
      });
      const invoice = invoiceResult.invoice;
      const invoiceId = invoice?.id as string | undefined;

      if (invoiceId) {
        await documentFlowService.linkDocuments(client, 'SALE', saleRecord.id, 'INVOICE', invoiceId, 'CREATED_FROM');
        await documentFlowService.linkDocuments(client, 'QUOTATION', quotation.id, 'INVOICE', invoiceId, 'CREATED_FROM');
      }

      let payment: Record<string, unknown> | undefined;
      if (invoiceId) {
        if (data.paymentOption === 'full') {
          // Full payment: mark invoice as PAID immediately
          const paymentDate = getBusinessDate();
          const paymentResult = await invoiceService.addPayment(client, invoiceId, {
            paymentDate: paymentDate,
            amount: totalAmount,
            paymentMethod: data.depositMethod || 'CASH',
            notes: `Full payment for quote ${quotation.quote_number}`,
          });
          payment = paymentResult?.payment as unknown as Record<string, unknown> | undefined;
        } else if (data.paymentOption === 'partial' && data.depositAmount) {
          // Partial payment: record deposit, invoice remains PARTIALLY_PAID
          const paymentDate = getBusinessDate();
          const paymentResult = await invoiceService.addPayment(client, invoiceId, {
            paymentDate: paymentDate,
            amount: data.depositAmount,
            paymentMethod: data.depositMethod!,
            notes: `Deposit for quote ${quotation.quote_number}`,
          });
          payment = paymentResult?.payment as unknown as Record<string, unknown> | undefined;
        }
        // For 'none': invoice remains UNPAID with full balance due
      }

      // BR-QUOTE-003: Mark quotation as CONVERTED and link the invoice in one shot.
      // This used to be split (set CONVERTED in Phase 1 with invoice_id=null, then a
      // post-commit pool.query updated converted_to_invoice_id). Now we have the
      // invoice id available inside the same transaction, so we link it directly.
      await quotationRepository.markQuotationAsConverted(
        client,
        quotation.id,
        saleRecord.id,
        invoiceId ?? null,
      );

      if (invoiceId) {
        await client.query(
          'UPDATE quotations SET converted_to_invoice_id = $1, updated_at = NOW() WHERE id = $2',
          [invoiceId, quotation.id],
        );
      }

      return { saleRecord, quotation, customerId, totalAmount, invoice, payment };
    });

    return {
      sale: result.saleRecord,
      invoice: result.invoice,
      payment: result.payment,
    };
  },

  /**
   * Delete quotation (cancel any non-terminal quote)
   */
  async deleteQuotation(pool: Pool, id: string, permanent = false): Promise<void> {
    await UnitOfWork.run(pool, async (client) => {
      const result = await quotationRepository.getQuotationById(pool, id);
      if (!result) {
        throw new NotFoundError('Quotation not found');
      }

      const { status, quote_number } = result.quotation;
      const convertedToSaleId = result.quotation.converted_to_sale_id;
      const convertedToSoId = (result.quotation as { converted_to_so_id?: string | null }).converted_to_so_id ?? null;

      const convertedToDnId = (result.quotation as { converted_to_dn_id?: string | null }).converted_to_dn_id ?? null;

      if (permanent) {
        // Hard delete — only allowed for CANCELLED quotations
        if (status !== 'CANCELLED') {
          throw new ConflictError(
            `Quotation ${quote_number} is ${status}; only CANCELLED quotations can be permanently deleted.`,
          );
        }
        await quotationRepository.hardDeleteQuotation(client, id);
        return;
      }

      if (status === 'CONVERTED' || convertedToSaleId || convertedToSoId || convertedToDnId) {
        throw new ConflictError(
          `Quotation ${quote_number} is locked: it has been converted to a downstream document.`,
        );
      }
      if (status === 'CANCELLED') {
        throw new ConflictError(`Quotation ${quote_number} is already cancelled.`);
      }

      // Soft delete by setting status to CANCELLED
      await quotationRepository.deleteQuotation(client, id);
    });
  },

  async createFromOpportunity(
    client: import('pg').PoolClient,
    opportunityId: string,
    userId: string
  ): Promise<QuotationDetail> {
    const oppResult = await client.query(
      `SELECT o.*, c.name AS customer_name
       FROM opportunities o
       LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.id = $1`,
      [opportunityId]
    );
    const opp = oppResult.rows[0];
    if (!opp) throw new Error('Opportunity not found');

    const itemsResult = await client.query(
      `SELECT * FROM opportunity_items WHERE opportunity_id = $1 ORDER BY sort_order, id`,
      [opportunityId]
    );

    if (!itemsResult.rows.length) {
      throw new ValidationError(
        'Cannot create quotation from opportunity: add at least one line item first',
      );
    }

    const items = itemsResult.rows.map((row: Record<string, unknown>) => ({
      productId: null as string | null,
      itemType: 'custom' as const,
      sku: null as string | null,
      description: String(row.description || 'Opportunity item'),
      notes: null as string | null,
      quantity: Number(row.quantity ?? 1),
      unitPrice: Number(row.estimated_price ?? 0),
      discountAmount: 0,
      isTaxable: false,
      taxRate: 0,
      uomId: null as string | null,
      uomName: null as string | null,
      unitCost: null as number | null,
      productType: 'service',
    }));

    const validFrom = getBusinessDate();
    const validUntil = addDaysToDateString(validFrom, 30);

    return this.createQuotationInTransaction(client, {
      quoteType: 'standard',
      customerId: opp.customer_id || null,
      customerName: opp.customer_name || null,
      customerPhone: null,
      customerEmail: null,
      description: `From opportunity: ${opp.title}${opp.tender_ref ? ` (Ref: ${opp.tender_ref})` : ''}`,
      validFrom,
      validUntil,
      createdById: userId,
      items,
    });
  },

  async updateItemDecisions(
    pool: Pool,
    quotationId: string,
    decisions: Array<{ itemId: string; status: 'ACCEPTED' | 'REJECTED'; rejectionReason?: string }>
  ): Promise<QuotationItem[]> {
    return UnitOfWork.run(pool, async (client) => {
      // Verify quotation is in a valid state for edits — SSOT guard.
      const quoteResult = await client.query(
        `SELECT status, quote_number, converted_to_sale_id, converted_to_so_id, converted_to_dn_id
           FROM quotations WHERE id = $1 FOR UPDATE`,
        [quotationId]
      );
      if (quoteResult.rows.length === 0) {
        throw new NotFoundError('Quotation not found');
      }
      assertEditableQuotation(quoteResult.rows[0]);
      const status = quoteResult.rows[0].status;

      // Verify all items belong to this quotation
      for (const d of decisions) {
        const itemCheck = await client.query(
          'SELECT id FROM quotation_items WHERE id = $1 AND quotation_id = $2',
          [d.itemId, quotationId]
        );
        if (itemCheck.rows.length === 0) {
          throw new ValidationError(`Item ${d.itemId} does not belong to quotation ${quotationId}`);
        }
      }

      const rows = await quotationRepository.updateItemStatuses(client, quotationId, decisions);

      // Log to status history
      const acceptCount = decisions.filter(d => d.status === 'ACCEPTED').length;
      const rejectCount = decisions.filter(d => d.status === 'REJECTED').length;
      await quotationRepository.updateQuotationStatus(
        client,
        quotationId,
        status, // Keep same status
        `Item decisions: ${acceptCount} accepted, ${rejectCount} rejected`
      );

      return rows.map(normalizeQuotationItem);
    });
  },

  /**
   * Auto-expire overdue quotations (SAP batch job equivalent).
   * Should be called periodically (e.g., daily cron or on list load).
   */
  async expireOverdueQuotations(pool: Pool): Promise<number> {
    return quotationRepository.expireOverdueQuotations(pool);
  },
};
