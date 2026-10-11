/**
 * Distribution Module — Routes
 *
 * SAP-style document flow API:
 *   Sales Order → Delivery + Invoice → Clearing/Payment
 *
 * Architecture follows: Routes → Controller → Service → Repository
 */

import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../rbac/middleware.js';
import { distController } from './distController.js';

const router = Router();
router.use(authenticate);

// ─── Sales Orders ───────────────────────────────────────────
router.post('/sales-orders', requirePermission('distribution.create'), distController.createSalesOrder);
router.get('/sales-orders', requirePermission('distribution.read'), distController.listSalesOrders);
router.get('/sales-orders/:id', requirePermission('distribution.read'), distController.getSalesOrder);
router.put('/sales-orders/:id', requirePermission('distribution.update'), distController.editSalesOrder);
router.post('/sales-orders/:id/reconfirm', requirePermission('distribution.update'), distController.reconfirmSalesOrder);

// ─── Quotation Conversion (WHOLESALE → Distribution SO) ────
router.post('/from-quotation/:quotationId', requirePermission('distribution.create'), distController.convertFromQuotation);

// ─── Deliveries ─────────────────────────────────────────────
router.post('/deliveries', requirePermission('delivery.create'), distController.createDelivery);
router.get('/deliveries', requirePermission('delivery.read'), distController.listDeliveries);
router.get('/deliveries/:id', requirePermission('delivery.read'), distController.getDelivery);

// ─── Invoices ───────────────────────────────────────────────
router.get('/invoices', requirePermission('accounting.read'), distController.listInvoices);
router.get('/invoices/:id', requirePermission('accounting.read'), distController.getInvoice);

// ─── Clearing / Payment ────────────────────────────────────
router.get('/clearing/screen/:customerId', requirePermission('accounting.read'), distController.getClearingScreen);
router.post('/clearing', requirePermission('accounting.post'), distController.processClearing);

// ─── ATP ────────────────────────────────────────────────────
router.post('/atp', requirePermission('inventory.read'), distController.checkAtp);

// ─── Backorders ─────────────────────────────────────────────
router.get('/backorders', requirePermission('distribution.read'), distController.listBackorders);
router.post('/backorders/reconfirm', requirePermission('distribution.update'), distController.reconfirmBackorders);

export { router as distRoutes };
