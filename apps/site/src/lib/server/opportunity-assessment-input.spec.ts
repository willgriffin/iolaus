import { describe, expect, it } from 'vitest';
import {
  buildOpportunityAssessmentPostingInput,
  opportunityAssessmentSubjectMaterialFingerprint,
  selectOpportunityAssessmentCandidateSources,
  verifiedOpportunityRequirementCoverage,
} from './opportunity-assessment-input.js';
import {
  buildRequirementCoverageSource,
  requirementCoverageContextForOpportunity,
} from './opportunity-requirement-coverage.js';
import {
  prepareRequirementCoverageAudit,
  requirementCoverageClauseQuestionKey,
  resolveRequirementCoverageAudit,
} from './opportunity-requirement-coverage-provider.js';

describe('opportunity assessment input', () => {
  it('never sends proposed hard labels for low-confidence or unoffered source importance', () => {
    for (const descriptionRaw of [
      'Platform reliability and service-mesh diagnosis.',
      `Required ${'production tooling '.repeat(700)}`,
    ]) {
      const opportunity = {
        id: 'role-1',
        descriptionRaw,
        sourceContentFingerprint: 'source-importance',
        sourceContentVersion: 1,
        preparedPostingFingerprint: 'prepared-1',
        preparedPostingJson: '{}',
        requiredSkills: ['Unverified taxonomy label'],
      };
      const context = requirementCoverageContextForOpportunity(opportunity);
      const ledger = buildRequirementCoverageSource(context);
      ledger.requirements = [
        {
          id: 'r1',
          text: descriptionRaw.trim(),
          clauseIds: [ledger.clauses[0]!.id],
          importance: 'required',
        },
      ];
      ledger.dispositions = [
        {
          clauseId: ledger.clauses[0]!.id,
          type: 'material_requirement',
          requirementIds: ['r1'],
        },
      ];
      const request = prepareRequirementCoverageAudit(context, ledger);
      const result = {
        answers: Object.fromEntries(
          Object.keys(request.request.questions).map((key) => [
            key,
            {
              type: 'predicate',
              probability: key.startsWith('importance_') ? 0.84 : 0.95,
            },
          ]),
        ),
      } as import('@happyvertical/ai').DecisionResult;
      ledger.audit = resolveRequirementCoverageAudit(
        request,
        result,
        'recorded-source-importance',
      );
      opportunity.preparedPostingJson = JSON.stringify({
        requirementCoverage: ledger,
      });
      const verified = verifiedOpportunityRequirementCoverage(opportunity)!;
      const posting = buildOpportunityAssessmentPostingInput(
        opportunity,
        verified,
      );
      expect(posting.requirements[0]!.auditedImportance).toBe('unknown');
      expect(
        posting.postingSources
          .filter((source) => source.kind === 'posting_requirement')
          .map((source) => source.text),
      ).toEqual([descriptionRaw.trim()]);
      expect(verified.fingerprint).toBe(ledger.audit.fingerprint);
    }
  });
  it('retains exact context without candidate rows or duplicate text and retires a mixed-clause context row', () => {
    const descriptionRaw = [
      'Our infrastructure team serves four million customers. Diagnose service-mesh failures and prevent recurrence.',
      'Employees may work abroad for 90 days, except roles with regulatory restrictions.',
      'Applicants must reside in Canada and hold current work authorization.',
    ].join('\n');
    const opportunity = {
      id: 'role-context',
      descriptionRaw,
      sourceContentFingerprint: 'context-source',
      sourceContentVersion: 1,
      preparedPostingFingerprint: 'context-prepared',
      preparedPostingJson: '{}',
    };
    const context = requirementCoverageContextForOpportunity(opportunity);
    const ledger = buildRequirementCoverageSource(context);
    const [mixed, benefits, eligibility] = ledger.clauses;
    const historicalRequirements = [
      {
        id: 'company-fact',
        text: 'Our infrastructure team serves four million customers.',
        clauseIds: [mixed!.id],
        importance: 'unknown' as const,
      },
      {
        id: 'duty',
        text: 'Diagnose service-mesh failures and prevent recurrence.',
        clauseIds: [mixed!.id],
        importance: 'unknown' as const,
      },
      {
        id: 'eligibility',
        text: eligibility!.text,
        clauseIds: [eligibility!.id],
        importance: 'unknown' as const,
      },
    ];
    // A current source repair may retire the descriptive row; paid historical
    // proposal records stay unchanged and are not reused as verified criteria.
    ledger.requirements = historicalRequirements.filter(
      (row) => row.id !== 'company-fact',
    );
    ledger.dispositions = [
      { clauseId: mixed!.id, type: 'role_duty', requirementIds: ['duty'] },
      { clauseId: benefits!.id, type: 'source_context', requirementIds: [] },
      {
        clauseId: eligibility!.id,
        type: 'material_requirement',
        requirementIds: ['eligibility'],
      },
    ];
    const prepared = prepareRequirementCoverageAudit(context, ledger);
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      {
        model: 'jev-test',
        provenance: { model: 'jev-test', provider: 'typesafe' },
        answers: Object.fromEntries(
          Object.keys(prepared.request.questions).map((key) => [
            key,
            {
              type: 'predicate',
              probability: prepared.contextQuestionKeys.includes(key)
                ? 0.05
                : 0.95,
            },
          ]),
        ),
      } satisfies import('@happyvertical/ai').DecisionResult,
      'context-repair-receipt',
    );
    opportunity.preparedPostingJson = JSON.stringify({
      requirementCoverage: ledger,
    });
    const verified = verifiedOpportunityRequirementCoverage(opportunity)!;
    expect(verified).toBeDefined();
    const posting = buildOpportunityAssessmentPostingInput(
      opportunity,
      verified,
    );
    expect(posting.requirements.map((row) => row.text)).toEqual([
      'Diagnose service-mesh failures and prevent recurrence.',
      eligibility!.text,
    ]);
    const fullSource = posting.postingSources.find(
      (row) => row.kind === 'posting_description',
    )!;
    expect(fullSource.text).toBe(descriptionRaw);
    expect(fullSource.sourceSpans).toEqual([
      {
        clauseId: benefits!.id,
        start: benefits!.spanStart,
        end: benefits!.spanEnd,
        hash: benefits!.hash,
      },
    ]);
    expect(
      posting.postingSources.filter((row) => row.text.includes('90 days')),
    ).toHaveLength(1);
    expect(
      posting.postingSources.filter(
        (row) => row.kind === 'posting_requirement',
      ),
    ).toHaveLength(2);
    expect(historicalRequirements.map((row) => row.id)).toEqual([
      'company-fact',
      'duty',
      'eligibility',
    ]);
  });
  it('consumes only current lossless requirements and preserves exact clause attribution', () => {
    const opportunity = {
      id: 'role-1',
      descriptionRaw:
        'Diagnose failures across a service mesh and prevent recurrence.',
      sourceContentFingerprint: 'source-1',
      sourceContentVersion: 1,
      preparedPostingFingerprint: 'prepared-1',
      preparedPostingJson: '{}',
      requiredSkills: ['Distributed Systems'],
    };
    const context = requirementCoverageContextForOpportunity(opportunity);
    const ledger = buildRequirementCoverageSource(context);
    const clause = ledger.clauses[0]!;
    ledger.requirements = [
      {
        id: 'full-duty',
        text: clause.text,
        clauseIds: [clause.id],
        importance: 'unknown',
      },
    ];
    ledger.dispositions = [
      { clauseId: clause.id, type: 'role_duty', requirementIds: ['full-duty'] },
    ];
    ledger.audit = resolveRequirementCoverageAudit(
      prepareRequirementCoverageAudit(context, ledger),
      {
        model: 'jev-test',
        provenance: { model: 'jev-test', provider: 'typesafe' },
        answers: {
          c0_row0_entailed: { type: 'predicate', probability: 0.9 },
          [requirementCoverageClauseQuestionKey(0, 'mapped')]: {
            type: 'predicate',
            probability: 0.9,
          },
        },
      } satisfies import('@happyvertical/ai').DecisionResult,
      'receipt-1',
    );
    opportunity.preparedPostingJson = JSON.stringify({
      requirementCoverage: ledger,
    });
    const verified = verifiedOpportunityRequirementCoverage(opportunity)!;
    expect(verified.fingerprint).toBe(ledger.audit.fingerprint);
    const posting = buildOpportunityAssessmentPostingInput(
      opportunity,
      verified,
    );
    expect(posting.requirements.map((row) => row.text)).toEqual([clause.text]);
    const rendered = {
      ...opportunity,
      descriptionRaw: 'Rendered abbreviated description.',
      sourceContentJson: JSON.stringify({
        descriptionRaw: opportunity.descriptionRaw,
      }),
    };
    expect(
      buildOpportunityAssessmentPostingInput(
        rendered,
        verified,
      ).postingSources.find((source) => source.kind === 'posting_description')
        ?.text,
    ).toBe(context.sourceText);
    expect(
      posting.postingSources.find(
        (source) => source.kind === 'posting_requirement',
      )?.sourceSpans,
    ).toEqual([
      {
        clauseId: clause.id,
        start: clause.spanStart,
        end: clause.spanEnd,
        hash: clause.hash,
      },
    ]);
    expect(
      verifiedOpportunityRequirementCoverage({
        ...opportunity,
        descriptionRaw: `${opportunity.descriptionRaw}!`,
      }),
    ).toBeUndefined();
    expect(
      verifiedOpportunityRequirementCoverage({
        ...opportunity,
        preparedPostingFingerprint: 'prepared-2',
      }),
    ).toBeUndefined();
    expect(
      opportunityAssessmentSubjectMaterialFingerprint({
        candidateMaterialFingerprint: 'candidate',
        sourceContentFingerprint: 'source-1',
        sourceContentVersion: 1,
        requirementCoverageFingerprint: verified.fingerprint,
        subject: { tenantId: 'tenant', userId: 'user', profileId: 'profile' },
      }),
    ).not.toBe(
      opportunityAssessmentSubjectMaterialFingerprint({
        candidateMaterialFingerprint: 'candidate',
        sourceContentFingerprint: 'source-1',
        sourceContentVersion: 1,
        subject: { tenantId: 'tenant', userId: 'user', profileId: 'profile' },
      }),
    );
  });
  it('keeps the full raw posting and attributed structured requirements', () => {
    const prepared = buildOpportunityAssessmentPostingInput({
      descriptionRaw: `Remote Canada. ${'x'.repeat(25_000)}`,
      id: 'opportunity-1',
      locations: ['Canada', 'United States'],
      requiredSkills: ['TypeScript'],
      title: 'Platform engineer',
      visaOrEorPossible: 'No sponsorship',
    });
    expect(prepared.requirements).toEqual([
      {
        id: 'opportunity-1:required:0',
        text: 'TypeScript',
        postingSourceIds: ['opportunity-1:required:0'],
      },
    ]);
    expect(
      prepared.postingSources.some((source) =>
        source.id.includes('field:locations'),
      ),
    ).toBe(true);
    expect(
      prepared.postingSources.find(
        (source) => source.kind === 'posting_description',
      )?.text,
    ).toBe(`Remote Canada. ${'x'.repeat(25_000)}`);
    expect(prepared.postingCoverageTruncated).toBe(false);
  });

  it('retains every role, skill and narrative independent of keyword matching', () => {
    const sources = [
      {
        id: 'role-1',
        kind: 'employment',
        text: 'Platform engineer at Example, 2022 - 2026',
        title: 'Platform engineer',
      },
      {
        id: 'skill-ts',
        kind: 'skill',
        text: 'TypeScript',
        title: 'TypeScript',
      },
      {
        id: 'skill-k8s',
        kind: 'skill',
        text: 'Kubernetes',
        title: 'Kubernetes',
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `project-${index}`,
        kind: 'project',
        text: `Unrelated project ${index}`,
        title: `Project ${index}`,
      })),
    ];
    const selected = selectOpportunityAssessmentCandidateSources(sources, [
      { id: 'required-ts', text: 'TypeScript' },
      { id: 'required-k8s', text: 'Kubernetes' },
    ]);
    expect(selected.sources.map((source) => source.id)).toEqual(
      expect.arrayContaining(['role-1', 'skill-ts', 'skill-k8s']),
    );
    expect(selected.truncated).toBe(false);
  });

  it('preserves evidence beyond the old loader and request count caps', () => {
    const selected = selectOpportunityAssessmentCandidateSources(
      Array.from({ length: 201 }, (_, index) => ({
        id: `achievement-${index}`,
        kind: 'achievement',
        text: `Evidence ${index}`,
        title: `Evidence ${index}`,
      })),
      [{ id: 'required-role', text: 'Leadership' }],
    );
    expect(selected.sources).toHaveLength(201);
    expect(selected.truncated).toBe(false);
  });

  it('preserves every matching atomic skill without a fixed count limit', () => {
    const selected = selectOpportunityAssessmentCandidateSources(
      Array.from({ length: 40 }, (_, index) => ({
        id: `skill-${index}`,
        kind: 'skill',
        text: `TypeScript skill ${index}`,
        title: `TypeScript skill ${index}`,
      })),
      [{ id: 'required-ts', text: 'TypeScript' }],
    );
    expect(selected.sources).toHaveLength(40);
    expect(selected.truncated).toBe(false);
  });

  it('marks a summary-only posting as partial rather than inventing complete coverage', () => {
    expect(
      buildOpportunityAssessmentPostingInput({
        id: 'posting',
        descriptionSummary: 'Remote role',
      }).postingCoverageTruncated,
    ).toBe(true);
  });

  it('separates identical material for two workspace subjects', () => {
    const shared = {
      candidateMaterialFingerprint: 'candidate',
      sourceContentFingerprint: 'posting',
      sourceContentVersion: 1,
    };
    expect(
      opportunityAssessmentSubjectMaterialFingerprint({
        ...shared,
        subject: {
          profileId: 'profile-a',
          tenantId: 'tenant',
          userId: 'user-a',
        },
      }),
    ).not.toBe(
      opportunityAssessmentSubjectMaterialFingerprint({
        ...shared,
        subject: {
          profileId: 'profile-b',
          tenantId: 'tenant',
          userId: 'user-b',
        },
      }),
    );
  });
  it('includes full qualification statements beyond taxonomy skill tags', () => {
    const input = buildOpportunityAssessmentPostingInput({
      id: 'job',
      descriptionRaw: 'Complete raw posting',
      requiredSkills: ['TypeScript'],
      qualifications:
        '8+ years engineering experience; Reliability at scale\nCross-team influence and clear communication',
    });
    expect(input.requirements.map((requirement) => requirement.text)).toEqual([
      'TypeScript',
      '8+ years engineering experience',
      'Reliability at scale',
      'Cross-team influence and clear communication',
    ]);
    expect(
      input.requirements.every((requirement) =>
        input.postingSources.some(
          (source) =>
            source.id === requirement.postingSourceIds?.[0] &&
            source.text.includes(requirement.text),
        ),
      ),
    ).toBe(true);
  });
  it('includes attributed responsibilities demanded by full-role completeness', () => {
    const input = buildOpportunityAssessmentPostingInput({
      id: 'job',
      descriptionRaw: 'Own production systems, reliability and mentoring.',
      requiredSkills: ['TypeScript'],
      qualifications: '8+ years engineering experience',
      responsibilities:
        'Own production systems, reliability and scaling; Mentor engineers\nCoordinate cross-team delivery',
    });
    expect(input.requirements.map((requirement) => requirement.text)).toEqual([
      'TypeScript',
      '8+ years engineering experience',
      'Own production systems, reliability and scaling',
      'Mentor engineers',
      'Coordinate cross-team delivery',
    ]);
    for (const requirement of input.requirements.slice(2)) {
      expect(requirement.id).toContain(':responsibility:');
      expect(input.postingSources).toContainEqual({
        id: requirement.id,
        kind: 'posting_requirement',
        text: requirement.text,
        title: 'Role responsibility',
      });
      expect(requirement.postingSourceIds).toEqual([requirement.id]);
    }
    expect(input.postingCoverageTruncated).toBe(false);
  });
});
