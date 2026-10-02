import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { pool as globalPool } from '../../db/pool.js';
import { ordersService, CreateOrderInput, OrderItemInput, buildOrderCompletionSaleTotals } from './ordersService.js';
import { repriceSaleItemsForAtCostCustomer, isAtCostCustomer } from './orderAtCostPricing.js';
import { salesService, CreateSaleInput, SaleItemInput } from '../sales/salesService.js';
import { restaurantService } from '../restaurant/restaurantService.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireAnyPermission } from '../../rbac/middleware.js';
import { asyncHandler, BusinessError } from '../../middleware/errorHandler.js';
import { Money } from '../../utils/money.js';
import logger from '../../utils/logger.js';
import { DocumentTaxService } from '../../services/documentTaxService.js';
import { userHasPermission } from '../../authorization/serviceAuth.js';
import {
  findSaleByIdempotencyKey,
  resolveExistingCompleteSale,
} from './orderCompleteIdempotency.js';

// ── Validation Schemas ────────────────────────────────────────────────

const OrderItemSchema = z.object({
  productId: z.string().min(1),
  productName: z.string().min(1),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  discountAmount: z.number().nonnegative().optional(),
  uomId: z.string().uuid().nullable().optional(),
  baseQty: z.number().nullable().optional(),
  baseUomId: z.string().uuid().nullable().optional(),
  conversionFactor: z.number().nullable().optional(),
});

const CreateOrderSchema = z.object({
  customerId: z.string().uuid().nullable().optional(),
  items: z.array(OrderItemSchema).min(1),
  subtotal: z.number().nonnegative().optional(),
  discountAmount: z.number().nonnegative().optional(),
  taxAmount: z.number().nonnegative().optional(),
  totalAmount: z.number().nonnegative().optional(),
  assignedCashierId: z.string().uuid().nullable().optional(),
  orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().nullable().optional(),
  idempotencyKey: z.string().max(100).optional(),
  quoteId: z.string().uuid().nullable().optional(),
});

const CompleteOrderSchema = z.object({
  paymentMethod: z.enum(['CASH', 'CARD', 'MOBILE_MONEY', 'AIRTEL_MONEY', 'CREDIT', 'DEPOSIT', 'BANK_TRANSFER']),
  paymentReceived: z.number().nonnegative(),
  paymentLines: z.array(z.object({
    paymentMethod: z.enum(['CASH', 'CARD', 'MOBILE_MONEY', 'AIRTEL_MONEY', 'CREDIT', 'DEPOSIT']),
    amount: z.number().positive(),
    reference: z.string().optional(),
  })).optional(),
  customerId: z.string().uuid().nullable().optional(),
  cashRegisterSessionId: z.string().uuid().optional(),
  // Optional additional discount the cashier can apply at payment time
  extraDiscountAmount: z.number().nonnegative().optional(),
  /** Required for integrity: retries / double-submit must reuse the same key. */
  idempotencyKey: z.string().min(1).max(100),
});

const CancelOrderSchema = z.object({
  reason: z.string().min(1, 'Cancellation reason is required'),
});

const ListOrdersQuerySchema = z.object({
  page: z.string().optional().transform(val => val ? parseInt(val) : 1),
  limit: z.string().optional().transform(val => val ? parseInt(val) : 50),
  status: z.enum(['PENDING', 'COMPLETED', 'CANCELLED']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

// ── Router ────────────────────────────────────────────────────────────

const router = Router();

// All order routes require authentication
router.use(authenticate);

/**
 * GET /api/orders/pending
 * List pending orders for the queue screen.
 * Access: CASHIER, ADMIN, MANAGER, STAFF
 */
router.get(
  '/pending',
  requireAnyPermission(['orders.read', 'orders.pay', 'orders.create']),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const orderDate = typeof req.query.orderDate === 'string' ? req.query.orderDate : undefined;
    const orders = await ordersService.listPendingOrders(pool, { orderDate });
    res.json({ success: true, data: orders });
  })
);

/**
 * GET /api/orders/pending-count
 * Get count of pending orders (for badge display).
 */
router.get(
  '/pending-count',
  requireAnyPermission(['orders.read', 'orders.pay', 'orders.create']),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const count = await ordersService.getPendingCount(pool);
    res.json({ success: true, data: { count } });
  })
);

