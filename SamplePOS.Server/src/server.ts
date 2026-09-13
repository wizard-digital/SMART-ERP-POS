// Main Express Server
// SamplePOS Backend API

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import dotenv from 'dotenv';
import * as Sentry from '@sentry/node';
import { testConnection } from './db/pool.js';
import logger from './utils/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { businessRuleErrorHandler } from './middleware/businessRules.js';
import { mountFrontendSpa } from './middleware/serveFrontend.js';
import { globalRateLimit, authRateLimit } from './middleware/security.js';
import { productRoutes } from './modules/products/productRoutes.js';
import { customerRoutes } from './modules/customers/customerRoutes.js';
import { supplierRoutes } from './modules/suppliers/supplierRoutes.js';
import { authRoutes } from './modules/auth/authRoutes.js';
import { quickLoginRoutes } from './modules/auth/quickLoginRoutes.js';
import { salesRoutes } from './modules/sales/salesRoutes.js';
import { inventoryRoutes } from './modules/inventory/inventoryRoutes.js';
import { purchaseOrderRoutes } from './modules/purchase-orders/purchaseOrderRoutes.js';
import { goodsReceiptRoutes } from './modules/goods-receipts/goodsReceiptRoutes.js';
import { stockMovementRoutes } from './modules/stock-movements/stockMovementRoutes.js';
import { invoiceRoutes } from './modules/invoices/invoiceRoutes.js';
import { createDocumentRoutes } from './modules/documents/documentRoutes.js';
import { invoiceSettingsRoutes } from './modules/settings/invoiceSettingsRoutes.js';
import { systemSettingsRoutes } from './modules/system-settings/systemSettingsRoutes.js';
import { createReportsRouter } from './modules/reports/reportsRoutes.js';
import { createUserRoutes } from './modules/users/userRoutes.js';
import { adminRoutes } from './modules/admin/adminRoutes.js';
import { systemManagementRoutes } from './modules/system-management/systemManagementRoutes.js';
import { discountRoutes } from './modules/discounts/discountRoutes.js';
import { createPaymentsRoutes } from './modules/payments/paymentsRoutes.js';
import auditRoutes from './modules/audit/auditRoutes.js';
import { createHoldRoutes } from './modules/pos/holdRoutes.js';
import { createOfflineSyncRoutes } from './modules/pos/offlineSyncRoutes.js';
import { createSyncEventsRoutes } from './modules/pos/syncEventsRoutes.js';
import quotationRoutes from './modules/quotations/quotationRoutes.js';
import deliveryRoutes from './modules/delivery/deliveryRoutes.js';
import deliveryNoteRoutes from './modules/delivery-notes/deliveryNoteRoutes.js';
import { distRoutes } from './modules/distribution/distRoutes.js';
import { importRoutes } from './modules/import/importRoutes.js';
import { accountingRoutes } from './modules/accounting/accountingRoutes.js';
import depositsRoutes from './modules/deposits/depositsRoutes.js';
import { comprehensiveAccountingRoutes } from './modules/accounting/comprehensiveAccountingRoutes.js';
import integrityRoutes from './modules/accounting/integrityRoutes.js';
import documentRoutes from './modules/documents/documentController.js';
import expenseRoutes from './routes/expenseRoutes.js';
import erpAccountingRoutes from './routes/erpAccountingRoutes.js';
import bankingRoutes from './routes/bankingRoutes.js';
import businessReportRoutes from './routes/businessReportRoutes.js';
import { createSupplierPaymentRoutes } from './modules/supplier-payments/supplierPaymentRoutes.js';
import { arPaymentRoutes } from './modules/ar-payments/arPaymentRoutes.js';
import { cashRegisterRoutes } from './modules/cash-register/index.js';
import { crmRoutes } from './modules/crm/crmRoutes.js';
import { hrRoutes } from './modules/hr/hr.routes.js';
import { creditDebitNoteRoutes } from './modules/credit-debit-notes/creditDebitNoteRoutes.js';
import { returnGrnRoutes } from './modules/return-grn/returnGrnRoutes.js';
import { supplierAdjustmentRoutes } from './modules/supplier-adjustments/supplierAdjustmentRoutes.js';
import { customerInvoiceAdjustmentRoutes } from './modules/customer-invoice-adjustments/customerInvoiceAdjustmentRoutes.js';
import { correctionRoutes } from './modules/corrections/correctionRoutes.js';
import { documentFlowRoutes } from './modules/document-flow/documentFlowRoutes.js';
import { pricingEngineRoutes } from './modules/pricing/pricingRoutes.js';
import { glRepairRoutes } from './modules/system/glRepairRoutes.js';
import ordersRoutes from './modules/orders/ordersRoutes.js';
import { costCenterRoutes } from './modules/cost-centers/costCenterRoutes.js';
import { periodControlRoutes } from './modules/period-control/periodControlRoutes.js';
import { grirClearingRoutes } from './modules/grir-clearing/grirClearingRoutes.js';
import { downPaymentClearingRoutes } from './modules/down-payment-clearing/clearingRoutes.js';
import { dunningRoutes } from './modules/dunning/dunningRoutes.js';
import { whtRoutes } from './modules/withholding-tax/whtRoutes.js';
import { vatRemittanceRoutes } from './modules/vat-remittance/vatRemittanceRoutes.js';
import { badDebtRoutes } from './modules/bad-debt/badDebtRoutes.js';
import { treasuryRoutes } from './modules/treasury/treasuryRoutes.js';
import restaurantRoutes from './modules/restaurant/restaurantRoutes.js';
import kitchenProductionRoutes from './modules/kitchen-production/kitchenProductionRoutes.js';
import printJobsRoutes from './modules/print-jobs/printJobsRoutes.js';
import { assetRoutes } from './modules/asset-accounting/assetRoutes.js';
import { jeApprovalRoutes } from './modules/je-approval/jeApprovalRoutes.js';
import { paymentProgramRoutes } from './modules/payment-program/paymentProgramRoutes.js';
import { currencyRoutes } from './modules/multi-currency/currencyRoutes.js';
import { enterpriseAccountingRoutes } from './modules/accounting/enterpriseAccountingRoutes.js';
import pool from './db/pool.js';
import { auditContextMiddleware } from './middleware/auditContext.js';
import { createRbacRoutes, initializeRbacMiddleware } from './rbac/index.js';
import { platformRoutes } from './modules/platform/platformRoutes.js';
import { syncRoutes } from './modules/platform/syncRoutes.js';
import { tenantConfigRoutes } from './modules/tenant/tenantConfigRoutes.js';
import { tenantMiddleware } from './middleware/tenantMiddleware.js';
import { tenantRateLimit } from './middleware/tenantRateLimit.js';
import { idempotencyMiddleware } from './middleware/idempotency.js';
import { requireFeature } from './middleware/requireFeature.js';
import notificationRoutes from './modules/notifications/notificationRoutes.js';
import { ensureVapidKeys } from './modules/notifications/vapidKeys.js';
import type { TenantPlan } from '../../shared/types/tenant.js';
import { jobQueue } from './services/jobQueue.js';
import { connectionManager } from './db/connectionManager.js';
import { sessionService } from './services/sessionService.js';
import { authenticate } from './middleware/auth.js';
import { requirePermission } from './rbac/middleware.js';
import { correlationId } from './middleware/correlationId.js';
import { initCalculationsScheduledJobs } from './services/calculationsScheduledJobs.js';
import healthRoutes, { incrementMetric, closeHealthRedis } from './routes/health.js';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger.js';
import { getBusinessDate, getBusinessYear, BUSINESS_TIMEZONE, formatBusinessTimestamp } from './utils/dateRange.js';

