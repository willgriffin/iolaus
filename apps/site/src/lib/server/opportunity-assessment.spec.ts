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

function decision(
  answers: Record<string, unknown>,
  request?: ReturnType<typeof prepared>,
): DecisionResult {
  // Existing scenario fixtures describe the intended categorical outcome; turn
  // those intents into complete binary wire answers. New protocol regressions
  // below supply predicate probabilities directly, without choice confidence.
  answers = { ...answers };
  if (request) {
    for (const [key, question] of Object.entries(request.request.questions)) {
      const match =
        /^r(\d+)_(required|preferred|c\d+_supports|c\d+_contradicts)$/u.exec(
          key,
        );
      if (!match || question.type !== 'predicate' || answers[key]) continue;
      const prefix = `r${match[1]}`;
      const importance = answers[`${prefix}_importance`] as
        | { choice?: string; confidence?: number }
        | undefined;
      const support = answers[`${prefix}_support`] as
        | { choice?: string; confidence?: number }
        | undefined;
      const citation = answers[`${prefix}_candidate_source`] as
        | { choice?: string; confidence?: number }
        | undefined;
      const outcome = match[2]!;
      const affirmed =
        outcome === 'required' || outcome === 'preferred'
          ? importance?.choice === outcome
          : outcome === `${citation?.choice}_supports`
            ? support?.choice === 'supported'
            : outcome === `${citation?.choice}_contradicts` &&
              support?.choice === 'gap';
      const probability =
        outcome === 'required' || outcome === 'preferred'
          ? (importance?.confidence ?? 0.04)
          : Math.min(support?.confidence ?? 0.04, citation?.confidence ?? 0.04);
      answers[key] = {
        type: 'predicate',
        probability: affirmed ? probability : 0.04,
      };
    }
    for (const key of Object.keys(answers))
      if (/^r\d+_(importance|support|candidate_source)$/u.test(key))
        delete answers[key];
  }
  return {
    answers: answers as DecisionResult['answers'],
    model: 'jev-1.13.0',
    provenance: { model: 'jev-1.13.0', provider: 'typesafe' },
  };
}

function completeAnswers(values: Record<string, [string, string]>) {
  const answers: Record<string, unknown> = {
    requirements_complete: { type: 'predicate', probability: 0.95 },
  };
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
        choice: unresolved ? 'uncertain' : 'p2',
        confidence: unresolved ? 0.9 : 0.96,
        probabilities: {},
      };
    }
  }
  return answers;
}