/**
 * POST /api/orders
 * Create a new POS order (dispenser workflow).
 * Access: orders.create (STAFF/dispenser role, ADMIN, MANAGER)
 */
router.post(
  '/',
  requirePermission('orders.create'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const validated = CreateOrderSchema.parse(req.body);
    const userId = req.user!.id;

    const input: CreateOrderInput = {
      ...validated,
      createdBy: userId,
      items: validated.items as OrderItemInput[],
    };

    const order = await ordersService.createOrder(pool, input);
    res.status(201).json({ success: true, data: order, message: `Order ${order.orderNumber} created` });
  })
);

/**
 * GET /api/orders
 * List all orders with pagination and filters.
 */
router.get(
  '/',
  requireAnyPermission(['orders.read', 'orders.pay', 'orders.create']),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const filters = ListOrdersQuerySchema.parse(req.query);
    const { rows, total } = await ordersService.listOrders(pool, filters);

    const page = filters.page || 1;
    const limit = filters.limit || 50;
    res.json({
      success: true,
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  })
);

/**
 * GET /api/orders/:id/at-cost-preview
 * Live FEFO AT_COST prices for order lines (payment screen).
 * Access: orders.pay
 */
router.get(
  '/:id/at-cost-preview',
  requirePermission('orders.pay'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const order = await ordersService.prepareOrderForPayment(pool, req.params.id);
    const customerId =
      typeof req.query.customerId === 'string' && req.query.customerId.length > 0
        ? req.query.customerId
        : order.customerId;

    if (!customerId || !(await isAtCostCustomer(pool, customerId))) {
      res.json({
        success: true,
        data: { isAtCostCustomer: false, hasDrift: false, lines: [], repricedTotal: null },
      });
      return;
    }

    const saleItems: SaleItemInput[] = order.items!.map((item) => ({
      productId: item.productId ?? `custom_svc_order_${item.id}`,
      productName: item.productName,
      quantity: Money.toNumber(Money.parseDb(item.quantity)),
      unitPrice: Money.toNumber(Money.parseDb(item.unitPrice)),
      discountAmount: item.discountAmount
        ? Money.toNumber(Money.parseDb(item.discountAmount))
        : undefined,
      uomId: item.uomId || undefined,
    }));

    const { preview, hasDrift, repricedItems } = await repriceSaleItemsForAtCostCustomer(
      pool,
      saleItems,
      customerId,
    );

    const repricedTotals = buildOrderCompletionSaleTotals(order, 0, repricedItems);

    res.json({
      success: true,
      data: {
        isAtCostCustomer: true,
        hasDrift,
        lines: preview,
        orderTotal: Money.toNumber(Money.parseDb(order.totalAmount)),
        repricedTotal: repricedTotals.totalAmount,
      },
    });
  }),
);

/**
 * GET /api/orders/:id
 * Get a single order by ID or order number.
 */
router.get(
  '/:id',
  requireAnyPermission(['orders.read', 'orders.pay', 'orders.create']),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const order = await ordersService.getOrder(pool, req.params.id);
    res.json({ success: true, data: order });
  })
);

/**
 * POST /api/orders/:id/complete
 * Complete an order by converting it to a sale (cashier workflow).
 * The cashier provides payment details; the order items become sale items.
 * Access:
 *   - Restaurant checks (table / non-RETAIL channel): restaurant.pay
 *   - Retail / queue orders: orders.pay
 * Manager has orders.pay but not restaurant.pay — cannot settle FOH checks.
 */
