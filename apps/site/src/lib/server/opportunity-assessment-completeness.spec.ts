import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assessCompleteOpportunityReview,
  assessCurrentScreenedOutOpportunity,
  buildCompleteCapturedFieldCatalog,
  COMPLETE_OPPORTUNITY_SOURCE_MATERIAL_VERSION,
  type CompleteMaterialReviewForAcceptance,
  type CompleteOpportunitySourceMaterial,
  classifyCompleteOpportunitySourceMaterial,
  fingerprintCompleteOpportunitySourceMaterial,
  summarizeCompleteReviewEvidence,
} from './opportunity-assessment-completeness.js';
import {
  buildRequirementCoverageSource,
  type CoverageLedger,
} from './opportunity-requirement-coverage.js';
import {
  REQUIREMENT_EVIDENCE_CAPTURED_SOURCE_AUDIT_VERSION,
  type RequirementEvidenceAudit,
} from './opportunity-requirement-coverage-provider.js';
import type { CurrentOpportunityAssessmentScreen } from './opportunity-screening-provider.js';
import { fingerprintOpportunitySourceContent } from './opportunity-source-content.js';

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Compact literal regression for the paid Northbeam source failure. The actual
// public receipt is native-canada-v3-role-01-source-stage-completed-extraction-
// public.json: r26/r27, r28, r31/r32 had exact reciprocal spans but low
// independent row relevance. No candidate or private receipt is copied here.
const sourceText = [
  '<h2>Qualifications</h2>',
  '- 5+ years of expertise in building frontend and backend systems with TypeScript',
  '- 3+ years of expertise with modern component-based libraries such as React',
  '- Proficiency in SQL and BigQuery',
].join('\n');

function materialFixture(paid = true): CompleteOpportunitySourceMaterial {
  const captured = {
    descriptionRaw: sourceText,
    locationNotes: 'Remote - Canada; Remote, United States',
    workMode: 'remote',
  };
  const sourceContentJson = JSON.stringify(captured);
  const context = {
    extractionContract: 'current' as const,
    sourceText,
    sourceFingerprint: fingerprintOpportunitySourceContent(captured),
    sourceVersion: 1,
    extractionFingerprint: 'paid-extraction-fingerprint',
    preparedFingerprint: 'prepared-posting-fingerprint',
  };
  const ledger = buildRequirementCoverageSource(context);
  if (paid) {
    const clauses = ledger.clauses.filter((clause) => clause.kind === 'body');
    if (clauses.length !== 3) throw new Error('Unexpected literal fixture.');
    ledger.requirements = [
      {
        id: 'r26',
        text: 'Have 5+ years building frontend systems with TypeScript.',
        clauseIds: [clauses[0]!.id],
        importance: 'required',
      },
      {
        id: 'r27',
        text: 'Have 5+ years building backend systems with TypeScript.',
        clauseIds: [clauses[0]!.id],
        importance: 'required',
      },
      {
        id: 'r28',
        text: 'Have 3+ years with React.',
        clauseIds: [clauses[1]!.id],
        importance: 'required',
      },
      {
        id: 'r31',
        text: 'Be proficient in SQL.',
        clauseIds: [clauses[2]!.id],
        importance: 'required',
      },
      {
        id: 'r32',
        text: 'Be proficient in BigQuery.',
        clauseIds: [clauses[2]!.id],
        importance: 'required',
      },
    ];
    ledger.dispositions = ledger.dispositions.map((row) => {
      const requirementIds = ledger.requirements
        .filter((requirement) => requirement.clauseIds.includes(row.clauseId))
        .map((requirement) => requirement.id);
      return requirementIds.length
        ? {
            clauseId: row.clauseId,
            type: 'material_requirement',
            requirementIds,
          }
        : row;
    });
  }
  const { audit: _audit, ...ledgerBody } = ledger;
  const value: Omit<CompleteOpportunitySourceMaterial, 'fingerprint'> = {
    version: COMPLETE_OPPORTUNITY_SOURCE_MATERIAL_VERSION,
    context,
    ledger,
    capturedSource: {
      sourceContentJson,
      fingerprint: hash(captured),
    },
    capturedFields: buildCompleteCapturedFieldCatalog(
      sourceContentJson,
      ledger.clauses,
      sourceText,
    ),
    ...(paid
      ? {
          extraction: {
            requestId: 'paid-global-extraction',
            agentRunId: 'original-run',
            ledgerFingerprint: hash(ledgerBody),
          },
        }
      : {}),
  };
  return {
    ...value,
    fingerprint: fingerprintCompleteOpportunitySourceMaterial(value),
  };
}

