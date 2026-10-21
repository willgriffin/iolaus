import { z } from 'zod';
import { publicOpportunitySchema } from './public-opportunity-contract.js';

export const SHORTLIST_LIMIT = 500;
export const SHORTLIST_STORAGE_KEY = 'iolaus:shortlist:v1';
export const shortlistDecisionSchema = z.enum([
  'seen',
  'later',
  'saved',
  'passed',
]);
const timestamp = z.string().datetime();
export const shortlistEntrySchema = z
  .object({
    opportunity: publicOpportunitySchema,
    decision: shortlistDecisionSchema,
    firstSeenAt: timestamp,
    updatedAt: timestamp,
    openedAt: timestamp.nullable(),
    appliedAt: timestamp.nullable(),
    revision: z.number().int().nonnegative(),
    available: z.boolean().optional(),
  })
  .strict();
export const shortlistMutationSchema = z
  .object({
    mutationId: z.string().uuid(),
    opportunityId: z.string().min(1).max(128),
    expectedRevision: z.number().int().nonnegative(),
    decision: shortlistDecisionSchema.optional(),
    opened: z.boolean().optional(),
    applied: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.decision !== undefined ||
      value.opened !== undefined ||
      value.applied !== undefined,
    'A change is required',
  );
export const shortlistImportSchema = z
  .object({
    entries: z.array(shortlistEntrySchema).max(SHORTLIST_LIMIT),
  })
  .strict();
export const shortlistListSchema = z
  .object({
    entries: z.array(shortlistEntrySchema).max(SHORTLIST_LIMIT),
  })
  .strict();
export const shortlistImportResultSchema = shortlistListSchema.extend({
  acknowledgedIds: z.array(z.string().min(1).max(128)).max(SHORTLIST_LIMIT),
});
export const shortlistStorageSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(shortlistEntrySchema).max(SHORTLIST_LIMIT),
  })
  .strict();
export type ShortlistDecision = z.infer<typeof shortlistDecisionSchema>;
export type ShortlistEntry = z.infer<typeof shortlistEntrySchema>;
export type ShortlistMutation = z.infer<typeof shortlistMutationSchema>;
export type ShortlistChange = Pick<
  ShortlistMutation,
  'decision' | 'opened' | 'applied'
>;
