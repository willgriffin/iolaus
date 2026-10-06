import { createHash } from 'node:crypto';
import type { DecisionRequest, DecisionResult } from '@happyvertical/ai';

/**
 * Source-only decision contract. A lexical hint may nominate a clause for a
 * typed decision, but it never decides whether a video step exists or applies.
 */
export const OPPORTUNITY_VIDEO_REQUIREMENTS_VERSION =
  'opportunity-video-requirements/v2' as const;
export const OPPORTUNITY_VIDEO_REQUIREMENTS_THRESHOLD = 0.85;

export type VideoRequirementStatus =
  | 'required'
  | 'optional'
  | 'explicitly_not_required'
  | 'unknown';

export type VideoRequirementKind =
  | 'recorded_application_video'
  | 'live_video_interview';

export type VideoRequirementDecision = Exclude<
  VideoRequirementStatus,
  'unknown'
>;

export interface VideoRequirementClause {
  id: string;
  /** Exact UTF-16 offsets into the unchanged captured source text. */
  spanStart: number;
  spanEnd: number;
  /** Exact captured source substring at spanStart/spanEnd. */
  quote: string;
}

export interface VideoRequirementEvidence extends VideoRequirementClause {
  confidence: number;
  decision: VideoRequirementDecision;
  probability: number;
}

export interface VideoRequirementFinding {
  kind: VideoRequirementKind;
  status: VideoRequirementStatus;
  evidence: VideoRequirementEvidence[];
  /** Never absent: consumers can explain an unknown or conflict. */
  uncertainty: string | null;
}

export interface OpportunityVideoRequirements {
  version: typeof OPPORTUNITY_VIDEO_REQUIREMENTS_VERSION;
  fingerprint: string;
  source: VideoRequirementSourceIdentity;
  recordedSubmission: VideoRequirementFinding;
  liveInterview: VideoRequirementFinding;
  /** Typed decision provenance is retained only when a result was supplied. */
  provenance?: DecisionResult['provenance'];
}

export interface VideoRequirementSourceIdentity {
  sourceContentFingerprint?: string;
  sourceContentVersion?: number;
}

export interface PreparedOpportunityVideoRequirements {
  clauses: VideoRequirementClause[];
  fingerprint: string;
  request: DecisionRequest;
  source: VideoRequirementSourceIdentity;
  sourceText: string;
}

const kinds: VideoRequirementKind[] = [
  'recorded_application_video',
  'live_video_interview',
];
const decisions: VideoRequirementDecision[] = [
  'required',
  'optional',
  'explicitly_not_required',
];

/**
 * Builds a bounded typed-decision request from exact candidate clauses. This
 * is intentionally not a detector: no result means every finding is unknown.
 */
export function prepareOpportunityVideoRequirements(
  sourceText: string,
  source: VideoRequirementSourceIdentity = {},
): PreparedOpportunityVideoRequirements {
  const clauses = nominateVideoRequirementClauses(sourceText);
  const questions: DecisionRequest['questions'] = {};
  for (const kind of kinds) {
    for (const decision of decisions) {
      const key = questionKey(kind, decision);
      questions[key] = {
        type: 'predicate',
        instructions: predicateInstructions(kind, decision),
      };
      questions[evidenceQuestionKey(kind, decision)] = {
        type: 'choice',
        instructions: evidenceInstructions(kind, decision),
        criteria: Object.fromEntries([
          ...clauses.map((clause) => [clause.id, null]),
          ['none', 'No supplied clause explicitly proves this predicate.'],
        ]),
      };
    }
  }
  const request: DecisionRequest = {
    state: {
      sourceClauses: clauses.map((clause) => ({
        id: clause.id,
        spanStart: clause.spanStart,
        spanEnd: clause.spanEnd,
        quote: clause.quote,
      })),
    },
    questions,
  };
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        version: OPPORTUNITY_VIDEO_REQUIREMENTS_VERSION,
        source,
        sourceText,
        request,
      }),
    )
    .digest('hex');
  return {
    clauses,
    fingerprint,
    request,
    source: structuredClone(source),
    sourceText,
  };
}

