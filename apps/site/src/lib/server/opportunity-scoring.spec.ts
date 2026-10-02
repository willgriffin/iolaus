import { describe, expect, it } from 'vitest';
import {
  borderlineScoringFixture,
  clearAcceptScoringFixture,
  clearRejectScoringFixture,
  conflictingEvidenceScoringFixture,
  maximumScoringInputFixture,
  missingEvidenceScoringFixture,
  type OpportunityScoringFixture,
  preferredOnlyEvidenceScoringFixture,
} from './fixtures/opportunity-scoring.js';
import { prepareOpportunityPosting } from './opportunity-posting-preparation.js';
import { opportunityEligibilityProjection } from '../opportunity-eligibility.js';
import {
  buildBoundedOpportunityScoringRequest,
  deterministicOpportunityScore,
  OPPORTUNITY_SCORING_MAX_EVIDENCE_COUNT,
  OPPORTUNITY_SCORING_MAX_EXCERPT_LENGTH,
  OPPORTUNITY_SCORING_MAX_REQUIREMENTS,
  preScoreOpportunity,
  scoringMaterialFingerprint,
  validatePreparedPostingForScoring,
} from './opportunity-scoring.js';
import type { SkillMatchingResult } from './skill-matching.js';

async function build(fixture: OpportunityScoringFixture) {
  return await buildBoundedOpportunityScoringRequest({
    evidenceSources: fixture.evidenceSources,
    inputTokenCeiling: fixture.policy.inputTokenCeiling,
    model: 'openai/gpt-5.6-luna',
    opportunity: fixture.opportunity,
    policy: fixture.policy,
    prepared: fixture.prepared,
  });
}

