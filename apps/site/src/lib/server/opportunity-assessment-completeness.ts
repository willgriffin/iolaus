import { createHash } from 'node:crypto';
import {
  buildRequirementCoverageSource,
  type CoverageLedger,
  type RequirementCoverageContext,
} from './opportunity-requirement-coverage.js';
import type { RequirementEvidenceAudit } from './opportunity-requirement-coverage-provider.js';
import { OPPORTUNITY_SCREENING_VERSION } from './opportunity-screening.js';
import type { CurrentOpportunityAssessmentScreen } from './opportunity-screening-provider.js';
import { fingerprintOpportunitySourceContent } from './opportunity-source-content.js';

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const COMPLETE_OPPORTUNITY_SOURCE_MATERIAL_VERSION =
  'opportunity-source-material/v1-complete-catalog';
export const SOURCE_CONSIDERATION_VERSION =
  'opportunity-source-consideration/v1';

/** Populated only by the server's current, owned, native source reader. */
export interface CompleteOpportunitySourceMaterial {
  version: typeof COMPLETE_OPPORTUNITY_SOURCE_MATERIAL_VERSION;
  fingerprint: string;
  context: RequirementCoverageContext;
  /** Original paid extraction, or the exact deterministic captured-source manifest. */
  ledger: CoverageLedger;
  capturedSource: { sourceContentJson: string; fingerprint: string };
  /** Exact current captured ATS fields, distinct from description clauses. */
  capturedFields: CompleteCapturedSourceField[];
  /** Absent only for a current captured source with no paid extraction. */
  extraction?: {
    requestId: string;
    agentRunId: string;
    ledgerFingerprint: string;
  };
  /** An actual recorded GLOBAL audit; never a caller or cached summary verdict. */
  audit?: RequirementEvidenceAudit;
}

export interface CompleteCapturedSourceField {
  id: string;
  path: string;
  text: string;
  /** SHA256 of the exact path, NUL separator, and original field value. */
  hash: string;
  /** Populated only when the entire value occurs under literal body spans. */
  bodyClauseIds: string[];
}

const capturedMaterialFields = [
  'title',
  'locationNotes',
  'workMode',
  'employmentType',
  'qualifications',
  'requiredSkills',
  'preferredSkills',
  'responsibilities',
  'compNotes',
  'salaryMin',
  'salaryMax',
  'hourlyMin',
  'hourlyMax',
  'equityMinPercent',
  'equityMaxPercent',
  'currency',
] as const;

/** The source schema's identity URL, external ID, and posting date are checked
 * by the native reader. Every nonempty content/constraint field is retained.
 * Body coverage requires exact literal value and spans, not semantic similarity.
 */
