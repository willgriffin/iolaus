import { createHash } from 'node:crypto';
import type {
  DecisionAnswer,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  DecisionValue,
} from '@happyvertical/ai';
import { assessmentDecisionOutputTokenCeiling } from './opportunity-assessment.js';
import type { PreparedOpportunityResumeFitReview } from './opportunity-resume-fit-review.js';

export const OPPORTUNITY_JEV_ASSESSMENT_EXPERIMENT_VERSION =
  'opportunity-jev-assessment-experiment/v1-ordinal-evidence';
export const OPPORTUNITY_JEV_ASSESSMENT_EXPERIMENT_FEATURE =
  'opportunity-jev-assessment-experiment';
export const OPPORTUNITY_JEV_ASSESSMENT_EXPERIMENT_PROFILE =
  'typesafe-opportunity-jev-assessment-experiment';
export const OPPORTUNITY_JEV_ASSESSMENT_EXPERIMENT_MODEL = 'jev-1.13.0';
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tenureLiteral =
  /\b\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?\+?\s*(?:years?|yrs?)\b/iu;
const roleLevels = [
  'The actual duties belong to an unrelated occupation; shared employer industry does not establish alignment.',
  'The actual duties are adjacent to the explicitly stated target roles, with a different primary occupation.',
  'The actual duties belong to an explicitly stated candidate target role, with some scope differences.',
  'The actual primary duties directly match an explicitly stated candidate target role and its stated scope.',
];
const evidenceLevels = [
  'No attributable example demonstrating this facet is established by the supplied facts; this is not a claim of absence or inability.',
  'An attributable related component or equivalent capability is demonstrated; the complete role-specific facet remains unestablished.',
  'Attributable direct substantive work demonstrates this facet in the context of the actual posting duties.',
];
export interface PreparedOpportunityJevAssessmentExperiment {
  version: typeof OPPORTUNITY_JEV_ASSESSMENT_EXPERIMENT_VERSION;
  model: typeof OPPORTUNITY_JEV_ASSESSMENT_EXPERIMENT_MODEL;
  opportunityId: string;
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  sourceMaterialFingerprint: string;
  candidateMaterialFingerprint: string;
  candidateSourceCount: number;
  tenureClauseId?: string;
  request: DecisionRequest;
  fingerprint: string;
}
export interface OpportunityJevAssessmentExperimentResult {
  version: typeof OPPORTUNITY_JEV_ASSESSMENT_EXPERIMENT_VERSION;
  mode: 'diagnostic_only';
  model: typeof OPPORTUNITY_JEV_ASSESSMENT_EXPERIMENT_MODEL;
  requestId: string;
  inputFingerprint: string;
  preparedFingerprint: string;
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  candidateMaterialFingerprint: string;
  answers: Record<string, DecisionAnswer>;
  /** Ordinal rubric position, never a skill percentage or overall fit. */
  ordinalPositions: Record<string, number>;
}
function jsonValue(value: unknown): DecisionValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonValue(item)]),
    );
  throw new Error('Experiment context must be lossless JSON data.');
}
export function enumerateOpportunityJevTenureClauses(
  input: PreparedOpportunityResumeFitReview,
): string[] {
  return input.clauses
    .filter(
      (clause) => clause.kind === 'body' && tenureLiteral.test(clause.text),
    )
    .map((clause) => clause.id);
}
/** Consumes a freshly attested native catalog. It does not load or attest authority. */
export function prepareOpportunityJevAssessmentExperiment(
  input: PreparedOpportunityResumeFitReview,
  options: { tenureClauseId?: string } = {},
): PreparedOpportunityJevAssessmentExperiment {
  const source = input.completeSourceMaterial;
  if (
    input.version !== 'opportunity-resume-fit-review/v4-complete-material' ||
    !source ||
    !input.sourceComplete ||
    !input.opportunityId ||
    !input.candidateMaterialFingerprint ||
    !input.candidates.length ||
    new Set(input.candidates.map((row) => row.id)).size !==
      input.candidates.length ||
    input.candidates.some((row) => !row.id || !row.text)
  )
    throw new Error(
      'Experiment requires the complete current native source and candidate catalog.',
    );
  const captured: unknown = JSON.parse(source.capturedSource.sourceContentJson);
  if (
    !captured ||
    typeof captured !== 'object' ||
    Array.isArray(captured) ||
    !('descriptionRaw' in captured) ||
    captured.descriptionRaw !== source.context.sourceText
  )
    throw new Error('Experiment requires the unchanged captured posting body.');
  const tenure = options.tenureClauseId
    ? input.clauses.find(
        (clause) =>
          clause.id === options.tenureClauseId &&
          clause.kind === 'body' &&
          tenureLiteral.test(clause.text),
      )
    : undefined;
  if (options.tenureClauseId && !tenure)
    throw new Error(
      'Tenure nomination must name a literal quantified current body clause.',
    );
  const questions: Record<string, DecisionQuestion> = {
    country_incompatible: {
      type: 'predicate',
      instructions:
        'Do explicit capturedPosting location restrictions clearly exclude the candidate target work country stated in candidateFacts? Missing target, remote wording, or local/timezone ambiguity does not establish incompatibility. Distinguish primary target compatibility from a separately offered sponsorship path.',
      criteria: {
        true: 'Explicit incompatible posting restriction and explicit typed target country are both present.',
        false:
          'Clear source-backed target-country incompatibility is not established; this does not certify permission.',
      },
    },
    authorization_incompatible: {
      type: 'predicate',
      instructions:
        'Do explicit capturedPosting work-authorization requirements clearly conflict with the exact typed authorizedWorkCountriesJson or sponsorshipRequired facts? Citizenship, residence, target country and employer silence are not authorization. Ambiguous scope or sponsorship conditions remain unestablished.',
      criteria: {
        true: 'An explicit source authorization requirement and explicit contradictory typed candidate fact establish incompatibility.',
        false:
          'Clear authorization incompatibility is not established; missing facts do not prove eligibility.',
      },
    },
    sponsorship_offered: {
      type: 'predicate',
      instructions:
        'Does capturedPosting explicitly offer employer sponsorship for this role? General company description, relocation, citizenship and silence do not establish an offer.',
      criteria: {
        true: 'An explicit sponsorship offer appears in the captured posting.',
        false:
          'An explicit sponsorship offer is not established; this does not prove denial.',
      },
    },
    role_alignment: {
      type: 'score',
      instructions:
        'Compare capturedPosting actual duties with targetRoles explicitly recorded in candidateFacts preferencesJson. Judge occupation and duties, not employer industry alone. Missing targetRoles cannot establish direct alignment.',
      criteria: roleLevels,
    },
  };
  for (const [key, facet] of Object.entries({
    technical_implementation:
      'technical implementation of the actual posting duties',
    production_ownership:
      'production delivery, operation or ownership required by the actual posting duties',
    role_specific_duties:
      'the actual role-specific domain work or product-management duties, according to the occupation in the posting',
  }))
    questions[key] = {
      type: 'score',
      instructions: `Using capturedPosting and candidateFacts, assess attributable supplied evidence for ${facet}. Semantic equivalents may count; do not invent unmentioned technology, domain work, level or years. Separate a related component from the complete facet; unrelated company industry is not work evidence.`,
      criteria: evidenceLevels,
    };
  if (tenure)
    questions.tenure_established = {
      type: 'predicate',
      instructions: {
        clause: tenure.text,
        question:
          'Do exact candidateFacts establish the quantified experience requested by this literal clause, explicitly linked to its named skill or duty? A dated role plus an undated skill is insufficient. Do not substitute total career duration for skill-linked tenure. Missing or ambiguous dates remain unknown.',
      },
      criteria: {
        true: 'Explicit skill/duty-linked dated evidence establishes the literal tenure requirement.',
        false:
          'The exact linked tenure is not established; this does not prove insufficient experience.',
      },
    };
  const material: Omit<
    PreparedOpportunityJevAssessmentExperiment,
    'fingerprint'
  > = {
    version: OPPORTUNITY_JEV_ASSESSMENT_EXPERIMENT_VERSION,
    model: OPPORTUNITY_JEV_ASSESSMENT_EXPERIMENT_MODEL,
    opportunityId: input.opportunityId,
    sourceContentFingerprint: input.sourceContentFingerprint,
    sourceContentVersion: input.sourceContentVersion,
    sourceMaterialFingerprint: source.fingerprint,
    candidateMaterialFingerprint: input.candidateMaterialFingerprint,
    candidateSourceCount: input.candidates.length,
    ...(tenure ? { tenureClauseId: tenure.id } : {}),
    request: {
      state: {
        capturedPosting: jsonValue(captured),
        candidateFacts: input.candidates.map((row) => ({
          id: row.key,
          kind: row.kind,
          title: row.title,
          text: row.text,
        })),
      },
      questions,
    } satisfies DecisionRequest,
  };
  return { ...material, fingerprint: hash(material) };
}
function validatePrepared(
  prepared: PreparedOpportunityJevAssessmentExperiment,
) {
  const { fingerprint, ...material } = prepared;
  if (
    hash(material) !== fingerprint ||
    prepared.version !== OPPORTUNITY_JEV_ASSESSMENT_EXPERIMENT_VERSION ||
    prepared.model !== OPPORTUNITY_JEV_ASSESSMENT_EXPERIMENT_MODEL
  )
    throw new Error('Experiment prepared material is not current.');
}
export function opportunityJevAssessmentExperimentInputFingerprint(
  prepared: PreparedOpportunityJevAssessmentExperiment,
  subject: { tenantId: string; userId: string; profileId: string },
): string {
  validatePrepared(prepared);
  if (!subject.tenantId || !subject.userId || !subject.profileId)
    throw new Error('Experiment requires an owned subject tuple.');
  return hash({
    prepared: prepared.fingerprint,
    subject: {
      tenantId: subject.tenantId,
      userId: subject.userId,
      profileId: subject.profileId,
    },
  });
}
/** SDK has no tokenizer. UTF8 bytes are conservative TOKEN upper bounds, not vendor byte limits. */
export function preflightOpportunityJevAssessmentExperiment(
  prepared: PreparedOpportunityJevAssessmentExperiment,
) {
  validatePrepared(prepared);
  const wire = {
    state: prepared.request.state,
    model: prepared.model,
    questions: Object.fromEntries(
      Object.entries(prepared.request.questions).map(([id, question]) => [
        id,
        question.type === 'predicate'
          ? { ...question, type: 'noul' }
          : question,
      ]),
    ),
  };
  const requestBytes = Buffer.byteLength(JSON.stringify(wire));
  const stateBytes = Buffer.byteLength(JSON.stringify(prepared.request.state));
  const longestQuestionBytes = Math.max(
    ...Object.values(wire.questions).map((question) =>
      Buffer.byteLength(JSON.stringify(question)),
    ),
  );
  const maxOutputTokens = assessmentDecisionOutputTokenCeiling(
    prepared.request,
  );
  return {
    requestBytes,
    inputTokenCeiling: requestBytes,
    stateBytes,
    longestQuestionBytes,
    maxOutputTokens,
    reservedTokens: requestBytes + maxOutputTokens,
    fitsModelConservativeBounds:
      requestBytes <= 64000 && stateBytes + longestQuestionBytes <= 32000,
    fitsOutputBound: maxOutputTokens <= 4096,
  };
}
export function resolveOpportunityJevAssessmentExperiment(
  prepared: PreparedOpportunityJevAssessmentExperiment,
  result: DecisionResult,
  identity: { requestId: string; inputFingerprint: string },
): OpportunityJevAssessmentExperimentResult {
  validatePrepared(prepared);
  const ids = Object.keys(prepared.request.questions);
  if (
    !identity.requestId ||
    !identity.inputFingerprint ||
    result.model !== prepared.model ||
    result.provenance?.provider !== 'typesafe' ||
    result.provenance.model !== prepared.model ||
    !result.answers ||
    Object.keys(result.answers).length !== ids.length ||
    ids.some((id) => !Object.hasOwn(result.answers, id))
  )
    throw new Error(
      'Experiment answers must match the exact governed model and request.',
    );
  const ordinalPositions: Record<string, number> = {};
  const validProbability = (value: number) =>
    Number.isFinite(value) && value >= 0 && value <= 1;
  for (const id of ids) {
    const question = prepared.request.questions[id]!;
    const answer = result.answers[id]!;
    if (question.type === 'predicate') {
      if (answer.type !== 'predicate' || !validProbability(answer.probability))
        throw new Error('Experiment predicate answer is invalid.');
    } else {
      if (
        question.type !== 'score' ||
        answer.type !== 'score' ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > question.criteria.length - 1 ||
        !validProbability(answer.confidence) ||
        hash(answer.levels) !== hash(question.criteria) ||
        !answer.probabilities ||
        Object.keys(answer.probabilities).length !== question.criteria.length ||
        question.criteria.some(
          (_, index) => !Object.hasOwn(answer.probabilities, String(index)),
        ) ||
        Object.values(answer.probabilities).some(
          (value) => !validProbability(value),
        ) ||
        Math.abs(
          Object.values(answer.probabilities).reduce(
            (sum, value) => sum + value,
            0,
          ) - 1,
        ) > 1e-6
      )
        throw new Error('Experiment score answer is invalid.');
      ordinalPositions[id] = answer.score / (question.criteria.length - 1);
    }
  }
  return {
    version: prepared.version,
    mode: 'diagnostic_only',
    model: prepared.model,
    requestId: identity.requestId,
    inputFingerprint: identity.inputFingerprint,
    preparedFingerprint: prepared.fingerprint,
    sourceContentFingerprint: prepared.sourceContentFingerprint,
    sourceContentVersion: prepared.sourceContentVersion,
    candidateMaterialFingerprint: prepared.candidateMaterialFingerprint,
    answers: result.answers,
    ordinalPositions,
  };
}
