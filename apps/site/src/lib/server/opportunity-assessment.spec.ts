import type { DecisionResult } from '@happyvertical/ai';
import { describe, expect, it } from 'vitest';
import {
  opportunityAssessmentCacheKey,
  prepareOpportunityAssessment,
  projectPersonalEligibility,
  rankOpportunityAssessment,
  resolveOpportunityAssessment,
} from './opportunity-assessment.js';

const candidate = {
  authorizedWorkCountries: [],
  citizenships: [{ code: 'CA', label: 'Canada' }],
  residenceCountry: { code: 'CA', label: 'Canada' },
  sponsorshipRequired: true as const,
  targetWorkCountry: { code: 'CA', label: 'Canada' },
};

function prepared(
  overrides: Partial<Parameters<typeof prepareOpportunityAssessment>[0]> = {},
) {
  return prepareOpportunityAssessment({
    candidate,
    candidateMaterialFingerprint: 'candidate-v1',
    candidateSources: [
      {
        id: 'resume-1',
        kind: 'achievement',
        title: 'Platform work',
        text: 'Led production platform engineering.',
      },
    ],
    postingMaterial: {
      sourceContentFingerprint: 'posting-v1',
      sourceContentVersion: 1,
    },
    postingSources: [
      {
        id: 'posting-1',
        kind: 'location',
        title: 'Location',
        text: 'This role is remote from Canada.',
      },
      {
        id: 'posting-2',
        kind: 'authorization',
        title: 'Authorization',
        text: 'Existing authorization to work in Canada is required. Visa sponsorship is available.',
      },
      {
        id: 'posting-3',
        kind: 'duties',
        title: 'Duties',
        text: 'Build platform services and production systems.',
      },
    ],
    ...overrides,
  });
}

function decision(answers: Record<string, unknown>): DecisionResult {
  return {
    answers: answers as DecisionResult['answers'],
    model: 'jev-1.13.0',
    provenance: { model: 'jev-1.13.0', provider: 'typesafe' },
  };
}

function completeAnswers(values: Record<string, [string, string]>) {
  const answers: Record<string, unknown> = {};
  for (const dimension of [
    'location_access',
    'sponsorship',
    'authorization',
    'work_mode',
    'employment_type',
    'timezone',
    'travel',
    'role_domain',
    'experience_fit',
  ]) {
    const candidateScoped = [
      'location_access',
      'role_domain',
      'experience_fit',
    ].includes(dimension);
    const [value, source] = values[dimension] ?? [
      dimension === 'experience_fit' ? 'uncertain' : 'unknown',
      'uncertain',
    ];
    const unresolved = value === 'unknown' || value === 'uncertain';
    answers[`${dimension}_explicit`] = {
      type: 'predicate',
      probability: unresolved ? 0.1 : 0.95,
    };
    answers[`${dimension}_value`] = {
      type: 'choice',
      choice: value,
      confidence: unresolved ? 0.9 : 0.96,
      probabilities: {},
    };
    answers[`${dimension}_source`] = {
      type: 'choice',
      choice: source,
      confidence: source === 'uncertain' ? 0.9 : 0.96,
      probabilities: {},
    };
    if (candidateScoped) {
      answers[`${dimension}_posting_source`] = {
        type: 'choice',
        choice: unresolved ? 'uncertain' : 'posting_2',
        confidence: unresolved ? 0.9 : 0.96,
        probabilities: {},
      };
    }
  }
  return answers;
}