function withAudit(
  material: CompleteOpportunitySourceMaterial,
  acceptedRequirementIds: string[] = [],
): CompleteOpportunitySourceMaterial {
  const body = material.ledger.clauses.filter(
    (clause) => clause.kind === 'body',
  );
  const auditBody: Omit<RequirementEvidenceAudit, 'fingerprint'> = {
    version: REQUIREMENT_EVIDENCE_CAPTURED_SOURCE_AUDIT_VERSION,
    ledgerFingerprint: material.extraction!.ledgerFingerprint,
    inputFingerprint: 'actual-global-audit-input',
    requestId: 'actual-global-audit',
    answerProbabilities: {},
    rowSupport: Object.fromEntries(
      material.ledger.requirements.map((row) => [row.id, 0.94]),
    ),
    rowRelevance: Object.fromEntries(
      material.ledger.requirements.map((row) => [row.id, 0.63]),
    ),
    capturedSource: {
      extractionRequestId: material.extraction!.requestId,
      sourceContentJsonFingerprint: material.capturedSource.fingerprint,
    },
    clausePrecision: {},
    clauseRecall: Object.fromEntries(body.map((clause) => [clause.id, 0.9])),
    clauseContext: {},
    acceptedRequirementIds,
    unresolvedClauseIds: body.map((clause) => clause.id),
    fullCoverage: false,
  };
  const audit = { ...auditBody, fingerprint: hash(auditBody) };
  const value = { ...material, audit };
  const { fingerprint: _fingerprint, ...withoutFingerprint } = value;
  return {
    ...withoutFingerprint,
    fingerprint:
      fingerprintCompleteOpportunitySourceMaterial(withoutFingerprint),
  };
}

