import { candidateWorkEligibilityFromProfile } from './candidate-work-eligibility.js';
import type { CandidateWorkEligibility } from './opportunity-assessment.js';
import {
  fingerprintOpportunitySourceContent,
  parseOpportunitySourceContent,
} from './opportunity-source-content.js';
import type { WorkspaceSubject } from './private-workspace.js';
import { loadWorkspaceCandidateEvidence } from './resume-data.js';
import {
  projectVerifiedSourceEligibility,
  type SourceEligibilityCitation,
  type SourceEligibilityConditionalPath,
  type SourceEligibilityEvidence,
  type SourceEligibilityEvidenceContext,
  type SourceEligibilityProjection,
  sourceEligibilityConditionalPaths,
  validateSourceEligibilityEvidence,
} from './source-eligibility-facts.js';

/** The provider reader must reconstruct this from an actual GLOBAL receipt. */
export interface CurrentSourceEligibilityEvidenceReceipt {
  evidence: SourceEligibilityEvidence;
  sourceContext: SourceEligibilityEvidenceContext;
}

export type SourceEligibilityEvidenceReader = (
  opportunity: Record<string, unknown>,
) => Promise<CurrentSourceEligibilityEvidenceReceipt | undefined>;

/**
 * Kept behind a runtime module boundary while the aggregate sidecar is rolled
 * out. Missing or malformed exports fail closed; once present, the provider
 * reader remains the only source of current GLOBAL authority.
 */
async function readAttestedSourceEligibilityEvidence(
  opportunity: Record<string, unknown>,
): Promise<CurrentSourceEligibilityEvidenceReceipt | undefined> {
  const module = (await import(
    './opportunity-requirement-coverage-provider.js'
  )) as Record<string, unknown>;
  const reader = module.readVerifiedOpportunitySourceEligibilityEvidence;
  if (typeof reader !== 'function') return undefined;
  const result = await reader(opportunity);
  if (!result || typeof result !== 'object' || Array.isArray(result))
    return undefined;
  const receipt = result as Partial<CurrentSourceEligibilityEvidenceReceipt>;
  return receipt.evidence && receipt.sourceContext
    ? (receipt as CurrentSourceEligibilityEvidenceReceipt)
    : undefined;
}

export type SourceEligibilityConditionalPathProjection = {
  facts: Array<{
    citations: SourceEligibilityCitationProjection[];
    key: string;
  }>;
  kind: SourceEligibilityConditionalPath['kind'];
  status: SourceEligibilityConditionalPath['status'];
};

export type SourceEligibilityCitationProjection =
  | {
      end: number;
      hash: string;
      quote: string;
      source: 'descriptionRaw';
      start: number;
    }
  | {
      field: 'locationNotes' | 'workMode';
      hash: string;
      path: `sourceContentJson.${'locationNotes' | 'workMode'}`;
      quote: string;
      /** Scalar field offsets, never offsets into descriptionRaw. */
      start: number;
      end: number;
      source: 'captured_field';
    };

export type SourceEligibilityUiProjection = {
  capturedPostingLocation?: CapturedPostingLocationProjection;
  conditionalPaths: SourceEligibilityConditionalPathProjection[];
  eligibilityBucket:
    | 'eligible'
    | 'sponsorship_possible'
    | 'location_restriction'
    | 'unknown'
    | 'conflicting';
  /** Source-only projections must never authorize a fit score or stars. */
  sourceStatus: 'current' | 'unknown';
  sourceContentFingerprint: string | null;
  sourceContentVersion: number | null;
  reason: string;
  unresolvedConstraintFactKeys: string[];
};

/** Literal captured ATS metadata, independently current; it grants no work rights. */
export type CapturedPostingLocationProjection = {
  sourceStatus: 'current';
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  locationNotes: string | null;
  workMode: string | null;
};

export function projectCapturedPostingLocation(
  opportunity: Record<string, unknown>,
): CapturedPostingLocationProjection | null {
  const source = parseOpportunitySourceContent(opportunity.sourceContentJson);
  if (
    !source ||
    typeof opportunity.sourceContentFingerprint !== 'string' ||
    !Number.isSafeInteger(opportunity.sourceContentVersion) ||
    Number(opportunity.sourceContentVersion) < 1 ||
    fingerprintOpportunitySourceContent(source) !==
      opportunity.sourceContentFingerprint
  )
    return null;
  const locationNotes =
    typeof source.locationNotes === 'string' && source.locationNotes.trim()
      ? source.locationNotes
      : null;
  const workMode =
    typeof source.workMode === 'string' && source.workMode.trim()
      ? source.workMode
      : null;
  if (!locationNotes && !workMode) return null;
  return {
    sourceStatus: 'current',
    sourceContentFingerprint: opportunity.sourceContentFingerprint,
    sourceContentVersion: Number(opportunity.sourceContentVersion),
    locationNotes,
    workMode,
  };
}

function eligibilityBucket(
  projection: SourceEligibilityProjection,
): SourceEligibilityUiProjection['eligibilityBucket'] {
  switch (projection.verdict) {
    case 'eligible_without_sponsorship':
      return 'eligible';
    case 'sponsorship_possible':
      return 'sponsorship_possible';
    case 'location_restriction':
    case 'incompatible':
      return 'location_restriction';
    case 'conflicting':
      return 'conflicting';
    default:
      return 'unknown';
  }
}