// All modules now use consistent named exports for maintainability

dotenv.config();
ensureVapidKeys();

// ============================================================
// PRODUCTION ENVIRONMENT VALIDATION
// Fail fast if critical secrets are missing in production
// ============================================================
if (process.env.NODE_ENV === 'production') {
  const required = ['JWT_SECRET', 'DATABASE_URL'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(
      `FATAL: Missing required environment variables in production: ${missing.join(', ')}`
    );
    process.exit(1);
  }
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
    console.error(`FATAL: JWT_SECRET must be at least 32 characters in production`);
    process.exit(1);
  }
  // Warn about default/weak database credentials
  if (
    process.env.DATABASE_URL?.includes('password@') ||
    process.env.DATABASE_URL?.includes(':postgres@')
  ) {
    console.warn(
      'WARNING: DATABASE_URL appears to use default credentials. Change for production!'
    );
  }
  // Warn about missing APM — errors are invisible without it
  if (!process.env.SENTRY_DSN) {
    console.warn(
      'WARNING: SENTRY_DSN not set. Production errors will only appear in logs, not in an APM dashboard.'
    );
  }
  // Warn about missing Redis — queues/banking retries won't work
  if (!process.env.REDIS_URL) {
    console.warn(
      'WARNING: REDIS_URL not set. Job queues (banking retries, imports) will fail silently.'
    );
  }
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.warn(
      'WARNING: VAPID keys not set. OS Web Push notifications will not be delivered.'
    );
  }
  // Validate CORS_ORIGIN — block wildcard in production
  if (process.env.CORS_ORIGIN === '*') {
    console.error(
      'FATAL: CORS_ORIGIN=* is not allowed in production (credentials mode requires explicit origins)'
    );
    process.exit(1);
  }
}

