import { z } from 'zod';
import { publicProfileSnapshotSchema } from './public-profile-contract';

/** API versioning is independent of the persisted snapshot's version. */
export const publicProfileApiSchema = z
  .object({
    apiVersion: z.literal(1),
    handle: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u),
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
    revisionCreatedAt: z.iso.datetime(),
    links: z
      .object({
        profile: z.string().regex(/^\/people\/[a-z][a-z0-9-]{2,62}$/u),
        pdf: z.string().regex(/^\/people\/[a-z][a-z0-9-]{2,62}\/resume\.pdf$/u),
      })
      .strict(),
    profile: publicProfileSnapshotSchema.omit({ version: true }),
  })
  .strict();

export const publicProfileApiErrorSchema = z
  .object({
    apiVersion: z.literal(1),
    error: z
      .object({
        code: z.enum(['PROFILE_UNAVAILABLE', 'PROFILE_SERVICE_UNAVAILABLE']),
        message: z.string(),
      })
      .strict(),
  })
  .strict();
export type PublicProfileApiV1 = z.infer<typeof publicProfileApiSchema>;