describe('opportunity assessment contract', () => {
  it('instructs JEV to treat an explicit target-country alternative as allowed', () => {
    const question = prepared().request.questions.location_access_value;
    expect(question?.type).toBe('choice');
    expect(String(question?.instructions)).toContain(
      'multi-country remote listing that includes the target',
    );
    expect(String(question?.instructions)).toContain(
      'listing without the target does not make another country mandatory',
    );
  });

  it('keeps source-attributed posting facts separate from private compatibility', () => {
    const assessment = resolveOpportunityAssessment(
      prepared(),
      decision(
        completeAnswers({
          location_access: ['allowed', 'candidate_0'],
          authorization: ['required', 'posting_1'],
          sponsorship: ['offered', 'posting_1'],
          role_domain: ['direct', 'candidate_0'],
          experience_fit: ['supported', 'candidate_0'],
        }),
      ),
    );
    expect(assessment.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: 'location_access',
          scope: 'candidate',
          sourceKeys: ['posting-3', 'resume-1'],
          value: 'allowed',
        }),
        expect.objectContaining({
          dimension: 'role_domain',
          scope: 'candidate',
          sourceKeys: ['posting-3', 'resume-1'],
          value: 'direct',
        }),
      ]),
    );
    // Citizenship alone does not satisfy an explicitly required authorization.
    expect(projectPersonalEligibility(assessment, candidate)).toBe(
      'sponsorship_possible',
    );
    expect(
      projectPersonalEligibility(assessment, {
        ...candidate,
        sponsorshipRequired: 'unknown',
      }),
    ).toBe('unknown');
    expect(
      projectPersonalEligibility(assessment, {
        ...candidate,
        authorizedWorkCountries: [
          {
            country: { code: 'CA', label: 'Canada' },
            scope: 'country' as const,
          },
        ],
      }),
    ).toBe('eligible_without_sponsorship');
  });

  it('rejects unproven or malformed model claims instead of constructing a gap', () => {
    const request = prepared({ candidateSources: [] });
    const answers = completeAnswers({ experience_fit: ['gap', 'candidate_0'] });
    expect(() =>
      resolveOpportunityAssessment(request, decision(answers)),
    ).toThrow('Unknown experience_fit decision choice');
    const low = completeAnswers({ experience_fit: ['gap', 'candidate_0'] });
    (low.experience_fit_explicit as { probability: number }).probability = 0.4;
    const resolved = resolveOpportunityAssessment(prepared(), decision(low));
    expect(
      resolved.claims.find((claim) => claim.dimension === 'experience_fit'),
    ).toBeUndefined();
  });

  it('treats explicit restrictions and denied required sponsorship as incompatible', () => {
    const assessment = resolveOpportunityAssessment(
      prepared(),
      decision(
        completeAnswers({
          location_access: ['restricted', 'candidate_0'],
          sponsorship: ['denied', 'posting_1'],
          authorization: ['required', 'posting_1'],
        }),
      ),
    );
    expect(projectPersonalEligibility(assessment, candidate)).toBe(
      'incompatible',
    );
  });

  it('requires verified target-country authorization before an allowed location is eligible', () => {
    const assessment = resolveOpportunityAssessment(
      prepared(),
      decision(
        completeAnswers({
          location_access: ['allowed', 'candidate_0'],
          authorization: ['not_stated', 'posting_1'],
          sponsorship: ['denied', 'posting_1'],
        }),
      ),
    );
    const authorizedCandidate = {
      ...candidate,
      authorizedWorkCountries: [
        {
          country: { code: 'CA', label: 'Canada' },
          scope: 'country' as const,
        },
      ],
    };

    // The same Canadian work location is only eligible for the profile with
    // explicit country-wide authorization. A sponsorship denial cannot undo
    // an authorization the candidate already has.
    expect(projectPersonalEligibility(assessment, authorizedCandidate)).toBe(
      'eligible_without_sponsorship',
    );
    expect(
      projectPersonalEligibility(assessment, {
        ...candidate,
        sponsorshipRequired: 'unknown',
      }),
    ).toBe('unknown');
  });

  it('keeps sponsorship possible only for a candidate who confirms the need', () => {
    const assessment = resolveOpportunityAssessment(
      prepared(),
      decision(
        completeAnswers({
          location_access: ['allowed', 'candidate_0'],
          authorization: ['not_stated', 'posting_1'],
          sponsorship: ['offered', 'posting_1'],
        }),
      ),
    );
    expect(projectPersonalEligibility(assessment, candidate)).toBe(
      'sponsorship_possible',
    );
    expect(
      projectPersonalEligibility(assessment, {
        ...candidate,
        sponsorshipRequired: 'unknown',
      }),
    ).toBe('unknown');
  });

  it('uses preferences only for local, explainable ranking', () => {
    const source = prepared();
    const assessment = resolveOpportunityAssessment(
      source,
      decision(
        completeAnswers({
          location_access: ['allowed', 'candidate_0'],
          authorization: ['not_stated', 'posting_1'],
          role_domain: ['direct', 'candidate_0'],
          experience_fit: ['supported', 'candidate_0'],
        }),
      ),
    );
    const authorizedCandidate = {
      ...candidate,
      authorizedWorkCountries: [
        {
          country: { code: 'CA', label: 'Canada' },
          scope: 'country' as const,
        },
      ],
    };
    const before = opportunityAssessmentCacheKey(source, 'jev-1.13.0');
    const ranking = rankOpportunityAssessment(assessment, authorizedCandidate, [
      {
        category: 'scoring',
        name: 'Direct domain',
        ruleJson: '{"dimension":"role_domain","values":["direct"]}',
        weight: 25,
      },
      {
        category: 'scoring',
        name: 'Proven experience',
        ruleJson: '{"dimension":"experience_fit","values":["supported"]}',
        weight: 15,
      },
    ]);
    expect(ranking).toMatchObject({
      eligibility: 'eligible_without_sponsorship',
      eligibilityPriority: 0,
      fitScore: 100,
      excluded: false,
    });
    expect(ranking.reasons).toContain('Direct domain: +25');
    expect(opportunityAssessmentCacheKey(source, 'jev-1.13.0')).toBe(before);
    expect(opportunityAssessmentCacheKey(source, 'jev-next')).not.toBe(before);
  });

  it('keeps requirement importance and support attributable per requirement', () => {
    const source = prepared({
      requirements: [
        { id: 'kubernetes', text: 'Production Kubernetes experience' },
        { id: 'leadership', text: 'People leadership experience' },
      ],
    });
    const answers = completeAnswers({});
    answers.requirement_0_importance = {
      type: 'choice',
      choice: 'required',
      confidence: 0.96,
      probabilities: {},
    };
    answers.requirement_0_support = {
      type: 'choice',
      choice: 'supported',
      confidence: 0.96,
      probabilities: {},
    };
    answers.requirement_0_posting_source = {
      type: 'choice',
      choice: 'posting_2',
      confidence: 0.96,
      probabilities: {},
    };
    answers.requirement_0_candidate_source = {
      type: 'choice',
      choice: 'candidate_0',
      confidence: 0.96,
      probabilities: {},
    };
    answers.requirement_1_importance = {
      type: 'choice',
      choice: 'required',
      confidence: 0.96,
      probabilities: {},
    };
    answers.requirement_1_support = {
      type: 'choice',
      choice: 'gap',
      confidence: 0.96,
      probabilities: {},
    };
    answers.requirement_1_posting_source = {
      type: 'choice',
      choice: 'posting_2',
      confidence: 0.96,
      probabilities: {},
    };
    answers.requirement_1_candidate_source = {
      type: 'choice',
      choice: 'none',
      confidence: 0.96,
      probabilities: {},
    };
    const resolved = resolveOpportunityAssessment(source, decision(answers));
    expect(resolved.requirements).toEqual([
      {
        id: 'kubernetes',
        importance: 'required',
        support: 'supported',
        postingSourceKeys: ['posting-3'],
        candidateSourceKeys: ['resume-1'],
      },
      {
        id: 'leadership',
        importance: 'required',
        support: 'gap',
        postingSourceKeys: ['posting-3'],
        candidateSourceKeys: [],
      },
    ]);
    const truncated = prepareOpportunityAssessment({
      candidate,
      candidateMaterialFingerprint: 'candidate-v1',
      candidateSources: [
        {
          id: 'long',
          kind: 'achievement',
          title: 'Long',
          text: 'x'.repeat(601),
        },
      ],
      postingMaterial: source.postingMaterial,
      postingSources: source.postingSources,
      requirements: [
        { id: 'leadership', text: 'People leadership experience' },
      ],
    });
    const truncatedAnswers = completeAnswers({});
    truncatedAnswers.requirement_0_importance = {
      type: 'choice',
      choice: 'required',
      confidence: 0.96,
      probabilities: {},
    };
    truncatedAnswers.requirement_0_support = {
      type: 'choice',
      choice: 'gap',
      confidence: 0.96,
      probabilities: {},
    };
    truncatedAnswers.requirement_0_posting_source = {
      type: 'choice',
      choice: 'posting_2',
      confidence: 0.96,
      probabilities: {},
    };
    truncatedAnswers.requirement_0_candidate_source = {
      type: 'choice',
      choice: 'none',
      confidence: 0.96,
      probabilities: {},
    };
    expect(
      resolveOpportunityAssessment(truncated, decision(truncatedAnswers))
        .requirements[0]?.support,
    ).toBe('uncertain');
  });

  it('invalidates the request for candidate and source material changes, and records truncation', () => {
    const one = prepared();
    const two = prepared({ candidateMaterialFingerprint: 'candidate-v2' });
    const three = prepared({
      postingMaterial: {
        sourceContentFingerprint: 'posting-v2',
        sourceContentVersion: 2,
      },
    });
    const long = prepared({
      candidateSources: [
        {
          id: 'long',
          kind: 'achievement',
          title: 'Long',
          text: 'x'.repeat(601),
        },
      ],
    });
    expect(two.fingerprint).not.toBe(one.fingerprint);
    expect(three.fingerprint).not.toBe(one.fingerprint);
    expect(long.coverage.candidateTruncated).toBe(true);
  });
});
