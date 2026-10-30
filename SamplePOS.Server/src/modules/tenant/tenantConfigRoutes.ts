/**
 * Tenant Config Routes
 *
 * Public endpoint (no auth required) that returns the tenant's
 * branding, currency, locale, and feature flags.
 *
 * Resolution order:
 *   1. req.tenant (set by tenantMiddleware from DB)
 *   2. Fallback to config/tenants/<slug>.json file
 *   3. Fallback to config/tenants/default.json
 *
 * This allows the frontend to configure itself before the user
 * logs in (login page branding, currency display, etc.).
 */

import express from 'express';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import multer from 'multer';
import type { TenantConfig } from '../../../../shared/types/tenantConfig.js';
import type { Request, Response } from 'express';
import { PLAN_LIMITS, type TenantPlan } from '../../../../shared/types/tenant.js';
import logger from '../../utils/logger.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../rbac/middleware.js';
import { connectionManager } from '../../db/connectionManager.js';
import { invalidateTenantCache } from '../../middleware/tenantMiddleware.js';

const router = express.Router();

// Cache loaded file configs in memory (they rarely change)
const fileConfigCache = new Map<string, TenantConfig>();

/**
 * Load a tenant config from the config/tenants/ directory.
 * Returns null if the file doesn't exist.
 */
function loadFileConfig(slug: string): TenantConfig | null {
  if (fileConfigCache.has(slug)) {
    return fileConfigCache.get(slug)!;
  }

  try {
    // Resolve relative to project root (3 levels up from dist/src/modules/)
    const configPath = join(process.cwd(), '..', 'config', 'tenants', `${slug}.json`);
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as TenantConfig;
    fileConfigCache.set(slug, config);
    return config;
  } catch {
    // File not found — try from CWD directly (for different working dirs)
    try {
      const altPath = join(process.cwd(), 'config', 'tenants', `${slug}.json`);
      const raw = readFileSync(altPath, 'utf-8');
      const config = JSON.parse(raw) as TenantConfig;
      fileConfigCache.set(slug, config);
      return config;
    } catch {
      return null;
    }
  }
}

/**
 * Build a TenantConfig from the Tenant DB row + system settings.
 * This is used when the tenant is resolved from the database.
 */
function buildConfigFromTenant(tenant: {
  slug: string;
  name: string;
  id: string;
  plan: string;
  currency: string;
  timezone: string;
  country: string;
}): TenantConfig {
  // Start with defaults, override with tenant DB fields
  const fileConfig = loadFileConfig(tenant.slug) || loadFileConfig('default');

  const plan = (tenant.plan || 'FREE') as TenantPlan;
  const planFeatures = PLAN_LIMITS[plan]?.features ?? PLAN_LIMITS.FREE.features;

  return {
    tenantId: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    plan,
    planFeatures,
    currency: fileConfig?.currency || {
      code: tenant.currency || 'UGX',
      symbol: tenant.currency || 'UGX',
      name: 'Currency',
      decimals: 2,
      thousandsSeparator: ',',
      decimalSeparator: '.',
      symbolPosition: 'before',
    },
    branding: fileConfig?.branding || {
      companyName: tenant.name,
      companyAddress: '',
      companyPhone: '',
      companyEmail: '',
      logoUrl: null,
      primaryColor: '#2563eb',
      secondaryColor: '#10b981',
      footerText: 'Thank you for your business!',
    },
    locale: fileConfig?.locale || {
      country: tenant.country || 'UG',
      timezone: tenant.timezone || 'Africa/Kampala',
      dateFormat: 'YYYY-MM-DD',
      timeFormat: 'HH:mm',
    },
    tax: fileConfig?.tax || {
      enabled: true,
      defaultRate: 18,
      name: 'VAT',
      inclusive: false,
    },
    features: fileConfig?.features || {
      pharmacy_mode: false,
      restaurant_mode: false,
      sales_targets: false,
      offline_pos: true,
      credit_sales: true,
      quotations: true,
      purchase_orders: true,
      multi_currency: false,
      barcode_scanner: true,
    },
  };
}

