// Phase 7: Security Middleware Collection
// File: SamplePOS.Server/src/middleware/security.ts

import { Request, Response, NextFunction } from 'express';
import rateLimit, { MemoryStore } from 'express-rate-limit';
import helmet from 'helmet';
import { body, query, param, validationResult, ValidationChain } from 'express-validator';
// import xss from 'xss'; // Commented out - install xss package if needed

/**
 * Security headers middleware using Helmet
 */
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // Disable for development
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  }
});

/**
 * Rate limiting configurations
 *
 * SAP/Odoo: business API is limited per tenant (tenantRateLimit.ts).
 * Global IP limit is a DDoS safety net for unauthenticated traffic only —
 * see server.ts placement after tenantMiddleware.
 */
export const globalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Auth rate limiter — DDoS safety net only.
 * Per-user lockout (passwordPolicyService) is the real brute-force guard.
 * This is intentionally generous so shared-IP setups (reverse proxy, NAT)
 * don't lock out all users when one person fat-fingers their password.
 */
const authRateLimitStore = new MemoryStore();

export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // Very generous — per-user lockout is the real defense
  message: {
    success: false,
    error: 'Too many requests, please try again later'
  },
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  store: authRateLimitStore,
});

/**
 * Call after a successful login to wipe the IP's failure count so 
 * the user is never blocked after proving valid credentials.
 */
export function resetAuthRateLimit(req: Request): void {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  authRateLimitStore.resetKey(key);
}

export const apiRateLimit = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 200, // 200 API requests per minute (POS workflows require high throughput)
  message: {
    success: false,
    error: 'API rate limit exceeded, please slow down'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export const strictRateLimit = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 20, // Limit each IP to 20 requests per minute for 2FA verification (increased from 10)
  message: {
    success: false,
    error: 'Too many verification attempts. Please wait a moment and try again.'
  },
  skipFailedRequests: false, // Count all requests to prevent brute force
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * XSS Protection Middleware — only runs on write methods (POST/PUT/PATCH)
 * GET/DELETE/HEAD/OPTIONS skip sanitization for lower latency
 */
export function xssProtection(req: Request, res: Response, next: NextFunction): void {
  // Skip read-only methods — no body to sanitize
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'DELETE' || method === 'HEAD' || method === 'OPTIONS') {
    return next();
  }

  // Sanitize request body
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body) as typeof req.body;
  }

  // Sanitize query parameters
  if (req.query && typeof req.query === 'object') {
    req.query = sanitizeObject(req.query) as typeof req.query;
  }

  // Sanitize URL parameters
  if (req.params && typeof req.params === 'object') {
    req.params = sanitizeObject(req.params) as typeof req.params;
  }

  next();
}

/**
 * Recursively sanitize an object to prevent XSS
 */
function sanitizeObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    // Simple XSS prevention - strip HTML tags
    return obj.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<[^>]*>/g, '')
      .trim();
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item));
  }

  if (typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {};
    const record = obj as Record<string, unknown>;
    for (const key in record) {
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        sanitized[key] = sanitizeObject(record[key]);
      }
    }
    return sanitized;
  }

  return obj;
}

/**
 * Input validation middleware factory
 */
export function validateInput(validations: ValidationChain[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Run validations
    await Promise.all(validations.map(validation => validation.run(req)));

    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors.array().map(error => ({
          field: error.type === 'field' ? error.path : 'unknown',
          message: error.msg
        }))
      });
      return;
    }

    next();
  };
}

/**
 * Common validation rules
 */
