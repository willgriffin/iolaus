import { z } from 'zod';
import {
  MATCHING_SOURCE_DESCRIPTION_LIMIT,
  matchingSourceSemanticUnits,
} from '../src/lib/server/matching-source-units.js';

const field = z.enum(['title', 'description', 'location', 'workplace']);
const citation = z.strictObject({
  field,
  text: z.string().min(1).max(800),
  start: z.number().int().nonnegative().optional(),
});
const qualification = z.strictObject({
  slug: z.string().regex(/^[a-z0-9-]{1,100}$/u),
  years: z.number().int().min(1).max(80).optional(),
  context: z.enum(['production', 'professional']).optional(),
});
const group = z.strictObject({
  citation,
  alternatives: z.array(qualification).min(1).max(8),
});
const conceptReview = z.discriminatedUnion('kind', [
  z.strictObject({
    citation,
    kind: z.literal('equivalent'),
    slug: qualification.shape.slug,
  }),
  z.strictObject({
    citation,
    kind: z.enum(['related-only', 'no-fit']),
  }),
]);
const mode = z.enum(['remote', 'hybrid', 'onsite']);
const country = z.string().regex(/^[A-Z]{2}$/u);
const fixtureCase = z.strictObject({
  source: z.strictObject({
    title: z.string().min(1).max(300),
    location: z.string().max(600),
    description: z.string().min(1).max(MATCHING_SOURCE_DESCRIPTION_LIMIT),
    workplaceType: mode.optional(),
  }),
  gold: z.strictObject({
    required: z.array(group).max(60),
    preferred: z.array(group).max(30),
    unresolved: z.array(citation).max(60),
    concepts: z.array(conceptReview).max(60).default([]),
    role: z
      .strictObject({
        family: z.string().min(1).max(100),
        specialty: z.string().min(1).max(100).optional(),
        level: z
          .enum(['entry', 'mid', 'senior', 'staff', 'principal', 'lead'])
          .optional(),
        citation,
      })
      .nullable(),
    geography: z
      .strictObject({
        mode: mode.optional(),
        regions: z
          .array(
            z.strictObject({
              country: country.optional(),
              locality: z.string().min(1).max(100).optional(),
            }),
          )
          .max(25),
        worldwide: z.boolean(),
        citation,
      })
      .nullable(),
  }),
  probes: z
    .array(
      z.strictObject({
        targetRole: z.string().min(1).max(100),
        remoteCountry: country.optional(),
        workMode: mode.optional(),
        conflict: z.boolean(),
      }),
    )
    .min(1)
    .max(4),
});
const benchmarkFixture = z.strictObject({
  version: z.literal(1),
  synthetic: z.array(fixtureCase).min(1).max(12),
  heldOut: z.array(fixtureCase).min(1).max(12),
});

export type BenchmarkFixture = z.infer<typeof benchmarkFixture>;
export type BenchmarkCase = z.infer<typeof fixtureCase>;
export type BenchmarkCitation = z.infer<typeof citation>;

export function expectedSpan(
  source: BenchmarkCase['source'],
  input: BenchmarkCitation,
) {
  const value =
    input.field === 'workplace'
      ? (source.workplaceType ?? '')
      : source[input.field];
  const first = value.indexOf(input.text);
  const start = input.start ?? first;
  const end = start + input.text.length;
  if (
    start < 0 ||
    value.slice(start, end) !== input.text ||
    (input.start === undefined && value.indexOf(input.text, start + 1) !== -1)
  )
    throw new Error('Invalid reviewed citation.');
  return { field: input.field, start, end, text: input.text };
}

export function parseBenchmarkFixture(input: unknown): BenchmarkFixture {
  const checked = benchmarkFixture.safeParse(input);
  if (!checked.success) throw new Error('Invalid benchmark fixture.');
  const distinctSources = new Set<string>();
  for (const { source, gold } of [
    ...checked.data.synthetic,
    ...checked.data.heldOut,
  ]) {
    const units = matchingSourceSemanticUnits(source);
    const key = source.description.trim().replace(/\s+/gu, ' ').toLowerCase();
    if (distinctSources.has(key))
      throw new Error('Duplicate benchmark source.');
    distinctSources.add(key);
    const citations = [
      ...[...gold.required, ...gold.preferred].map(({ citation }) => citation),
      ...gold.unresolved,
      ...(gold.role ? [gold.role.citation] : []),
      ...(gold.geography ? [gold.geography.citation] : []),
    ];
    for (const citation of citations) expectedSpan(source, citation);
    const reviewedConceptSpans = new Set<number>();
    for (const { citation } of gold.concepts) {
      const span = expectedSpan(source, citation);
      if (
        span.field !== 'description' ||
        reviewedConceptSpans.has(span.start) ||
        !units.some(
          (unit) =>
            unit.field === span.field &&
            unit.start === span.start &&
            unit.end === span.end,
        )
      )
        throw new Error('Invalid reviewed concept citation.');
      reviewedConceptSpans.add(span.start);
    }
  }
  return checked.data;
}