export function buildCompleteCapturedFieldCatalog(
  sourceContentJson: string,
  bodyClauses: CoverageLedger['clauses'],
  sourceText: string,
): CompleteCapturedSourceField[] {
  let captured: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(sourceContentJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return [];
    captured = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  return capturedMaterialFields.flatMap((field) => {
    const value = captured[field];
    if (
      (typeof value !== 'string' && typeof value !== 'number') ||
      !String(value).trim()
    )
      return [];
    const text = String(value);
    const path = `sourceContentJson.${field}`;
    let bodyClauseIds: string[] = [];
    for (
      let start = sourceText.indexOf(text);
      start >= 0;
      start = sourceText.indexOf(text, start + 1)
    ) {
      const matching = bodyClauses.filter(
        (clause) =>
          clause.spanStart < start + text.length && clause.spanEnd > start,
      );
      if (
        matching.length &&
        Array.from({ length: text.length }, (_, offset) => offset).every(
          (offset) => {
            const character = text.charAt(offset);
            if (/\s/u.test(character)) return true;
            const position = start + offset;
            return matching.some(
              (clause) =>
                clause.spanStart <= position && position < clause.spanEnd,
            );
          },
        )
      ) {
        bodyClauseIds = matching.map((clause) => clause.id);
        break;
      }
    }
    return [
      {
        id: `source-field:${field}`,
        path,
        text,
        hash: createHash('sha256').update(`${path}\u0000${text}`).digest('hex'),
        bodyClauseIds,
      },
    ];
  });
}

export type SourceClauseConsiderationStatus =
  | 'certified_nonrequirement'
  | 'confirmed_requirement'
  | 'possible_requirement_unknown'
  | 'unprocessed';

export interface SourceClauseConsideration {
  clauseId: string;
  status: SourceClauseConsiderationStatus;
  /** Only exact reciprocal rows are offered as candidate-review premises. */
  requirementIds: string[];
  /** Raw disposition links remain visible even when an edge is invalid. */
  originalRequirementIds: string[];
  reason:
    | 'exact_heading'
    | 'audited_context'
    | 'audited_requirement'
    | 'low_confidence'
    | 'source_mapping'
    | 'missing_audit'
    | 'invalid_source';
}

export interface CapturedFieldConsideration {
  fieldId: string;
  path: string;
  hash: string;
  bodyClauseIds: string[];
  status:
    | 'represented_in_body'
    | 'possible_requirement_unknown'
    | 'unprocessed';
  reason: 'exact_body_coverage' | 'captured_field_unknown' | 'invalid_source';
}

export interface SourceConsiderationLedger {
  version: typeof SOURCE_CONSIDERATION_VERSION;
  sourceMaterialFingerprint: string;
  clauses: SourceClauseConsideration[];
  metadata: CapturedFieldConsideration[];
  /** Source classification only; private candidate review is a separate gate. */
  complete: boolean;
  unprocessedClauseIds: string[];
  issues: string[];
}

export interface OpportunityReviewEvidenceFit {
  kind: 'evidence_summary';
  supportedCriterionCount: number;
  uncertainCriterionCount: number;
  sourceUnknownCriterionCount: number;
  /** Prior source classification remains uncertain even when candidate support is found. */
  sourceClassificationUnknownCount: number;
  contextUnitCount: number;
  /** Supported, uncertain, and source-unknown units; context is excluded. */
  consideredCriterionCount: number;
  /** A lower bound on reviewed support, never a fit or eligibility score. */
  supportLowerBound: number | null;
  status:
    | 'supports_all_reviewed_criteria'
    | 'supported_with_uncertainties'
    | 'needs_evidence'
    | 'no_applicant_criteria';
}

export type CompleteReviewEvidenceRow = {
  status: 'strength' | 'uncertain';
  sourceDisposition: 'criterion' | 'context' | 'unknown';
  sourceClassification:
    | 'confirmed_requirement'
    | 'possible_requirement_unknown';
};

/** Counts native candidate evidence without erasing support merely because
 * the earlier source classifier was uncertain. The independent source qualifier
 * prevents an unqualified all-supported claim.
 */
export function summarizeCompleteReviewEvidence(
  rows: ReadonlyArray<CompleteReviewEvidenceRow>,
): OpportunityReviewEvidenceFit {
  let supportedCriterionCount = 0;
  let uncertainCriterionCount = 0;
  let sourceUnknownCriterionCount = 0;
  let sourceClassificationUnknownCount = 0;
  let contextUnitCount = 0;
  for (const row of rows) {
    if (row.sourceClassification === 'possible_requirement_unknown')
      sourceClassificationUnknownCount += 1;
    if (row.sourceDisposition === 'unknown') sourceUnknownCriterionCount += 1;
    else if (row.sourceDisposition === 'context') contextUnitCount += 1;
    else if (row.status === 'strength') supportedCriterionCount += 1;
    else uncertainCriterionCount += 1;
  }
  const consideredCriterionCount =
    supportedCriterionCount +
    uncertainCriterionCount +
    sourceUnknownCriterionCount;
  return {
    kind: 'evidence_summary',
    supportedCriterionCount,
    uncertainCriterionCount,
    sourceUnknownCriterionCount,
    sourceClassificationUnknownCount,
    contextUnitCount,
    consideredCriterionCount,
    supportLowerBound: consideredCriterionCount
      ? supportedCriterionCount / consideredCriterionCount
      : null,
    status: !consideredCriterionCount
      ? 'no_applicant_criteria'
      : !supportedCriterionCount
        ? 'needs_evidence'
        : !uncertainCriterionCount &&
            !sourceUnknownCriterionCount &&
            !sourceClassificationUnknownCount
          ? 'supports_all_reviewed_criteria'
          : 'supported_with_uncertainties',
  };
}

/** Structural subset of the actual V4 PRIVATE review. The native reader still
 * verifies provider result, ownership, currentness, and candidate provenance.
 */
export interface CompleteMaterialReviewForAcceptance {
  contractVersion: 'opportunity-resume-fit-review/v4-complete-material';
  mode: 'complete_material';
  evidenceFingerprint: string;
  candidateMaterialFingerprint: string;
  inputFingerprint: string;
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  evidenceFit: OpportunityReviewEvidenceFit;
  coverage: {
    candidateSourceCount: number;
    sourceComplete: boolean;
    fullFit: OpportunityReviewEvidenceFit;
    consideredComplete?: boolean;
    sourceClauseConsideration: SourceClauseConsideration[];
    metadataConsideration: CapturedFieldConsideration[];
    reviewedMaterialClauseIds: string[];
    reviewedRequirementIds: string[];
    requirementsCertainty: 'confirmed' | 'uncertain';
  };
  requirements: Array<{
    id: string;
    text: string;
    originalRequirementIds: string[];
    sourceClassification:
      | 'confirmed_requirement'
      | 'possible_requirement_unknown';
    sourceDisposition: 'criterion' | 'context' | 'unknown';
    status: 'strength' | 'uncertain';
    postingCitations: Array<{
      clauseId: string;
      start: number;
      end: number;
      quote: string;
      citationMode: 'whole_clause' | 'whole_field';
      sourceFieldPath?: string;
    }>;
  }>;
}

export interface CompleteReviewExpectedCurrent {
  candidateMaterialFingerprint: string;
  /** Recomputed by the native reader; includes the verified owner tuple. */
  inputFingerprint: string;
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  candidateSourceCount: number;
}

export interface CompleteAssessmentDisposition {
  status: 'reviewed_with_unknowns' | 'incomplete';
  consideredComplete: boolean;
  catalogClauseCount: number;
  reviewedMaterialClauseCount: number;
  possibleRequirementCount: number;
  evidenceFit: OpportunityReviewEvidenceFit;
  unprocessedClauseIds: string[];
  issues: string[];
}

export interface ScreenedOutExpectedCurrent {
  inputFingerprint: string;
  profileFingerprint: string;
  sourceContentFingerprint: string;
  sourceContentVersion: number;
}

/** A decisive coarse exclusion is a completed screen, never a full candidate
 * review. Only the native current reader may supply the joined PRIVATE receipt.
 */
export function assessCurrentScreenedOutOpportunity(
  receipt: CurrentOpportunityAssessmentScreen,
  sourceContentJson: string,
  expected: ScreenedOutExpectedCurrent,
): { status: 'screened_out' | 'incomplete'; issues: string[] } {
  const issues: string[] = [];
  let captured: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(sourceContentJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      captured = parsed as Record<string, unknown>;
  } catch {
    // Invalid current source cannot support a terminal exclusion.
  }
  if (
    !captured ||
    fingerprintOpportunitySourceContent(captured) !==
      expected.sourceContentFingerprint
  )
    issues.push('Current captured source does not match the screen.');
  if (
    receipt.outcome !== 'clear_mismatch' ||
    receipt.screen.status !== 'clear_mismatch' ||
    receipt.screen.version !== OPPORTUNITY_SCREENING_VERSION ||
    receipt.screen.holdReasons.length > 0 ||
    receipt.screen.mismatches.length === 0 ||
    receipt.inputFingerprint !== expected.inputFingerprint ||
    receipt.screen.inputFingerprint !== expected.inputFingerprint ||
    receipt.screen.profileFingerprint !== expected.profileFingerprint ||
    receipt.screen.sourceIdentity.sourceContentFingerprint !==
      expected.sourceContentFingerprint ||
    receipt.screen.sourceIdentity.sourceContentVersion !==
      expected.sourceContentVersion ||
    !receipt.requestId ||
    receipt.screen.requestId !== receipt.requestId ||
    !receipt.agentRunId ||
    receipt.reservation.calls < 1
  )
    issues.push('Screen is not a current, paid, decisive native receipt.');
  const witnesses = receipt.screen.evidence.filter((row) =>
    receipt.screen.mismatches.includes(row.dimension),
  );
  if (
    receipt.screen.mismatches.some(
      (dimension) =>
        !witnesses.some(
          (row) =>
            row.dimension === dimension &&
            row.probability >= 0.85 &&
            row.confidence >= 0.85,
        ),
    ) ||
    witnesses.some((row) => {
      const key = row.witness.path.replace('sourceContentJson.', '');
      const exact = captured?.[key];
      const span = row.witness.spanStart;
      const end = row.witness.spanEnd;
      return (
        row.evidenceScope !== 'captured_source_context' ||
        typeof exact !== 'string' ||
        (span === undefined || end === undefined
          ? row.witness.text !== exact
          : !Number.isSafeInteger(span) ||
            !Number.isSafeInteger(end) ||
            span < 0 ||
            end <= span ||
            exact.slice(span, end) !== row.witness.text)
      );
    })
  )
    issues.push('Mismatch has no exact captured-source witness.');
  return { status: issues.length ? 'incomplete' : 'screened_out', issues };
}

export function fingerprintCompleteOpportunitySourceMaterial(
  material: Omit<CompleteOpportunitySourceMaterial, 'fingerprint'>,
): string {
  return hash(material);
}

/** Classify every literal clause without promoting a low-confidence row or
 * treating an unreviewed clause as irrelevant. Native currentness and actor
 * authority are checked by the reader before this pure function is called.
 */
export function classifyCompleteOpportunitySourceMaterial(
  material: CompleteOpportunitySourceMaterial,
): SourceConsiderationLedger {
  const issues: string[] = [];
  const { fingerprint: _fingerprint, ...body } = material;
  if (
    material.version !== COMPLETE_OPPORTUNITY_SOURCE_MATERIAL_VERSION ||
    material.fingerprint !== fingerprintCompleteOpportunitySourceMaterial(body)
  )
    issues.push('Source material identity is invalid.');

  let captured: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(
      material.capturedSource.sourceContentJson,
    );
    if (value && typeof value === 'object' && !Array.isArray(value))
      captured = value as Record<string, unknown>;
  } catch {
    // Invalid captured JSON is handled as unprocessed source below.
  }
  if (
    !captured ||
    material.capturedSource.fingerprint !== hash(captured) ||
    captured.descriptionRaw !== material.context.sourceText ||
    fingerprintOpportunitySourceContent(captured) !==
      material.context.sourceFingerprint
  )
    issues.push('Captured source JSON or body does not match its identity.');

  const canonical = buildRequirementCoverageSource(material.context);
  const expectedCapturedFields = buildCompleteCapturedFieldCatalog(
    material.capturedSource.sourceContentJson,
    canonical.clauses,
    material.context.sourceText,
  );
  if (
    JSON.stringify(material.capturedFields) !==
    JSON.stringify(expectedCapturedFields)
  )
    issues.push('Captured ATS field catalog is incomplete or changed.');
  const ledger = material.ledger;
  const { audit: _cachedAudit, ...ledgerBody } = ledger;
  const ledgerFingerprint = hash(ledgerBody);
  if (
    !material.context.sourceFingerprint ||
    !Number.isSafeInteger(material.context.sourceVersion) ||
    material.context.sourceVersion < 1 ||
    ledger.version !== canonical.version ||
    ledger.sourceFingerprint !== material.context.sourceFingerprint ||
    ledger.sourceVersion !== material.context.sourceVersion ||
    ledger.extractionFingerprint !== material.context.extractionFingerprint ||
    ledger.preparedFingerprint !== canonical.preparedFingerprint
  )
    issues.push('Source and ledger identity is inconsistent.');
  if (material.extraction) {
    if (
      !material.extraction.requestId ||
      !material.extraction.agentRunId ||
      material.extraction.ledgerFingerprint !== ledgerFingerprint
    )
      issues.push(
        'Paid extraction locator does not match the original ledger.',
      );
  } else if (
    material.audit ||
    JSON.stringify(ledger) !== JSON.stringify(canonical)
  ) {
    issues.push(
      'Unpaid source may contain only the exact captured-source manifest.',
    );
  }
  if (material.audit) {
    const { fingerprint: _auditFingerprint, ...auditBody } = material.audit;
    if (
      !material.extraction ||
      material.audit.fingerprint !== hash(auditBody) ||
      material.audit.ledgerFingerprint !== ledgerFingerprint ||
      (material.audit.capturedSource &&
        (material.audit.capturedSource.extractionRequestId !==
          material.extraction.requestId ||
          material.audit.capturedSource.sourceContentJsonFingerprint !==
            material.capturedSource.fingerprint))
    )
      issues.push('Recorded source audit does not match the extraction.');
  }

  const canonicalById = new Map(canonical.clauses.map((row) => [row.id, row]));
  const sameClause = (
    left: CoverageLedger['clauses'][number],
    right: CoverageLedger['clauses'][number] | undefined,
  ) =>
    Boolean(
      right &&
        left.id === right.id &&
        left.section === right.section &&
        left.kind === right.kind &&
        left.spanStart === right.spanStart &&
        left.spanEnd === right.spanEnd &&
        left.text === right.text &&
        left.hash === right.hash,
    );
  const clauseIds = new Set(ledger.clauses.map((row) => row.id));
  if (
    canonical.clauses.length !== ledger.clauses.length ||
    clauseIds.size !== ledger.clauses.length ||
    ledger.clauses.some(
      (row, index) => !sameClause(row, canonical.clauses[index]),
    )
  )
    issues.push('Literal source clause manifest is incomplete or malformed.');
  const requirements = new Map(ledger.requirements.map((row) => [row.id, row]));
  const dispositions = new Map(
    ledger.dispositions.map((row) => [row.clauseId, row]),
  );
  if (
    requirements.size !== ledger.requirements.length ||
    dispositions.size !== ledger.dispositions.length ||
    ledger.dispositions.length !== ledger.clauses.length ||
    ledger.dispositions.some((row) => !clauseIds.has(row.clauseId)) ||
    ledger.requirements.some((row) =>
      row.clauseIds.some((id) => !clauseIds.has(id)),
    )
  )
    issues.push(
      'Source rows or dispositions have an unknown or duplicate identity.',
    );
  const audit = material.audit;
  if (
    audit &&
    (audit.acceptedRequirementIds.some((id) => !requirements.has(id)) ||
      audit.unresolvedClauseIds.some((id) => !clauseIds.has(id)))
  )
    issues.push('Recorded audit references unknown source material.');

  const accepted = new Set(audit?.acceptedRequirementIds ?? []);
  const unresolved = new Set(audit?.unresolvedClauseIds ?? []);
  const recovery = new Set(
    audit?.recovery?.unresolvedClauses.map((row) => row.clauseId) ?? [],
  );
  const clauses = ledger.clauses.map(
    (clause, index): SourceClauseConsideration => {
      const disposition = dispositions.get(clause.id);
      const originalRequirementIds = [...(disposition?.requirementIds ?? [])];
      const requirementIds = originalRequirementIds.filter((id) =>
        requirements.get(id)?.clauseIds.includes(clause.id),
      );
      const reverseIds = ledger.requirements
        .filter((row) => row.clauseIds.includes(clause.id))
        .map((row) => row.id);
      const invalidLink =
        originalRequirementIds.some((id) => !requirements.has(id)) ||
        originalRequirementIds.some((id) => !requirementIds.includes(id)) ||
        reverseIds.some((id) => !originalRequirementIds.includes(id));
      const exact = canonicalById.get(clause.id);
      const validClause =
        sameClause(clause, exact) && canonical.clauses[index]?.id === clause.id;
      const base = {
        clauseId: clause.id,
        requirementIds,
        originalRequirementIds,
      };
      if (!validClause || !disposition || issues.length)
        return { ...base, status: 'unprocessed', reason: 'invalid_source' };
      if (
        originalRequirementIds.some((id) => !requirements.has(id)) ||
        disposition.requirementIds.length !==
          new Set(disposition.requirementIds).size
      )
        return { ...base, status: 'unprocessed', reason: 'invalid_source' };
      if (invalidLink || recovery.has(clause.id))
        return {
          ...base,
          status: 'possible_requirement_unknown',
          reason: 'source_mapping',
        };
      if (
        clause.kind === 'heading' &&
        disposition.type === 'nonrequirement' &&
        disposition.exclusionRule === 'section_heading' &&
        !originalRequirementIds.length
      )
        return {
          ...base,
          status: 'certified_nonrequirement',
          reason: 'exact_heading',
        };
      if (!audit)
        return {
          ...base,
          status: 'possible_requirement_unknown',
          reason: 'missing_audit',
        };
      if (unresolved.has(clause.id))
        return {
          ...base,
          status: 'possible_requirement_unknown',
          reason: 'low_confidence',
        };
      if (
        requirementIds.length &&
        requirementIds.every((id) => accepted.has(id)) &&
        (audit.clauseRecall[clause.id] ?? 0) >= 0.85
      )
        return {
          ...base,
          status: 'confirmed_requirement',
          reason: 'audited_requirement',
        };
      if (
        !requirementIds.length &&
        ['nonrequirement', 'source_context', 'role_context'].includes(
          disposition.type,
        ) &&
        (audit.clauseContext[clause.id] ?? 1) <= 0.15
      )
        return {
          ...base,
          status: 'certified_nonrequirement',
          reason: 'audited_context',
        };
      return {
        ...base,
        status: 'possible_requirement_unknown',
        reason: 'low_confidence',
      };
    },
  );
  const metadata = material.capturedFields.map(
    (field): CapturedFieldConsideration => {
      if (issues.length)
        return {
          fieldId: field.id,
          path: field.path,
          hash: field.hash,
          bodyClauseIds: field.bodyClauseIds,
          status: 'unprocessed',
          reason: 'invalid_source',
        };
      return {
        fieldId: field.id,
        path: field.path,
        hash: field.hash,
        bodyClauseIds: field.bodyClauseIds,
        status: field.bodyClauseIds.length
          ? 'represented_in_body'
          : 'possible_requirement_unknown',
        reason: field.bodyClauseIds.length
          ? 'exact_body_coverage'
          : 'captured_field_unknown',
      };
    },
  );
  const unprocessedClauseIds = [
    ...new Set([
      ...clauses
        .filter((row) => row.status === 'unprocessed')
        .map((row) => row.clauseId),
      ...canonical.clauses
        .filter((row) => !clauseIds.has(row.id))
        .map((row) => row.id),
      ...metadata
        .filter((row) => row.status === 'unprocessed')
        .map((row) => row.fieldId),
    ]),
  ];
  return {
    version: SOURCE_CONSIDERATION_VERSION,
    sourceMaterialFingerprint: material.fingerprint,
    clauses,
    metadata,
    complete: issues.length === 0 && unprocessedClauseIds.length === 0,
    unprocessedClauseIds,
    issues,
  };
}

