import { z } from 'zod';

const token = z.string().trim().min(1).max(80);
const optionalTokens = z.array(token).max(12).optional().default([]);

/** The complete anonymous input surface. Unknown keys are deliberately rejected. */
export const publicSearchInputSchema = z
  .object({
    q: z.string().trim().max(200).optional().default(''),
    skills: optionalTokens,
    seniority: optionalTokens,
    function: optionalTokens,
    workMode: optionalTokens,
    employmentType: optionalTokens,
    country: optionalTokens,
    company: z.string().trim().max(120).optional(),
    postedSince: z.coerce.date().optional(),
    salaryMin: z.coerce.number().finite().nonnegative().optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
    sort: z
      .enum(['relevance', 'newest', 'salary'])
      .optional()
      .default('relevance'),
  })
  .strict();

export const publicOpportunitySchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    company: z.string().min(1),
    locations: z.array(z.string()),
    workMode: z.string(),
    employmentType: z.string(),
    seniority: z.string(),
    function: z.string(),
    skills: z.array(z.string()).max(30),
    summary: z.array(z.string()).max(5),
    compensation: z
      .object({
        currency: z.string().max(12).optional(),
        min: z.number().finite().nonnegative().optional(),
        max: z.number().finite().nonnegative().optional(),
        period: z.string().max(32).optional(),
      })
      .optional(),
    postedAt: z.string().datetime().nullable(),
    originalUrl: z.string().url(),
  })
  .strict();

export const publicOpportunityDetailSchema = publicOpportunitySchema.extend({
  countries: z.array(z.string()).max(30),
});

export const publicFacetsSchema = z
  .object({
    skills: z.array(
      z.object({ value: z.string(), count: z.number().int().nonnegative() }),
    ),
    seniority: z.array(
      z.object({ value: z.string(), count: z.number().int().nonnegative() }),
    ),
    function: z.array(
      z.object({ value: z.string(), count: z.number().int().nonnegative() }),
    ),
    workMode: z.array(
      z.object({ value: z.string(), count: z.number().int().nonnegative() }),
    ),
    employmentType: z.array(
      z.object({ value: z.string(), count: z.number().int().nonnegative() }),
    ),
    country: z.array(
      z.object({ value: z.string(), count: z.number().int().nonnegative() }),
    ),
  })
  .strict();

export const publicSearchPageSchema = z
  .object({
    items: z.array(publicOpportunitySchema),
    nextCursor: z.string().nullable(),
    facets: publicFacetsSchema,
  })
  .strict();

export type PublicSearchInput = z.infer<typeof publicSearchInputSchema>;
export type PublicOpportunity = z.infer<typeof publicOpportunitySchema>;
export type PublicOpportunityDetail = z.infer<
  typeof publicOpportunityDetailSchema
>;
export type PublicFacets = z.infer<typeof publicFacetsSchema>;
export type PublicSearchPage = z.infer<typeof publicSearchPageSchema>;

/** A small OpenAPI fragment consumed by the generated public document. */
export const publicOpportunityOpenApi = {
  openapi: '3.1.0',
  info: { title: 'Iolaus public opportunity API', version: 'v1' },
  paths: {
    '/api/public/opportunities': {
      get: { operationId: 'searchPublicOpportunities' },
    },
    '/api/public/opportunities/{id}': {
      get: { operationId: 'getPublicOpportunity' },
    },
  },
} as const;
