import { createHash } from 'node:crypto';
import type { Opportunity } from '$lib/objects/Opportunity.js';
import type { OpportunityAnalysis } from '$lib/objects/OpportunityAnalysis.js';
import type { OpportunitySkill } from '$lib/objects/OpportunitySkill.js';
import {
  OPPORTUNITY_ANALYSIS_VERSION,
  type OpportunityAnalysisSkill,
  type OpportunityAnalysisSnapshot,
} from '$lib/opportunity-analysis-contract.js';
import { executeGovernedOpportunityIntelligenceRequest } from './opportunity-intelligence-governance.js';
import { canonicalSkillSlug, skillLabelFromSlug } from './skill-vocabulary.js';
import { getCollection } from './smrt.js';

export type OpportunityAnalysisEnrichment = Pick<
  OpportunityAnalysisSnapshot,
  'skills' | 'requirements' | 'summaryBullets' | 'eligibility'
>;
export type OpportunityAnalysisGateway = (input: {
  opportunityId: string;
  sourceContentFingerprint: string;
  title: string;
  description: string;
}) => Promise<OpportunityAnalysisEnrichment>;
let enrichmentGateway: OpportunityAnalysisGateway | null = null;
/** Test/operator seam. Production wiring must provide a governed gateway. */
export function setOpportunityAnalysisGatewayForTest(
  gateway: OpportunityAnalysisGateway | null,
): void {
  enrichmentGateway = gateway;
}

export interface EnsureOpportunityAnalysisOptions {
  enrich?: boolean;
  budgetMicros?: number;
}
const splitTerms = (value: string) =>
  value
    .split(/[\n,;]/)
    .map((term) => term.trim())
    .filter(Boolean);
const safeJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

