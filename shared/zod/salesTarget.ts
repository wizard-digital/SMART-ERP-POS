import { z } from 'zod';

export const SalesTargetStatusSchema = z.enum([
  'DRAFT',
  'PENDING_APPROVAL',
  'ACTIVE',
  'CLOSED',
  'CANCELLED',
]);

export const SalesTargetPeriodTypeSchema = z.enum([
  'WEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'YEARLY',
  'CUSTOM',
]);

export const SalesTargetScopeSchema = z.enum(['INDIVIDUAL', 'GENERAL', 'TEAM']);

const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

export const CreateSalesTargetSchema = z
  .object({
    scope: SalesTargetScopeSchema.default('INDIVIDUAL'),
    salespersonId: z.string().uuid().optional().nullable(),
    teamId: z.string().uuid().optional().nullable(),
    periodType: SalesTargetPeriodTypeSchema,
    periodStart: DateOnlySchema,
    periodEnd: DateOnlySchema,
    targetAmount: z.number().positive().finite(),
    notes: z.string().max(2000).optional().nullable(),
    submit: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.periodEnd < v.periodStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'periodEnd must be on or after periodStart',
        path: ['periodEnd'],
      });
    }
    const scope = v.scope ?? 'INDIVIDUAL';
    if (scope === 'INDIVIDUAL' && !v.salespersonId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'salespersonId required for INDIVIDUAL scope',
        path: ['salespersonId'],
      });
    }
    if (scope === 'TEAM' && !v.teamId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'teamId required for TEAM scope',
        path: ['teamId'],
      });
    }
    if (scope === 'GENERAL' && (v.salespersonId || v.teamId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'GENERAL scope must not set salespersonId or teamId',
        path: ['scope'],
      });
    }
  });

export const UpdateDraftSalesTargetSchema = z
  .object({
    salespersonId: z.string().uuid().optional().nullable(),
    teamId: z.string().uuid().optional().nullable(),
    periodType: SalesTargetPeriodTypeSchema.optional(),
    periodStart: DateOnlySchema.optional(),
    periodEnd: DateOnlySchema.optional(),
    targetAmount: z.number().positive().finite().optional(),
    notes: z.string().max(2000).optional().nullable(),
    rowVersion: z.number().int().positive(),
  })
  .strict()
  .refine(
    (v) =>
      v.periodStart === undefined ||
      v.periodEnd === undefined ||
      v.periodEnd >= v.periodStart,
    {
      message: 'periodEnd must be on or after periodStart',
      path: ['periodEnd'],
    },
  );

export const AmendSalesTargetSchema = z
  .object({
    targetAmount: z.number().positive().finite(),
    periodStart: DateOnlySchema.optional(),
    periodEnd: DateOnlySchema.optional(),
    amendmentReason: z.string().trim().min(3).max(2000),
    rowVersion: z.number().int().positive(),
  })
  .strict()
  .refine(
    (v) =>
      v.periodStart === undefined ||
      v.periodEnd === undefined ||
      v.periodEnd >= v.periodStart,
    {
      message: 'periodEnd must be on or after periodStart',
      path: ['periodEnd'],
    },
  );

export const CancelSalesTargetSchema = z
  .object({
    reason: z.string().trim().min(3).max(2000),
    rowVersion: z.number().int().positive(),
  })
  .strict();

export const RowVersionSchema = z
  .object({
    rowVersion: z.number().int().positive(),
  })
  .strict();

export const ListSalesTargetsQuerySchema = z.object({
  status: SalesTargetStatusSchema.optional(),
  scope: SalesTargetScopeSchema.optional(),
  salespersonId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
  periodStart: DateOnlySchema.optional(),
  periodEnd: DateOnlySchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const CreateSalesTargetTeamSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    memberIds: z.array(z.string().uuid()).min(1).max(200),
  })
  .strict();

export const UpdateSalesTargetTeamSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    memberIds: z.array(z.string().uuid()).min(1).max(200).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type CreateSalesTargetInput = z.infer<typeof CreateSalesTargetSchema>;
export type UpdateDraftSalesTargetInput = z.infer<typeof UpdateDraftSalesTargetSchema>;
export type AmendSalesTargetInput = z.infer<typeof AmendSalesTargetSchema>;
export type CancelSalesTargetInput = z.infer<typeof CancelSalesTargetSchema>;
export type ListSalesTargetsQuery = z.infer<typeof ListSalesTargetsQuerySchema>;
export type CreateSalesTargetTeamInput = z.infer<typeof CreateSalesTargetTeamSchema>;
export type UpdateSalesTargetTeamInput = z.infer<typeof UpdateSalesTargetTeamSchema>;