/**
 * Resolves only a complete, well-formed typed decision result. A lexical hint,
 * missing result, low confidence, or conflicting predicates always stays
 * unknown; this function never calls a provider.
 */
export function resolveOpportunityVideoRequirements(
  prepared: PreparedOpportunityVideoRequirements,
  result?: DecisionResult,
): OpportunityVideoRequirements {
  if (!result)
    return outcomeForAllKinds(prepared, () => ({
      status: 'unknown',
      evidence: [],
      uncertainty:
        'No typed decision has resolved the nominated captured-source clauses.',
    }));

  validateDecisionResult(prepared, result);
  return {
    version: OPPORTUNITY_VIDEO_REQUIREMENTS_VERSION,
    fingerprint: prepared.fingerprint,
    source: structuredClone(prepared.source),
    recordedSubmission: resolveKind(
      prepared,
      result,
      'recorded_application_video',
    ),
    liveInterview: resolveKind(prepared, result, 'live_video_interview'),
    ...(result.provenance ? { provenance: result.provenance } : {}),
  };
}

/**
 * Pure UI-safe entrypoint. It prepares the exact decision contract but returns
 * unknown for both dimensions until a typed decision is resolved separately.
 */
export function analyzeOpportunityVideoRequirements(
  capturedText: string,
  source: VideoRequirementSourceIdentity = {},
): OpportunityVideoRequirements {
  return resolveOpportunityVideoRequirements(
    prepareOpportunityVideoRequirements(capturedText, source),
  );
}

/** Deterministic hints only select literal excerpts offered to the decision. */
export function nominateVideoRequirementClauses(
  sourceText: string,
): VideoRequirementClause[] {
  const clauses: VideoRequirementClause[] = [];
  const matcher = /[^\n.!?]+(?:[.!?]+|$)/gu;
  for (const match of sourceText.matchAll(matcher)) {
    const raw = match[0];
    const firstNonWhitespace = raw.search(/\S/u);
    if (firstNonWhitespace < 0 || !/\b(?:video|zoom|teams|webex)\b/iu.test(raw))
      continue;
    const matchStart = match.index ?? 0;
    const spanStart = matchStart + firstNonWhitespace;
    const trailingWhitespace = raw.match(/\s*$/u)?.[0] ?? '';
    const spanEnd = matchStart + raw.length - trailingWhitespace.length;
    if (spanStart >= spanEnd) continue;
    clauses.push({
      id: `c${clauses.length}`,
      spanStart,
      spanEnd,
      quote: sourceText.slice(spanStart, spanEnd),
    });
  }
  return clauses;
}

function resolveKind(
  prepared: PreparedOpportunityVideoRequirements,
  result: DecisionResult,
  kind: VideoRequirementKind,
): VideoRequirementFinding {
  const affirmed: VideoRequirementEvidence[] = [];
  for (const decision of decisions) {
    const predicate = result.answers[questionKey(kind, decision)];
    const selection = result.answers[evidenceQuestionKey(kind, decision)];
    if (
      predicate?.type !== 'predicate' ||
      selection?.type !== 'choice' ||
      predicate.probability < OPPORTUNITY_VIDEO_REQUIREMENTS_THRESHOLD ||
      selection.confidence < OPPORTUNITY_VIDEO_REQUIREMENTS_THRESHOLD
    )
      continue;
    if (selection.choice === 'none')
      throw new Error(
        `A high-confidence ${kind} ${decision} predicate requires an exact source clause.`,
      );
    const clause = prepared.clauses.find(
      (item) => item.id === selection.choice,
    );
    if (!clause)
      throw new Error('Video decision cited an unavailable source clause.');
    affirmed.push({
      ...clause,
      decision,
      probability: predicate.probability,
      confidence: selection.confidence,
    });
  }

  const distinct = new Set(affirmed.map((item) => item.decision));
  if (!affirmed.length)
    return {
      kind,
      status: 'unknown',
      evidence: [],
      uncertainty: `No exact captured-source clause was affirmed for ${kindLabel(kind)}.`,
    };
  if (distinct.size > 1)
    return {
      kind,
      status: 'unknown',
      evidence: affirmed,
      uncertainty: `Conflicting typed decisions were affirmed for ${kindLabel(kind)}. Confirm the current application instructions.`,
    };

  const [status] = distinct;
  if (!status)
    return {
      kind,
      status: 'unknown',
      evidence: affirmed,
      uncertainty: `No determinate typed decision was available for ${kindLabel(kind)}.`,
    };
  return { kind, status, evidence: affirmed, uncertainty: null };
}