const app = express();
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// ============================================================
// SENTRY ERROR MONITORING (must init before other middleware)
// ============================================================
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    integrations: [
      Sentry.httpIntegration(),
      Sentry.expressIntegration(),
      Sentry.postgresIntegration(),
    ],
  });
  logger.info('Sentry error monitoring + performance tracing initialized');
}

// ============================================================
// MIDDLEWARE
// ============================================================

// Make pool available to routes via app.get('pool')
app.set('pool', pool);

// Trust first proxy (nginx) so express-rate-limit reads correct client IP
app.set('trust proxy', 1);

// Initialize RBAC middleware with database pool
initializeRbacMiddleware(pool);

// Security headers
app.use(helmet());

// Correlation ID for request tracing
app.use(correlationId);

// CORS - Allow both localhost and 127.0.0.1
const CORS_ORIGINS = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',')
  : ['http://localhost:5173', 'http://127.0.0.1:5173'];

app.use(
  cors({
    origin: CORS_ORIGINS,
    credentials: true,
  })
);

// Body parsing (limit prevents DoS via oversized payloads)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Compression
app.use(compression());

// Request counting for metrics
app.use((_req, res, next) => {
  incrementMetric('httpRequestsTotal');
  res.on('finish', () => {
    if (res.statusCode >= 500) {
      incrementMetric('httpErrorsTotal');
    }
  });
  next();
});

