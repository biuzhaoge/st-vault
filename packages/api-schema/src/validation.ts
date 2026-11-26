import { z } from 'zod';

export const accountSyncConfigSchema = z
  .object({
    cookiesText: z.string().min(1).max(65536),
    origin: z.string().url().max(2048).optional(),
  })
  .strict();
export type AccountSyncConfig = z.infer<typeof accountSyncConfigSchema>;
export const policySchema = z
  .object({ monitorEnabled: z.boolean().optional(), autoRecord: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
export const subjectIdSchema = z
  .string()
  .regex(/^stripchat:[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value.slice('stripchat:'.length))));
export const playbackSchema = z
  .object({
    subjectId: subjectIdSchema,
    targetUtcMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    gapPolicy: z.enum(['report', 'next', 'previous', 'next-or-previous']).default('report'),
    fromMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    toMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    openUnitId: z.string().uuid().optional(),
    unitId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.fromMs === undefined && value.toMs === undefined) ||
      (value.fromMs !== undefined &&
        value.toMs !== undefined &&
        value.toMs > value.fromMs &&
        value.targetUtcMs >= value.fromMs &&
        value.targetUtcMs < value.toMs),
  );
export const timelineSchema = z
  .object({
    from: z.coerce.number().int().nonnegative(),
    to: z.coerce.number().int().positive(),
    limit: z.coerce.number().int().min(1).max(2000).default(1000),
  })
  .refine((v) => v.to > v.from && v.to - v.from <= 9 * 86400000);
