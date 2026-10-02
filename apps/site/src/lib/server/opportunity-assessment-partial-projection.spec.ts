import { createHash } from 'node:crypto';
import type { DecisionResult } from '@happyvertical/ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { opportunityAssessmentSubjectMaterialFingerprint } from './opportunity-assessment-input.js';
import {
  OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION,
  preparePartialOpportunityAssessment,
  resolvePartialOpportunityAssessment,
} from './opportunity-assessment-partial.js';
import {
  loadCurrentPartialOpportunityAssessmentProjections,
  projectCurrentPartialOpportunityAssessment,
  readRecordedPartialOpportunityAssessment,
} from './opportunity-assessment-partial-projection.js';
import { buildRequirementCoverageSource } from './opportunity-requirement-coverage.js';
import {
  partialRequirementEvidenceFromAudit,
  prepareRequirementEvidenceAudit,
  resolveRequirementEvidenceAudit,
} from './opportunity-requirement-coverage-provider.js';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  candidate: vi.fn(),
  evidence: vi.fn(),
  query: vi.fn(),
}));
vi.mock('./private-workspace.js', async (original) => ({
  ...(await original<typeof import('./private-workspace.js')>()),
  listPrivateRecords: mocks.list,
}));
vi.mock('./resume-data.js', () => ({
  loadWorkspaceCandidateEvidence: mocks.candidate,
}));
vi.mock('./opportunity-requirement-coverage-provider.js', async (original) => ({
  ...(await original<
    typeof import('./opportunity-requirement-coverage-provider.js')
  >()),
  readPartialOpportunityRequirementEvidence: mocks.evidence,
}));
vi.mock('@happyvertical/smrt-core', async (original) => ({
  ...(await original<typeof import('@happyvertical/smrt-core')>()),
  resolveDatabase: async () => ({ query: mocks.query }),
}));
vi.mock('./db.js', () => ({
  getDbConfig: () => ({ type: 'sqlite', url: 'unit-only' }),
}));
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture() {
  const subject = { tenantId: 'tenant', userId: 'user', profileId: 'profile' };
  const opportunity = {
    id: 'role',
    sourceContentFingerprint: 'source',
    sourceContentVersion: 1,
  };
  const context = {
    sourceText:
      'Requirements\nFamiliarity with Kubernetes.\nCompany context remains unresolved.',
    sourceFingerprint: 'source',
    sourceVersion: 1,
    extractionFingerprint: 'extract',
  };
  const ledger = buildRequirementCoverageSource(context);
  ledger.requirements = [
    {
      id: 'k8',
      text: 'Familiarity with Kubernetes.',
      clauseIds: [ledger.clauses[1]!.id],
      importance: 'unknown',
    },
  ];
  ledger.dispositions = ledger.clauses.map((clause, i) =>
    i === 0
      ? {
          clauseId: clause.id,
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: 'section_heading',
        }
      : i === 1
        ? {
            clauseId: clause.id,
            type: 'material_requirement',
            requirementIds: ['k8'],
          }
        : { clauseId: clause.id, type: 'source_context', requirementIds: [] },
  );
  const auditPrepared = prepareRequirementEvidenceAudit(context, ledger);
  const sourceDecision: DecisionResult = {
    model: 'test',
    provenance: { model: 'test', provider: 'typesafe' },
    answers: Object.fromEntries(
      Object.entries(auditPrepared.bindings).map(([key, binding]) => [
        key,
        {
          type: 'predicate',
          probability:
            binding.mode === 'recall'
              ? 0.6
              : binding.mode === 'context'
                ? 0.4
                : 0.95,
        },
      ]),
    ),
  };
  const evidence = partialRequirementEvidenceFromAudit(
    auditPrepared,
    resolveRequirementEvidenceAudit(
      auditPrepared,
      sourceDecision,
      'source-receipt',
    ),
  );
  const candidate = {
    subject,
    fingerprint: 'candidate',
    candidate: {} as never,
    evidence: [
      {
        id: 'skill:k8',
        kind: 'skill' as const,
        text: 'Kubernetes',
        title: 'Kubernetes',
        recordId: 'skill-record',
        sectionId: 'technical',
      },
      {
        id: 'employment:platform',
        kind: 'employment' as const,
        text: 'Operated Kubernetes clusters for the platform team.',
        title: 'Platform engineer',
        recordId: 'employment-record',
        sectionId: 'duties',
      },
    ],
  };
  const prepared = preparePartialOpportunityAssessment({
    opportunityId: 'role',
    evidence,
    candidateSources: candidate.evidence,
    candidateMaterialFingerprint: candidate.fingerprint,
  });
  const decision: DecisionResult = {
    model: 'test',
    provenance: { model: 'test', provider: 'typesafe' },
    answers: Object.fromEntries(
      Object.keys(prepared.bindings).map((key) => [
        key,
        { type: 'predicate', probability: 0.95 },
      ]),
    ),
  };
  const subjectFingerprint = opportunityAssessmentSubjectMaterialFingerprint({
    candidateMaterialFingerprint: candidate.fingerprint,
    sourceContentFingerprint: 'source',
    sourceContentVersion: 1,
    requirementCoverageFingerprint: evidence.fingerprint,
    subject,
  });
  const inputFingerprint = hash({
    prepared: prepared.fingerprint,
    subject: subjectFingerprint,
  });
  const result = {
    ...resolvePartialOpportunityAssessment(prepared, decision, evidence),
    requestId: 'private-receipt',
    inputFingerprint,
  };
  const row = {
    tenantId: subject.tenantId,
    ownerUserId: subject.userId,
    candidateProfileId: subject.profileId,
    opportunityId: 'role',
    agentRunId: 'private-run',
    status: 'partial',
    matchReadiness: 'needs_evidence',
    contractVersion: OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION,
    candidateMaterialFingerprint: candidate.fingerprint,
    sourceContentFingerprint: 'source',
    sourceContentVersion: 1,
    assessmentFingerprint: result.fingerprint,
    assessmentJson: JSON.stringify(result),
  };
  const receipt = {
    owner_request_id: result.requestId,
    request_id: result.requestId,
    output_json: JSON.stringify(decision),
    opportunity_id: 'role',
    agent_run_id: 'private-run',
    content_fingerprint: 'source',
    input_fingerprint: inputFingerprint,
    feature: 'opportunity-assessment-partial',
    profile: 'typesafe-opportunity-assessment-partial',
    model: 'test',
    output_schema_version: OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION,
    prompt_version: OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION,
    prepared_payload_version: OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION,
    result_status: 'completed',
    request_status: 'succeeded',
    accounting_basis: 'actual',
    actual_total_tokens: 200,
    tenant_id: subject.tenantId,
    owner_user_id: subject.userId,
    candidate_profile_id: subject.profileId,
    request_tenant_id: subject.tenantId,
    request_owner_user_id: subject.userId,
    request_candidate_profile_id: subject.profileId,
  };
  return {
    row,
    opportunity,
    subject,
    candidate,
    evidence,
    decision,
    result,
    receipt,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  const f = fixture();
  mocks.list.mockResolvedValue([f.row]);
  mocks.candidate.mockResolvedValue(f.candidate);
  mocks.evidence.mockResolvedValue(f.evidence);
  mocks.query.mockResolvedValue({ rows: [f.receipt] });
});