function deterministic(opportunity: Opportunity) {
  const skills: OpportunityAnalysisSkill[] = [];
  for (const [value, kind] of [
    [opportunity.requiredSkills, 'required'],
    [opportunity.preferredSkills, 'preferred'],
  ] as const) {
    for (const raw of splitTerms(value)) {
      const slug = canonicalSkillSlug(raw);
      if (
        slug &&
        !skills.some((skill) => skill.slug === slug && skill.kind === kind)
      )
        skills.push({
          slug,
          label: skillLabelFromSlug(slug),
          kind,
          confidence: 1,
          evidence: [],
        });
    }
  }
  const compensation =
    opportunity.currency &&
    (opportunity.salaryMin !== null || opportunity.salaryMax !== null)
      ? {
          currency: opportunity.currency,
          min: opportunity.salaryMin ?? undefined,
          max: opportunity.salaryMax ?? undefined,
          period: 'year',
          source: 'posted' as const,
        }
      : null;
  return {
    skills,
    compensation,
    summary: opportunity.descriptionSummary
      ? [opportunity.descriptionSummary.slice(0, 600)]
      : [],
    countries: [] as string[],
  };
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

function snapshot(row: OpportunityAnalysis): OpportunityAnalysisSnapshot {
  const compensation = safeJson<OpportunityAnalysisSnapshot['compensation']>(
    row.compensationJson,
    null,
  );
  const eligibility = safeJson<Record<string, unknown>>(
    row.eligibilityJson,
    {},
  );
  return {
    id: row.id ?? '',
    opportunityId: row.opportunityId,
    sourceContentFingerprint: row.sourceContentFingerprint,
    sourceContentVersion: row.sourceContentVersion,
    analysisVersion: OPPORTUNITY_ANALYSIS_VERSION,
    status: row.status as OpportunityAnalysisSnapshot['status'],
    normalizedTitle: row.normalizedTitle,
    seniority: row.seniority,
    function: row.function,
    workMode: row.workMode,
    employmentType: row.employmentType,
    skills: safeJson(row.skillsJson, []),
    requirements: safeJson(row.requirementsJson, []),
    skillSlugs: safeJson(row.skillSlugsJson, []),
    summaryBullets: safeJson(row.summaryJson, []),
    eligibility: {
      remote:
        typeof eligibility.remote === 'boolean' ? eligibility.remote : null,
      countries: safeJson(row.countriesJson, []),
      regions: Array.isArray(eligibility.regions)
        ? (eligibility.regions as string[])
        : [],
      timezones: Array.isArray(eligibility.timezones)
        ? (eligibility.timezones as string[])
        : [],
      flags: typeof eligibility.flags === 'number' ? eligibility.flags : 0,
      workAuthorization: {
        required: Array.isArray(
          (eligibility.workAuthorization as Record<string, unknown> | undefined)
            ?.required,
        )
          ? (eligibility.workAuthorization as { required: string[] }).required
          : [],
        sponsorship: ['yes', 'no', 'unknown'].includes(
          String(
            (
              eligibility.workAuthorization as
                | Record<string, unknown>
                | undefined
            )?.sponsorship,
          ),
        )
          ? (String(
              (
                eligibility.workAuthorization as
                  | Record<string, unknown>
                  | undefined
              )?.sponsorship,
            ) as 'yes' | 'no' | 'unknown')
          : 'unknown',
      },
    },
    compensation: compensation?.source === 'posted' ? compensation : null,
    errorCode: row.errorCode || undefined,
  };
}

/** Reject hallucinated source citations before they can enter the shared
 * catalog. Model input contains only source posting fields, never candidates. */
export function validateOpportunityAnalysisEnrichment(
  value: OpportunityAnalysisEnrichment,
  description: string,
): OpportunityAnalysisEnrichment {
  for (const skill of value.skills) {
    for (const evidence of skill.evidence) {
      if (
        !Number.isInteger(evidence.start) ||
        !Number.isInteger(evidence.end) ||
        evidence.start < 0 ||
        evidence.end < evidence.start ||
        evidence.end > description.length
      )
        throw new Error('Opportunity analysis evidence span is out of bounds.');
      if (
        evidence.quote &&
        description.slice(evidence.start, evidence.end) !== evidence.quote
      )
        throw new Error(
          'Opportunity analysis evidence quote does not match source text.',
        );
    }
  }
  return value;
}

/** Return the current source-version analysis without invoking a provider. */
export async function getCurrentOpportunityAnalysis(
  opportunityId: string,
): Promise<OpportunityAnalysisSnapshot | null> {
  const opportunities = await getCollection<Opportunity>('Opportunity');
  const opportunity = await opportunities.get(opportunityId);
  if (!opportunity) return null;
  const analyses = await getCollection<OpportunityAnalysis>(
    'OpportunityAnalysis',
  );
  const [current] = await analyses.list({
    limit: 1,
    where: {
      opportunityId,
      sourceContentFingerprint: opportunity.sourceContentFingerprint,
      analysisVersion: OPPORTUNITY_ANALYSIS_VERSION,
    },
  });
  return current ? snapshot(current) : null;
}

/** Deterministically materialize the artifact once for the current source version.
 * Enrichment is intentionally not invoked until the governed provider adapter is wired. */
export async function ensureOpportunityAnalysis(
  opportunityId: string,
  options: EnsureOpportunityAnalysisOptions = {},
): Promise<OpportunityAnalysisSnapshot> {
  const existing = await getCurrentOpportunityAnalysis(opportunityId);
  if (existing) return existing;
  const opportunities = await getCollection<Opportunity>('Opportunity');
  const opportunity = await opportunities.get(opportunityId);
  if (!opportunity)
    throw new Error(`Opportunity ${opportunityId} was not found.`);
  if (!opportunity.sourceContentFingerprint)
    throw new Error(
      `Opportunity ${opportunityId} has no source content fingerprint.`,
    );
  const analysis = deterministic(opportunity);
  const analyses = await getCollection<OpportunityAnalysis>(
    'OpportunityAnalysis',
  );
  const created = await analyses.create({
    opportunityId,
    sourceContentFingerprint: opportunity.sourceContentFingerprint,
    sourceContentVersion: opportunity.sourceContentVersion,
    analysisVersion: OPPORTUNITY_ANALYSIS_VERSION,
    status: 'deterministic',
    normalizedTitle: opportunity.title.trim(),
    seniority: opportunity.seniority,
    function: 'unknown',
    workMode: opportunity.workMode,
    employmentType: opportunity.employmentType,
    skillsJson: JSON.stringify(analysis.skills),
    requirementsJson: '[]',
    eligibilityJson: opportunity.postingEligibilityJson || '{}',
    compensationJson: JSON.stringify(analysis.compensation ?? {}),
    summaryJson: JSON.stringify(analysis.summary),
    countriesJson: JSON.stringify(analysis.countries),
    skillSlugsJson: JSON.stringify(
      analysis.skills.map((skill) => skill.slug).sort(),
    ),
    errorCode:
      options.enrich && (options.budgetMicros ?? 0) <= 0
        ? 'enrichment_budget_required'
        : '',
  });
  const opportunitySkills =
    await getCollection<OpportunitySkill>('OpportunitySkill');
  if (!created.id) throw new Error('Created opportunity analysis has no id.');
  const analysisId = created.id;
  await Promise.all(
    analysis.skills.map((skill) =>
      opportunitySkills.create({
        opportunityId,
        analysisId,
        skillSlug: skill.slug,
        kind: skill.kind,
        confidence: skill.confidence,
      }),
    ),
  );
  // Do not publish an analysis against a posting version that changed while
  // it was being materialized. A later ensure call will create the new row.
  const latest = await opportunities.get(opportunityId);
  if (
    latest &&
    latest.sourceContentFingerprint === opportunity.sourceContentFingerprint &&
    latest.sourceContentVersion === opportunity.sourceContentVersion
  ) {
    latest.currentAnalysisId = analysisId;
    await latest.save();
  }
  if (
    options.enrich &&
    options.budgetMicros &&
    options.budgetMicros > 0 &&
    enrichmentGateway
  ) {
    try {
      const gateway = enrichmentGateway;
      if (!gateway)
        throw new Error(
          'Opportunity analysis enrichment gateway is unavailable.',
        );
      const sourceInput = `${opportunity.title}\n${opportunity.descriptionRaw}`;
      const estimatedInputTokens = Math.max(
        1,
        Math.ceil(sourceInput.length / 4),
      );
      // The governance ledger owns retries, idempotency and circuit/provider
      // limits. The gateway is injected only to keep unit tests token-free.
      const governed =
        await executeGovernedOpportunityIntelligenceRequest<OpportunityAnalysisEnrichment>(
          {
            estimatedInputTokens,
            inputTokenCeiling: Math.min(30_000, estimatedInputTokens),
            maxOutputTokens: 4_000,
            identity: {
              agentRunId: 'opportunity-analysis',
              opportunityId,
              contentFingerprint: opportunity.sourceContentFingerprint,
              inputFingerprint:
                opportunityAnalysisInputFingerprint(opportunity),
              feature: 'opportunity-analysis',
              profile: 'opportunity-intelligence-extraction',
              model: 'openai/gpt-6-luna',
              promptVersion: OPPORTUNITY_ANALYSIS_VERSION,
              outputSchemaVersion: OPPORTUNITY_ANALYSIS_VERSION,
              preparedPayloadVersion: OPPORTUNITY_ANALYSIS_VERSION,
            },
            invoke: async () => ({
              output: await gateway({
                opportunityId,
                sourceContentFingerprint: opportunity.sourceContentFingerprint,
                title: opportunity.title,
                description: opportunity.descriptionRaw,
              }),
            }),
          },
        );
      const enriched = validateOpportunityAnalysisEnrichment(
        governed.output,
        opportunity.descriptionRaw,
      );
      created.status = 'enriched';
      created.skillsJson = JSON.stringify(enriched.skills);
      created.requirementsJson = JSON.stringify(enriched.requirements);
      created.summaryJson = JSON.stringify(enriched.summaryBullets.slice(0, 5));
      created.eligibilityJson = JSON.stringify(enriched.eligibility);
      created.requestId = governed.requestId;
      created.skillSlugsJson = JSON.stringify(
        enriched.skills.map((skill) => skill.slug).sort(),
      );
      await created.save();
    } catch (cause) {
      // Deterministic analysis remains current and searchable after any model
      // failure; the scheduled backfill may retry this version later.
      created.errorCode =
        cause instanceof Error
          ? 'enrichment_failed'
          : 'enrichment_unknown_failure';
      await created.save();
    }
  }
  return snapshot(created);
}