function outcomeForAllKinds(
  prepared: PreparedOpportunityVideoRequirements,
  finding: () => Omit<VideoRequirementFinding, 'kind'>,
): OpportunityVideoRequirements {
  return {
    version: OPPORTUNITY_VIDEO_REQUIREMENTS_VERSION,
    fingerprint: prepared.fingerprint,
    source: structuredClone(prepared.source),
    recordedSubmission: {
      kind: 'recorded_application_video',
      ...finding(),
    },
    liveInterview: { kind: 'live_video_interview', ...finding() },
  };
}

function validateDecisionResult(
  prepared: PreparedOpportunityVideoRequirements,
  result: DecisionResult,
): void {
  const expected = decisionQuestionKeys();
  const actual = Object.keys(result.answers).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    throw new Error(
      'Video decision must answer every exact predicate and evidence question.',
    );

  for (const kind of kinds) {
    for (const decision of decisions) {
      const predicate = result.answers[questionKey(kind, decision)];
      const selection = result.answers[evidenceQuestionKey(kind, decision)];
      const evidenceQuestion =
        prepared.request.questions[evidenceQuestionKey(kind, decision)];
      if (
        predicate?.type !== 'predicate' ||
        !probability(predicate.probability) ||
        selection?.type !== 'choice' ||
        !probability(selection.confidence) ||
        evidenceQuestion?.type !== 'choice' ||
        !Object.hasOwn(evidenceQuestion.criteria, selection.choice)
      )
        throw new Error('Malformed video decision answer.');
    }
  }
}

function predicateInstructions(
  kind: VideoRequirementKind,
  decision: VideoRequirementDecision,
): string {
  return `Using only the supplied literal source clauses as data, is there an explicit statement that ${kindLabel(kind)} is ${decisionLabel(decision)}? Do not infer a requirement from a general mention of recruiting, an interview, video, company policy, a benefit, or an absence of text. Keep recorded application videos distinct from synchronous live video interviews. A clause may support only what it explicitly says.`;
}

function evidenceInstructions(
  kind: VideoRequirementKind,
  decision: VideoRequirementDecision,
): string {
  return `Select exactly one literal source clause that explicitly proves ${kindLabel(kind)} is ${decisionLabel(decision)}, or none. Do not select a merely related clause. Keep recorded application videos distinct from synchronous live video interviews.`;
}

function questionKey(
  kind: VideoRequirementKind,
  decision: VideoRequirementDecision,
): string {
  return `${kind}_${decision}`;
}

function evidenceQuestionKey(
  kind: VideoRequirementKind,
  decision: VideoRequirementDecision,
): string {
  return `${questionKey(kind, decision)}_evidence`;
}

function decisionQuestionKeys(): string[] {
  return kinds
    .flatMap((kind) =>
      decisions.flatMap((decision) => [
        questionKey(kind, decision),
        evidenceQuestionKey(kind, decision),
      ]),
    )
    .sort();
}

function probability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function kindLabel(kind: VideoRequirementKind): string {
  return kind === 'recorded_application_video'
    ? 'a recorded application video'
    : 'a live video interview';
}

function decisionLabel(decision: VideoRequirementDecision): string {
  return decision === 'explicitly_not_required'
    ? 'explicitly not required'
    : decision;
}