describe('opportunity assessment contract', () => {
  it('keeps audited unknown importance uncertain without private classification fallback', () => {
    const request = prepared({
      postingMaterial: {
        sourceContentFingerprint: 'posting-v1',
        sourceContentVersion: 1,
        requirementCoverageFingerprint: 'verified-audit-v2',
      },
      requirements: [
        {
          id: 'duty-1',
          text: 'Platform work',
          postingSourceIds: ['posting-3'],
          auditedImportance: 'unknown',
        },
      ],
    });
    expect(request.request.questions.r0_required).toBeUndefined();
    expect(request.request.questions.r0_preferred).toBeUndefined();
    const answers = completeAnswers({});
    for (const key of Object.keys(request.request.questions).filter((key) =>
      key.endsWith('_supports'),
    ))
      answers[key] = { type: 'predicate', probability: 0.95 };
    const result = resolveOpportunityAssessment(
      request,
      decision(answers, request),
    );
    expect(result.requirements[0]!.importance).toBe('uncertain');
    expect(result.requirements[0]!.support).toBe('supported');
  });
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
          location_access: ['allowed', 'c0'],
          authorization: ['required', 'p1'],
          sponsorship: ['offered', 'p1'],
          role_domain: ['direct', 'c0'],
          experience_fit: ['supported', 'c0'],
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
    const answers = completeAnswers({ experience_fit: ['gap', 'c0'] });
    expect(() =>
      resolveOpportunityAssessment(request, decision(answers)),
    ).toThrow('Unknown experience_fit decision choice');
    const low = completeAnswers({ experience_fit: ['gap', 'c0'] });
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
          location_access: ['restricted', 'c0'],
          sponsorship: ['denied', 'p1'],
          authorization: ['required', 'p1'],
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
          location_access: ['allowed', 'c0'],
          authorization: ['not_stated', 'p1'],
          sponsorship: ['denied', 'p1'],
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
          location_access: ['allowed', 'c0'],
          authorization: ['not_stated', 'p1'],
          sponsorship: ['offered', 'p1'],
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
          location_access: ['allowed', 'c0'],
          authorization: ['not_stated', 'p1'],
          role_domain: ['direct', 'c0'],
          experience_fit: ['supported', 'c0'],
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

  it('ranks supported requirements locally and never penalizes a gap from incomplete coverage', () => {
    const source = prepared({
      requirements: [{ id: 'typescript', text: 'TypeScript' }],
    });
    const answers = completeAnswers({
      location_access: ['allowed', 'c0'],
      authorization: ['not_stated', 'p1'],
    });
    answers.r0_importance = {
      type: 'choice',
      choice: 'required',
      confidence: 0.96,
      probabilities: {},
    };
    answers.r0_support = {
      type: 'choice',
      choice: 'supported',
      confidence: 0.96,
      probabilities: {},
    };
    answers.r0_posting_source = {
      type: 'choice',
      choice: 'p2',
      confidence: 0.96,
      probabilities: {},
    };
    answers.r0_candidate_source = {
      type: 'choice',
      choice: 'c0',
      confidence: 0.96,
      probabilities: {},
    };
    const supported = resolveOpportunityAssessment(
      source,
      decision(answers, source),
    );
    const authorized = {
      ...candidate,
      authorizedWorkCountries: [
        {
          country: { code: 'CA', label: 'Canada' },
          scope: 'country' as const,
        },
      ],
    };
    expect(rankOpportunityAssessment(supported, authorized, []).fitScore).toBe(
      90,
    );
    const fourSupported = {
      ...supported,
      requirements: [
        ...Array.from({ length: 4 }, (_, index) => ({
          ...supported.requirements[0]!,
          id: `required-${index}`,
        })),
        {
          ...supported.requirements[0]!,
          id: 'uncertain',
          importance: 'uncertain' as const,
        },
      ],
    };
    expect(
      rankOpportunityAssessment(fourSupported, authorized, []).fitScore,
    ).toBe(90);
    expect(
      rankOpportunityAssessment(fourSupported, authorized, [
        {
          category: 'scoring',
          name: 'Location preference',
          ruleJson: '{"dimension":"location_access","values":["allowed"]}',
          weight: 100,
        },
      ]).fitScore,
    ).toBe(100);

    const incomplete = {
      ...supported,
      coverage: { ...supported.coverage, candidateTruncated: true },
      requirements: [
        { ...supported.requirements[0]!, support: 'gap' as const },
      ],
    };
    expect(rankOpportunityAssessment(incomplete, authorized, []).fitScore).toBe(
      60,
    );
  });

  it('keeps requirement importance and support attributable per requirement', () => {
    const source = prepared({
      requirements: [
        { id: 'kubernetes', text: 'Production Kubernetes experience' },
        { id: 'leadership', text: 'People leadership experience' },
      ],
    });
    const answers = completeAnswers({});
    answers.r0_importance = {
      type: 'choice',
      choice: 'required',
      confidence: 0.96,
      probabilities: {},
    };
    answers.r0_support = {
      type: 'choice',
      choice: 'supported',
      confidence: 0.96,
      probabilities: {},
    };
    answers.r0_posting_source = {
      type: 'choice',
      choice: 'p2',
      confidence: 0.96,
      probabilities: {},
    };
    answers.r0_candidate_source = {
      type: 'choice',
      choice: 'c0',
      confidence: 0.96,
      probabilities: {},
    };
    answers.r1_importance = {
      type: 'choice',
      choice: 'required',
      confidence: 0.96,
      probabilities: {},
    };
    answers.r1_support = {
      type: 'choice',
      choice: 'gap',
      confidence: 0.96,
      probabilities: {},
    };
    answers.r1_posting_source = {
      type: 'choice',
      choice: 'p2',
      confidence: 0.96,
      probabilities: {},
    };
    answers.r1_candidate_source = {
      type: 'choice',
      choice: 'none',
      confidence: 0.96,
      probabilities: {},
    };
    const resolved = resolveOpportunityAssessment(
      source,
      decision(answers, source),
    );
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
        support: 'uncertain',
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
    truncatedAnswers.r0_importance = {
      type: 'choice',
      choice: 'required',
      confidence: 0.96,
      probabilities: {},
    };
    truncatedAnswers.r0_support = {
      type: 'choice',
      choice: 'gap',
      confidence: 0.96,
      probabilities: {},
    };
    truncatedAnswers.r0_posting_source = {
      type: 'choice',
      choice: 'p2',
      confidence: 0.96,
      probabilities: {},
    };
    truncatedAnswers.r0_candidate_source = {
      type: 'choice',
      choice: 'none',
      confidence: 0.96,
      probabilities: {},
    };
    expect(
      resolveOpportunityAssessment(
        truncated,
        decision(truncatedAnswers, truncated),
      ).requirements[0]?.support,
    ).toBe('uncertain');
  });

  it('invalidates the request for changed material and preserves long source content', () => {
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
    expect(long.coverage.candidateTruncated).toBe(false);
    expect(long.candidateSources[0]?.text).toBe('x'.repeat(601));
  });
  it('retains full catalogs and more than eight requirements while scoping only skill choices', () => {
    const requirements = Array.from({ length: 12 }, (_, index) => ({
      id: `r-${index}`,
      text: `TypeScript ${index}`,
      postingSourceIds: ['posting-3'],
    }));
    const source = prepared({
      requirements,
      candidateSources: Array.from({ length: 201 }, (_, index) => ({
        id: `skill-${String(index).padStart(3, '0')}`,
        kind: 'skill',
        text:
          index === 0 || index === 200
            ? 'TypeScript'
            : `Unrelated atomic skill ${index}`,
        title: `Skill ${index}`,
      })),
    });
    expect(source.candidateSources).toHaveLength(201);
    expect(source.requirements).toHaveLength(12);
    expect(source.coverage).toEqual({
      candidateTruncated: false,
      postingTruncated: false,
      requirementsTruncated: false,
    });
    expect(
      (source.request.state as Record<string, unknown>)
        .candidateEvidence as unknown[],
    ).toHaveLength(201);
    expect(source.request.questions.r0_c0_supports?.type).toBe('predicate');
    expect(source.request.questions.r0_c200_supports?.type).toBe('predicate');
    expect(source.request.questions.r0_c199_supports).toBeUndefined();
    expect(source.request.questions.r0_candidate_source).toBeUndefined();
    const state = source.request.state as {
      requirementPolicy: { support: string };
    };
    expect(state.requirementPolicy.support).toContain(
      'rN=requirements[key=rN]; cN=candidateEvidence[k=cN]',
    );
    expect(state.requirementPolicy.support).toContain(
      'rN.text or postingEvidence[k=rN.postingKey].t',
    );
    const answers = completeAnswers({});
    for (const index of requirements.keys()) {
      answers[`r${index}_importance`] = {
        type: 'choice',
        choice: 'required',
        confidence: 0.96,
      };
      answers[`r${index}_support`] = {
        type: 'choice',
        choice: index === 0 ? 'supported' : 'uncertain',
        confidence: 0.96,
      };
      answers[`r${index}_posting_source`] = {
        type: 'choice',
        choice: 'p2',
        confidence: 0.96,
      };
      answers[`r${index}_candidate_source`] = {
        type: 'choice',
        choice: index === 0 ? 'c200' : 'uncertain',
        confidence: 0.96,
      };
    }
    expect(
      resolveOpportunityAssessment(source, decision(answers, source))
        .requirements[0],
    ).toMatchObject({
      support: 'supported',
      candidateSourceKeys: ['skill-200'],
      postingSourceKeys: ['posting-3'],
    });
    expect(source.request.questions.r0_posting_source).toBeUndefined();
    expect(
      source.sourceCatalog.find((entry) => entry.key === 'p2')?.sourceId,
    ).toBe('posting-3');
  });

  it('rejects a conflicting source identifier instead of silently losing attribution', () => {
    expect(() =>
      prepared({
        candidateSources: [
          { id: 'same', kind: 'skill', title: 'A', text: 'A' },
          { id: 'same', kind: 'skill', title: 'B', text: 'B' },
        ],
      }),
    ).toThrow('Conflicting assessment source id');
  });
  it('requires an attributed contradiction for a gap and suppresses it when coverage is partial', () => {
    const source = prepared({
      candidateSources: [
        {
          id: 'contradiction',
          kind: 'candidate_profile',
          title: 'Verified experience',
          text: 'I have never managed employees.',
        },
      ],
      requirements: [{ id: 'leadership', text: 'People management required' }],
    });
    const answers = completeAnswers({});
    answers.r0_importance = {
      type: 'choice',
      choice: 'required',
      confidence: 0.96,
    };
    answers.r0_support = {
      type: 'choice',
      choice: 'gap',
      confidence: 0.96,
    };
    answers.r0_posting_source = {
      type: 'choice',
      choice: 'p2',
      confidence: 0.96,
    };
    answers.r0_candidate_source = {
      type: 'choice',
      choice: 'c0',
      confidence: 0.96,
    };
    expect(
      resolveOpportunityAssessment(source, decision(answers, source))
        .requirements[0],
    ).toMatchObject({ support: 'gap', candidateSourceKeys: ['contradiction'] });
    expect(
      resolveOpportunityAssessment(
        {
          ...source,
          coverage: { ...source.coverage, candidateTruncated: true },
        },
        decision(answers, source),
      ).requirements[0]?.support,
    ).toBe('uncertain');
  });
  it('keeps all semantic facts and durable provenance when wire citations are compact', () => {
    const source = prepared({
      candidateSources: [
        {
          id: 'source-with-long-private-identity',
          recordId: 'original-record',
          sectionId: 'parent-role',
          kind: 'achievement',
          title: 'Achievement',
          text: 'Achievement\nComplete narrative evidence.',
        },
        {
          id: 'parent-role',
          recordId: 'original-role',
          kind: 'employment',
          title: 'Engineer',
          text: 'Engineer at Example 2010–2026',
        },
      ],
      requirements: [
        { id: 'full-requirement-id', text: 'Engineering experience' },
      ],
    });
    const wire = JSON.stringify(source.request);
    expect(wire).not.toContain('source-with-long-private-identity');
    expect(wire).not.toContain('original-record');
    expect(source.sourceCatalog).toContainEqual({
      key: 'c1',
      sourceId: 'source-with-long-private-identity',
      recordId: 'original-record',
      sectionId: 'parent-role',
      kind: 'achievement',
    });
    const evidence = (source.request.state as Record<string, unknown>)
      .candidateEvidence as Array<Record<string, unknown>>;
    expect(evidence[1]).toMatchObject({
      k: 'c1',
      p: 'c0',
      t: 'Achievement\nComplete narrative evidence.',
    });
    expect(evidence[1]).not.toHaveProperty('u');
    expect(
      prepareOpportunityAssessment({
        ...source,
        candidateSources: [
          { ...source.candidateSources[1]!, id: 'other-private-identity' },
          source.candidateSources[0]!,
        ],
      }).fingerprint,
    ).not.toBe(source.fingerprint);
  });

  it('retains supporting facts outside offered citations as uncertain with no gap penalty', () => {
    const candidateSources = Array.from({ length: 150 }, (_, index) => ({
      id: `a${String(index).padStart(3, '0')}`,
      kind: 'achievement',
      title: 'Evidence',
      text: 'People management context',
    }));
    candidateSources.push({
      id: 'zz-support',
      kind: 'achievement',
      title: 'Supporting narrative',
      text: 'Mentored executives and coached direct reports.',
    });
    const source = prepared({
      candidateSources,
      requirements: Array.from({ length: 30 }, (_, index) => ({
        id: `role-${index}`,
        text: 'People management',
        postingSourceIds: ['posting-3'],
      })),
    });
    const outsideIndex = source.candidateSources.findIndex(
      (entry) => entry.id === 'zz-support',
    );
    expect(source.citationScopes[0]?.complete).toBe(false);
    expect(source.citationScopes[0]?.candidateKeys).not.toContain(
      `c${outsideIndex}`,
    );
    expect(JSON.stringify(source.request.state)).toContain(
      'Mentored executives and coached direct reports.',
    );
    const answers = completeAnswers({});
    for (const index of source.requirements.keys()) {
      answers[`r${index}_importance`] = {
        type: 'choice',
        choice: 'required',
        confidence: 0.96,
      };
      answers[`r${index}_support`] = {
        type: 'choice',
        choice: index === 0 ? 'supported' : 'gap',
        confidence: 0.96,
      };
      answers[`r${index}_posting_source`] = {
        type: 'choice',
        choice: 'p2',
        confidence: 0.96,
      };
      answers[`r${index}_candidate_source`] = {
        type: 'choice',
        choice:
          index === 0
            ? 'uncertain'
            : source.citationScopes[index]!.candidateKeys[0]!,
        confidence: 0.96,
      };
    }
    const assessment = resolveOpportunityAssessment(
      source,
      decision(answers, source),
    );
    expect(
      assessment.requirements.every((entry) => entry.support === 'uncertain'),
    ).toBe(true);
    expect(assessment.citationScopes).toEqual(source.citationScopes);
    expect(
      rankOpportunityAssessment(assessment, candidate, []).reasons.some(
        (reason) => reason.includes('gap'),
      ),
    ).toBe(false);
  });

  it('withholds authoritative readiness when any raw role requirement remains unextracted', () => {
    const source = prepared({
      requirements: [{ id: 'r', text: 'TypeScript' }],
    });
    const answers = completeAnswers({});
    answers.requirements_complete = { type: 'predicate', probability: 0.4 };
    answers.r0_importance = {
      type: 'choice',
      choice: 'required',
      confidence: 0.96,
    };
    answers.r0_support = {
      type: 'choice',
      choice: 'uncertain',
      confidence: 0.96,
    };
    answers.r0_posting_source = {
      type: 'choice',
      choice: 'p2',
      confidence: 0.96,
    };
    answers.r0_candidate_source = {
      type: 'choice',
      choice: 'uncertain',
      confidence: 0.96,
    };
    const resolved = resolveOpportunityAssessment(
      source,
      decision(answers, source),
    );
    expect(resolved.coverage.requirementsTruncated).toBe(true);
    expect(resolved.requirementCompleteness).toEqual({
      inputComplete: true,
      probability: 0.4,
      complete: false,
    });
  });
  it('accepts independent binary support from several exact citations without multiclass confidence', () => {
    const source = prepared({
      candidateSources: [
        {
          id: 'achievement-a',
          kind: 'achievement',
          title: 'A',
          text: 'Built reliable production platforms.',
        },
        {
          id: 'achievement-b',
          kind: 'achievement',
          title: 'B',
          text: 'Operated reliable production platforms.',
        },
      ],
      postingSources: [
        {
          id: 'required-platform',
          kind: 'posting_requirement',
          title: 'Required',
          text: 'required: Production platforms',
        },
      ],
      requirements: [
        {
          id: 'platform',
          text: 'Production platforms',
          postingSourceIds: ['required-platform'],
        },
      ],
    });
    const answers = completeAnswers({});
    for (const [key, question] of Object.entries(source.request.questions))
      if (/^r0_/u.test(key) && question.type === 'predicate')
        answers[key] = {
          type: 'predicate',
          probability: key.endsWith('_supports') ? 0.9 : 0.04,
        };
    expect(source.request.questions.r0_support).toBeUndefined();
    expect(source.request.questions.r0_importance).toBeUndefined();
    expect(source.request.questions.r0_candidate_source).toBeUndefined();
    const resolved = resolveOpportunityAssessment(source, decision(answers));
    expect(resolved.requirements[0]).toEqual({
      id: 'platform',
      importance: 'required',
      support: 'supported',
      candidateSourceKeys: ['achievement-a', 'achievement-b'],
      postingSourceKeys: ['required-platform'],
    });
    answers.r0_c0_supports = { type: 'predicate', probability: 1.01 };
    expect(() =>
      resolveOpportunityAssessment(source, decision(answers)),
    ).toThrow('Malformed r0_c0_supports');
  });

  it('keeps low support probabilities and contradictory binary evidence uncertain', () => {
    const source = prepared({
      requirements: [{ id: 'r', text: 'Platform leadership' }],
    });
    const answers = completeAnswers({});
    answers.r0_required = { type: 'predicate', probability: 0.96 };
    answers.r0_preferred = { type: 'predicate', probability: 0.04 };
    answers.r0_posting_source = {
      type: 'choice',
      choice: 'p2',
      confidence: 0.96,
    };
    answers.r0_c0_supports = { type: 'predicate', probability: 0.84 };
    answers.r0_c0_contradicts = { type: 'predicate', probability: 0.04 };
    expect(
      resolveOpportunityAssessment(source, decision(answers)).requirements[0],
    ).toMatchObject({ support: 'uncertain', candidateSourceKeys: [] });
    answers.r0_c0_supports = { type: 'predicate', probability: 0.96 };
    answers.r0_c0_contradicts = { type: 'predicate', probability: 0.96 };
    expect(
      resolveOpportunityAssessment(source, decision(answers)).requirements[0],
    ).toMatchObject({ support: 'uncertain', candidateSourceKeys: [] });
    delete answers.r0_c0_supports;
    expect(() =>
      resolveOpportunityAssessment(source, decision(answers)),
    ).toThrow('Malformed r0_c0_supports');
  });
});