// GET /api/tenant/config — public, no auth required
router.get('/config', (req: Request, res: Response) => {
  try {
    // If tenant middleware resolved a DB tenant, use it
    if (req.tenant) {
      const config = buildConfigFromTenant(
        req.tenant as {
          slug: string;
          name: string;
          id: string;
          plan: string;
          currency: string;
          timezone: string;
          country: string;
        }
      );
      res.json({ success: true, data: config });
      return;
    }

    // Fallback: load from config file (single-tenant / dev mode)
    const slug = 'default';
    const config = loadFileConfig(slug);
    if (config) {
      res.json({ success: true, data: config });
      return;
    }

    // Absolute fallback — hardcoded defaults
    res.json({
      success: true,
      data: {
        tenantId: 'default',
        slug: 'default',
        name: 'SMART ERP',
        plan: 'ENTERPRISE',
        planFeatures: PLAN_LIMITS.ENTERPRISE.features,
        currency: {
          code: 'UGX',
          symbol: 'UGX',
          name: 'Ugandan Shillings',
          decimals: 2,
          thousandsSeparator: ',',
          decimalSeparator: '.',
          symbolPosition: 'before',
        },
        branding: {
          companyName: 'SMART ERP',
          companyAddress: '',
          companyPhone: '',
          companyEmail: '',
          logoUrl: null,
          primaryColor: '#2563eb',
          secondaryColor: '#10b981',
          footerText: '',
        },
        locale: {
          country: 'UG',
          timezone: 'Africa/Kampala',
          dateFormat: 'YYYY-MM-DD',
          timeFormat: 'HH:mm',
        },
        tax: { enabled: true, defaultRate: 18, name: 'VAT', inclusive: false },
        features: {
          pharmacy_mode: false,
          restaurant_mode: false,
          sales_targets: false,
          offline_pos: true,
          credit_sales: true,
          quotations: true,
          purchase_orders: true,
          multi_currency: false,
          barcode_scanner: true,
        },
      } satisfies TenantConfig,
    });
  } catch (err) {
    logger.error('Failed to load tenant config', { error: (err as Error).message });
    res.status(500).json({ success: false, error: 'Failed to load tenant configuration' });
  }
});