/** Never infer completeness from a model-supplied flag. Every noncertified
 * literal source clause must have one candidate-review row with its complete
 * exact posting citation, even when the answer is honestly uncertain.
 */
export function assessCompleteOpportunityReview(
  material: CompleteOpportunitySourceMaterial,
  review: CompleteMaterialReviewForAcceptance,
  expected: CompleteReviewExpectedCurrent,
): CompleteAssessmentDisposition {
  const source = classifyCompleteOpportunitySourceMaterial(material);
  const issues = [...source.issues];
  const reviewClauses = source.clauses.filter(
    (row) => row.status !== 'certified_nonrequirement',
  );
  const reviewFields = source.metadata.filter(
    (row) => row.status !== 'represented_in_body',
  );
  const reviewedIds = [
    ...reviewClauses.map((row) => row.clauseId),
    ...reviewFields.map((row) => row.fieldId),
  ];
  const clauseById = new Map(
    material.ledger.clauses.map((row) => [row.id, row]),
  );
  const sourceById = new Map(source.clauses.map((row) => [row.clauseId, row]));
  const fieldById = new Map(
    material.capturedFields.map((row) => [row.id, row]),
  );
  if (!source.complete) issues.push('Source catalog has unprocessed material.');
  if (
    review.contractVersion !==
      'opportunity-resume-fit-review/v4-complete-material' ||
    review.mode !== 'complete_material' ||
    review.evidenceFingerprint !== material.fingerprint ||
    review.candidateMaterialFingerprint !==
      expected.candidateMaterialFingerprint ||
    review.inputFingerprint !== expected.inputFingerprint ||
    review.sourceContentFingerprint !== expected.sourceContentFingerprint ||
    review.sourceContentFingerprint !== material.context.sourceFingerprint ||
    review.sourceContentVersion !== expected.sourceContentVersion ||
    review.sourceContentVersion !== material.context.sourceVersion ||
    review.coverage.candidateSourceCount !== expected.candidateSourceCount ||
    !review.candidateMaterialFingerprint ||
    !review.inputFingerprint
  )
    issues.push(
      'Review identity or current candidate/source material changed.',
    );
  if (
    review.coverage.sourceComplete !== source.complete ||
    JSON.stringify(review.coverage.sourceClauseConsideration) !==
      JSON.stringify(source.clauses) ||
    JSON.stringify(review.coverage.metadataConsideration) !==
      JSON.stringify(source.metadata)
  )
    issues.push('Review promotes or changes source classification.');
  if (
    JSON.stringify(review.coverage.reviewedMaterialClauseIds) !==
      JSON.stringify(reviewedIds) ||
    JSON.stringify(review.coverage.reviewedRequirementIds) !==
      JSON.stringify(reviewedIds.map((id) => `material:${id}`)) ||
    review.requirements.length !== reviewedIds.length
  )
    issues.push(
      'Review did not cover every noncertified source clause exactly once.',
    );
  for (const [index, row] of review.requirements.entries()) {
    if (
      !['strength', 'uncertain'].includes(row.status) ||
      !['criterion', 'context', 'unknown'].includes(row.sourceDisposition)
    )
      issues.push(`Review row ${index} has an invalid evidence disposition.`);
    const expectedClause = reviewClauses[index];
    if (!expectedClause) {
      const expectedField = reviewFields[index - reviewClauses.length];
      const field = expectedField && fieldById.get(expectedField.fieldId);
      if (
        !expectedField ||
        !field ||
        row.id !== `material:${field.id}` ||
        row.text !== field.text ||
        row.originalRequirementIds.length !== 0 ||
        row.sourceClassification !== 'possible_requirement_unknown' ||
        row.postingCitations.length !== 1 ||
        row.postingCitations[0]?.clauseId !== field.id ||
        row.postingCitations[0]?.start !== 0 ||
        row.postingCitations[0]?.end !== field.text.length ||
        row.postingCitations[0]?.quote !== field.text ||
        row.postingCitations[0]?.citationMode !== 'whole_field' ||
        row.postingCitations[0]?.sourceFieldPath !== field.path
      )
        issues.push(
          `Review row ${index} lacks its exact whole-field source proof.`,
        );
      continue;
    }
    const literal = expectedClause && clauseById.get(expectedClause.clauseId);
    if (
      !expectedClause ||
      !literal ||
      !sourceById.has(expectedClause.clauseId) ||
      row.id !== `material:${expectedClause.clauseId}` ||
      row.text !== literal.text ||
      JSON.stringify(row.originalRequirementIds) !==
        JSON.stringify(expectedClause.requirementIds) ||
      row.sourceClassification !== expectedClause.status ||
      row.postingCitations.length !== 1 ||
      row.postingCitations[0]?.clauseId !== literal.id ||
      row.postingCitations[0]?.start !== literal.spanStart ||
      row.postingCitations[0]?.end !== literal.spanEnd ||
      row.postingCitations[0]?.quote !== literal.text ||
      row.postingCitations[0]?.citationMode !== 'whole_clause'
    ) {
      issues.push(
        `Review row ${index} lacks its exact whole-clause source proof.`,
      );
    }
  }
  const possibleRequirementCount =
    source.clauses.filter(
      (row) => row.status === 'possible_requirement_unknown',
    ).length + reviewFields.length;
  if (
    review.coverage.requirementsCertainty !==
    (possibleRequirementCount ? 'uncertain' : 'confirmed')
  )
    issues.push('Review claims unsupported requirement certainty.');
  const evidenceFit = summarizeCompleteReviewEvidence(review.requirements);
  if (
    JSON.stringify(review.coverage.fullFit) !== JSON.stringify(evidenceFit) ||
    JSON.stringify(review.evidenceFit) !== JSON.stringify(evidenceFit)
  )
    issues.push(
      'Review evidence summary is not derived from exact reviewed units.',
    );
  const consideredComplete = issues.length === 0;
  if (
    review.coverage.consideredComplete !== undefined &&
    review.coverage.consideredComplete !== consideredComplete
  )
    issues.push(
      'Review completion flag is not derived from its source ledger.',
    );
  return {
    status: issues.length ? 'incomplete' : 'reviewed_with_unknowns',
    consideredComplete: issues.length === 0,
    catalogClauseCount: source.clauses.length + source.metadata.length,
    reviewedMaterialClauseCount: reviewedIds.length,
    possibleRequirementCount,
    evidenceFit,
    unprocessedClauseIds: source.unprocessedClauseIds,
    issues,
  };
}
