import { createHash } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { z } from 'zod';
import type { Opportunity } from '$lib/objects/Opportunity.js';
import {
  OPPORTUNITY_ANALYSIS_VERSION,
  type OpportunityAnalysisSnapshot,
} from '$lib/opportunity-analysis-contract.js';
import { getDbConfig } from './db.js';
import {
  ANALYSIS_MODEL,
  ANALYSIS_OUTPUT_VERSION,
  ANALYSIS_PROMPT_VERSION,
  enrichOpportunityAnalysis,
} from './opportunity-analysis-enrichment.js';
import {
  deterministicOpportunityAnalysis,
  hasAnalysisPII,
  negatedSkillEvidence,
  sourceText,
  verifiedAnalysisSource,
} from './opportunity-analysis-source.js';
import {
  publishOpportunityAnalysis,
  readCurrentAnalysis,
} from './opportunity-analysis-store.js';
import {
  canonicalSkillSlug,
  refreshSkillVocabularyLookup,
} from './skill-vocabulary.js';
import { getCollection } from './smrt.js';
export type OpportunityAnalysisEnrichment = Pick<
  OpportunityAnalysisSnapshot,
  'skills' | 'requirements' | 'summaryBullets' | 'eligibility'
>;
export interface EnsureOpportunityAnalysisOptions {
  enrich?: boolean;
  budgetMicros?: number;
  windowId?: string;
}
const span = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict();
const bounded = z.string().min(1).max(600);
export const opportunityAnalysisEnrichmentSchema = z
  .object({
    skills: z
      .array(
        z
          .object({
            slug: z.string().min(1).max(100),
            label: z.string().min(1).max(100),
            kind: z.enum(['required', 'preferred']),
            confidence: z.number().min(0).max(1),
            evidence: z
              .array(span.extend({ quote: bounded }))
              .min(1)
              .max(5),
          })
          .strict(),
      )
      .max(100),
    requirements: z
      .array(
        z
          .object({
            hash: z.string().max(100),
            text: bounded,
            kind: z.enum(['must', 'should', 'nice']),
            category: z.enum([
              'skill',
              'experience',
              'education',
              'credential',
              'location',
              'authorization',
              'other',
            ]),
            years: z.number().min(0).max(80).optional(),
            skills: z.array(z.string().max(100)).max(30),
            evidence: z.array(span).min(1).max(5),
          })
          .strict(),
      )
      .max(100),
    summaryBullets: z.array(bounded).max(5),
    eligibility: z
      .object({
        remote: z.boolean().nullable(),
        countries: z.array(z.string().max(80)).max(30),
        regions: z.array(z.string().max(100)).max(30),
        timezones: z.array(z.string().max(80)).max(30),
        flags: z.number().int().nonnegative(),
        workAuthorization: z
          .object({
            required: z.array(z.string().max(100)).max(30),
            sponsorship: z.enum(['yes', 'no', 'unknown']),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
/** All citations refer to exact canonical raw description offsets, never a human overlay. */
export function validateOpportunityAnalysisEnrichment(
  value: OpportunityAnalysisEnrichment,
  description: string,
): OpportunityAnalysisEnrichment {
  const parsed = opportunityAnalysisEnrichmentSchema.parse(value);
  if (
    [
      ...parsed.skills.flatMap((skill) => [
        skill.label,
        ...skill.evidence.map((e) => e.quote),
      ]),
      ...parsed.requirements.map((r) => r.text),
      ...parsed.summaryBullets,
      ...parsed.eligibility.countries,
      ...parsed.eligibility.regions,
      ...parsed.eligibility.timezones,
      ...parsed.eligibility.workAuthorization.required,
    ].some(hasAnalysisPII)
  )
    throw new Error('Analysis contains contact PII.');
  const validateSpan = (e: { start: number; end: number; quote?: string }) => {
    if (
      e.end <= e.start ||
      e.end > description.length ||
      ('quote' in e && description.slice(e.start, e.end) !== e.quote)
    )
      throw new Error('Analysis source evidence does not match.');
  };
  for (const skill of parsed.skills) {
    if (canonicalSkillSlug(skill.slug) !== skill.slug)
      throw new Error('Unknown canonical skill.');
    skill.evidence.forEach(validateSpan);
    if (
      skill.evidence.some((e) =>
        negatedSkillEvidence(description, e.start, e.end),
      )
    )
      throw new Error('Negated skill cannot establish proficiency.');
    if (!skill.evidence.some((e) => canonicalSkillSlug(e.quote) === skill.slug))
      throw new Error('Skill citation does not establish the skill.');
  }
  for (const summary of parsed.summaryBullets)
    if (!description.includes(summary))
      throw new Error('Summary is not grounded in source text.');
  for (const term of [
    ...parsed.eligibility.countries,
    ...parsed.eligibility.regions,
    ...parsed.eligibility.timezones,
    ...parsed.eligibility.workAuthorization.required,
  ])
    if (!description.toLowerCase().includes(term.toLowerCase()))
      throw new Error('Eligibility is not grounded in source text.');
  if (parsed.eligibility.remote === true && !/\bremote\b/i.test(description))
    throw new Error('Remote eligibility is unsupported.');
  if (
    parsed.eligibility.remote === false &&
    !/\b(on[ -]?site|in[ -]?office)\b/i.test(description)
  )
    throw new Error('Onsite eligibility is unsupported.');
  if (
    parsed.eligibility.workAuthorization.sponsorship !== 'unknown' &&
    !/\bsponsor(ship|ing)?\b/i.test(description)
  )
    throw new Error('Sponsorship eligibility is unsupported.');
  parsed.eligibility.flags = 0;
  for (const requirement of parsed.requirements) {
    requirement.evidence.forEach(validateSpan);
    if (
      !requirement.evidence.some(
        (e) => description.slice(e.start, e.end) === requirement.text,
      )
    )
      throw new Error('Requirement is not an exact source quotation.');
    requirement.hash = createHash('sha256')
      .update(
        requirement.text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' '),
      )
      .digest('hex');
    if (
      requirement.skills.some(
        (slug) => !parsed.skills.some((s) => s.slug === slug),
      )
    )
      throw new Error('Requirement references an unsupported skill.');
  }
  return parsed;
}
export function opportunityAnalysisInputFingerprint(
  opportunity: Pick<
    Opportunity,
    'id' | 'sourceContentFingerprint' | 'sourceContentVersion'
  >,
): string {
  return createHash('sha256')
    .update(
      `${opportunity.id}:${opportunity.sourceContentFingerprint}:${opportunity.sourceContentVersion}:${OPPORTUNITY_ANALYSIS_VERSION}`,
    )
    .digest('hex');
}
export async function getCurrentOpportunityAnalysis(
  opportunityId: string,
): Promise<OpportunityAnalysisSnapshot | null> {
  return readCurrentAnalysis(
    await resolveDatabase(getDbConfig()),
    opportunityId,
  );
}
export async function ensureOpportunityAnalysis(
  opportunityId: string,
  options: EnsureOpportunityAnalysisOptions = {},
): Promise<OpportunityAnalysisSnapshot> {
  await refreshSkillVocabularyLookup();
  const opportunities = await getCollection<Opportunity>('Opportunity');
  const opportunity = await opportunities.get(opportunityId);
  if (!opportunity?.id) throw new Error('Opportunity not found.');
  const identity = {
    id: opportunity.id,
    sourceContentJson: opportunity.sourceContentJson,
    sourceContentFingerprint: opportunity.sourceContentFingerprint,
    sourceContentVersion: opportunity.sourceContentVersion,
  };
  const source = verifiedAnalysisSource(identity);
  const db = await resolveDatabase(getDbConfig());
  let current = await readCurrentAnalysis(db, opportunityId);
  if (!current)
    current = await publishOpportunityAnalysis(
      db,
      identity,
      deterministicOpportunityAnalysis(identity),
    );
  if (!options.enrich || !(options.budgetMicros && options.budgetMicros > 0))
    return current;
  if (current.status === 'enriched') {
    const identityRow = (
      await db.query(
        'SELECT model,prompt_version,output_schema_version FROM opportunity_analyses WHERE id=?',
        [current.id],
      )
    ).rows[0];
    if (
      identityRow?.model === ANALYSIS_MODEL &&
      identityRow.prompt_version === ANALYSIS_PROMPT_VERSION &&
      identityRow.output_schema_version === ANALYSIS_OUTPUT_VERSION
    )
      return current;
  }
  try {
    const enriched = await enrichOpportunityAnalysis(
      {
        opportunityId,
        sourceContentFingerprint: identity.sourceContentFingerprint,
        sourceContentVersion: identity.sourceContentVersion,
        title: sourceText(source.title),
        description: sourceText(source.descriptionRaw),
        deterministic: current,
      },
      { budgetMicros: options.budgetMicros, windowId: options.windowId },
    );
    const fields = validateOpportunityAnalysisEnrichment(
      {
        skills: enriched.snapshot.skills,
        requirements: enriched.snapshot.requirements,
        summaryBullets: enriched.snapshot.summaryBullets,
        eligibility: enriched.snapshot.eligibility,
      },
      sourceText(source.descriptionRaw),
    );
    return await publishOpportunityAnalysis(
      db,
      identity,
      {
        ...current,
        ...fields,
        status: 'enriched',
        skillSlugs: fields.skills.map((s) => s.slug).sort(),
      },
      { ...enriched, outputSchemaVersion: ANALYSIS_OUTPUT_VERSION },
    );
  } catch {
    // Provider refusal, malformed output and obsolete workers never mutate the
    // immutable deterministic artifact. A later bounded job may retry.
    const latest = await readCurrentAnalysis(db, opportunityId);
    if (latest) return latest;
    throw new Error(
      'Opportunity source changed during analysis; retry current version.',
    );
  }
}