describe('bounded opportunity scoring fixtures', () => {
  it('carries only current, explicit posting eligibility assertions into scoring', async () => {
    const sourceContentFingerprint = 'posting-eligibility-v1';
    const sourceContentVersion = 1;
    const descriptionRaw = [
      'Location',
      'This role supports remote work from Canada.',
      'We offer visa sponsorship.',
      'Qualifications',
      'TypeScript is required.',
    ].join('\n');
    const sourceRecord = {
      ...borderlineScoringFixture.opportunity,
      descriptionRaw,
      sourceContentFingerprint,
      sourceContentJson: JSON.stringify({ descriptionRaw }),
      sourceContentVersion,
    };
    const opportunity = {
      ...sourceRecord,
      ...opportunityEligibilityProjection(sourceRecord),
    };
    const request = await build({
      ...borderlineScoringFixture,
      opportunity,
      prepared: prepareOpportunityPosting(opportunity),
    });

    expect(request.input.postingEligibility).toMatchObject({
      buckets: expect.arrayContaining([
        'canada_eligible',
        'sponsorship_possible',
      ]),
      sourceContentFingerprint,
      sourceContentVersion,
      status: 'current',
    });
    expect(request.input.postingEligibility.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          excerpt: 'This role supports remote work from Canada.',
          kind: 'canada_supported',
        }),
      ]),
    );
    expect(JSON.stringify(request.messages)).toContain(
      'This role supports remote work from Canada.',
    );
  });

  it('withholds stale eligibility assertions without changing deterministic scoring rules', async () => {
    const sourceRecord = {
      ...clearAcceptScoringFixture.opportunity,
      sourceContentFingerprint: 'current-posting',
      sourceContentJson: JSON.stringify({
        descriptionRaw: clearAcceptScoringFixture.opportunity.descriptionRaw,
      }),
      sourceContentVersion: 2,
      postingEligibilityJson: JSON.stringify({
        version: 'posting-eligibility/v1',
        sourceContentFingerprint: 'old-posting',
        sourceContentVersion: 1,
        assertions: [],
      }),
    };
    const request = await build({
      ...clearAcceptScoringFixture,
      opportunity: sourceRecord,
      prepared: prepareOpportunityPosting(sourceRecord),
    });

    expect(request.input.postingEligibility).toMatchObject({
      assertions: [],
      status: 'stale',
    });
    expect(preScoreOpportunity(request.input)).toMatchObject({
      kind: 'clear_accept',
      modelEligible: false,
    });
  });

  it('invalidates material freshness when semantic-only candidate evidence changes', () => {
    const opportunity = {
      ...clearAcceptScoringFixture.opportunity,
      requiredSkills: 'PostgreSQL, server-side JavaScript',
      descriptionRaw:
        'Qualifications\nPostgreSQL and server-side JavaScript are required.',
    };
    const fingerprint = (skill: string) =>
      scoringMaterialFingerprint({
        evidenceSources: [
          {
            id: 's1',
            kind: 'resume_skill',
            title: 'PostgreSQL',
            text: 'PostgreSQL',
          },
          { id: 's2', kind: 'resume_skill', title: skill, text: skill },
        ],
        inputTokenCeiling: clearAcceptScoringFixture.policy.inputTokenCeiling,
        opportunity,
        policy: clearAcceptScoringFixture.policy,
        prepared: prepareOpportunityPosting(opportunity),
      });
    expect(fingerprint('Node.js')).not.toBe(fingerprint('Rust'));
    expect(fingerprint('Node.js')).toBe(fingerprint('Node.js'));
  });

  it('keeps material freshness independent from model request trimming', async () => {
    const fixture = maximumScoringInputFixture;
    const material = scoringMaterialFingerprint({
      evidenceSources: fixture.evidenceSources,
      inputTokenCeiling: fixture.policy.inputTokenCeiling,
      opportunity: fixture.opportunity,
      policy: fixture.policy,
      prepared: fixture.prepared,
    });
    const trimmed = await buildBoundedOpportunityScoringRequest({
      evidenceSources: fixture.evidenceSources,
      inputTokenCeiling: 1,
      model: 'openai/gpt-5.6-luna',
      opportunity: fixture.opportunity,
      policy: { ...fixture.policy, inputTokenCeiling: 1 },
      prepared: fixture.prepared,
    }).catch(() => null);
    expect(material).toMatch(/^[a-f0-9]{64}$/);
    expect(trimmed?.input.fingerprint).not.toBe(material);
  });
  it.each([
    ['PostgreSQL', 'Postgres', 'supported'],
    ['Java', 'JavaScript', 'gap'],
    ['C', 'C++', 'gap'],
  ])('matches %s against %s without substring collisions', async (requirement, skill, status) => {
    const opportunity = {
      ...clearAcceptScoringFixture.opportunity,
      requiredSkills: requirement,
      descriptionRaw: `Qualifications\n${requirement} is required.`,
    };
    const request = await build({
      ...clearAcceptScoringFixture,
      opportunity,
      prepared: prepareOpportunityPosting(opportunity),
      evidenceSources: [
        { id: 's1', kind: 'resume_skill', title: skill, text: skill },
      ],
    });
    expect(request.evidenceMatrix[0].status).toBe(status);
  });

  it.each([
    '5 years PostgreSQL',
    '5-years PostgreSQL',
    'Production Kubernetes operations',
    'Engineering team leadership',
  ])('does not treat a qualified skill label as deterministic evidence for %s', async (requirement) => {
    const opportunity = {
      ...clearAcceptScoringFixture.opportunity,
      descriptionRaw: `Qualifications\\n${requirement} is required.`,
      requiredSkills: requirement,
    };
    const request = await build({
      ...clearAcceptScoringFixture,
      opportunity,
      prepared: prepareOpportunityPosting(opportunity),
      evidenceSources: [
        {
          id: 's1',
          kind: 'resume_skill',
          title: requirement,
          text: requirement,
        },
      ],
    });

    expect(request.evidenceMatrix[0]).toMatchObject({ status: 'gap' });
  });

  it('preserves reviewed experience for qualified requirements without semantic decisions', async () => {
    const requirement = 'Production Kubernetes operations';
    const opportunity = {
      ...clearAcceptScoringFixture.opportunity,
      requiredSkills: requirement,
      descriptionRaw: requirement,
    };
    const request = await build({
      ...clearAcceptScoringFixture,
      opportunity,
      prepared: prepareOpportunityPosting(opportunity),
      evidenceSources: [
        {
          id: 'a1',
          kind: 'achievement',
          title: requirement,
          text: 'Led production Kubernetes operations for five years.',
        },
      ],
    });
    expect(request.evidenceMatrix[0].status).toBe('supported');
  });

  it('combines title and text evidence on token boundaries', async () => {
    const opportunity = {
      ...clearAcceptScoringFixture.opportunity,
      descriptionRaw: 'Qualifications\\nPython APIs are required.',
      requiredSkills: 'Python APIs',
    };
    const request = await build({
      ...clearAcceptScoringFixture,
      opportunity,
      prepared: prepareOpportunityPosting(opportunity),
      evidenceSources: [
        {
          id: 'python',
          kind: 'achievement',
          title: 'Python',
          text: 'Built APIs',
        },
      ],
    });

    expect(request.evidenceMatrix[0]).toMatchObject({
      status: 'supported',
      sources: [expect.objectContaining({ id: 'python' })],
    });
  });

  it('keeps duplicate required and preferred requirements bound to their own semantic decisions', async () => {
    const opportunity = {
      ...clearAcceptScoringFixture.opportunity,
      descriptionRaw: 'Qualifications\\nPython is required and preferred.',
      preferredSkills: 'Python',
      requiredSkills: 'Python',
    };
    const skillMatching: SkillMatchingResult = {
      version: 'skill-match/v3',
      fingerprint: 'test',
      matches: [
        {
          requirement: 'Python',
          status: 'supported',
          sourceKeys: ['resume_skill:python'],
        },
        { requirement: 'Python', status: 'gap', sourceKeys: [] },
      ],
    };
    const request = await buildBoundedOpportunityScoringRequest({
      evidenceSources: [
        { id: 'python', kind: 'resume_skill', title: 'Python', text: 'Python' },
      ],
      inputTokenCeiling: clearAcceptScoringFixture.policy.inputTokenCeiling,
      model: 'test',
      opportunity,
      policy: clearAcceptScoringFixture.policy,
      prepared: prepareOpportunityPosting(opportunity),
      skillMatching,
    });

    expect(request.input.candidateEvidence).toEqual([
      expect.objectContaining({ requirementIds: ['requirement-required-1'] }),
    ]);
    expect(request.evidenceMatrix).toEqual([
      expect.objectContaining({ status: 'supported' }),
      expect.objectContaining({ status: 'gap' }),
    ]);
  });

  it('handles a configured clear accept deterministically', async () => {
    const request = await build(clearAcceptScoringFixture);
    const decision = preScoreOpportunity(request.input);

    expect(decision).toMatchObject({
      kind: 'clear_accept',
      modelEligible: false,
    });
    expect(deterministicOpportunityScore(request, decision)).toMatchObject({
      recommendation: 'recommend',
      score: 90,
    });
    expect(
      request.input.requirements.map(
        (requirement) => requirement.postingExcerpt?.sourceLineStart,
      ),
    ).toEqual([2, 3]);
  });

  it('handles a configured clear reject deterministically', async () => {
    const request = await build(clearRejectScoringFixture);
    const decision = preScoreOpportunity(request.input);

    expect(decision).toMatchObject({
      kind: 'clear_reject',
      modelEligible: false,
    });
    expect(deterministicOpportunityScore(request, decision)).toMatchObject({
      recommendation: 'reject',
      score: 25,
    });
  });

  it('distinguishes irrelevant attributable evidence from missing evidence', async () => {
    const request = await build({
      ...clearRejectScoringFixture,
      evidenceSources: [
        {
          id: 'irrelevant-evidence',
          kind: 'resume_skill',
          text: 'Go',
          title: 'Go',
        },
      ],
    });

    expect(request.input.candidateEvidence).toEqual([
      expect.objectContaining({ requirementIds: [] }),
    ]);
    expect(preScoreOpportunity(request.input)).toMatchObject({
      kind: 'clear_reject',
      modelEligible: false,
    });
  });

  it('limits model eligibility to a borderline case', async () => {
    const request = await build(borderlineScoringFixture);
    expect(preScoreOpportunity(request.input)).toMatchObject({
      kind: 'borderline',
      modelEligible: true,
    });
    expect(JSON.stringify(request.messages)).toContain(
      'recommendation must be maybe',
    );
  });

  it('selects the relevant portion of long candidate evidence', async () => {
    const request = await build({
      ...borderlineScoringFixture,
      evidenceSources: [
        {
          id: 'long-evidence',
          kind: 'resume_achievement',
          text: `${'Unrelated delivery context. '.repeat(20)}Led a TypeScript platform migration for production services.`,
          title: 'Platform migration',
        },
      ],
    });

    expect(request.input.candidateEvidence[0]?.excerpt).toContain('TypeScript');
    expect(
      request.input.candidateEvidence[0]?.excerpt.length,
    ).toBeLessThanOrEqual(OPPORTUNITY_SCORING_MAX_EXCERPT_LENGTH);
  });

  it('fails closed before model scoring when evidence is missing', async () => {
    const request = await build(missingEvidenceScoringFixture);
    const decision = preScoreOpportunity(request.input);

    expect(decision).toMatchObject({
      kind: 'missing_evidence',
      modelEligible: false,
    });
    expect(deterministicOpportunityScore(request, decision)).toMatchObject({
      recommendation: 'needs_research',
      score: null,
    });
  });

  it('applies the clear-reject gate when evidence supports only preferred requirements', async () => {
    const request = await build(preferredOnlyEvidenceScoringFixture);

    expect(request.input.candidateEvidence).toEqual([
      expect.objectContaining({
        requirementIds: ['requirement-preferred-3'],
      }),
    ]);
    expect(preScoreOpportunity(request.input)).toMatchObject({
      kind: 'clear_reject',
      modelEligible: false,
    });
  });

  it('fails closed when only preferred evidence is attributable', async () => {
    const request = await build({
      ...preferredOnlyEvidenceScoringFixture,
      policy: {
        ...preferredOnlyEvidenceScoringFixture.policy,
        clearRejectMinGaps: 3,
      },
    });

    expect(preScoreOpportunity(request.input)).toMatchObject({
      kind: 'missing_evidence',
      modelEligible: false,
    });
  });

  it('marks conflicting structured facts as model-eligible ambiguity', async () => {
    const request = await build(conflictingEvidenceScoringFixture);

    expect(request.input.conflicts).toEqual([
      expect.objectContaining({ field: 'workMode' }),
    ]);
    expect(preScoreOpportunity(request.input)).toMatchObject({
      kind: 'conflicting_evidence',
      modelEligible: true,
    });
    expect(JSON.stringify(request.messages)).toContain(
      'borderline or conflicting_evidence',
    );
  });

  it('fails closed when fact conflicts have no requirement-matched candidate evidence', async () => {
    const request = await build({
      ...conflictingEvidenceScoringFixture,
      evidenceSources: [
        {
          id: 'unmatched-conflict-evidence',
          kind: 'resume_skill',
          text: 'Go',
          title: 'Go',
        },
      ],
    });

    expect(request.input.conflicts).not.toHaveLength(0);
    expect(preScoreOpportunity(request.input)).toMatchObject({
      kind: 'missing_evidence',
      modelEligible: false,
    });
  });

  it('detects a persisted opportunity field that conflicts with prepared source facts', async () => {
    const opportunity = {
      ...conflictingEvidenceScoringFixture.opportunity,
    };
    delete opportunity.workMode;
    const prepared = prepareOpportunityPosting(opportunity);
    const request = await buildBoundedOpportunityScoringRequest({
      ...conflictingEvidenceScoringFixture,
      inputTokenCeiling:
        conflictingEvidenceScoringFixture.policy.inputTokenCeiling,
      model: 'openai/gpt-5.6-luna',
      opportunity: { ...opportunity, workMode: 'remote' },
      prepared,
    });

    expect(request.input.conflicts).toEqual([
      expect.objectContaining({ field: 'workMode' }),
    ]);
    expect(
      request.input.structuredFacts.find(
        (fact) => fact.evidence.sourceKind === 'opportunity_field',
      ),
    ).toMatchObject({
      field: 'workMode',
      value: 'remote',
    });
    expect(preScoreOpportunity(request.input)).toMatchObject({
      kind: 'conflicting_evidence',
      modelEligible: true,
    });
  });

  it('ignores empty and semantically equivalent persisted opportunity fields', async () => {
    const opportunity = {
      ...conflictingEvidenceScoringFixture.opportunity,
    };
    delete opportunity.workMode;
    const prepared = prepareOpportunityPosting(opportunity);

    for (const workMode of ['', ' ONSITE ']) {
      const request = await buildBoundedOpportunityScoringRequest({
        ...conflictingEvidenceScoringFixture,
        inputTokenCeiling:
          conflictingEvidenceScoringFixture.policy.inputTokenCeiling,
        model: 'openai/gpt-5.6-luna',
        opportunity: { ...opportunity, workMode },
        prepared,
      });

      expect(request.input.conflicts).toEqual([]);
      expect(
        request.input.structuredFacts.some(
          (fact) => fact.evidence.sourceKind === 'opportunity_field',
        ),
      ).toBe(false);
    }
  });

  it('enforces evidence, excerpt, requirement, and total input ceilings without raw posting text', async () => {
    const request = await buildBoundedOpportunityScoringRequest({
      evidenceSources: maximumScoringInputFixture.evidenceSources,
      inputTokenCeiling: maximumScoringInputFixture.policy.inputTokenCeiling,
      model: 'openai/gpt-5.6-luna',
      opportunity: maximumScoringInputFixture.opportunity,
      policy: maximumScoringInputFixture.policy,
      prepared: maximumScoringInputFixture.prepared,
    });
    const serializedMessages = JSON.stringify(request.messages);
    const excerpts = [
      ...request.input.candidateEvidence.map((entry) => entry.excerpt),
      ...request.input.structuredFacts.map((entry) => entry.evidence.excerpt),
      ...request.input.requirements.flatMap((entry) =>
        entry.postingExcerpt ? [entry.postingExcerpt.excerpt] : [],
      ),
    ];

    expect(request.input.evidenceCount).toBeLessThanOrEqual(
      OPPORTUNITY_SCORING_MAX_EVIDENCE_COUNT,
    );
    expect(request.input.requirements).toHaveLength(
      OPPORTUNITY_SCORING_MAX_REQUIREMENTS,
    );
    expect(
      excerpts.every(
        (excerpt) => excerpt.length <= OPPORTUNITY_SCORING_MAX_EXCERPT_LENGTH,
      ),
    ).toBe(true);
    expect(request.inputTokenCount).toBeLessThanOrEqual(
      Math.floor(request.inputTokenCeiling * 0.8),
    );
    expect(serializedMessages).not.toContain(
      String(maximumScoringInputFixture.opportunity.descriptionRaw),
    );
    expect(serializedMessages).not.toContain('COMPLETE_RAW_POSTING_SENTINEL');
  });

  it('rejects missing and stale prepared payload versions before scoring', () => {
    expect(
      validatePreparedPostingForScoring({ opportunity: { id: 'missing' } }),
    ).toMatchObject({ kind: 'prerequisite' });
    expect(
      validatePreparedPostingForScoring({
        expectedSourceContentFingerprint:
          clearAcceptScoringFixture.opportunity.sourceContentFingerprint,
        expectedSourceContentVersion: 2,
        opportunity: {
          ...clearAcceptScoringFixture.opportunity,
          preparedPostingFingerprint:
            clearAcceptScoringFixture.prepared.fingerprint,
          preparedPostingJson: JSON.stringify(
            clearAcceptScoringFixture.prepared,
          ),
          preparedPostingVersion: clearAcceptScoringFixture.prepared.version,
        },
      }),
    ).toMatchObject({ kind: 'stale' });
  });
});