function unknown(reason: string): SourceEligibilityUiProjection {
  return {
    eligibilityBucket: 'unknown',
    conditionalPaths: [],
    reason,
    sourceContentFingerprint: null,
    sourceContentVersion: null,
    sourceStatus: 'unknown',
    unresolvedConstraintFactKeys: [],
  };
}

function currentUnknown(
  receipt: CurrentSourceEligibilityEvidenceReceipt,
  reason: string,
): SourceEligibilityUiProjection {
  return {
    eligibilityBucket: 'unknown',
    conditionalPaths: conditionalPathsForUi(
      sourceEligibilityConditionalPaths(receipt.evidence),
      receipt.sourceContext.sourceText,
    ),
    reason,
    sourceStatus: 'current',
    sourceContentFingerprint: receipt.sourceContext.sourceContentFingerprint,
    sourceContentVersion: receipt.sourceContext.sourceContentVersion,
    unresolvedConstraintFactKeys: [],
  };
}

function conditionalPathsForUi(
  paths: SourceEligibilityConditionalPath[],
  sourceText: string,
): SourceEligibilityConditionalPathProjection[] {
  return paths.map((path) => ({
    kind: path.kind,
    status: path.status,
    facts: path.facts.map((fact) => ({
      key: fact.key,
      citations: fact.citations.map((citation) =>
        citation.source === 'captured_field'
          ? {
              end: citation.text.length,
              field: citation.field,
              hash: citation.hash,
              path: citation.path,
              quote: citation.text,
              source: 'captured_field' as const,
              start: 0,
            }
          : {
              end: citation.end,
              hash: citation.hash,
              quote: sourceText.slice(citation.start, citation.end),
              source: 'descriptionRaw' as const,
              start: citation.start,
            },
      ),
    })),
  }));
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await mapper(values[index]!);
      }
    }),
  );
  return results;
}

/**
 * Loads one current public source attestation per posting, then evaluates it
 * using the verified active profile. This never reads `postingEligibilityJson`:
 * a persisted payload cannot attest to the provider result that created it.
 */
export async function loadCurrentSourceEligibilityProjections(input: {
  opportunities: Record<string, unknown>[];
  readEvidence?: SourceEligibilityEvidenceReader;
  subject: WorkspaceSubject;
}): Promise<Map<string, SourceEligibilityUiProjection>> {
  const capturedLocations = new Map(
    input.opportunities.flatMap((opportunity) => {
      const captured = projectCapturedPostingLocation(opportunity);
      return typeof opportunity.id === 'string' && opportunity.id && captured
        ? [[opportunity.id, captured] as const]
        : [];
    }),
  );
  function withCapturedLocations(
    projections: Map<string, SourceEligibilityUiProjection>,
  ) {
    for (const [id, capturedPostingLocation] of capturedLocations) {
      projections.set(id, {
        ...(projections.get(id) ??
          unknown(
            'No current work-location eligibility evidence is available.',
          )),
        capturedPostingLocation,
      });
    }
    return projections;
  }
  // Prove a current public receipt before touching private workspace data. This
  // keeps normal list hydration cheap and prevents an absent source sidecar
  // from turning a missing/new profile into a route failure.
  const attestations = await mapWithConcurrency(
    input.opportunities,
    4,
    async (opportunity) => {
      const id = typeof opportunity.id === 'string' ? opportunity.id : '';
      if (!id) return null;
      let receipt: CurrentSourceEligibilityEvidenceReceipt | undefined;
      try {
        receipt = await (
          input.readEvidence ?? readAttestedSourceEligibilityEvidence
        )(opportunity);
      } catch {
        return null;
      }
      if (
        !receipt ||
        !validateSourceEligibilityEvidence(
          receipt.sourceContext,
          receipt.evidence,
        )
      )
        return null;
      return { id, receipt };
    },
  );
  const current = attestations.filter(
    (
      item,
    ): item is {
      id: string;
      receipt: CurrentSourceEligibilityEvidenceReceipt;
    } => Boolean(item),
  );
  if (!current.length) return withCapturedLocations(new Map());
  let candidate: CandidateWorkEligibility;
  try {
    candidate = candidateWorkEligibilityFromProfile(
      (await loadWorkspaceCandidateEvidence(input.subject)).candidate,
    );
  } catch {
    return withCapturedLocations(
      new Map(
        current.map(
          ({ id, receipt }) =>
            [
              id,
              currentUnknown(
                receipt,
                'The active candidate profile is unavailable.',
              ),
            ] as const,
        ),
      ),
    );
  }
  return withCapturedLocations(
    new Map(
      current.map(({ id, receipt }) => {
        const projection = projectVerifiedSourceEligibility({
          candidate,
          evidence: receipt.evidence,
          sourceContext: receipt.sourceContext,
        });
        return [
          id,
          {
            eligibilityBucket: eligibilityBucket(projection),
            conditionalPaths: conditionalPathsForUi(
              projection.conditionalPaths,
              receipt.sourceContext.sourceText,
            ),
            reason: projection.reason,
            sourceStatus: 'current',
            sourceContentFingerprint:
              receipt.sourceContext.sourceContentFingerprint,
            sourceContentVersion: receipt.sourceContext.sourceContentVersion,
            unresolvedConstraintFactKeys:
              projection.unresolvedConstraintFactKeys,
          },
        ] as const;
      }),
    ),
  );
}
