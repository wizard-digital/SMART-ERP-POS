// User Controller - HTTP request handlers

import type { Request, Response } from 'express';
import { pool as globalPool } from '../../db/pool.js';
import * as userService from './userService.js';
import { CreateUserSchema, UpdateUserSchema, ChangePasswordSchema, AdminResetPasswordSchema } from '../../../../shared/zod/user.js';
import { asyncHandler, NotFoundError, ValidationError, ConflictError, UnauthorizedError } from '../../middleware/errorHandler.js';

/** Map service-layer error messages to appropriate AppError subclasses */
function mapServiceError(error: unknown): never {
  if (!(error instanceof Error)) throw error;
  switch (error.message) {
    case 'User not found': throw new NotFoundError('User');
    case 'Email already in use': throw new ConflictError('Email already in use');
    case 'Current password is incorrect': throw new UnauthorizedError('Current password is incorrect');
    case 'Cannot delete your own account': throw new ValidationError('Cannot delete your own account');
    default: throw error;
  }
}

/**
 * GET /api/users
 */
export const getAllUsers = asyncHandler(async (req: Request, res: Response) => {
  const pool = req.tenantPool || globalPool;
  const users = await userService.getAllUsers(pool);
  res.json({ success: true, data: users });
});

/**
 * GET /api/users/:id
 */
export const getUserById = asyncHandler(async (req: Request, res: Response) => {
  const pool = req.tenantPool || globalPool;
  try {
    const user = await userService.getUserById(pool, req.params.id);
    res.json({ success: true, data: user });
  } catch (error) {
    mapServiceError(error);
  }
});

/**
 * POST /api/users
 */
export const createUser = asyncHandler(async (req: Request, res: Response) => {
  const pool = req.tenantPool || globalPool;
  const data = CreateUserSchema.parse(req.body);
  try {
    const user = await userService.createUser(pool, data, req.user?.id);
    res.status(201).json({ success: true, data: user });
  } catch (error) {
    mapServiceError(error);
  }
});

/**
 * PUT /api/users/:id
 */
export const updateUser = asyncHandler(async (req: Request, res: Response) => {
  const pool = req.tenantPool || globalPool;
  const data = UpdateUserSchema.parse(req.body);
  try {
    const user = await userService.updateUser(pool, req.params.id, data);
    res.json({ success: true, data: user });
  } catch (error) {
    mapServiceError(error);
  }
});

/**
 * POST /api/users/:id/change-password
 */
export const changePassword = asyncHandler(async (req: Request, res: Response) => {
  const pool = req.tenantPool || globalPool;
  const data = ChangePasswordSchema.parse(req.body);
  try {
    await userService.changePassword(pool, req.params.id, data);
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    mapServiceError(error);
  }
});

/**
 * POST /api/users/:id/reset-password (admin only, no current password required)
 */
export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const pool = req.tenantPool || globalPool;
  const data = AdminResetPasswordSchema.parse(req.body);
  try {
    await userService.adminResetPassword(pool, req.params.id, data);
    res.json({ success: true, message: 'Password reset successfully' });
  } catch (error) {
    mapServiceError(error);
  }
});

/**
 * DELETE /api/users/:id?permanent=true
 */
export const deleteUser = asyncHandler(async (req: Request, res: Response) => {
  const pool = req.tenantPool || globalPool;
  const { id } = req.params;
  const hardDelete = req.query.permanent === 'true';

  if (req.user?.id === id) {
    throw new ValidationError('Cannot delete your own account');
  }

  try {
    const result = await userService.deleteUser(pool, id, hardDelete, req.user?.id);
    res.json({ success: true, message: result.message, permanentlyDeleted: result.deleted });
  } catch (error) {
    mapServiceError(error);
  }
});

/**
 * GET /api/users/stats
 */
export const getUserStats = asyncHandler(async (req: Request, res: Response) => {
  const pool = req.tenantPool || globalPool;
  const stats = await userService.getUserStats(pool);
  res.json({ success: true, data: stats });
});