// ============================================================
// GET /api/tenant/manifest.json — Dynamic PWA Manifest
// Public (no auth) — browser fetches this for PWA install
// ============================================================
router.get('/manifest.json', (req: Request, res: Response) => {
  try {
    const tenant = req.tenant as {
      id: string;
      slug: string;
      name: string;
      pwaName?: string;
      pwaShortName?: string;
      pwaThemeColor?: string;
      pwaBackgroundColor?: string;
      pwaIcon192Path?: string;
      pwaIcon512Path?: string;
    } | undefined;

    const appName = tenant?.pwaName || tenant?.name || 'SMART-ERP POS';
    const shortName = tenant?.pwaShortName || tenant?.slug?.toUpperCase() || 'POS';
    const themeColor = tenant?.pwaThemeColor || '#3b82f6';
    const backgroundColor = tenant?.pwaBackgroundColor || '#0f172a';

    // Icons: use tenant-uploaded icons or fall back to defaults
    const icon192 = tenant?.pwaIcon192Path
      ? `/api/tenant/branding/icon/${tenant.id}/192`
      : '/pos-icon-192.png';
    const icon512 = tenant?.pwaIcon512Path
      ? `/api/tenant/branding/icon/${tenant.id}/512`
      : '/pos-icon-512.png';

    const manifest = {
      id: '/',
      name: appName,
      short_name: shortName,
      description: `${appName} - Enterprise Point of Sale System`,
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: backgroundColor,
      theme_color: themeColor,
      icons: [
        { src: icon192, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: icon512, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: icon512, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
      categories: ['business', 'productivity'],
      prefer_related_applications: false,
    };

    res.setHeader('Content-Type', 'application/manifest+json');
    res.setHeader('Cache-Control', 'no-cache');
    res.json(manifest);
  } catch (err) {
    logger.error('Failed to generate manifest', { error: (err as Error).message });
    // Fall back to static defaults
    res.setHeader('Content-Type', 'application/manifest+json');
    res.json({
      id: '/',
      name: 'SMART-ERP POS',
      short_name: 'POS',
      description: 'Enterprise Point of Sale System',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#0f172a',
      theme_color: '#3b82f6',
      icons: [
        { src: '/pos-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/pos-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/pos-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
      categories: ['business', 'productivity'],
      prefer_related_applications: false,
    });
  }
});

// ============================================================
// GET /api/tenant/branding/icon/:tenantId/:size — Serve tenant icon
// Public (no auth) — browser needs this for PWA icons
// ============================================================
router.get('/branding/icon/:tenantId/:size', (req: Request, res: Response) => {
  const { tenantId, size } = req.params;

  if (size !== '192' && size !== '512') {
    res.status(400).json({ success: false, error: 'Invalid icon size. Use 192 or 512.' });
    return;
  }

  // Sanitize tenantId (UUID only)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    res.status(400).json({ success: false, error: 'Invalid tenant ID' });
    return;
  }

  const iconPath = join(process.cwd(), 'uploads', 'branding', tenantId, `icon-${size}.png`);

  if (!existsSync(iconPath)) {
    // Redirect to default icon
    res.redirect(size === '192' ? '/pos-icon-192.png' : '/pos-icon-512.png');
    return;
  }

  res.sendFile(iconPath);
});

// ============================================================
// Logo Upload — multer config for branding icons
// ============================================================
const brandingStorage = multer.diskStorage({
  destination: (req: Request, _file: Express.Multer.File, cb) => {
    const tenantId = (req.tenant as { id: string } | undefined)?.id;
    if (!tenantId) {
      cb(new Error('Tenant not resolved'), '');
      return;
    }
    const uploadDir = join(process.cwd(), 'uploads', 'branding', tenantId);
    mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (_req: Request, _file: Express.Multer.File, cb) => {
    // We'll rename after upload based on size
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `temp-${uniqueSuffix}.png`);
  },
});

const brandingUpload = multer({
  storage: brandingStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max for icons
  fileFilter: (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PNG, JPEG, and SVG are allowed for icons.'));
    }
  },
});

// ============================================================
// PUT /api/tenant/branding — Update PWA branding settings
// Auth required — ADMIN only
// ============================================================
router.put('/branding', authenticate, requirePermission('settings.update'), async (req: Request, res: Response) => {
  try {
    const tenant = req.tenant as { id: string } | undefined;
    if (!tenant) {
      res.status(404).json({ success: false, error: 'Tenant not resolved' });
      return;
    }

    const { pwaName, pwaShortName, pwaThemeColor, pwaBackgroundColor } = req.body as {
      pwaName?: string;
      pwaShortName?: string;
      pwaThemeColor?: string;
      pwaBackgroundColor?: string;
    };

    // Validate color format
    const colorRegex = /^#[0-9a-fA-F]{6}$/;
    if (pwaThemeColor && !colorRegex.test(pwaThemeColor)) {
      res.status(400).json({ success: false, error: 'Invalid theme color format. Use #RRGGBB.' });
      return;
    }
    if (pwaBackgroundColor && !colorRegex.test(pwaBackgroundColor)) {
      res.status(400).json({ success: false, error: 'Invalid background color format. Use #RRGGBB.' });
      return;
    }
    if (pwaShortName && pwaShortName.length > 12) {
      res.status(400).json({ success: false, error: 'Short name must be 12 characters or less.' });
      return;
    }

    const masterPool = connectionManager.getMasterPool();

    const setClauses: string[] = [];
    const params: unknown[] = [tenant.id];
    let idx = 2;

    if (pwaName !== undefined) { setClauses.push(`pwa_name = $${idx++}`); params.push(pwaName); }
    if (pwaShortName !== undefined) { setClauses.push(`pwa_short_name = $${idx++}`); params.push(pwaShortName); }
    if (pwaThemeColor !== undefined) { setClauses.push(`pwa_theme_color = $${idx++}`); params.push(pwaThemeColor); }
    if (pwaBackgroundColor !== undefined) { setClauses.push(`pwa_background_color = $${idx++}`); params.push(pwaBackgroundColor); }

    if (setClauses.length === 0) {
      res.status(400).json({ success: false, error: 'No branding fields provided' });
      return;
    }

    setClauses.push('updated_at = NOW()');

    await masterPool.query(
      `UPDATE tenants SET ${setClauses.join(', ')} WHERE id = $1`,
      params
    );

    // Invalidate cache so manifest reflects changes immediately
    const tenantSlug = (req.tenant as { slug?: string })?.slug;
    invalidateTenantCache(tenant.id, tenantSlug);

    logger.info('Tenant branding updated', { tenantId: tenant.id });
    res.json({ success: true, message: 'Branding updated successfully' });
  } catch (err) {
    logger.error('Failed to update branding', { error: (err as Error).message });
    res.status(500).json({ success: false, error: 'Failed to update branding' });
  }
});

// ============================================================
// POST /api/tenant/branding/icon — Upload PWA icon
// Auth required — ADMIN only
// Accepts a single PNG file, stores as icon-192.png and icon-512.png
// ============================================================
router.post('/branding/icon', authenticate, requirePermission('settings.update'), brandingUpload.single('icon'), async (req: Request, res: Response) => {
  try {
    const tenant = req.tenant as { id: string } | undefined;
    if (!tenant) {
      res.status(404).json({ success: false, error: 'Tenant not resolved' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ success: false, error: 'No icon file provided' });
      return;
    }

    const { renameSync } = await import('fs');
    const tenantDir = join(process.cwd(), 'uploads', 'branding', tenant.id);

    // Save as both 192 and 512 (the browser will resize as needed)
    const icon192Path = join(tenantDir, 'icon-192.png');
    const icon512Path = join(tenantDir, 'icon-512.png');

    // Copy uploaded file to both sizes
    const { copyFileSync } = await import('fs');
    copyFileSync(req.file.path, icon192Path);
    renameSync(req.file.path, icon512Path);

    // Store relative paths in DB (portable across deployments)
    const relIcon192 = `uploads/branding/${tenant.id}/icon-192.png`;
    const relIcon512 = `uploads/branding/${tenant.id}/icon-512.png`;

    // Update tenant record in master DB
    const masterPool = connectionManager.getMasterPool();
    await masterPool.query(
      `UPDATE tenants SET pwa_icon_192_path = $2, pwa_icon_512_path = $3, updated_at = NOW() WHERE id = $1`,
      [tenant.id, relIcon192, relIcon512]
    );

    // Invalidate cache so manifest reflects new icon immediately
    const tenantSlug = (req.tenant as { slug?: string })?.slug;
    invalidateTenantCache(tenant.id, tenantSlug);

    logger.info('Tenant icon uploaded', { tenantId: tenant.id });
    res.json({
      success: true,
      message: 'Icon uploaded successfully',
      data: {
        icon192: `/api/tenant/branding/icon/${tenant.id}/192`,
        icon512: `/api/tenant/branding/icon/${tenant.id}/512`,
      },
    });
  } catch (err) {
    logger.error('Failed to upload icon', { error: (err as Error).message });
    res.status(500).json({ success: false, error: 'Failed to upload icon' });
  }
});

// ============================================================
// GET /api/tenant/branding — Get current branding settings
// Auth required
// ============================================================
router.get('/branding', authenticate, async (req: Request, res: Response) => {
  try {
    const tenant = req.tenant as { id: string } | undefined;
    if (!tenant) {
      res.status(404).json({ success: false, error: 'Tenant not resolved' });
      return;
    }

    const masterPool = connectionManager.getMasterPool();
    const result = await masterPool.query(
      `SELECT pwa_name, pwa_short_name, pwa_theme_color, pwa_background_color,
              pwa_icon_192_path, pwa_icon_512_path, name, slug
       FROM tenants WHERE id = $1`,
      [tenant.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Tenant not found' });
      return;
    }

    const row = result.rows[0];
    res.json({
      success: true,
      data: {
        pwaName: row.pwa_name || row.name,
        pwaShortName: row.pwa_short_name || row.slug?.toUpperCase(),
        pwaThemeColor: row.pwa_theme_color || '#3b82f6',
        pwaBackgroundColor: row.pwa_background_color || '#0f172a',
        hasCustomIcon: !!(row.pwa_icon_192_path || row.pwa_icon_512_path),
        icon192Url: row.pwa_icon_192_path ? `/api/tenant/branding/icon/${tenant.id}/192` : null,
        icon512Url: row.pwa_icon_512_path ? `/api/tenant/branding/icon/${tenant.id}/512` : null,
      },
    });
  } catch (err) {
    logger.error('Failed to get branding', { error: (err as Error).message });
    res.status(500).json({ success: false, error: 'Failed to get branding' });
  }
});

export const tenantConfigRoutes = router;