describe('complete source consideration ledger', () => {
  it('keeps every exact low-confidence reciprocal hard requirement as possible material', () => {
    const material = withAudit(materialFixture());
    const result = classifyCompleteOpportunitySourceMaterial(material);
    expect(result.complete).toBe(true);
    expect(result.unprocessedClauseIds).toEqual([]);
    expect(result.clauses.map((row) => row.status)).toEqual([
      'certified_nonrequirement',
      'possible_requirement_unknown',
      'possible_requirement_unknown',
      'possible_requirement_unknown',
    ]);
    expect(result.clauses[1]?.requirementIds).toEqual(['r26', 'r27']);
    expect(result.clauses[2]?.requirementIds).toEqual(['r28']);
    expect(result.clauses[3]?.requirementIds).toEqual(['r31', 'r32']);
    expect(material.capturedSource.sourceContentJson).toContain(
      'Remote - Canada',
    );
    expect(
      result.metadata.find(
        (field) => field.fieldId === 'source-field:locationNotes',
      ),
    ).toMatchObject({
      status: 'possible_requirement_unknown',
      bodyClauseIds: [],
    });
    expect(result).not.toHaveProperty('eligibility');
    expect(result).not.toHaveProperty('fitScore');
  });

  it('keeps untouched captured clauses possible without inventing paid extraction or audit', () => {
    const material = materialFixture(false);
    const result = classifyCompleteOpportunitySourceMaterial(material);
    expect(result.complete).toBe(true);
    expect(result.clauses[0]?.status).toBe('certified_nonrequirement');
    expect(result.clauses.slice(1).map((row) => row.status)).toEqual([
      'possible_requirement_unknown',
      'possible_requirement_unknown',
      'possible_requirement_unknown',
    ]);
    expect(
      result.clauses.slice(1).every((row) => !row.requirementIds.length),
    ).toBe(true);
  });

  it('denies metadata-only drift even if a caller recomputes the material fingerprint', () => {
    const material = materialFixture();
    const captured = JSON.parse(
      material.capturedSource.sourceContentJson,
    ) as Record<string, unknown>;
    captured.locationNotes = 'Remote U.S. only';
    material.capturedSource.sourceContentJson = JSON.stringify(captured);
    material.capturedSource.fingerprint = hash(captured);
    const { fingerprint: _fingerprint, ...body } = material;
    material.fingerprint = fingerprintCompleteOpportunitySourceMaterial(body);
    const result = classifyCompleteOpportunitySourceMaterial(material);
    expect(result.complete).toBe(false);
    expect(result.unprocessedClauseIds).toEqual(
      expect.arrayContaining(
        material.ledger.clauses.map((clause) => clause.id),
      ),
    );
    expect(result.issues).toContain(
      'Captured source JSON or body does not match its identity.',
    );
  });

  it('denies missing or malformed literal spans instead of counting them as reviewed', () => {
    for (const change of ['missing', 'span'] as const) {
      const material = materialFixture();
      if (change === 'missing') material.ledger.clauses.pop();
      else material.ledger.clauses[1]!.spanEnd -= 1;
      const { audit: _audit, ...ledgerBody } = material.ledger;
      material.extraction!.ledgerFingerprint = hash(ledgerBody);
      const { fingerprint: _fingerprint, ...body } = material;
      material.fingerprint = fingerprintCompleteOpportunitySourceMaterial(body);
      const result = classifyCompleteOpportunitySourceMaterial(material);
      expect(result.complete).toBe(false);
      expect(result.unprocessedClauseIds.length).toBeGreaterThan(0);
    }
  });

  it('retains known broken reciprocal edges as possible, but denies unknown row identities', () => {
    const material = materialFixture();
    material.ledger.dispositions[1]!.requirementIds.push('r28');
    const { audit: _audit, ...ledgerBody } = material.ledger;
    material.extraction!.ledgerFingerprint = hash(ledgerBody);
    const { fingerprint: _fingerprint, ...body } = material;
    material.fingerprint = fingerprintCompleteOpportunitySourceMaterial(body);
    const known = classifyCompleteOpportunitySourceMaterial(material);
    expect(known.complete).toBe(true);
    expect(known.clauses[1]?.status).toBe('possible_requirement_unknown');
    expect(known.clauses[1]?.requirementIds).toEqual(['r26', 'r27']);
    expect(known.clauses[1]?.originalRequirementIds).toContain('r28');

    material.ledger.dispositions[1]!.requirementIds.push('invented-row');
    const { audit: _nextAudit, ...nextLedgerBody } = material.ledger;
    material.extraction!.ledgerFingerprint = hash(nextLedgerBody);
    const { fingerprint: _nextFingerprint, ...nextBody } = material;
    material.fingerprint =
      fingerprintCompleteOpportunitySourceMaterial(nextBody);
    const unknown = classifyCompleteOpportunitySourceMaterial(material);
    expect(unknown.complete).toBe(false);
    expect(unknown.clauses[1]?.status).toBe('unprocessed');
  });

  it('requires exact review of every possible body clause and uncovered ATS field', () => {
    const material = withAudit(materialFixture());
    const source = classifyCompleteOpportunitySourceMaterial(material);
    const body = source.clauses.filter(
      (row) => row.status !== 'certified_nonrequirement',
    );
    const metadata = source.metadata.filter(
      (row) => row.status !== 'represented_in_body',
    );
    const bodyById = new Map(
      material.ledger.clauses.map((row) => [row.id, row]),
    );
    const fieldsById = new Map(
      material.capturedFields.map((row) => [row.id, row]),
    );
    const reviewedIds = [
      ...body.map((row) => row.clauseId),
      ...metadata.map((row) => row.fieldId),
    ];
    const requirements: CompleteMaterialReviewForAcceptance['requirements'] = [
      ...body.map((row) => {
        const clause = bodyById.get(row.clauseId)!;
        return {
          id: `material:${row.clauseId}`,
          text: clause.text,
          originalRequirementIds: row.requirementIds,
          sourceClassification: row.status as 'possible_requirement_unknown',
          sourceDisposition: 'unknown' as const,
          status: 'uncertain' as const,
          postingCitations: [
            {
              clauseId: row.clauseId,
              start: clause.spanStart,
              end: clause.spanEnd,
              quote: clause.text,
              citationMode: 'whole_clause' as const,
            },
          ],
        };
      }),
      ...metadata.map((row) => {
        const field = fieldsById.get(row.fieldId)!;
        return {
          id: `material:${field.id}`,
          text: field.text,
          originalRequirementIds: [],
          sourceClassification: 'possible_requirement_unknown' as const,
          sourceDisposition: 'unknown' as const,
          status: 'uncertain' as const,
          postingCitations: [
            {
              clauseId: field.id,
              start: 0,
              end: field.text.length,
              quote: field.text,
              citationMode: 'whole_field' as const,
              sourceFieldPath: field.path,
            },
          ],
        };
      }),
    ];
    const evidenceFit = summarizeCompleteReviewEvidence(requirements);
    const review: CompleteMaterialReviewForAcceptance = {
      contractVersion: 'opportunity-resume-fit-review/v4-complete-material',
      mode: 'complete_material',
      evidenceFingerprint: material.fingerprint,
      candidateMaterialFingerprint: 'owned-current-candidate',
      inputFingerprint: 'native-owner-bound-input',
      sourceContentFingerprint: material.context.sourceFingerprint,
      sourceContentVersion: material.context.sourceVersion,
      evidenceFit,
      coverage: {
        candidateSourceCount: 150,
        sourceComplete: true,
        fullFit: evidenceFit,
        sourceClauseConsideration: source.clauses,
        metadataConsideration: source.metadata,
        reviewedMaterialClauseIds: reviewedIds,
        reviewedRequirementIds: reviewedIds.map((id) => `material:${id}`),
        requirementsCertainty: 'uncertain',
      },
      requirements,
    };
    const expected = {
      candidateMaterialFingerprint: review.candidateMaterialFingerprint,
      inputFingerprint: review.inputFingerprint,
      sourceContentFingerprint: review.sourceContentFingerprint,
      sourceContentVersion: review.sourceContentVersion,
      candidateSourceCount: 150,
    };
    expect(
      assessCompleteOpportunityReview(material, review, expected),
    ).toMatchObject({
      status: 'reviewed_with_unknowns',
      consideredComplete: true,
      reviewedMaterialClauseCount: reviewedIds.length,
    });
    const missing = structuredClone(review);
    missing.requirements.pop();
    expect(
      assessCompleteOpportunityReview(material, missing, expected).status,
    ).toBe('incomplete');
    const forgedCitation = structuredClone(review);
    forgedCitation.requirements.at(-1)!.postingCitations[0]!.quote =
      'Remote in Canada';
    expect(
      assessCompleteOpportunityReview(material, forgedCitation, expected)
        .status,
    ).toBe('incomplete');
    const inflatedFit = structuredClone(review);
    inflatedFit.coverage.fullFit.supportedCriterionCount = 99;
    expect(
      assessCompleteOpportunityReview(material, inflatedFit, expected).status,
    ).toBe('incomplete');
    const staleCandidate = {
      ...expected,
      candidateMaterialFingerprint: 'foreign-candidate',
    };
    expect(
      assessCompleteOpportunityReview(material, review, staleCandidate).status,
    ).toBe('incomplete');
    const staleOwner = { ...expected, inputFingerprint: 'foreign-owner-input' };
    expect(
      assessCompleteOpportunityReview(material, review, staleOwner).status,
    ).toBe('incomplete');
  });

  it('does not trust omitted or substituted captured ATS metadata even with a recomputed fingerprint', () => {
    const material = materialFixture();
    material.capturedFields = material.capturedFields.filter(
      (field) => field.id !== 'source-field:locationNotes',
    );
    const { fingerprint: _fingerprint, ...body } = material;
    material.fingerprint = fingerprintCompleteOpportunitySourceMaterial(body);
    const result = classifyCompleteOpportunitySourceMaterial(material);
    expect(result.complete).toBe(false);
    expect(result.issues).toContain(
      'Captured ATS field catalog is incomplete or changed.',
    );
  });

  it('keeps a cited current V4 exclusion distinct from a full candidate review', () => {
    const material = materialFixture(false);
    const captured = JSON.parse(
      material.capturedSource.sourceContentJson,
    ) as Record<string, string>;
    const expected = {
      inputFingerprint: 'current-private-owner-bound-input',
      profileFingerprint: 'current-owned-profile',
      sourceContentFingerprint: material.context.sourceFingerprint,
      sourceContentVersion: material.context.sourceVersion,
    };
    const receipt = {
      outcome: 'clear_mismatch',
      agentRunId: 'original-run',
      requestId: 'actual-private-screen',
      inputFingerprint: expected.inputFingerprint,
      reservation: { calls: 1, reservedTokens: 4524, spendMicros: 900 },
      screen: {
        version: 'opportunity-screening/v4-independent-source-entailment',
        status: 'clear_mismatch',
        requestId: 'actual-private-screen',
        inputFingerprint: expected.inputFingerprint,
        sourceFingerprint: expected.sourceContentFingerprint,
        profileFingerprint: expected.profileFingerprint,
        sourceIdentity: {
          sourceContentFingerprint: expected.sourceContentFingerprint,
          sourceContentVersion: expected.sourceContentVersion,
        },
        evidence: [
          {
            dimension: 'role_mismatch',
            probability: 0.94,
            confidence: 0.91,
            witness: {
              id: 'source:context',
              path: 'sourceContentJson.descriptionRaw',
              text: captured.descriptionRaw,
              spanStart: 0,
              spanEnd: captured.descriptionRaw.length,
            },
            evidenceScope: 'captured_source_context',
          },
        ],
        mismatches: ['role_mismatch'],
        holdReasons: [],
      },
    } as unknown as CurrentOpportunityAssessmentScreen;
    expect(
      assessCurrentScreenedOutOpportunity(
        receipt,
        material.capturedSource.sourceContentJson,
        expected,
      ),
    ).toMatchObject({ status: 'screened_out', issues: [] });
    receipt.screen.evidence[0]!.witness.text = 'unsupported role summary';
    expect(
      assessCurrentScreenedOutOpportunity(
        receipt,
        material.capturedSource.sourceContentJson,
        expected,
      ).status,
    ).toBe('incomplete');
    receipt.screen.evidence[0]!.witness.text = captured.descriptionRaw;
    receipt.screen.evidence[0]!.confidence = 0.7;
    expect(
      assessCurrentScreenedOutOpportunity(
        receipt,
        material.capturedSource.sourceContentJson,
        expected,
      ).status,
    ).toBe('incomplete');
    receipt.screen.evidence[0]!.confidence = 0.91;
    expect(
      assessCurrentScreenedOutOpportunity(
        receipt,
        material.capturedSource.sourceContentJson,
        { ...expected, profileFingerprint: 'stale-profile' },
      ).status,
    ).toBe('incomplete');
  });
});