router.post(
  '/:id/complete',
  requireAnyPermission(['orders.pay', 'restaurant.pay']),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const headerKey =
      typeof req.headers['x-idempotency-key'] === 'string'
        ? req.headers['x-idempotency-key'].trim()
        : '';
    const paymentData = CompleteOrderSchema.parse({
      ...req.body,
      // Header fills body when client retries via X-Idempotency-Key only
      idempotencyKey: req.body?.idempotencyKey ?? (headerKey || undefined),
    });
    const userId = req.user!.id;
    const orderId = req.params.id;
    const idempotencyKey = paymentData.idempotencyKey;

    // 0. Idempotent replay: same key already produced a sale
    const keyedSale = await findSaleByIdempotencyKey(pool, idempotencyKey);
    if (keyedSale) {
      const order = await ordersService.getOrder(pool, orderId);
      res.status(200).json({
        success: true,
        data: {
          order: order ? { ...order, status: order.status } : { id: orderId, status: 'COMPLETED' },
          sale: { id: keyedSale.id, saleNumber: keyedSale.saleNumber },
          alreadyCompleted: true,
        },
        message: 'Order already completed (idempotent)',
      });
      return;
    }

    // Restaurant settlement must use restaurant.pay (not orders.pay alone).
    const isRestaurantCheck = await restaurantService.isRestaurantCheck(pool, orderId);
    const needed = isRestaurantCheck ? 'restaurant.pay' : 'orders.pay';
    const allowed = await userHasPermission(pool, userId, needed, req.user?.role);
    if (!allowed) {
      throw new BusinessError(
        isRestaurantCheck
          ? 'Restaurant payment requires restaurant.pay (cashier, accountant, or admin)'
          : 'Order payment requires orders.pay',
        'ERR_PERMISSION_DENIED',
        { orderId, permission: needed },
      );
    }

    // 1. Validate PENDING — if already settled, return linked sale (retry after commit)
    let order;
    try {
      order = await ordersService.prepareOrderForPayment(pool, orderId);
    } catch (prepErr: unknown) {
      if (prepErr instanceof BusinessError && prepErr.errorCode === 'ERR_ORDER_003') {
        const existing = await resolveExistingCompleteSale(pool, { orderId, idempotencyKey });
        if (existing) {
          const settled = await ordersService.getOrder(pool, orderId);
          res.status(200).json({
            success: true,
            data: {
              order: settled
                ? { ...settled, status: settled.status }
                : { id: orderId, status: 'COMPLETED' },
              sale: { id: existing.id, saleNumber: existing.saleNumber },
              alreadyCompleted: true,
            },
            message: 'Order already completed (idempotent)',
          });
          return;
        }
      }
      throw prepErr;
    }

    // 2. Build CreateSaleInput from order items
    const saleItems: SaleItemInput[] = order.items!.map(item => ({
      productId: item.productId ?? `custom_svc_order_${item.id}`,
      productName: item.productName,
      quantity: Money.toNumber(Money.parseDb(item.quantity)),
      unitPrice: Money.toNumber(Money.parseDb(item.unitPrice)),
      discountAmount: item.discountAmount ? Money.toNumber(Money.parseDb(item.discountAmount)) : undefined,
      uomId: item.uomId || undefined,
    }));

    // Allow customer override at payment time (cashier can assign/change customer)
    const effectiveCustomerId = paymentData.customerId ?? order.customerId;

    let atCostRepriceMeta: { hasDrift: boolean; lines: unknown[] } | null = null;
    if (effectiveCustomerId && (await isAtCostCustomer(pool, effectiveCustomerId))) {
      const reprice = await repriceSaleItemsForAtCostCustomer(pool, saleItems, effectiveCustomerId);
      saleItems.length = 0;
      saleItems.push(...reprice.repricedItems);
      atCostRepriceMeta = { hasDrift: reprice.hasDrift, lines: reprice.preview };
      if (reprice.hasDrift) {
        logger.info('AT_COST order completion: repriced lines to current FEFO', {
          orderId,
          orderNumber: order.orderNumber,
          driftLines: reprice.preview.filter((l) => l.priceDrift).length,
        });
      }
    }

    // Authoritative tax before createSale — avoids ERR_SALE_TOTAL_MISMATCH when order
    // header tax was a stale client preview (createSale recomputes via DocumentTaxService).
    const pricedTax = await DocumentTaxService.priceDocumentLines(pool, {
      customerId: effectiveCustomerId,
      scope: 'SALE',
      preferLineTaxOverrides: false,
      // Match FOH restaurant DocumentTax (tenant default when unresolved)
      applyTenantDefaultWhenUnresolved: isRestaurantCheck,
      lines: saleItems.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountAmount: item.discountAmount || 0,
      })),
    });

    // Combine order header discount with cashier extra discount — avoid double-counting
    // line discounts already passed on sale items (createSale nets lines then subtracts cart).
    const saleTotals = buildOrderCompletionSaleTotals(
      order,
      paymentData.extraDiscountAmount ?? 0,
      saleItems,
      pricedTax.taxAmount,
    );

    const saleInput: CreateSaleInput = {
      customerId: effectiveCustomerId,
      items: saleItems,
      subtotal: saleTotals.subtotal,
      discountAmount: saleTotals.discountAmount,
      taxAmount: saleTotals.taxAmount,
      totalAmount: saleTotals.totalAmount,
      paymentMethod: paymentData.paymentMethod,
      paymentReceived: paymentData.paymentReceived,
      soldBy: userId,
      paymentLines: paymentData.paymentLines,
      cashRegisterSessionId: paymentData.cashRegisterSessionId,
      // Atomically mark the order COMPLETED within the same sale transaction
      fromOrderId: orderId,
      quoteId: order.quoteId ?? undefined,
      idempotencyKey,
      profileCheckout:
        process.env.CHECKOUT_PROFILE === '1' ||
        req.headers['x-checkout-profile'] === '1',
    };

    // 3. Create the sale AND atomically mark order completed (single transaction)
    let result;
    try {
      result = await salesService.createSale(pool, saleInput);
    } catch (createErr: unknown) {
      // A second terminal, or a retry after commit, must receive the sale
      // whether the throw was ERR_ORDER_003, isIdempotencyUniqueViolation, or
      // any other error raised after the sale row exists.
      const settled = await resolveExistingCompleteSale(pool, { orderId, idempotencyKey });
      if (settled) {
        res.status(200).json({
          success: true,
          data: {
            order: { ...order, status: 'COMPLETED' },
            sale: { id: settled.id, saleNumber: settled.saleNumber },
            alreadyCompleted: true,
          },
          message: 'Order already completed (idempotent)',
        });
        return;
      }
      throw createErr;
    }

    // 4. Restaurant SSOT: free floor + clear FIRE/VOID KOTs from KDS after payment
    try {
      await restaurantService.releaseTableForOrder(pool, orderId, {
        bumpVoids: true,
        updatedBy: userId,
      });
    } catch (releaseErr) {
      logger.error('Restaurant table release failed after order complete', {
        orderId,
        releaseErr,
      });
    }

    res.json({
      success: true,
      data: {
        order: { ...order, status: 'COMPLETED' },
        sale: result.sale,
        alreadyCompleted: false,
        ...(result.checkoutProfile ? { checkoutProfile: result.checkoutProfile } : {}),
        ...(atCostRepriceMeta?.hasDrift
          ? { atCostReprice: atCostRepriceMeta }
          : {}),
      },
      message: `Order ${order.orderNumber} completed → Sale ${result.sale.saleNumber}`,
    });
  })
);

/**
 * POST /api/orders/:id/cancel
 * Cancel a pending order.
 * Access: orders.cancel (ADMIN, MANAGER, or the dispenser who created it)
 */
router.post(
  '/:id/cancel',
  requireAnyPermission(['orders.cancel', 'orders.create']),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const { reason } = CancelOrderSchema.parse(req.body);
    const userId = req.user!.id;

    const order = await ordersService.cancelOrder(pool, req.params.id, userId, reason);

    try {
      await restaurantService.releaseTableForOrder(pool, order.id, {
        bumpVoids: true,
        updatedBy: userId,
      });
    } catch (releaseErr) {
      logger.error('Restaurant table release failed after order cancel', {
        orderId: order.id,
        releaseErr,
      });
    }

    res.json({ success: true, data: order, message: `Order ${order.orderNumber} cancelled` });
  })
);

export default router;
