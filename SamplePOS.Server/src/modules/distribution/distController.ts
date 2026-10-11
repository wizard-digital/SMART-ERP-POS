/**
 * Distribution Controller
 * HTTP handlers for SAP-style distribution document flow:
 *   Sales Order → Delivery + Invoice → Clearing/Payment
 */

import { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import * as distService from './distService.js';

// ─── Zod Schemas ────────────────────────────────────────────

export const CreateSalesOrderSchema = z.object({
  customerId: z.string().uuid(),
  quotationId: z.string().uuid().optional(),
  orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().optional(),
  lines: z.array(z.object({
    productId: z.string().uuid(),
    orderedQty: z.number().positive(),
    unitPrice: z.number().nonnegative(),
  })).min(1, 'At least one line item is required'),
});

export const CreateDeliverySchema = z.object({
  salesOrderId: z.string().uuid(),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().optional(),
  lines: z.array(z.object({
    salesOrderLineId: z.string().uuid(),
    quantity: z.number().positive(),
  })).min(1, 'At least one delivery line is required'),
});

export const EditSalesOrderSchema = z.object({
  orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().optional(),
  lines: z.array(z.object({
    id: z.string().uuid().optional(),
    productId: z.string().uuid(),
    orderedQty: z.number().positive(),
    unitPrice: z.number().nonnegative(),
  })).min(1, 'At least one line item is required'),
});

export const ClearingSchema = z.object({
  customerId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  depositAllocations: z.array(z.object({
    depositId: z.string().uuid(),
    amount: z.number().positive(),
  })).default([]),
  cashPayment: z.object({
    amount: z.number().positive(),
    paymentMethod: z.enum(['CASH', 'CARD', 'MOBILE_MONEY', 'BANK_TRANSFER']),
    referenceNumber: z.string().optional(),
  }).optional(),
  notes: z.string().optional(),
});

// ─── Controller ─────────────────────────────────────────────

export const distController = {

  // ─── Sales Orders ───────────────────────────────────────

  createSalesOrder: asyncHandler(async (req: Request, res: Response) => {
    const pool: Pool = req.tenantPool || req.pool!;
    const input = CreateSalesOrderSchema.parse(req.body);
    const result = await distService.createSalesOrder(pool, {
      ...input,
      createdBy: req.user!.id,
    });
    res.status(201).json({ success: true, data: result });
  }),

  listSalesOrders: asyncHandler(async (req: Request, res: Response) => {
    const pool: Pool = req.tenantPool || req.pool!;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);
    const status = req.query.status as string | undefined;
    const customerId = req.query.customerId as string | undefined;
    const result = await distService.listSalesOrders(pool, { status, customerId, page, limit });
    res.json({
      success: true,
      data: result.data,
      pagination: { page, limit, total: result.total, totalPages: Math.ceil(result.total / limit) },
    });
  }),

  getSalesOrder: asyncHandler(async (req: Request, res: Response) => {
    const pool: Pool = req.tenantPool || req.pool!;
    const result = await distService.getSalesOrder(pool, req.params.id);
    res.json({ success: true, data: result });
  }),

  editSalesOrder: asyncHandler(async (req: Request, res: Response) => {
    const pool: Pool = req.tenantPool || req.pool!;
    const input = EditSalesOrderSchema.parse(req.body);
    const result = await distService.editSalesOrder(pool, {
      orderId: req.params.id,
      ...input,
      updatedBy: req.user!.id,
    });
    res.json({ success: true, data: result });
  }),

  // ─── Deliveries ─────────────────────────────────────────

  createDelivery: asyncHandler(async (req: Request, res: Response) => {
    const pool: Pool = req.tenantPool || req.pool!;
    const input = CreateDeliverySchema.parse(req.body);
    const result = await distService.createDeliveryWithInvoice(pool, {
      ...input,
      createdBy: req.user!.id,
    });
    res.status(201).json({ success: true, data: result });
  }),

  listDeliveries: asyncHandler(async (req: Request, res: Response) => {
    const pool: Pool = req.tenantPool || req.pool!;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);
    const salesOrderId = req.query.salesOrderId as string | undefined;
    const status = req.query.status as string | undefined;
    const customerId = req.query.customerId as string | undefined;
    const result = await distService.listDeliveries(pool, { salesOrderId, status, customerId, page, limit });
    res.json({
      success: true,
      data: result.data,
      pagination: { page, limit, total: result.total, totalPages: Math.ceil(result.total / limit) },
    });
  }),

  getDelivery: asyncHandler(async (req: Request, res: Response) => {
    const pool: Pool = req.tenantPool || req.pool!;
    const result = await distService.getDelivery(pool, req.params.id);
    res.json({ success: true, data: result });
  }),

  // ─── Invoices ───────────────────────────────────────────

  listInvoices: asyncHandler(async (req: Request, res: Response) => {
    const pool: Pool = req.tenantPool || req.pool!;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);
    const customerId = req.query.customerId as string | undefined;
    const status = req.query.status as string | undefined;
    const salesOrderId = req.query.salesOrderId as string | undefined;
    const result = await distService.listDistInvoices(pool, { customerId, status, salesOrderId, page, limit });
    res.json({
      success: true,
      data: result.data,
      pagination: { page, limit, total: result.total, totalPages: Math.ceil(result.total / limit) },
    });
  }),

  getInvoice: asyncHandler(async (req: Request, res: Response) => {
    const pool: Pool = req.tenantPool || req.pool!;
    const result = await distService.getDistInvoice(pool, req.params.id);
    res.json({ success: true, data: result });
  }),

  // ─── Clearing / Payment ────────────────────────────────

  getClearingScreen: asyncHandler(async (req: Request, res: Response) => {
    const pool: Pool = req.tenantPool || req.pool!;
    const result = await distService.getClearingScreenData(pool, req.params.customerId);
    res.json({ success: true, data: result });
  }),

  processClearing: asyncHandler(async (req: Request, res: Response) => {
    const pool: Pool = req.tenantPool || req.pool!;
    const input = ClearingSchema.parse(req.body);
    const result = await distService.processClearing(pool, {
      ...input,
      clearedBy: req.user!.id,
    });
    res.status(201).json({ success: true, data: result });
  }),

  // ─── ATP ────────────────────────────────────────────────

  checkAtp: asyncHandler(async (req: Request, res: Response) => {
    const pool: Pool = req.tenantPool || req.pool!;
    const { productIds } = z.object({ productIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
    const result = await distService.getAtpForProducts(pool, productIds);
    res.json({ success: true, data: result });
  }),

  // ─── Backorders ─────────────────────────────────────────

  listBackorders: asyncHandler(async (req: Request, res: Response) => {
    const pool: Pool = req.tenantPool || req.pool!;
    const productId = req.query.productId as string | undefined;
    const result = await distService.getBackorders(pool, productId);
    res.json({ success: true, data: result });
  }),

  reconfirmBackorders: asyncHandler(async (req: Request, res: Response) => {
    const pool: Pool = req.tenantPool || req.pool!;
    const { productId } = z.object({ productId: z.string().uuid() }).parse(req.body);
    const confirmed = await distService.reconfirmBackorders(pool, productId);
    res.json({ success: true, data: { confirmed }, message: `${confirmed} units reconfirmed` });
  }),

  reconfirmSalesOrder: asyncHandler(async (req: Request, res: Response) => {
    const pool: Pool = req.tenantPool || req.pool!;
    const result = await distService.reconfirmSalesOrder(pool, req.params.id);
    res.json({
      success: true,
      data: result,
      message: 'Sales order confirmation refreshed from issue-store ATP',
    });
  }),

  // ─── Quotation Conversion ──────────────────────────────

  convertFromQuotation: asyncHandler(async (req: Request, res: Response) => {
    const pool: Pool = req.tenantPool || req.pool!;
    const { quotationId } = z.object({ quotationId: z.string().uuid() }).parse(req.params);
    const result = await distService.convertFromQuotation(pool, quotationId, req.user!.id);
    res.status(201).json({
      success: true,
      data: result,
      message: 'Quotation converted to distribution sales order',
    });
  }),
};
