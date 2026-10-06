import type { DecisionResult } from '@happyvertical/ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPartialOpportunityAssessmentPostingInput } from './opportunity-assessment-input.js';
import {
  evaluatePartialOpportunityAssessment,
  OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION,
  preflightPartialOpportunityAssessment,
  preparePartialOpportunityAssessment,
  resolvePartialOpportunityAssessment,
  storePartialOpportunityAssessment,
} from './opportunity-assessment-partial.js';
import { buildRequirementCoverageSource } from './opportunity-requirement-coverage.js';
import {
  partialRequirementEvidenceFromAudit,
  prepareQuarantinedSourceCompositeRequirementEvidenceAudit,
  prepareRequirementEvidenceAudit,
  resolveRequirementEvidenceAudit,
} from './opportunity-requirement-coverage-provider.js';

import { fingerprintOpportunitySourceContent } from './opportunity-source-content.js';

const mocks = vi.hoisted(() => ({
  readEvidence: vi.fn(),
  governed: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
}));
vi.mock('./opportunity-requirement-coverage-provider.js', async (original) => ({
  ...(await original<
    typeof import('./opportunity-requirement-coverage-provider.js')
  >()),
  readPartialOpportunityRequirementEvidence: mocks.readEvidence,
}));
vi.mock('./opportunity-intelligence-governance.js', () => ({
  executeGovernedOpportunityIntelligenceRequest: mocks.governed,
}));
vi.mock('./private-workspace.js', () => ({
  createPrivateRecord: mocks.create,
  listPrivateRecords: mocks.list,
}));
function fixture(skill = 'Kubernetes') {
  const context = {
    sourceText: `Requirements\nFamiliarity with ${skill}.\nCompany marketing is unresolved.`,
    sourceFingerprint: 'source-1',
    sourceVersion: 1,
    extractionFingerprint: 'extract-1',
  };
  const ledger = buildRequirementCoverageSource(context);
  ledger.requirements = [
    {
      id: 'k8',
      text: `Familiarity with ${skill}.`,
      clauseIds: [ledger.clauses[1]!.id],
      importance: 'required',
    },
  ];
  ledger.dispositions = ledger.clauses.map((clause, index) =>
    index === 0
      ? {
          clauseId: clause.id,
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: 'section_heading',
        }
      : index === 1
        ? {
            clauseId: clause.id,
            type: 'material_requirement',
            requirementIds: ['k8'],
          }
        : { clauseId: clause.id, type: 'source_context', requirementIds: [] },
  );
  const auditPrepared = prepareRequirementEvidenceAudit(context, ledger);
  const decisions: DecisionResult = {
    model: 'test',
    provenance: { model: 'test', provider: 'typesafe' },
    answers: Object.fromEntries(
      Object.entries(auditPrepared.bindings).map(([key, row]) => [
        key,
        {
          type: 'predicate',
          probability:
            row.mode === 'recall' ? 0.6 : row.mode === 'context' ? 0.4 : 0.95,
        },
      ]),
    ),
  };
  const evidence = partialRequirementEvidenceFromAudit(
    auditPrepared,
    resolveRequirementEvidenceAudit(auditPrepared, decisions, 'actual-source'),
  );
  const candidateSources = [
    {
      id: `skill:${skill}`,
      kind: 'skill',
      title: skill,
      text: skill,
    },
    {
      id: 'employment:platform',
      kind: 'employment',
      title: 'Platform engineer',
      text: 'Owned platform services and service-mesh diagnostics.',
    },
  ];
  const prepared = preparePartialOpportunityAssessment({
    opportunityId: 'role-1',
    evidence,
    candidateSources,
    candidateMaterialFingerprint: 'candidate-1',
  });
  const result: DecisionResult = {
    model: 'test',
    provenance: { model: 'test', provider: 'typesafe' },
    answers: Object.fromEntries(
      Object.keys(prepared.bindings).map((key) => [
        key,
        { type: 'predicate', probability: key.includes('c0') ? 0.95 : 0.2 },
      ]),
    ),
  };
  return { evidence, candidateSources, prepared, result };
}
const subject = {
  tenantId: 'tenant-1',
  userId: 'owner-1',
  profileId: 'profile-1',
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue([]);
});
describe('partial private requirement evidence', () => {
  it('passes accepted excerpts only and retains exact provenance without unresolved raw criteria', () => {
    const { evidence, prepared } = fixture();
    const input = buildPartialOpportunityAssessmentPostingInput(
      'role-1',
      evidence,
    );
    expect(input.requirements).toHaveLength(1);
    expect(() =>
      preparePartialOpportunityAssessment({
        opportunityId: 'role-1',
        evidence: {
          ...evidence,
          acceptedRequirements: evidence.acceptedRequirements.map((row) => ({
            ...row,
            text: 'Invented applicant condition',
          })),
        },
        candidateSources: [
          {
            id: 'candidate',
            kind: 'employment',
            title: 'Engineer',
            text: 'Engineer',
          },
        ],
        candidateMaterialFingerprint: 'native-candidate',
      }),
    ).toThrow('changed after');
    expect(input.requirements[0]!.auditedImportance).toBe('unknown');
    expect(input.postingSources[0]!.sourceSpans?.[0]?.clauseId).toBe(
      evidence.acceptedRequirements[0]!.clauseIds[0],
    );
    expect(JSON.stringify(prepared.request)).not.toContain(
      'Company marketing is unresolved',
    );
    expect(
      Object.keys(prepared.request.questions).every((key) =>
        key.endsWith('_supports'),
      ),
    ).toBe(true);
    expect(preflightPartialOpportunityAssessment(prepared).fits).toBe(true);
  });
  it('binds literal requirement and exact candidate/linked parent without state pointers', () => {
    const { evidence, candidateSources } = fixture();
    const sources = [
      ...candidateSources,
      {
        id: 'story',
        kind: 'project',
        title: 'Story',
        text: 'Exact Kubernetes delivery narrative.',
        sectionId: 'employment:platform',
      },
      {
        id: 'unrelated',
        kind: 'project',
        title: 'Other',
        text: 'UNRELATED PRIVATE PARENT',
      },
      {
        id: 'skill:generic',
        kind: 'skill',
        title: 'Terraform',
        text: 'Strong familiarity with Kubernetes platform work.',
      },
    ];
    const prepared = preparePartialOpportunityAssessment({
      opportunityId: 'role-1',
      evidence,
      candidateSources: sources,
      candidateMaterialFingerprint: 'literal-current',
    });
    const questions = prepared.request.questions;
    expect(questions.r0_c0_supports!.instructions).toContain(
      JSON.stringify(evidence.acceptedRequirements[0]!.text),
    );
    expect(questions.r0_c0_supports!.instructions).toContain(
      JSON.stringify(sources[0]!.text),
    );
    expect(questions.r0_c2_supports!.instructions).toContain(
      `Parent evidence: ${JSON.stringify(sources[1]!.text)}`,
    );
    expect(questions.r0_c2_supports!.instructions).not.toContain(
      'UNRELATED PRIVATE PARENT',
    );
    expect(
      Object.values(questions).every(
        (question) =>
          typeof question.instructions === 'string' &&
          !question.instructions.includes('state.'),
      ),
    ).toBe(true);
    expect(prepared.bindings).not.toHaveProperty('r0_c4_supports');
    expect(JSON.stringify(prepared.request.state)).toContain(sources[4]!.text);
    expect(
      Object.values(prepared.bindings).some(
        (binding) => binding.candidateKey === 'c2',
      ),
    ).toBe(true);
    expect(() =>
      preparePartialOpportunityAssessment({
        opportunityId: 'role-1',
        evidence,
        candidateSources: [sources[0]!],
        candidateMaterialFingerprint: 'atomic-only',
      }),
    ).toThrow('useful citation scopes');
  });
  it('emits supported or uncertain only; no gaps, fit, mandatory importance or eligibility conclusions', () => {
    const { evidence, prepared, result } = fixture();
    const resolved = resolvePartialOpportunityAssessment(
      prepared,
      result,
      evidence,
    );
    expect(resolved.requirements[0]?.support).toBe('supported');
    expect(resolved.requirements[0]?.candidateSourceKeys).toEqual(['c0']);
    expect(resolved.matchReadiness).toBe('needs_evidence');
    expect(resolved.contractVersion).toBe(
      OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION,
    );
    expect(resolved).not.toHaveProperty('fitScore');
    expect(resolved).not.toHaveProperty('eligibility');
    const low: DecisionResult = {
      ...result,
      answers: Object.fromEntries(
        Object.keys(result.answers).map((key) => [
          key,
          { type: 'predicate', probability: 0.1 },
        ]),
      ),
    };
    expect(
      resolvePartialOpportunityAssessment(prepared, low, evidence)
        .requirements[0]?.support,
    ).toBe('uncertain');
    for (const mode of ['missing', 'extra', 'nan']) {
      const bad = structuredClone(result),
        first = Object.keys(bad.answers)[0]!;
      if (mode === 'missing') delete bad.answers[first];
      else
        bad.answers[mode === 'extra' ? 'unasked' : first] = {
          type: 'predicate',
          probability: mode === 'nan' ? NaN : 1,
        };
      expect(() =>
        resolvePartialOpportunityAssessment(prepared, bad, evidence),
      ).toThrow();
    }
  });
  it('keeps all 150 semantic candidate sources and known matching atomic citations available', () => {
    const { evidence } = fixture();
    const sources = Array.from({ length: 150 }, (_, index) => ({
      id: `native:${index}`,
      kind:
        index === 149 ? 'skill' : index % 3 === 0 ? 'employment' : 'project',
      title: index === 149 ? 'Kubernetes' : `Native ${index}`,
      text:
        index === 149
          ? 'Kubernetes'
          : `Full private narrative ${index}: ` +
            'Built resilient platform services. '.repeat(4),
    }));
    const prepared = preparePartialOpportunityAssessment({
      opportunityId: 'role-1',
      evidence,
      candidateSources: sources,
      candidateMaterialFingerprint: '150-source-fp',
    });
    expect(
      prepared.sourceCatalog.filter((row) => row.key.startsWith('c')),
    ).toHaveLength(150);
    expect(JSON.stringify(prepared.request.state)).toContain(
      sources[100]!.text,
    );
    expect(
      Object.values(prepared.bindings).some(
        (row) => row.candidateKey === 'c149',
      ),
    ).toBe(true);
    const changed = preparePartialOpportunityAssessment({
      opportunityId: 'role-1',
      evidence,
      candidateSources: sources,
      candidateMaterialFingerprint: 'changed-candidate',
    });
    expect(changed.fingerprint).not.toBe(prepared.fingerprint);
  });
  it('denies empty accepted evidence and absent native proof before any reservation', async () => {
    const { evidence, candidateSources, prepared } = fixture();
    expect(() =>
      preparePartialOpportunityAssessment({
        opportunityId: 'role-1',
        evidence: { ...evidence, acceptedRequirements: [] },
        candidateSources,
        candidateMaterialFingerprint: 'candidate-1',
      }),
    ).toThrow();
    vi.stubEnv('OPPORTUNITY_ASSESSMENT_DECISIONS_ENABLED', 'true');
    mocks.readEvidence.mockResolvedValue(undefined);
    await expect(
      evaluatePartialOpportunityAssessment(prepared, {
        agentRunId: 'run-1',
        subject,
        opportunityId: 'role-1',
        opportunity: { id: 'role-1' },
        subjectFingerprint: 'opaque',
      }),
    ).rejects.toThrow('native GLOBAL');
    expect(mocks.governed).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
  it('attaches the actual governed PRIVATE receipt locator to the resolved result', async () => {
    const { evidence, prepared, result } = fixture();
    for (const [name, value] of Object.entries({
      OPPORTUNITY_ASSESSMENT_DECISIONS_ENABLED: 'true',
      OPPORTUNITY_INTELLIGENCE_RUN_CALL_LIMIT: '4',
      OPPORTUNITY_INTELLIGENCE_RUN_INPUT_TOKEN_LIMIT: '80000',
      OPPORTUNITY_INTELLIGENCE_RUN_SPEND_LIMIT_MICROS: '100000',
      TYPESAFE_API_KEY: 'fixture-only',
      OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION: '1',
      OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION: '1',
    }))
      vi.stubEnv(name, value);
    try {
      mocks.readEvidence.mockResolvedValue(evidence);
      mocks.governed.mockResolvedValue({
        output: result,
        requestId: 'native-private-request',
        reused: false,
      });
      const evaluated = await evaluatePartialOpportunityAssessment(prepared, {
        agentRunId: 'run-1',
        subject,
        opportunityId: 'role-1',
        opportunity: { id: 'role-1' },
        subjectFingerprint: 'opaque-native-subject',
      });
      expect(evaluated.requestId).toBe('native-private-request');
      expect(evaluated.inputFingerprint).toBe(
        mocks.governed.mock.calls[0]![0].identity.inputFingerprint,
      );
      expect(mocks.governed.mock.calls[0]![0].workspaceSubject).toEqual(
        subject,
      );
      expect(mocks.governed.mock.calls[0]![0].identity).not.toHaveProperty(
        'workspaceSubject',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('stores an idempotent private partial contract excluded from full current ranking and never creates a score', async () => {
    const { evidence, prepared, result } = fixture();
    const resolved = resolvePartialOpportunityAssessment(
      prepared,
      result,
      evidence,
    );
    expect(
      await storePartialOpportunityAssessment({
        result: resolved,
        subject,
        opportunityId: 'role-1',
        agentRunId: 'run-1',
      }),
    ).toBe(true);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(
      'OpportunityAssessment',
      subject,
      expect.objectContaining({
        contractVersion: OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION,
        status: 'partial',
        matchReadiness: 'needs_evidence',
        eligibilityBucket: 'unknown',
        eligibilityPriority: 2,
      }),
    );
    expect(mocks.create.mock.calls[0]![2]).not.toHaveProperty('fitScore');
    expect(
      JSON.parse(mocks.create.mock.calls[0]![2].projectionJson),
    ).not.toHaveProperty('ranking');
    mocks.list.mockResolvedValue([{ id: 'existing-private-partial' }]);
    expect(
      await storePartialOpportunityAssessment({
        result: resolved,
        subject,
        opportunityId: 'role-1',
        agentRunId: 'run-1',
      }),
    ).toBe(false);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it('offers named atomic skills despite sentence punctuation while preserving .NET, C++ and C#', () => {
    for (const skill of ['Kubernetes', '.NET', 'C++', 'C#']) {
      const { prepared, evidence, result } = fixture(skill);
      expect(
        Object.values(prepared.bindings).some(
          (row) => row.candidateKey === 'c0',
        ),
      ).toBe(true);
      expect(
        resolvePartialOpportunityAssessment(prepared, result, evidence)
          .requirements[0]!.support,
      ).toBe('supported');
      expect(JSON.stringify(prepared.request.state)).toContain(skill);
    }
  });
});

it('reconstructs canonical V5 evidence without restoring quarantined criteria to the private matcher', () => {
  const captured = {
    descriptionRaw: 'Requirements\nBuild reliable systems.\nReview designs.',
  };
  const context = {
    sourceText: captured.descriptionRaw,
    sourceFingerprint: fingerprintOpportunitySourceContent(captured),
    sourceVersion: 1,
    extractionFingerprint: 'current-extraction',
    extractionContract: 'current' as const,
  };
  const ledger = buildRequirementCoverageSource(context);
  ledger.requirements = [
    {
      id: 'bad',
      text: ledger.clauses[1]!.text,
      clauseIds: [ledger.clauses[1]!.id, ledger.clauses[2]!.id],
      importance: 'unknown',
    },
    {
      id: 'good',
      text: ledger.clauses[2]!.text,
      clauseIds: [ledger.clauses[2]!.id],
      importance: 'unknown',
    },
  ];
  ledger.dispositions = [
    {
      clauseId: ledger.clauses[0]!.id,
      type: 'nonrequirement',
      requirementIds: [],
      exclusionRule: 'section_heading',
    },
    {
      clauseId: ledger.clauses[1]!.id,
      type: 'role_duty',
      requirementIds: ['bad'],
    },
    {
      clauseId: ledger.clauses[2]!.id,
      type: 'role_duty',
      requirementIds: ['good'],
    },
  ];
  const source = prepareQuarantinedSourceCompositeRequirementEvidenceAudit(
    context,
    ledger,
    {
      extractionRequestId: 'actual-extraction',
      sourceContentJson: JSON.stringify(captured),
    },
  );
  const output: DecisionResult = {
    model: 'test',
    provenance: { provider: 'typesafe', model: 'test' },
    answers: Object.fromEntries(
      Object.entries(source.request.questions).map(([key, question]) => [
        key,
        question.type === 'choice'
          ? {
              type: 'choice' as const,
              choice: 'none',
              confidence: 1,
              probabilities: Object.fromEntries(
                Object.keys(question.criteria).map((id) => [
                  id,
                  id === 'none' ? 1 : 0,
                ]),
              ),
            }
          : { type: 'predicate' as const, probability: 0.95 },
      ]),
    ),
  };
  const evidence = partialRequirementEvidenceFromAudit(
    source,
    resolveRequirementEvidenceAudit(source, output, 'actual-source'),
  );
  const prepared = preparePartialOpportunityAssessment({
    opportunityId: 'role',
    evidence,
    candidateMaterialFingerprint: 'candidate',
    candidateSources: [
      {
        id: 'employment:design',
        kind: 'employment',
        title: 'Systems engineer',
        text: 'Reviewed architectural designs.',
      },
    ],
  });
  expect(prepared.requirements.map((row) => row.id)).toEqual([
    'role:partial:good',
  ]);
  expect(evidence.ledger.requirements.map((row) => row.id)).toEqual([
    'bad',
    'good',
  ]);
  expect(evidence.unresolvedClauses).toHaveLength(2);
  const mutated = structuredClone(evidence);
  mutated.acceptedRequirements.push({
    ...ledger.requirements[0]!,
    importance: 'unknown',
  });
  expect(() =>
    preparePartialOpportunityAssessment({
      opportunityId: 'role',
      evidence: mutated,
      candidateMaterialFingerprint: 'candidate',
      candidateSources: [
        {
          id: 'employment:design',
          kind: 'employment',
          title: 'Systems engineer',
          text: 'Reviewed architectural designs.',
        },
      ],
    }),
  ).toThrow('Partial accepted excerpts changed');
});
