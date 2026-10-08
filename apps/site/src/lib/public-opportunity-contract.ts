import { z } from 'zod';

const token = z.string().trim().min(1).max(80);
const tokens = z.array(token).max(50).default([]);
/** Shared path/tool input for a single catalog opportunity. */
export const publicOpportunityInputSchema = z
  .object({ id: z.string().min(1).max(128) })
  .strict();
export const publicSearchInputSchema = z
  .object({
    q: z
      .string()
      .trim()
      .max(200)
      .refine(
        (v) => v.split(/\s+/u).filter(Boolean).length <= 8,
        'At most eight search terms',
      )
      .default(''),
    skills: tokens,
    seniority: tokens,
    function: tokens,
    work_mode: tokens,
    employment_type: tokens,
    country: tokens,
    remote_ok: z.boolean().optional(),
    company: token.optional(),
    source: token.optional(),
    posted_since: z.string().datetime().optional(),
    salary_min: z.coerce.number().finite().nonnegative().optional(),
    salary_currency: z
      .string()
      .regex(/^[A-Z]{3}$/u)
      .optional(),
    salary_period: z.enum(['hour', 'day', 'week', 'month', 'year']).optional(),
    cursor: z.string().max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    sort: z.enum(['relevance', 'newest', 'salary']).default('relevance'),
  })
  .strict()
  .refine(
    (v) =>
      (v.salary_min === undefined && v.sort !== 'salary') ||
      Boolean(v.salary_currency && v.salary_period),
    'Salary filters and sorting require currency and period',
  );
const skill = z.object({ slug: token, label: z.string().max(120) });
const seniority = z.enum([
  'intern',
  'junior',
  'mid',
  'senior',
  'staff',
  'principal',
  'manager',
  'director',
  'exec',
  'unknown',
]);
const compensation = z
  .object({
    currency: z.string(),
    min: z.number().finite().nonnegative().nullable(),
    max: z.number().finite().nonnegative().nullable(),
    period: z.string(),
    equity: z.boolean().nullable(),
    source: z.literal('posted'),
  })
  .nullable();
export const publicOpportunitySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  normalized_title: z.string(),
  company: z
    .object({ id: z.string(), name: z.string(), slug: z.string() })
    .nullable(),
  location: z.object({
    text: z.string(),
    countries: z.array(z.string()),
    remote: z.boolean().nullable(),
    timezones: z.array(z.string()),
  }),
  seniority,
  function: z.string(),
  employment_type: z.string(),
  work_mode: z.string(),
  skills: z.object({
    required: z.array(skill).max(100),
    preferred: z.array(skill).max(100),
  }),
  compensation,
  posted_at: z.string().datetime().nullable(),
  updated_at: z.string(),
  expires_at: z.string().datetime().nullable(),
  analysis_version: z.string(),
  source_content_version: z.number().int().nonnegative(),
  posting_url: z.string().url(),
  url: z.string(),
});
const requirement = z.object({
  hash: z.string(),
  text: z.string(),
  kind: z.enum(['must', 'should', 'nice']),
  category: z.string(),
  years: z.number().nonnegative().optional(),
  skills: z.array(z.string()),
});
export const publicOpportunityDetailSchema = publicOpportunitySchema.extend({
  summary_bullets: z.array(z.string()).max(5),
  requirements: z.array(requirement).max(100),
  eligibility: z.object({
    remote: z.boolean().nullable(),
    countries: z.array(z.string()),
    regions: z.array(z.string()),
    timezones: z.array(z.string()),
    flags: z.number().int(),
    workAuthorization: z.object({
      required: z.array(z.string()),
      sponsorship: z.enum(['yes', 'no', 'unknown']),
    }),
  }),
});
const facet = z.array(
  z.object({
    value: z.string(),
    label: z.string(),
    count: z.number().int().nonnegative(),
  }),
);
export const publicFacetsSchema = z.object({
  skills: facet,
  seniority: facet,
  function: facet,
  work_mode: facet,
  employment_type: facet,
  country: facet,
});
export const publicSearchPageSchema = z.object({
  items: z.array(publicOpportunitySchema),
  next_cursor: z.string().nullable(),
  total_estimate: z.number().int().nonnegative(),
  facets: publicFacetsSchema,
});
export const publicMatchInputSchema = z
  .object({
    skills: z.array(token).max(100),
    seniority: seniority.optional(),
    countries: z.array(token).max(50).optional(),
    remote_ok: z.boolean().optional(),
    years: z.number().finite().nonnegative().max(100).optional(),
    opportunity_ids: z.array(token).max(500).optional(),
  })
  .strict();
export const publicMatchResultSchema = z.object({
  items: z.array(
    z.object({
      opportunity: publicOpportunitySchema,
      score: z.number(),
      matched_skills: z.array(z.string()),
      missing_skills: z.array(z.string()),
      eligibility_notes: z.array(z.string()),
      requirements: z.array(
        z.object({
          hash: z.string(),
          decision: z.enum(['meets', 'partial', 'no', 'unknown']),
          confidence: z.number(),
          submitted_skill_indices: z.array(z.number().int()),
        }),
      ),
    }),
  ),
  model_calls: z.literal(0),
});
export type PublicSearchInput = z.infer<typeof publicSearchInputSchema>;
export type PublicOpportunity = z.infer<typeof publicOpportunitySchema>;
export type PublicOpportunitySummary = PublicOpportunity;
export type PublicOpportunityDetail = z.infer<
  typeof publicOpportunityDetailSchema
>;
export type PublicFacets = z.infer<typeof publicFacetsSchema>;
export type PublicSearchPage = z.infer<typeof publicSearchPageSchema>;
export type PublicMatchInput = z.infer<typeof publicMatchInputSchema>;
export type PublicMatchResult = z.infer<typeof publicMatchResultSchema>;
const queryParameters = Object.entries(
  z.toJSONSchema(publicSearchInputSchema).properties ?? {},
).map(([name, schema]) => ({ name, in: 'query', required: false, schema }));
export const publicOpportunityOpenApi = {
  openapi: '3.1.0',
  info: { title: 'Iolaus public opportunity API', version: 'v1' },
  paths: {
    '/api/public/v1/opportunities': {
      get: {
        operationId: 'searchPublicOpportunities',
        parameters: queryParameters,
        responses: {
          200: {
            description: 'Public catalog',
            content: {
              'application/json': {
                schema: z.toJSONSchema(publicSearchPageSchema),
              },
            },
          },
        },
      },
    },
    '/api/public/v1/opportunities/{id}': {
      get: {
        operationId: 'getPublicOpportunity',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: z.toJSONSchema(publicOpportunityInputSchema, {
              io: 'input',
            }).properties?.id,
          },
        ],
        responses: {
          200: {
            description: 'Public posting',
            content: {
              'application/json': {
                schema: z.toJSONSchema(publicOpportunityDetailSchema),
              },
            },
          },
        },
      },
    },
    '/api/public/v1/facets': {
      get: {
        operationId: 'listPublicFacets',
        parameters: queryParameters,
        responses: {
          200: {
            description: 'Public facets',
            content: {
              'application/json': {
                schema: z.toJSONSchema(publicFacetsSchema),
              },
            },
          },
        },
      },
    },
    '/api/public/v1/match': {
      post: {
        operationId: 'matchPublicSkills',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: z.toJSONSchema(publicMatchInputSchema),
            },
          },
        },
        responses: {
          200: {
            description: 'Stateless public coverage',
            content: {
              'application/json': {
                schema: z.toJSONSchema(publicMatchResultSchema),
              },
            },
          },
        },
      },
    },
  },
};