export const ValidationRules = {
  // User validations
  userId: param('userId').isUUID().withMessage('Invalid user ID format'),
  username: body('username').trim().isLength({ min: 3, max: 50 }).matches(/^[a-zA-Z0-9_]+$/).withMessage('Username must be 3-50 characters and contain only letters, numbers, and underscores'),
  email: body('email').trim().isEmail().normalizeEmail().withMessage('Invalid email format'),
  password: body('password').isLength({ min: 8 }).matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/).withMessage('Password must be at least 8 characters with uppercase, lowercase, number, and special character'),
  firstName: body('firstName').trim().isLength({ min: 1, max: 100 }).matches(/^[a-zA-Z\s'-]+$/).withMessage('First name must be 1-100 characters and contain only letters, spaces, hyphens, and apostrophes'),
  lastName: body('lastName').trim().isLength({ min: 1, max: 100 }).matches(/^[a-zA-Z\s'-]+$/).withMessage('Last name must be 1-100 characters and contain only letters, spaces, hyphens, and apostrophes'),
  role: body('role').isIn(['ADMIN', 'MANAGER', 'CASHIER', 'STAFF']).withMessage('Invalid role'),

  // Product validations
  productId: param('productId').isUUID().withMessage('Invalid product ID format'),
  productSku: body('sku').trim().isLength({ min: 1, max: 50 }).matches(/^[a-zA-Z0-9-_]+$/).withMessage('SKU must be 1-50 characters and contain only letters, numbers, hyphens, and underscores'),
  productName: body('name').trim().isLength({ min: 1, max: 255 }).withMessage('Product name must be 1-255 characters'),
  productPrice: body('price').isFloat({ min: 0 }).withMessage('Price must be a positive number'),
  productQuantity: body('quantity').isInt({ min: 0 }).withMessage('Quantity must be a non-negative integer'),

  // Sale validations
  saleId: param('saleId').matches(/^SALE-\d{4}-\d{4}$/).withMessage('Invalid sale ID format'),
  paymentMethod: body('paymentMethod').isIn(['CASH', 'CARD', 'MOBILE_MONEY', 'AIRTEL_MONEY', 'CREDIT', 'GIFT']).withMessage('Invalid payment method'),
  amount: body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0'),

  // Purchase Order validations
  poId: param('poId').matches(/^PO-\d{4}-\d{4}$/).withMessage('Invalid purchase order ID format'),
  supplierId: body('supplierId').isUUID().withMessage('Invalid supplier ID format'),

  // Customer validations
  customerId: param('customerId').isUUID().withMessage('Invalid customer ID format'),
  customerName: body('name').trim().isLength({ min: 1, max: 255 }).withMessage('Customer name must be 1-255 characters'),
  phoneNumber: body('phone').optional().matches(/^\+?[\d\s-()]+$/).withMessage('Invalid phone number format'),

  // Pagination validations
  page: query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  limit: query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),

  // Date validations
  dateFrom: query('dateFrom').optional().isISO8601().toDate().withMessage('Invalid date format for dateFrom'),
  dateTo: query('dateTo').optional().isISO8601().toDate().withMessage('Invalid date format for dateTo'),

  // Search validations
  searchQuery: query('q').optional().trim().isLength({ min: 1, max: 100 }).withMessage('Search query must be 1-100 characters'),

  // Sort validations
  sortBy: query('sortBy').optional().isIn(['name', 'createdAt', 'updatedAt', 'price', 'quantity']).withMessage('Invalid sort field'),
  sortOrder: query('sortOrder').optional().isIn(['asc', 'desc']).withMessage('Sort order must be asc or desc'),
};

/**
 * SQL Injection Prevention Middleware
 */
export function preventSqlInjection(req: Request, res: Response, next: NextFunction): void {
  const suspiciousPatterns = [
    /('|(\\x27)|(\\x2D)|(\\x2d))/i,
    /(;|(\\x3B)|(\\x3b))/i,
    /((\\x3D)|(\\x3d)|=)/i,
    /((union(.*?)select)|(union(.*?)all(.*?)select))/i,
    /(select(.*?)from)/i,
    /(insert(.*?)into)/i,
    /(delete(.*?)from)/i,
    /(update(.*?)set)/i,
    /(drop(.*?)table)/i,
    /(create(.*?)table)/i,
    /(alter(.*?)table)/i,
    /(exec(.*?)(\\x28|\\x29|\\(|\\)))/i,
    /((\\x3C)|(\\x3c)|<|(<script.*?>))/i,
  ];

  const checkForSqlInjection = (value: unknown): boolean => {
    if (typeof value === 'string') {
      return suspiciousPatterns.some(pattern => pattern.test(value));
    }
    if (Array.isArray(value)) {
      return value.some(checkForSqlInjection);
    }
    if (typeof value === 'object' && value !== null) {
      return Object.values(value).some(checkForSqlInjection);
    }
    return false;
  };

  // Check all user inputs
  const inputs = [req.body, req.query, req.params];
  if (inputs.some(checkForSqlInjection)) {
    res.status(400).json({
      success: false,
      error: 'Suspicious input detected'
    });
    return;
  }

  next();
}

/**
 * Request size limiting middleware
 */
export function limitRequestSize(maxSize: string = '10mb') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const contentLength = req.headers['content-length'];

    if (contentLength) {
      const size = parseInt(contentLength);
      const maxSizeBytes = parseSize(maxSize);

      if (size > maxSizeBytes) {
        res.status(413).json({
          success: false,
          error: 'Request entity too large'
        });
        return;
      }
    }

    next();
  };
}

/**
 * Parse size string to bytes
 */
function parseSize(size: string): number {
  const units: { [key: string]: number } = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024
  };

  const match = size.toLowerCase().match(/^(\d+(?:\.\d+)?)(b|kb|mb|gb)$/);
  if (!match) {
    throw new Error('Invalid size format');
  }

  const value = parseFloat(match[1]);
  const unit = match[2];

  return value * units[unit];
}

/**
 * Request timeout middleware
 */
export function requestTimeout(timeoutMs: number = 30000) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        res.status(408).json({
          success: false,
          error: 'Request timeout'
        });
      }
    }, timeoutMs);

    res.on('finish', () => {
      clearTimeout(timeout);
    });

    res.on('close', () => {
      clearTimeout(timeout);
    });

    next();
  };
}

/**
 * IP allowlist middleware
 */
export function ipAllowlist(allowedIPs: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;

    if (!clientIP || !allowedIPs.includes(clientIP)) {
      res.status(403).json({
        success: false,
        error: 'IP address not allowed'
      });
      return;
    }

    next();
  };
}

/**
 * Combined security middleware
 */
export function applySecurity() {
  return [
    securityHeaders,
    xssProtection,
    preventSqlInjection,
    limitRequestSize('10mb'),
    requestTimeout(30000)
  ];
}