// Request logging with response timing
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.http(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`, {
      requestId: req.requestId,
      status: res.statusCode,
      duration,
    });
  });
  next();
});

// Audit context middleware (adds audit context to all requests)
// Should be after auth middleware to get user info
app.use(auditContextMiddleware);

// Multi-tenant middleware (resolves tenant from JWT/header/subdomain → attaches pool)
app.use(tenantMiddleware);

// SAP/Odoo: authenticated tenant API uses per-tenant budgets (tenantRateLimit below).
// Global IP limit applies only to unauthenticated traffic (login flood, health probes).
app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/metrics') return next();
  if (req.tenantId) return next();
  return globalRateLimit(req, res, next);
});

app.use('/api/auth', authRateLimit);

// Per-tenant rate limiting (must be after tenant resolution, before routes)
app.use(tenantRateLimit);

// Idempotency deduplication (after tenant resolution so req.tenantPool is available)
app.use(idempotencyMiddleware(pool));

// ============================================================
// ROUTES
// ============================================================

// Health check - single fast query, no retries (unlike testConnection used at startup)
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');

    res.json({
      success: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        database: 'healthy',
        server: 'healthy',
      },
    });
  } catch (error: unknown) {
    res.status(500).json({
      success: false,
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      services: {
        database: 'unhealthy',
      },
    });
  }
});

// Server time endpoint — SAP/Odoo pattern: server is SOLE authority for business dates.
// Frontend MUST use this instead of new Date() for any business-critical date defaults.
app.get('/api/server-time', authenticate, (_req, res) => {
  res.json({
    success: true,
    data: {
      businessDate: getBusinessDate(),           // 'YYYY-MM-DD' in Africa/Kampala
      businessYear: getBusinessYear(),            // 4-digit year
      serverTimestamp: new Date().toISOString(),   // UTC ISO-8601
      businessTimestamp: formatBusinessTimestamp(), // Human-readable in business TZ
      timezone: BUSINESS_TIMEZONE,                 // 'Africa/Kampala'
    },
  });
});

// API Documentation (Swagger UI) — restricted to ADMIN only (SECURITY LAW)
app.use(
  '/api/docs',
  authenticate,
  requirePermission('admin.read'),
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    customSiteTitle: 'SMART-ERP-POS API Docs',
  })
);
app.get('/api/docs.json', authenticate, requirePermission('admin.read'), (_req, res) => res.json(swaggerSpec));

// API routes

// Health + Metrics (comprehensive — no auth required)
// Routes: /api/health, /api/health/metrics, /api/health/ready, /api/health/live, /api/health/legacy
app.use('/api/health', healthRoutes);

// Platform routes (super admin — tenant management, no tenant middleware needed)
app.use('/api/platform', platformRoutes);

// Tenant config (public — frontend fetches branding/currency/features before login)
app.use('/api/tenant', tenantConfigRoutes);

// Sync routes (edge node ↔ cloud synchronization)
app.use('/api/sync', syncRoutes);

app.use('/api/auth', authRoutes);

// ── Quick Login (SAP-style POS fast auth — PIN/biometric on trusted devices)
app.use('/api/auth/quick-login', quickLoginRoutes);

// ── Accounting module (plan: PROFESSIONAL+) ──────────────────
app.use('/api/accounting', requireFeature('accounting'), accountingRoutes);
app.use('/api/accounting/comprehensive', requireFeature('accounting'), comprehensiveAccountingRoutes);
app.use('/api/accounting/integrity', requireFeature('accounting'), authenticate, integrityRoutes);
app.use('/api/erp-accounting', requireFeature('accounting'), erpAccountingRoutes);
app.use('/api/banking', requireFeature('accounting'), bankingRoutes);
app.use('/api/enterprise-accounting', requireFeature('accounting'), enterpriseAccountingRoutes);

// ── Expenses (plan: STARTER+) ───────────────────────────────
app.use('/api/expenses', requireFeature('expenses'), expenseRoutes);

// ── Documents (always available) ─────────────────────────────
// PDF renderer MUST register before file-upload documentRoutes so
// GET /api/documents/:type/:id is not swallowed by GET /:id metadata.
app.use('/api/documents', createDocumentRoutes(pool));
app.use('/api/documents', documentRoutes);

// ── Reports (plan: STARTER+ for general, PROFESSIONAL+ for financial) ──
app.use('/api/reports', requireFeature('reports'), businessReportRoutes);

// ── Products (always available — core POS dependency) ────────
app.use('/api/products', productRoutes);

// ── Customers (plan: STARTER+) ──────────────────────────────
app.use('/api/customers', requireFeature('customers'), customerRoutes);
app.use('/api/suppliers', requireFeature('customers'), supplierRoutes);

// ── POS & Sales (plan: FREE+) ───────────────────────────────
app.use('/api/sales', requireFeature('pos'), salesRoutes);
app.use('/api/orders', requireFeature('pos'), ordersRoutes);
app.use('/api/pos/hold', requireFeature('pos'), createHoldRoutes(pool));
app.use('/api/pos/sync-offline-sales', requireFeature('pos'), createOfflineSyncRoutes(pool));
app.use('/api/pos/sync-events', requireFeature('pos'), createSyncEventsRoutes(pool));
app.use('/api/cash-registers', requireFeature('pos'), cashRegisterRoutes);
app.use('/api/discounts', requireFeature('pos'), authenticate, discountRoutes);
app.use('/api/payments', requireFeature('pos'), createPaymentsRoutes());

// ── Inventory (plan: STARTER+) ──────────────────────────────
app.use('/api/inventory', requireFeature('inventory'), inventoryRoutes);
app.use('/api/goods-receipts', requireFeature('inventory'), goodsReceiptRoutes);
app.use('/api/return-grn', requireFeature('inventory'), returnGrnRoutes);
app.use('/api/supplier-adjustments', requireFeature('purchase_orders'), supplierAdjustmentRoutes);
app.use('/api/corrections', requireFeature('purchase_orders'), correctionRoutes);
app.use('/api/customer-invoice-adjustments', requireFeature('invoices'), customerInvoiceAdjustmentRoutes);
app.use('/api/stock-movements', requireFeature('inventory'), stockMovementRoutes);

// ── Purchase Orders (plan: PROFESSIONAL+) ───────────────────
app.use('/api/purchase-orders', requireFeature('purchase_orders'), purchaseOrderRoutes);
app.use('/api/supplier-payments', requireFeature('purchase_orders'), createSupplierPaymentRoutes(pool));
app.use('/api/ar-payments', arPaymentRoutes);

// ── Invoices & Credit Notes (plan: STARTER+) ────────────────
app.use('/api/invoices', requireFeature('invoices'), invoiceRoutes);
app.use('/api/credit-debit-notes', requireFeature('invoices'), creditDebitNoteRoutes);
app.use('/api/document-flow', requireFeature('invoices'), documentFlowRoutes);
app.use('/api/deposits', requireFeature('customers'), depositsRoutes);
app.use('/api/down-payment-clearing', requireFeature('accounting'), downPaymentClearingRoutes);

// ── Settings & Admin (always available) ─────────────────────
app.use('/api/settings/invoice', invoiceSettingsRoutes);
app.use('/api/system-settings', systemSettingsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reports', requireFeature('reports'), createReportsRouter(pool));
app.use('/api/users', createUserRoutes());
app.use('/api/admin', adminRoutes);
app.use('/api/system', systemManagementRoutes);
app.use('/api/system/gl', glRepairRoutes);
app.use('/api/audit', authenticate, auditRoutes);
app.use('/api/rbac', createRbacRoutes(pool));
app.use('/api/import', importRoutes);

// ── Quotations & Delivery (plan: STARTER+) ──────────────────
app.use('/api', requireFeature('invoices'), quotationRoutes);
app.use('/api/delivery', requireFeature('invoices'), deliveryRoutes);
app.use('/api/delivery-notes', requireFeature('invoices'), deliveryNoteRoutes);

// ── CRM & HR (plan: STARTER+) ──────────────────────────────
app.use('/api/crm', requireFeature('customers'), crmRoutes);
app.use('/api/pricing', requireFeature('pos'), pricingEngineRoutes);
app.use('/api/hr', requireFeature('hr'), hrRoutes);
console.log('  HR & Payroll module loaded');

// ── Distribution Module (SAP-style document flow) ──────────
app.use('/api/distribution', requireFeature('invoices'), distRoutes);

// ── SAP-gap feature modules (plan: PROFESSIONAL+) ──────────
app.use('/api/cost-centers', requireFeature('accounting'), costCenterRoutes);
app.use('/api/period-control', requireFeature('accounting'), periodControlRoutes);
app.use('/api/grir-clearing', requireFeature('accounting'), grirClearingRoutes);
app.use('/api/dunning', requireFeature('accounting'), dunningRoutes);
app.use('/api/withholding-tax', requireFeature('accounting'), whtRoutes);
app.use('/api/vat-remittance', requireFeature('accounting'), vatRemittanceRoutes);
app.use('/api/bad-debt', requireFeature('accounting'), badDebtRoutes);
app.use('/api/treasury', requireFeature('accounting'), treasuryRoutes);
app.use('/api/restaurant', requireFeature('pos'), restaurantRoutes);
app.use('/api/kitchen-production', requireFeature('pos'), kitchenProductionRoutes);
app.use('/api/print-jobs', requireFeature('pos'), printJobsRoutes);
app.use('/api/assets', requireFeature('accounting'), assetRoutes);
app.use('/api/je-approval', requireFeature('accounting'), jeApprovalRoutes);
app.use('/api/payment-program', requireFeature('accounting'), paymentProgramRoutes);
app.use('/api/currency', requireFeature('accounting'), currencyRoutes);

// On-prem / commercial: serve Vite build from the same origin as the API
mountFrontendSpa(app);

// ============================================================
// ERROR HANDLERS
// ============================================================

// 404 handler for unknown routes (must be after all route definitions)
app.use(notFoundHandler);

// Sentry error handler — must be BEFORE our custom error handlers
// so it captures errors and calls next() to let our handlers format the response
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// Business rule error handler (catches business logic violations)
app.use(businessRuleErrorHandler);

// Global error handler (must be last)
app.use(errorHandler);

// ============================================================
// START SERVER
// ============================================================

async function startServer() {
  try {
    // Test database connection
    logger.info('Testing database connection...');
    const dbConnected = await testConnection();

    if (!dbConnected) {
      logger.error('Failed to connect to database');
      process.exit(1);
    }

    logger.info('Database connection successful');

    const { getArGovernanceMode } = await import(
      './modules/accounting-governance/arJournalGovernance.js'
    );
    const arGovernanceMode = getArGovernanceMode();
    logger.info('AR governance mode active', { arGovernanceMode });
    if (arGovernanceMode === 'warn') {
      logger.info(
        'AR_GOVERNANCE_MODE=warn — entity violations will be logged as AR_GOVERNANCE_WARN without blocking posts',
      );
    }

    // Self-healing guard: ensure every product has its child rows in
    // product_valuation and product_inventory. Safe to call at any time —
    // the underlying INSERT uses ON CONFLICT DO NOTHING. This recovers from
    // any data reset (UI or SQL) that wiped the child tables.
    try {
      const { ensureProductChildRows } = await import('./modules/products/productRepository.js');
      const healed = await ensureProductChildRows(pool);
      if (healed.valuation > 0 || healed.inventory > 0) {
        logger.warn('Product child rows were missing and have been recreated', healed);
      } else {
        logger.info('Product child row integrity check passed');
      }
    } catch (err) {
      logger.warn('Product child row integrity check skipped', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Pre-build tenant template database (non-blocking — failure just means
    // first tenant provision will build it on demand)
    try {
      const { tenantService } = await import('./modules/platform/tenantService.js');
      await tenantService.ensureTemplateDatabase(pool);
      await tenantService.syncTemplateDatabase(pool);
      logger.info('Tenant template database ready');
    } catch (err) {
      logger.warn('Template DB pre-build skipped (will create on first tenant provision)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Start Express server
    const server = app.listen(PORT, () => {
      console.log('');
      console.log('✅ SMART ERP Backend API Started');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📍 API endpoint: http://localhost:${PORT}`);
      console.log(`📍 Health check: http://localhost:${PORT}/health`);
      console.log(`📍 API docs:     http://localhost:${PORT}/api/docs`);
      console.log(`📍 Frontend URL: ${FRONTEND_URL}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📚 Available modules:');
      console.log('   - Auth (/api/auth)');
      console.log('   - Products (/api/products)');
      console.log('   - Customers (/api/customers)');
      console.log('   - Suppliers (/api/suppliers)');
      console.log('   - Sales (/api/sales)');
      console.log('   - Inventory (/api/inventory)');
      console.log('   - Purchase Orders (/api/purchase-orders)');
      console.log('   - Goods Receipts (/api/goods-receipts)');
      console.log('   - Stock Movements (/api/stock-movements)');
      console.log('   - Invoices (/api/invoices)');
      console.log('   - System Settings (/api/system-settings)');
      console.log('   - Reports (/api/reports)');
      console.log('   - Admin (/api/admin)');
      console.log('   - Audit Trail (/api/audit)');
      console.log('   - Quotations (/api/quotations)');
      console.log('   - Expenses (/api/expenses)');
      console.log('   - Supplier Payments (/api/supplier-payments)');
      console.log('   - Banking (/api/banking)');
      console.log('   - RBAC (/api/rbac)');
      console.log('   - Delivery (/api/delivery)');
      console.log('   - Import (/api/import)');
      console.log('   - Platform (/api/platform)');
      console.log('   - CRM (/api/crm)');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('');

      logger.info(`Server started on port ${PORT}`);

      // Pre-warm connection pools for all active tenants to eliminate cold-start latency
      (async () => {
        try {
          const masterPool = connectionManager.getMasterPool();
          const { rows } = await masterPool.query<{
            id: string;
            slug: string;
            database_name: string;
            database_host: string;
            database_port: number;
            plan: string;
          }>(
            `SELECT id, slug, database_name, database_host, database_port, plan
             FROM tenants WHERE status = 'ACTIVE'`
          );
          for (const row of rows) {
            connectionManager.preWarm({
              tenantId: row.id,
              slug: row.slug,
              databaseName: row.database_name,
              databaseHost: row.database_host,
              databasePort: row.database_port,
              plan: row.plan as TenantPlan,
            });
          }
          logger.info(`Pre-warmed ${rows.length} active tenant pool(s)`);

          // ── Tenant Schema Sync ──────────────────────────────────────────
          // Auto-sync all tenant databases to master schema version on startup.
          // Non-blocking: failures are logged but don't crash the server.
          const { tenantMigrationService: tms } = await import('./modules/system/tenantMigrationService.js');
          const syncResult = await tms.syncAllTenants(masterPool);
          if (syncResult.failed.length > 0) {
            logger.error(`⚠️  ${syncResult.failed.length} tenant(s) failed schema sync — check logs`);
          }

          // ── Tenant Health Check ─────────────────────────────────────────
          // Verify all tenants have required tables after migration.
          await tms.healthCheckAllTenants(masterPool);
        } catch (err) {
          logger.warn('Tenant pool pre-warm failed (non-fatal)', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();

      try {
        initCalculationsScheduledJobs(pool);
      } catch (err) {
        logger.warn('Calculations scheduled jobs not started (Redis may be offline)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Register GL period balance projection worker (requires Redis)
      // Processes gl_projection_events outbox table to keep gl_period_balances in sync.
      // A repeating job also sweeps for any PENDING events every 30s as a catch-all.
      try {
        import('./services/periodBalanceWorker.js')
          .then(({ pollAndProcessPendingEvents }) => {
            jobQueue.processQueue('gl_events', async (_job) => {
              await pollAndProcessPendingEvents(pool);
            });
            // Repeating sweep — catches any events missed by the immediate path
            const glQueue = jobQueue.getQueue('gl_events');
            if (glQueue) {
              glQueue.add(
                { type: 'SWEEP_PENDING_EVENTS', payload: null, userId: 'system', timestamp: new Date().toISOString() },
                { repeat: { every: 30000 }, jobId: 'gl-events-sweep' },
              ).catch((err) => logger.warn('GL events sweep job registration failed', {
                error: err instanceof Error ? err.message : String(err),
              }));
            }
            logger.info('GL period balance projection worker registered');
          })
          .catch((err) => {
            logger.warn('GL period balance projection worker not started', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      } catch (err) {
        logger.warn('GL period balance projection worker not started (Redis may be offline)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Register CSV import worker (requires Redis)
      try {
        import('./modules/import/importWorker.js')
          .then(({ processImportJob }) => {
            jobQueue.processQueue('imports', async (job) => {
              await processImportJob(job.data.payload as Parameters<typeof processImportJob>[0]);
            });
            logger.info('CSV import worker registered');
          })
          .catch((err) => {
            logger.warn('CSV import worker not started', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      } catch (err) {
        logger.warn('CSV import worker not started (Redis may be offline)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        import('./modules/notifications/notificationWorker.js')
          .then(async ({ processNotificationEvent }) => {
            const { resolveNotificationWorkerPool } = await import(
              './modules/notifications/tenantPoolResolver.js'
            );
            jobQueue.processQueue('notifications', async (job) => {
              if (job.data.type === 'SWEEP_PENDING') {
                const { sweepAllActiveTenantNotificationEvents } = await import(
                  './modules/notifications/tenantPoolResolver.js'
                );
                const sweep = await sweepAllActiveTenantNotificationEvents(pool);
                logger.info('Notification pending-event sweep', sweep);
                return;
              }
              const payload = job.data.payload as { tenantId?: string; eventId?: string };
              if (!payload?.eventId) return;
              const workerPool = await resolveNotificationWorkerPool(payload.tenantId, pool);
              if (!workerPool) {
                logger.error('Notification worker: tenant pool not found', {
                  tenantId: payload.tenantId,
                  eventId: payload.eventId,
                });
                return;
              }
              await processNotificationEvent(workerPool, payload.eventId, payload.tenantId ?? null);
            });
            const notifQueue = jobQueue.getQueue('notifications');
            if (notifQueue) {
              notifQueue
                .add(
                  {
                    type: 'SWEEP_PENDING',
                    payload: { sweep: true },
                    userId: 'system',
                    timestamp: new Date().toISOString(),
                  },
                  { repeat: { every: 20000 }, jobId: 'notification-events-sweep' },
                )
                .catch((err) =>
                  logger.warn('Notification sweep job registration failed', {
                    error: err instanceof Error ? err.message : String(err),
                  }),
                );
            }
            logger.info('Notification worker registered');
          })
          .catch((err) => {
            logger.warn('Notification worker not started', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      } catch (err) {
        logger.warn('Notification worker not started (Redis may be offline)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Register banking retry worker (requires Redis)
      try {
        import('./services/bankingService.js')
          .then(({ BankingService }) => {
            jobQueue.processQueue('banking', async (job) => {
              const payload = job.data.payload as {
                saleId: string;
                saleNumber: string;
                saleDate: string;
                payments: Array<{ amount: number; paymentMethod: string }>;
                tenantId?: string;
              };

              // Resolve tenant pool for multi-tenant isolation
              const workerPool = payload.tenantId
                ? connectionManager.getPoolById(payload.tenantId)
                : undefined;
              if (payload.tenantId && !workerPool) {
                logger.error('Banking retry: tenant pool not found, skipping job', {
                  tenantId: payload.tenantId,
                  saleId: payload.saleId,
                });
                return; // Don't retry — pool eviction means tenant hasn't been active
              }

              for (const payment of payload.payments) {
                await BankingService.createFromSale(
                  payload.saleId,
                  payload.saleNumber,
                  payment.amount,
                  payment.paymentMethod,
                  payload.saleDate,
                  workerPool
                );
              }
              logger.info('Banking retry succeeded', {
                saleId: payload.saleId,
                saleNumber: payload.saleNumber,
                attempt: job.attemptsMade + 1,
              });
            });
            logger.info('Banking retry worker registered');
          })
          .catch((err) => {
            logger.warn('Banking retry worker not started', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      } catch (err) {
        logger.warn('Banking retry worker not started (Redis may be offline)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    server.on('error', (error: Error) => {
      logger.error('Server error:', error);
      console.error('Server error:', error);
    });

    // Graceful shutdown
    const SHUTDOWN_TIMEOUT_MS = 30_000;
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);

      // Force exit if shutdown hangs
      const forceExit = setTimeout(() => {
        logger.error('Shutdown timed out, forcing exit');
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      forceExit.unref();

      server.close(async () => {
        try {
          sessionService.shutdown();
          await closeHealthRedis().catch((err: unknown) => {
            logger.warn('Health Redis close error', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
          await jobQueue.closeAll().catch((err: unknown) => {
            logger.warn('Job queue close error', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
          await connectionManager.shutdown();
        } catch (err) {
          logger.error('Shutdown cleanup error', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        clearTimeout(forceExit);
        process.exit(0);
      });
    };

    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception — initiating shutdown:', error);
      console.error('Uncaught exception:', error);
      // Process is in an unknown state; must exit to avoid data corruption
      shutdown('uncaughtException').catch(() => process.exit(1));
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection:', { reason, promise });
      console.error('Unhandled rejection:', reason);
    });

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
}

// Export app for testing
export default app;

// Start server only if not imported (i.e., not in test environment)
if (process.env.NODE_ENV !== 'test') {
  startServer();
}
