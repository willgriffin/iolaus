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
import {
  buildBoundedOpportunityScoringRequest,
  deterministicOpportunityScore,
  OPPORTUNITY_SCORING_MAX_EVIDENCE_COUNT,
  OPPORTUNITY_SCORING_MAX_EXCERPT_LENGTH,
  OPPORTUNITY_SCORING_MAX_REQUIREMENTS,
  preScoreOpportunity,
  validatePreparedPostingForScoring,
} from './opportunity-scoring.js';

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

  it('keeps preferred-only evidence model-eligible when the reject gate is not met', async () => {
    const request = await build({
      ...preferredOnlyEvidenceScoringFixture,
      policy: {
        ...preferredOnlyEvidenceScoringFixture.policy,
        clearRejectMinGaps: 3,
      },
    });

    expect(preScoreOpportunity(request.input)).toMatchObject({
      kind: 'borderline',
      modelEligible: true,
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