describe('current partial projection', () => {
  it('reloads owned actual source/private evidence with exact quotes and no ranking or overall fit fields', async () => {
    const f = fixture();
    const first = await loadCurrentPartialOpportunityAssessmentProjections({
      opportunities: [f.opportunity],
      subject: f.subject,
    });
    const reload = await loadCurrentPartialOpportunityAssessmentProjections({
      opportunities: [f.opportunity],
      subject: f.subject,
    });
    expect(reload).toEqual(first);
    expect(first.get('role')).toMatchObject({
      mode: 'partial',
      sourceStatus: 'current',
      criterionCount: 1,
      supportedCriterionCount: 1,
      unresolvedSourceClauseCount: 2,
      requirements: [
        {
          text: 'Familiarity with Kubernetes.',
          postingCitations: [{ excerpt: 'Familiarity with Kubernetes.' }],
          candidateCitations: expect.arrayContaining([
            expect.objectContaining({
              excerpt: 'Kubernetes',
              recordId: 'skill-record',
              sectionId: 'technical',
            }),
            expect.objectContaining({
              excerpt: 'Operated Kubernetes clusters for the platform team.',
              recordId: 'employment-record',
              sectionId: 'duties',
            }),
          ]),
        },
      ],
    });
    expect(JSON.stringify(first.get('role'))).not.toMatch(
      /fitScore|eligibility|ranking|answerProbabilities|provenance|requestId|candidateMaterialFingerprint/,
    );
    expect(mocks.evidence).toHaveBeenCalledWith(f.opportunity);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.list).toHaveBeenCalledWith(
      'OpportunityAssessment',
      f.subject,
      expect.objectContaining({
        where: {
          'opportunityId in': ['role'],
          status: 'partial',
          contractVersion: OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION,
        },
      }),
    );
  });
  it.each([
    'tenantId',
    'ownerUserId',
    'candidateProfileId',
  ])('rejects foreign %s even when a private store returns it', async (field) => {
    const f = fixture();
    mocks.list.mockResolvedValue([{ ...f.row, [field]: 'foreign' }]);
    expect(
      (
        await loadCurrentPartialOpportunityAssessmentProjections({
          opportunities: [f.opportunity],
          subject: f.subject,
        })
      ).size,
    ).toBe(0);
    expect(mocks.evidence).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each([
    'source',
    'candidate',
    'evidence',
  ])('rejects stale %s material on reload', async (changed) => {
    const f = fixture();
    const opportunity =
      changed === 'source'
        ? { ...f.opportunity, sourceContentVersion: 2 }
        : f.opportunity;
    if (changed === 'candidate')
      mocks.candidate.mockResolvedValue({
        ...f.candidate,
        fingerprint: 'candidate-revised',
      });
    if (changed === 'evidence')
      mocks.evidence.mockResolvedValue({
        ...f.evidence,
        fingerprint: 'evidence-revised',
      });
    expect(
      (
        await loadCurrentPartialOpportunityAssessmentProjections({
          opportunities: [opportunity],
          subject: f.subject,
        })
      ).size,
    ).toBe(0);
  });
  it('requires actual GLOBAL source evidence and does not authorize cache-only private JSON', async () => {
    const f = fixture();
    mocks.evidence.mockResolvedValue(undefined);
    expect(
      (
        await loadCurrentPartialOpportunityAssessmentProjections({
          opportunities: [f.opportunity],
          subject: f.subject,
        })
      ).size,
    ).toBe(0);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('rejects missing private locator and forged cached supported answers', async () => {
    const f = fixture();
    mocks.list.mockResolvedValue([
      {
        ...f.row,
        assessmentJson: JSON.stringify({ ...f.result, requestId: undefined }),
      },
    ]);
    expect(
      (
        await loadCurrentPartialOpportunityAssessmentProjections({
          opportunities: [f.opportunity],
          subject: f.subject,
        })
      ).size,
    ).toBe(0);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(
      projectCurrentPartialOpportunityAssessment({
        ...f,
        decision: {
          ...f.decision,
          answers: Object.fromEntries(
            Object.keys(f.decision.answers).map((key) => [
              key,
              { type: 'predicate', probability: 0.1 },
            ]),
          ),
        },
      }),
    ).toBeNull();
  });
  it.each([
    { accounting_basis: 'conservative' },
    { request_status: 'failed' },
    { actual_total_tokens: 0 },
    { request_owner_user_id: 'foreign' },
    { input_fingerprint: 'forged' },
    { output_schema_version: 'unknown/v0' },
  ])('rejects unattested private receipt %j', async (change) => {
    const f = fixture();
    mocks.query.mockResolvedValue({ rows: [{ ...f.receipt, ...change }] });
    expect(await readRecordedPartialOpportunityAssessment(f)).toBeUndefined();
  });
  it('rejects orphan and ambiguous private receipts', async () => {
    const f = fixture();
    mocks.query.mockResolvedValue({ rows: [] });
    expect(await readRecordedPartialOpportunityAssessment(f)).toBeUndefined();
    mocks.query.mockResolvedValue({ rows: [f.receipt, f.receipt] });
    expect(await readRecordedPartialOpportunityAssessment(f)).toBeUndefined();
  });
});
