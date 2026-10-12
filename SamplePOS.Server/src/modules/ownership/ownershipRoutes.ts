import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requirePermission } from '../../rbac/middleware.js';
import { LEGAL_FORMS } from '../../../../shared/domain/ownershipEquity.js';
import * as ownership from './ownershipService.js';

const router = Router();
router.use(authenticate);

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

router.get(
  '/profile',
  requirePermission('ownership.read'),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await ownership.getProfile(req.tenantPool!) });
  }),
);

router.put(
  '/legal-form',
  requirePermission('ownership.manage'),
  asyncHandler(async (req, res) => {
    const body = z.object({ legalForm: z.enum(LEGAL_FORMS) }).parse(req.body);
    const data = await ownership.changeLegalForm(req.tenantPool!, body.legalForm, req.user!.id);
    res.json({ success: true, data });
  }),
);

router.get(
  '/shareholders',
  requirePermission('ownership.read'),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await ownership.listShareholders(req.tenantPool!) });
  }),
);

router.post(
  '/shareholders',
  requirePermission('ownership.manage'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        legalName: z.string().min(1).max(255),
        userId: z.string().uuid().nullable().optional(),
        customerId: z.string().uuid().nullable().optional(),
      })
      .parse(req.body);
    const data = await ownership.createShareholder(req.tenantPool!, body, req.user!.id);
    res.json({ success: true, data });
  }),
);

router.get(
  '/register',
  requirePermission('ownership.read'),
  asyncHandler(async (req, res) => {
    const asOf = date.parse(req.query.asOf ?? new Date().toISOString().slice(0, 10));
    res.json({ success: true, data: await ownership.listRegister(req.tenantPool!, asOf) });
  }),
);

router.get(
  '/liquidity-accounts',
  requirePermission('ownership.read'),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await ownership.liquidity(req.tenantPool!) });
  }),
);

router.post(
  '/issues',
  requirePermission('ownership.issue'),
  requirePermission('accounting.post'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        shareholderId: z.string().uuid(),
        quantity: z.string().min(1),
        issueDate: date,
        considerationAmount: z.string(),
        considerationAccountCode: z.string().max(20).nullable().optional(),
        reference: z.string().max(200).nullable().optional(),
        idempotencyKey: z.string().min(8).max(200),
      })
      .parse(req.body);
    res.json({ success: true, data: await ownership.issueShares(req.tenantPool!, body, req.user!.id) });
  }),
);

router.post(
  '/issues/:id/cancel',
  requirePermission('ownership.issue'),
  requirePermission('accounting.post'),
  asyncHandler(async (req, res) => {
    const body = z.object({ idempotencyKey: z.string().min(8).max(200) }).parse(req.body);
    res.json({
      success: true,
      data: await ownership.cancelIssue(req.tenantPool!, req.params.id, req.user!.id, body.idempotencyKey),
    });
  }),
);

router.post(
  '/transfers',
  requirePermission('ownership.transfer'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        fromShareholderId: z.string().uuid(),
        toShareholderId: z.string().uuid(),
        quantity: z.string().min(1),
        transferDate: date,
        reference: z.string().max(200).nullable().optional(),
        reason: z.string().max(500).nullable().optional(),
        idempotencyKey: z.string().min(8).max(200),
      })
      .parse(req.body);
    res.json({ success: true, data: await ownership.transferShares(req.tenantPool!, body, req.user!.id) });
  }),
);

router.get(
  '/dividends',
  requirePermission('ownership.read'),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await ownership.listDividends(req.tenantPool!) });
  }),
);

router.post(
  '/dividends',
  requirePermission('ownership.manage'),
  asyncHandler(async (req, res) => {
    const body = z.object({ amount: z.string() }).parse(req.body);
    res.json({ success: true, data: await ownership.proposeDividend(req.tenantPool!, body.amount, req.user!.id) });
  }),
);

router.post(
  '/dividends/:id/approve',
  requirePermission('ownership.dividend_approve'),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await ownership.approveDividend(req.tenantPool!, req.params.id, req.user!.id) });
  }),
);

router.post(
  '/dividends/:id/declare',
  requirePermission('ownership.dividend_approve'),
  requirePermission('accounting.post'),
  asyncHandler(async (req, res) => {
    const body = z.object({ declarationDate: date, idempotencyKey: z.string().min(8).max(200) }).parse(req.body);
    res.json({
      success: true,
      data: await ownership.declareDividend(req.tenantPool!, req.params.id, body.declarationDate, req.user!.id, body.idempotencyKey),
    });
  }),
);

router.post(
  '/dividends/:id/pay',
  requirePermission('ownership.dividend_approve'),
  requirePermission('accounting.post'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        paymentDate: date,
        cashAccountCode: z.string().min(1).max(20),
        idempotencyKey: z.string().min(8).max(200),
      })
      .parse(req.body);
    res.json({
      success: true,
      data: await ownership.payDividend(
        req.tenantPool!,
        req.params.id,
        body.paymentDate,
        body.cashAccountCode,
        req.user!.id,
        body.idempotencyKey,
      ),
    });
  }),
);

router.get(
  '/loans',
  requirePermission('ownership.read'),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await ownership.listLoans(req.tenantPool!) });
  }),
);

router.post(
  '/loans',
  requirePermission('ownership.manage'),
  requirePermission('accounting.post'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        shareholderId: z.string().uuid(),
        amount: z.string(),
        cashAccountCode: z.string().min(1).max(20),
        idempotencyKey: z.string().min(8).max(200),
      })
      .parse(req.body);
    res.json({ success: true, data: await ownership.drawLoan(req.tenantPool!, body, req.user!.id) });
  }),
);

router.post(
  '/loans/:id/repay',
  requirePermission('ownership.manage'),
  requirePermission('accounting.post'),
  asyncHandler(async (req, res) => {
    const body = z.object({ idempotencyKey: z.string().min(8).max(200) }).parse(req.body);
    res.json({ success: true, data: await ownership.repayLoan(req.tenantPool!, req.params.id, req.user!.id, body.idempotencyKey) });
  }),
);

export const ownershipRoutes = router;
