import { readCurrentOpportunityVideoRequirementsEvidence } from './opportunity-requirement-coverage-provider.js';
import {
  OPPORTUNITY_VIDEO_REQUIREMENTS_VERSION,
  type OpportunityVideoRequirements,
} from './opportunity-video-requirements.js';

/**
 * The aggregate source-evidence reader supplies this only after it replays the
 * actual succeeded GLOBAL composite request. This projection never parses an
 * arbitrary browser or cached payload.
 */
export interface CurrentOpportunityVideoRequirementsReceipt {
  compositeInputFingerprint: string;
  requestId: string;
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  videoRequirements: OpportunityVideoRequirements;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isCurrentReceipt(
  value: unknown,
): value is CurrentOpportunityVideoRequirementsReceipt {
  const candidate = record(value);
  const videoRequirements = record(candidate?.videoRequirements);
  return Boolean(
    candidate &&
      videoRequirements &&
      typeof candidate.requestId === 'string' &&
      typeof candidate.compositeInputFingerprint === 'string' &&
      typeof candidate.sourceContentFingerprint === 'string' &&
      Number.isSafeInteger(candidate.sourceContentVersion) &&
      typeof videoRequirements.version === 'string' &&
      record(videoRequirements.source) &&
      record(videoRequirements.provenance),
  );
}

export function projectCurrentOpportunityVideoRequirements(input: {
  opportunity: Record<string, unknown>;
  receipt: unknown;
}): OpportunityVideoRequirements | null {
  const { opportunity, receipt } = input;
  if (!isCurrentReceipt(receipt)) return null;
  if (
    !receipt.requestId ||
    !receipt.compositeInputFingerprint ||
    receipt.sourceContentFingerprint !== opportunity.sourceContentFingerprint ||
    receipt.sourceContentVersion !== opportunity.sourceContentVersion ||
    receipt.videoRequirements.version !==
      OPPORTUNITY_VIDEO_REQUIREMENTS_VERSION ||
    receipt.videoRequirements.source.sourceContentFingerprint !==
      opportunity.sourceContentFingerprint ||
    receipt.videoRequirements.source.sourceContentVersion !==
      opportunity.sourceContentVersion ||
    !receipt.videoRequirements.provenance?.provider ||
    !receipt.videoRequirements.provenance.model
  )
    return null;
  return structuredClone(receipt.videoRequirements);
}

function hasPersistedVideoRequirementCandidate(
  opportunity: Record<string, unknown>,
): boolean {
  try {
    const prepared = record(
      JSON.parse(String(opportunity.preparedPostingJson ?? '{}')),
    );
    // This shape is a bounded read selector only. It is never returned to the
    // caller; `loadCurrent…Projection` below must still replay the actual
    // GLOBAL request/result before publication.
    return (
      projectCurrentOpportunityVideoRequirements({
        opportunity,
        receipt: prepared?.opportunityVideoRequirements,
      }) !== null
    );
  } catch {
    return false;
  }
}

/**
 * Bounded list projection for source-stage candidates. Persisted JSON is only
 * a routing hint; every candidate is replayed through the actual GLOBAL
 * request/result join before it can be surfaced.
 */
export async function loadCurrentOpportunityVideoRequirementsProjections(
  opportunities: Record<string, unknown>[],
): Promise<Map<string, OpportunityVideoRequirements>> {
  const projections = new Map<string, OpportunityVideoRequirements>();
  const candidates = opportunities.filter(
    (opportunity) =>
      typeof opportunity.id === 'string' &&
      opportunity.id.length > 0 &&
      hasPersistedVideoRequirementCandidate(opportunity),
  );
  for (let offset = 0; offset < candidates.length; offset += 4) {
    const results = await Promise.all(
      candidates
        .slice(offset, offset + 4)
        .map(
          async (opportunity) =>
            [
              opportunity.id as string,
              await loadCurrentOpportunityVideoRequirementsProjection(
                opportunity,
              ),
            ] as const,
        ),
    );
    for (const [id, videoRequirements] of results) {
      if (videoRequirements) projections.set(id, videoRequirements);
    }
  }
  return projections;
}

/**
 * Reads only a source-current, actual GLOBAL composite receipt. Paid legacy
 * coverage records and source text with no typed video decision stay unknown.
 */
export async function loadCurrentOpportunityVideoRequirementsProjection(
  opportunity: Record<string, unknown>,
): Promise<OpportunityVideoRequirements | null> {
  return projectCurrentOpportunityVideoRequirements({
    opportunity,
    receipt: await readCurrentOpportunityVideoRequirementsEvidence(opportunity),
  });
}