describe('complete review evidence summary', () => {
  it('counts all supported confirmed criteria without claiming legal eligibility', () => {
    expect(
      summarizeCompleteReviewEvidence([
        {
          status: 'strength',
          sourceDisposition: 'criterion',
          sourceClassification: 'confirmed_requirement',
        },
        {
          status: 'strength',
          sourceDisposition: 'criterion',
          sourceClassification: 'confirmed_requirement',
        },
      ]),
    ).toMatchObject({
      supportedCriterionCount: 2,
      uncertainCriterionCount: 0,
      sourceUnknownCriterionCount: 0,
      sourceClassificationUnknownCount: 0,
      consideredCriterionCount: 2,
      supportLowerBound: 1,
      status: 'supports_all_reviewed_criteria',
    });
  });

  it('retains supported candidate evidence from source-possible material with a visible qualifier', () => {
    expect(
      summarizeCompleteReviewEvidence([
        {
          status: 'strength',
          sourceDisposition: 'criterion',
          sourceClassification: 'possible_requirement_unknown',
        },
        {
          status: 'uncertain',
          sourceDisposition: 'criterion',
          sourceClassification: 'confirmed_requirement',
        },
        {
          status: 'uncertain',
          sourceDisposition: 'unknown',
          sourceClassification: 'possible_requirement_unknown',
        },
        {
          status: 'uncertain',
          sourceDisposition: 'context',
          sourceClassification: 'confirmed_requirement',
        },
      ]),
    ).toMatchObject({
      supportedCriterionCount: 1,
      uncertainCriterionCount: 1,
      sourceUnknownCriterionCount: 1,
      sourceClassificationUnknownCount: 2,
      contextUnitCount: 1,
      consideredCriterionCount: 3,
      supportLowerBound: 1 / 3,
      status: 'supported_with_uncertainties',
    });
  });

  it('reports evidence needs when no criterion has support', () => {
    expect(
      summarizeCompleteReviewEvidence([
        {
          status: 'uncertain',
          sourceDisposition: 'criterion',
          sourceClassification: 'confirmed_requirement',
        },
      ]).status,
    ).toBe('needs_evidence');
  });

  it('excludes confirmed context from the criterion denominator', () => {
    expect(
      summarizeCompleteReviewEvidence([
        {
          status: 'uncertain',
          sourceDisposition: 'context',
          sourceClassification: 'confirmed_requirement',
        },
      ]),
    ).toMatchObject({
      contextUnitCount: 1,
      consideredCriterionCount: 0,
      supportLowerBound: null,
      status: 'no_applicant_criteria',
    });
  });
});
