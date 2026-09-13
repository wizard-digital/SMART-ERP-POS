import type { Request, Response } from 'express';
import { z } from 'zod';
import { pool as globalPool } from '../../db/pool.js';
import { asyncHandler, ValidationError } from '../../middleware/errorHandler.js';
import * as notificationService from './notificationService.js';

const poolOf = (req: Request) => req.tenantPool || globalPool;
const userIdOf = (req: Request) => req.user!.id;
const tenantIdOf = (req: Request) => req.tenantId || req.user?.tenantId || null;

const PreferenceItemSchema = z.object({
  typeKey: z.string().min(1),
  inAppEnabled: z.boolean(),
  pushEnabled: z.boolean(),
});

const PolicyItemSchema = z.object({
  typeKey: z.string().min(1),
  isAllowed: z.boolean(),
  lockScreenDetail: z.boolean().optional(),
});

const SubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  clientInstallationId: z.string().min(8).max(64),
  platformHint: z.string().max(32).optional(),
  browserHint: z.string().max(64).optional().nullable(),
  displayName: z.string().max(120).optional().nullable(),
  permissionState: z.enum(['granted', 'denied', 'prompt']).optional(),
});

const DevicePatchSchema = z.object({
  pushEnabled: z.boolean().optional(),
  typeKeys: z
    .array(z.object({ typeKey: z.string().min(1), pushEnabled: z.boolean() }))
    .optional(),
});

export const getCatalog = asyncHandler(async (req: Request, res: Response) => {
  const data = await notificationService.getCatalog(poolOf(req));
  res.json({ success: true, data });
});

export const getPreferences = asyncHandler(async (req: Request, res: Response) => {
  const data = await notificationService.getPreferences(poolOf(req), userIdOf(req));
  res.json({ success: true, data });
});

export const putPreferences = asyncHandler(async (req: Request, res: Response) => {
  const parsed = z.object({ items: z.array(PreferenceItemSchema).min(1) }).safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid preference payload');
  const data = await notificationService.updatePreferences(poolOf(req), userIdOf(req), parsed.data.items);
  res.json({ success: true, data });
});

export const getInbox = asyncHandler(async (req: Request, res: Response) => {
  const unreadOnly = req.query.unreadOnly === 'true';
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  const offset = req.query.offset ? Number(req.query.offset) : 0;
  const data = await notificationService.listNotifications(poolOf(req), userIdOf(req), {
    unreadOnly,
    limit: Number.isFinite(limit) ? limit : 50,
    offset: Number.isFinite(offset) ? offset : 0,
  });
  res.json({ success: true, data });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const id = z.string().uuid().parse(req.params.id);
  const data = await notificationService.getNotification(poolOf(req), userIdOf(req), id);
  res.json({ success: true, data });
});

export const markRead = asyncHandler(async (req: Request, res: Response) => {
  const id = z.string().uuid().parse(req.params.id);
  const data = await notificationService.markNotificationRead(poolOf(req), userIdOf(req), id);
  res.json({ success: true, data });
});

export const markAllRead = asyncHandler(async (req: Request, res: Response) => {
  const data = await notificationService.markAllNotificationsRead(poolOf(req), userIdOf(req));
  res.json({ success: true, data });
});

export const unreadCount = asyncHandler(async (req: Request, res: Response) => {
  const data = await notificationService.getUnreadCount(poolOf(req), userIdOf(req));
  res.json({ success: true, data });
});

export const listDevices = asyncHandler(async (req: Request, res: Response) => {
  const data = await notificationService.listDevices(poolOf(req), userIdOf(req));
  res.json({ success: true, data });
});

export const subscribeDevice = asyncHandler(async (req: Request, res: Response) => {
  const parsed = SubscribeSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid push subscription');
  const data = await notificationService.registerDevice(poolOf(req), userIdOf(req), {
    endpoint: parsed.data.endpoint,
    p256dh: parsed.data.keys.p256dh,
    auth: parsed.data.keys.auth,
    clientInstallationId: parsed.data.clientInstallationId,
    platformHint: parsed.data.platformHint,
    browserHint: parsed.data.browserHint,
    displayName: parsed.data.displayName,
    permissionState: parsed.data.permissionState,
  });
  res.status(201).json({ success: true, data });
});

export const patchDevice = asyncHandler(async (req: Request, res: Response) => {
  const id = z.string().uuid().parse(req.params.id);
  const parsed = DevicePatchSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid device update');
  const data = await notificationService.updateDevice(poolOf(req), userIdOf(req), id, parsed.data);
  res.json({ success: true, data });
});

export const unsubscribeDevice = asyncHandler(async (req: Request, res: Response) => {
  const id = z.string().uuid().parse(req.params.id);
  const data = await notificationService.removeDevice(poolOf(req), userIdOf(req), id);
  res.json({ success: true, data });
});

export const sendTest = asyncHandler(async (req: Request, res: Response) => {
  const data = await notificationService.sendTestNotification(poolOf(req), userIdOf(req), tenantIdOf(req));
  res.json({ success: true, data });
});

export const getAdminPolicy = asyncHandler(async (req: Request, res: Response) => {
  const data = await notificationService.getAdminPolicy(poolOf(req));
  res.json({ success: true, data });
});

export const putAdminPolicy = asyncHandler(async (req: Request, res: Response) => {
  const parsed = z.object({ items: z.array(PolicyItemSchema).min(1) }).safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid tenant policy payload');
  const data = await notificationService.updateAdminPolicy(poolOf(req), userIdOf(req), parsed.data.items);
  res.json({ success: true, data });
});
