import { describe, expect, it } from 'vitest';
import type { AdminRecord } from '$lib/admin/dock';
import {
  collectOpportunityOptions,
  countActiveFilters,
  DEFAULT_OPPORTUNITY_FILTERS,
  filterStateFromSearchParams,
  matchesOpportunity,
  normalizeFilterState,
  type OpportunityFilterState,
  opportunityScreeningReviewMode,
  parseSkillList,
  sortOpportunities,
  writeFilterStateSearchParams,
} from './opportunity-filters';
import { completeReviewFixture } from './opportunity-resume-fit-review-projection.test-support';
import { aggregateScreeningQuestionAnswers } from './opportunity-screening-questions';
import { questionScreeningFixture } from './question-screening-projection.test-support';

function filters(
  overrides: Partial<OpportunityFilterState> = {},
): OpportunityFilterState {
  return { ...DEFAULT_OPPORTUNITY_FILTERS, ...overrides };
}

const matchAll = { hasSkill: () => true };
const matchNone = { hasSkill: () => false };

describe('coarse screening review views', () => {
  it('hides proof only in the default untriaged view and keeps human views independent', () => {
    expect(opportunityScreeningReviewMode(' unsorted ')).toBe('exclude');
    expect(opportunityScreeningReviewMode('screened_out')).toBe('only');
    for (const review of ['all', 'apply', 'maybe', 'reject', 'archived'])
      expect(opportunityScreeningReviewMode(review)).toBeNull();
  });
});

function eligibilityRecord(
  eligibilityBucket: string,
  overrides: AdminRecord = {},
): AdminRecord {
  return {
    assessmentProjection: {
      eligibilityBucket,
      sourceStatus: 'current',
      ranking: { eligibilityPriority: 0, fitScore: 80 },
    },
    ...overrides,
  };
}

describe('parseSkillList', () => {
  it('splits, trims, and dedupes case-insensitively', () => {
    expect(parseSkillList('TypeScript, typescript\nNode.js , ')).toEqual([
      'TypeScript',
      'Node.js',
    ]);
  });
});

describe('matchesOpportunity', () => {
  it('uses the same eligibility fallback for filtering and sorting captured-location-only rows', () => {
    const metadataOnly = eligibilityRecord('eligible', {
      id: 'legacy-current',
      sourceEligibilityProjection: {
        sourceStatus: 'unknown',
        eligibilityBucket: 'unknown',
        capturedPostingLocation: {
          sourceStatus: 'current',
          locationNotes: 'Remote Canada',
        },
      },
    });
    const currentUnknown = eligibilityRecord('eligible', {
      id: 'source-unknown',
      sourceEligibilityProjection: {
        sourceStatus: 'current',
        eligibilityBucket: 'unknown',
        reason: 'Legal eligibility is unresolved.',
      },
    });
    const stale = eligibilityRecord('eligible', {
      id: 'stale',
      sourceEligibilityProjection: { sourceStatus: 'unknown' },
      assessmentProjection: {
        sourceStatus: 'stale',
        eligibilityBucket: 'eligible',
      },
    });
    const selected = filters({ eligibilityBuckets: ['eligible'] });
    expect(matchesOpportunity(metadataOnly, selected, matchAll)).toBe(true);
    expect(matchesOpportunity(currentUnknown, selected, matchAll)).toBe(false);
    expect(matchesOpportunity(stale, selected, matchAll)).toBe(false);
    expect(
      sortOpportunities([currentUnknown, metadataOnly], 'eligibility').map(
        (row) => row.id,
      ),
    ).toEqual(['legacy-current', 'source-unknown']);
  });
  it('passes everything with default filters', () => {
    const record: AdminRecord = { status: 'found' };
    expect(matchesOpportunity(record, filters(), matchAll)).toBe(true);
  });

  it('filters by status', () => {
    const record: AdminRecord = { status: 'found' };
    expect(
      matchesOpportunity(record, filters({ status: 'apply' }), matchAll),
    ).toBe(false);
    expect(
      matchesOpportunity(record, filters({ status: 'found' }), matchAll),
    ).toBe(true);
  });

  it('fit=have does not treat matched static skills as an assessment', () => {
    const record: AdminRecord = { requiredSkills: 'Rust, Go' };
    expect(
      matchesOpportunity(record, filters({ fit: 'have' }), matchNone),
    ).toBe(false);
    expect(matchesOpportunity(record, filters({ fit: 'have' }), matchAll)).toBe(
      false,
    );
  });

  it('fit=NeedsEvidence requires a current review rather than a static skill mismatch', () => {
    const record: AdminRecord = { requiredSkills: 'Rust' };
    expect(
      matchesOpportunity(record, filters({ fit: 'gaps' }), matchNone),
    ).toBe(false);
    expect(matchesOpportunity(record, filters({ fit: 'gaps' }), matchAll)).toBe(
      false,
    );
  });

  it('does not infer supported criteria from an empty static skill list', () => {
    const record: AdminRecord = { requiredSkills: '' };
    expect(
      matchesOpportunity(record, filters({ fit: 'have' }), matchNone),
    ).toBe(false);
    expect(
      matchesOpportunity(record, filters({ fit: 'gaps' }), matchNone),
    ).toBe(false);
  });
  it('filters current reviewed support and uncertainty without implying a candidate gap', () => {
    const supported = { resumeFitReviewProjection: completeReviewFixture() };
    const uncertain = {
      resumeFitReviewProjection: completeReviewFixture({ sourceUnknown: true }),
    };
    const stale = {
      resumeFitReviewProjection: {
        ...completeReviewFixture(),
        sourceStatus: 'stale',
      },
    };
    expect(
      matchesOpportunity(supported, filters({ fit: 'have' }), matchNone),
    ).toBe(true);
    expect(
      matchesOpportunity(supported, filters({ fit: 'gaps' }), matchNone),
    ).toBe(false);
    expect(
      matchesOpportunity(uncertain, filters({ fit: 'have' }), matchAll),
    ).toBe(false);
    expect(
      matchesOpportunity(uncertain, filters({ fit: 'gaps' }), matchAll),
    ).toBe(true);
    expect(matchesOpportunity(stale, filters({ fit: 'have' }), matchAll)).toBe(
      false,
    );
    expect(matchesOpportunity(stale, filters({ fit: 'gaps' }), matchAll)).toBe(
      false,
    );
  });

  it('matches any of the selected skills', () => {
    const record: AdminRecord = {
      requiredSkills: 'TypeScript',
      preferredSkills: 'Svelte',
    };
    expect(
      matchesOpportunity(
        record,
        filters({ skills: ['python', 'svelte'] }),
        matchAll,
      ),
    ).toBe(true);
    expect(
      matchesOpportunity(
        record,
        filters({ skills: ['python', 'rust'] }),
        matchAll,
      ),
    ).toBe(false);
  });

  it('overlaps salary ranges and respects the missing-comp toggle', () => {
    const paid: AdminRecord = { salaryMin: 120000, salaryMax: 160000 };
    const unpaid: AdminRecord = {};
    expect(
      matchesOpportunity(paid, filters({ salaryMin: 150000 }), matchAll),
    ).toBe(true);
    expect(
      matchesOpportunity(paid, filters({ salaryMin: 200000 }), matchAll),
    ).toBe(false);
    expect(
      matchesOpportunity(unpaid, filters({ salaryMin: 100000 }), matchAll),
    ).toBe(true);
    expect(
      matchesOpportunity(
        unpaid,
        filters({ salaryMin: 100000, includeMissingComp: false }),
        matchAll,
      ),
    ).toBe(false);
  });

  it('filters by posted-within-days using a fixed now', () => {
    const now = new Date('2026-06-18T00:00:00.000Z');
    const recent: AdminRecord = { postedAt: '2026-06-15T00:00:00.000Z' };
    const stale: AdminRecord = { postedAt: '2026-04-01T00:00:00.000Z' };
    const undated: AdminRecord = {};
    expect(
      matchesOpportunity(recent, filters({ postedWithinDays: 7 }), {
        ...matchAll,
        now,
      }),
    ).toBe(true);
    expect(
      matchesOpportunity(stale, filters({ postedWithinDays: 7 }), {
        ...matchAll,
        now,
      }),
    ).toBe(false);
    expect(
      matchesOpportunity(undated, filters({ postedWithinDays: 7 }), {
        ...matchAll,
        now,
      }),
    ).toBe(false);
  });

  it('excludes expired postings only when asked', () => {
    const now = new Date('2026-06-18T00:00:00.000Z');
    const expired: AdminRecord = { expiresAt: '2026-06-01T00:00:00.000Z' };
    expect(matchesOpportunity(expired, filters(), { ...matchAll, now })).toBe(
      true,
    );
    expect(
      matchesOpportunity(expired, filters({ excludeExpired: true }), {
        ...matchAll,
        now,
      }),
    ).toBe(false);
  });

  it('filters by role attributes and boolean flags', () => {
    const record: AdminRecord = {
      workMode: 'remote',
      employmentType: 'full_time',
      relocationSupported: false,
    };
    expect(
      matchesOpportunity(record, filters({ workModes: ['onsite'] }), matchAll),
    ).toBe(false);
    expect(
      matchesOpportunity(
        record,
        filters({ employmentTypes: ['contract', 'full_time'] }),
        matchAll,
      ),
    ).toBe(true);
    expect(
      matchesOpportunity(
        record,
        filters({ workModes: ['hybrid', 'remote'] }),
        matchAll,
      ),
    ).toBe(true);
    expect(
      matchesOpportunity(record, filters({ relocationOnly: true }), matchAll),
    ).toBe(false);
  });

  it('filters by founder, greenfield, and fresh signal toggles', () => {
    const signal: AdminRecord = {
      founderSignal: true,
      greenfieldSignal: false,
      freshness: 'fresh',
    };
    expect(
      matchesOpportunity(signal, filters({ founderOnly: true }), matchAll),
    ).toBe(true);
    expect(
      matchesOpportunity(signal, filters({ greenfieldOnly: true }), matchAll),
    ).toBe(false);
    expect(
      matchesOpportunity(signal, filters({ freshOnly: true }), matchAll),
    ).toBe(true);
    expect(
      matchesOpportunity(
        { freshness: 'stale' },
        filters({ freshOnly: true }),
        matchAll,
      ),
    ).toBe(false);
  });

  it('matches generic active-profile buckets and treats absent or stale projections as unknown', () => {
    const eligible = eligibilityRecord('eligible');
    const sponsor = eligibilityRecord('sponsorship_possible');
    const stale = eligibilityRecord('eligible', {
      assessmentProjection: {
        eligibilityBucket: 'eligible',
        sourceStatus: 'stale',
        ranking: { eligibilityPriority: 0, fitScore: 80 },
      },
    });
    const selected = filters({
      eligibilityBuckets: ['eligible', 'sponsorship_possible'],
    });
    expect(matchesOpportunity(eligible, selected, matchAll)).toBe(true);
    expect(matchesOpportunity(sponsor, selected, matchAll)).toBe(true);
    expect(matchesOpportunity(stale, selected, matchAll)).toBe(false);
    expect(
      matchesOpportunity(
        stale,
        filters({ eligibilityBuckets: ['unknown'] }),
        matchAll,
      ),
    ).toBe(true);
    const postingOnly = {
      descriptionRaw: 'Location: Canada. No visa sponsorship is available.',
      eligibilityFlags: 1,
    };
    expect(
      matchesOpportunity(
        postingOnly,
        filters({ eligibilityBuckets: ['eligible'] }),
        matchAll,
      ),
    ).toBe(false);
    expect(
      matchesOpportunity(
        postingOnly,
        filters({ eligibilityBuckets: ['unknown'] }),
        matchAll,
      ),
    ).toBe(true);
  });

  it('uses a current source eligibility projection without treating it as a fit score', () => {
    const record: AdminRecord = {
      assessmentProjection: null,
      sourceEligibilityProjection: {
        eligibilityBucket: 'eligible',
        reason: 'Current source fact.',
        sourceStatus: 'current',
        unresolvedConstraintFactKeys: [],
      },
    };
    expect(
      matchesOpportunity(
        record,
        filters({ eligibilityBuckets: ['eligible'] }),
        matchAll,
      ),
    ).toBe(true);
    expect(
      matchesOpportunity(
        record,
        filters({ eligibilityBuckets: ['unknown'] }),
        matchAll,
      ),
    ).toBe(false);
  });

  it('filters explicit fresh freshness mode', () => {
    expect(
      matchesOpportunity(
        { freshness: 'fresh' },
        filters({ freshness: 'fresh' }),
        matchAll,
      ),
    ).toBe(true);
    expect(
      matchesOpportunity(
        { freshness: 'stale' },
        filters({ freshness: 'fresh' }),
        matchAll,
      ),
    ).toBe(false);
  });

  it('filters by rating and score range, excluding unscored', () => {
    const record: AdminRecord = { humanRating: 6, latestScore: 72 };
    const unscored: AdminRecord = {};
    expect(
      matchesOpportunity(record, filters({ minRating: 7 }), matchAll),
    ).toBe(false);
    expect(
      matchesOpportunity(
        record,
        filters({ minScore: 70, maxScore: 80 }),
        matchAll,
      ),
    ).toBe(true);
    expect(
      matchesOpportunity(unscored, filters({ minScore: 50 }), matchAll),
    ).toBe(false);
  });
});

describe('sortOpportunities', () => {
  it('orders best by native complete support counts while preserving human status, eligibility and legacy-only scores', () => {
    const one = completeReviewFixture();
    const fit = {
      ...one.evidenceFit,
      supportedCriterionCount: 2,
      consideredCriterionCount: 2,
    };
    const two = {
      ...one,
      evidenceFit: fit,
      completion: {
        ...one.completion,
        catalogClauseCount: 2,
        reviewedMaterialClauseCount: 2,
      },
      coverage: {
        ...one.coverage,
        fullFit: fit,
        reviewedRequirementIds: ['material:c1', 'material:c2'],
        reviewedMaterialClauseIds: ['c1', 'c2'],
        sourceClauseConsideration: [
          ...one.coverage.sourceClauseConsideration,
          {
            ...one.coverage.sourceClauseConsideration[0],
            clauseId: 'c2',
            requirementIds: ['original:r2'],
            originalRequirementIds: ['original:r2'],
          },
        ],
      },
      requirements: [
        ...one.requirements,
        {
          ...one.requirements[0],
          id: 'material:c2',
          originalRequirementIds: ['original:r2'],
          postingCitations: [
            { ...one.requirements[0].postingCitations[0], clauseId: 'c2' },
          ],
        },
      ],
    };
    const lower = {
      id: 'one',
      status: 'found',
      latestScore: 100,
      resumeFitReviewProjection: one,
    };
    const higher = {
      id: 'two',
      status: 'found',
      latestScore: 1,
      resumeFitReviewProjection: two,
    };
    const legacy = { id: 'legacy', status: 'found', latestScore: 99 };
    expect(
      sortOpportunities([lower, legacy, higher], 'best').map((row) => row.id),
    ).toEqual(['two', 'one', 'legacy']);
    expect(
      sortOpportunities([higher, { ...lower, status: 'apply' }], 'best').map(
        (row) => row.id,
      ),
    ).toEqual(['one', 'two']);
    expect(
      sortOpportunities(
        [
          higher,
          {
            ...lower,
            sourceEligibilityProjection: {
              sourceStatus: 'current',
              eligibilityBucket: 'eligible',
            },
          },
        ],
        'best',
      ).map((row) => row.id),
    ).toEqual(['one', 'two']);
    expect(
      sortOpportunities(
        [legacy, { id: 'older', status: 'found', latestScore: 50 }],
        'best',
      ).map((row) => row.id),
    ).toEqual(['legacy', 'older']);
    expect(
      sortOpportunities(
        [
          legacy,
          {
            ...lower,
            resumeFitReviewProjection: completeReviewFixture({ context: true }),
          },
        ],
        'best',
      ).map((row) => row.id),
    ).toEqual(['legacy', 'one']);
  });

  it('treats current complete reviews and owned unavailable complete reviews as unscored without changing legacy numeric scores', () => {
    const complete = {
      id: 'complete',
      latestScore: 99,
      resumeFitReviewProjection: completeReviewFixture(),
    };
    const unavailable = {
      id: 'unavailable',
      latestScore: 100,
      completeReviewStatus: 'unknown',
    };
    const legacy = { id: 'legacy', latestScore: 50 };
    for (const record of [complete, unavailable]) {
      expect(
        matchesOpportunity(record, filters({ minScore: 1 }), matchAll),
      ).toBe(false);
      expect(
        matchesOpportunity(record, filters({ maxScore: 100 }), matchAll),
      ).toBe(false);
    }
    expect(
      matchesOpportunity(
        legacy,
        filters({ minScore: 40, maxScore: 60 }),
        matchAll,
      ),
    ).toBe(true);
    for (const direction of ['asc', 'desc'] as const) {
      expect(
        sortOpportunities(
          [complete, unavailable, legacy],
          'score',
          direction,
        ).map((r) => r.id),
      ).toEqual(['legacy', 'complete', 'unavailable']);
    }
  });

  const records: AdminRecord[] = [
    {
      id: 'a',
      status: 'found',
      latestScore: 50,
      salaryMax: 100000,
      humanRating: 2,
      postedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'b',
      status: 'apply',
      latestScore: 90,
      salaryMax: 200000,
      humanRating: 9,
      postedAt: '2026-06-01T00:00:00.000Z',
    },
    {
      id: 'c',
      status: 'recommended',
      latestScore: 70,
      salaryMax: 150000,
      humanRating: 5,
      postedAt: '2026-03-01T00:00:00.000Z',
    },
  ];

  for (const sort of ['newest', 'score', 'salary', 'rating'] as const) {
    for (const direction of ['asc', 'desc'] as const) {
      it(`${sort} ${direction} keeps missing values last and uses stable SQL tie breaks`, () => {
        const shared = {
          postedAt: '2026-01-01',
          latestScore: 50,
          salaryMin: 100,
          humanRating: 4,
        };
        const rows: AdminRecord[] = [
          { id: 'missing', updatedAt: '2026-03-01' },
          { id: 'z', ...shared, updatedAt: '2026-02-01' },
          { id: 'older', ...shared, updatedAt: '2026-01-01' },
          { id: 'a', ...shared, updatedAt: '2026-02-01' },
        ];
        expect(
          sortOpportunities(rows, sort, direction).map((row) => row.id),
        ).toEqual(['a', 'z', 'older', 'missing']);
      });
    }
  }

  it('best sort orders by status rank then score', () => {
    expect(sortOpportunities(records, 'best').map((r) => r.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('keeps current generic profile eligibility ranking within an existing best-fit status rank', () => {
    const unknown = eligibilityRecord('unknown', {
      id: 'unknown',
      status: 'found',
      latestScore: 90,
      assessmentProjection: {
        eligibilityBucket: 'unknown',
        sourceStatus: 'current',
        ranking: { eligibilityPriority: 2, fitScore: 90 },
      },
    });
    const eligible = eligibilityRecord('eligible', {
      id: 'eligible',
      status: 'found',
      latestScore: 10,
      assessmentProjection: {
        eligibilityBucket: 'eligible',
        sourceStatus: 'current',
        ranking: { eligibilityPriority: 0, fitScore: 10 },
      },
    });
    const conflicting = eligibilityRecord('conflicting', {
      id: 'conflicting',
      status: 'found',
      latestScore: 100,
      assessmentProjection: {
        eligibilityBucket: 'conflicting',
        sourceStatus: 'current',
        ranking: { eligibilityPriority: 3, fitScore: 100 },
      },
    });
    expect(
      sortOpportunities([unknown, conflicting, eligible], 'best').map(
        (record) => record.id,
      ),
    ).toEqual(['eligible', 'unknown', 'conflicting']);
    expect(
      sortOpportunities([unknown, conflicting, eligible], 'eligibility').map(
        (record) => record.id,
      ),
    ).toEqual(['eligible', 'unknown', 'conflicting']);
  });

  it('newest sort orders by posted date desc', () => {
    expect(sortOpportunities(records, 'newest').map((r) => r.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('salary sort orders by top salary desc', () => {
    expect(sortOpportunities(records, 'salary').map((r) => r.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('sorts score ascending when requested', () => {
    expect(sortOpportunities(records, 'score', 'asc').map((r) => r.id)).toEqual(
      ['a', 'c', 'b'],
    );
  });

  it('newest sort falls back to firstSeenAt when postedAt is missing', () => {
    const mixed: AdminRecord[] = [
      { id: 'old', firstSeenAt: '2026-01-01T00:00:00.000Z' },
      { id: 'new', firstSeenAt: '2026-06-01T00:00:00.000Z' },
      { id: 'posted', postedAt: '2026-03-01T00:00:00.000Z' },
      { id: 'undated' },
    ];
    expect(sortOpportunities(mixed, 'newest').map((r) => r.id)).toEqual([
      'new',
      'posted',
      'old',
      'undated',
    ]);
  });

  it('does not mutate the input array', () => {
    const input = [...records];
    sortOpportunities(input, 'score');
    expect(input.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('collectOpportunityOptions', () => {
  it('gathers deduped, sorted option lists and skips unknown sentinels', () => {
    const options = collectOpportunityOptions([
      {
        status: 'found',
        workMode: 'remote',
        employmentType: 'unknown',
        requiredSkills: 'TypeScript',
      },
      {
        status: 'apply',
        workMode: 'unknown',
        preferredSkills: 'typescript, Svelte',
      },
    ]);
    expect(options.statuses).toEqual(['apply', 'found']);
    expect(options.workModes).toEqual(['remote']);
    expect(options.employmentTypes).toEqual([]);
    expect(options.skills).toEqual(['Svelte', 'TypeScript']);
  });
});

describe('countActiveFilters', () => {
  it('is zero for defaults and counts narrowing dimensions', () => {
    expect(countActiveFilters(filters())).toBe(0);
    expect(
      countActiveFilters(
        filters({
          employmentTypes: ['full_time', 'contract'],
          skills: ['x'],
          sort: 'newest',
          status: 'apply',
          workModes: ['remote'],
        }),
      ),
    ).toBe(4);
  });

  it('ignores includeMissingComp unless a comp range is active', () => {
    // Toggling off "include missing comp" alone does not narrow anything.
    expect(countActiveFilters(filters({ includeMissingComp: false }))).toBe(0);
    // With a salary range it both narrows and counts (range + toggle = 2).
    expect(
      countActiveFilters(
        filters({ includeMissingComp: false, salaryMin: 100000 }),
      ),
    ).toBe(2);
  });
});

describe('normalizeFilterState', () => {
  it('falls back to defaults for junk input', () => {
    expect(normalizeFilterState(null)).toEqual(DEFAULT_OPPORTUNITY_FILTERS);
    expect(normalizeFilterState('nope')).toEqual(DEFAULT_OPPORTUNITY_FILTERS);
  });

  it('keeps known keys and drops unknown / wrong-typed ones', () => {
    const result = normalizeFilterState({
      status: 'apply',
      fit: 'have',
      skills: ['TypeScript', 42],
      salaryMin: 100000,
      minRating: 'high',
      sort: 'newest',
      sortDirection: 'asc',
      bogus: true,
    });
    expect(result.status).toBe('apply');
    expect(result.fit).toBe('have');
    expect(result.skills).toEqual(['TypeScript']);
    expect(result.salaryMin).toBe(100000);
    expect(result.minRating).toBeNull();
    expect(result.sort).toBe('newest');
    expect(result.sortDirection).toBe('asc');
    expect(result).not.toHaveProperty('bogus');
  });

  it('normalizes multi-select role format filters and legacy single values', () => {
    expect(
      normalizeFilterState({
        employmentTypes: ['full_time', 12, 'contract', ''],
        workModes: ['remote', 'all', 'hybrid'],
      }),
    ).toMatchObject({
      employmentTypes: ['full_time', 'contract'],
      workModes: ['remote', 'hybrid'],
    });

    expect(
      normalizeFilterState({
        employmentType: 'full_time',
        workMode: 'remote',
      }),
    ).toMatchObject({
      employmentTypes: ['full_time'],
      workModes: ['remote'],
    });
  });
});

describe('opportunity filter query params', () => {
  it('round-trips non-default filters and leaves defaults out of the URL', () => {
    const params = new URLSearchParams('review=apply&page=3');
    writeFilterStateSearchParams(
      params,
      filters({
        excludeExpired: true,
        fit: 'have',
        includeMissingComp: false,
        minScore: 70,
        postedWithinDays: 30,
        salaryMin: 100000,
        skills: ['SvelteKit', 'TypeScript'],
        sort: 'score',
        employmentTypes: ['full_time', 'contract'],
        workModes: ['remote', 'hybrid'],
        eligibilityBuckets: ['eligible', 'unknown'],
      }),
    );

    expect(params.toString()).toBe(
      'review=apply&page=3&fit=have&skill=SvelteKit&skill=TypeScript&salaryMin=100000&includeMissingComp=false&postedWithinDays=30&excludeExpired=true&employmentType=full_time&employmentType=contract&workMode=remote&workMode=hybrid&eligibilityBucket=eligible&eligibilityBucket=unknown&minScore=70&sort=score',
    );
    expect(filterStateFromSearchParams(params)).toMatchObject({
      excludeExpired: true,
      fit: 'have',
      includeMissingComp: false,
      minScore: 70,
      postedWithinDays: 30,
      salaryMin: 100000,
      skills: ['SvelteKit', 'TypeScript'],
      sort: 'score',
      employmentTypes: ['full_time', 'contract'],
      workModes: ['remote', 'hybrid'],
      eligibilityBuckets: ['eligible', 'unknown'],
    });

    writeFilterStateSearchParams(params, DEFAULT_OPPORTUNITY_FILTERS);

    expect(params.toString()).toBe('review=apply&page=3');
  });

  it('round-trips a non-default sort direction', () => {
    const params = new URLSearchParams();
    writeFilterStateSearchParams(params, {
      ...DEFAULT_OPPORTUNITY_FILTERS,
      sort: 'score',
      sortDirection: 'asc',
    });

    expect(params.toString()).toBe('sort=score&sortDirection=asc');
    expect(filterStateFromSearchParams(params)).toMatchObject({
      sort: 'score',
      sortDirection: 'asc',
    });
  });

  it('maps saved Canada-era eligibility URL values to generic profile buckets', () => {
    const filters = filterStateFromSearchParams(
      new URLSearchParams(
        'eligibilityBucket=canada_eligible&eligibilityBucket=us_residence_required',
      ),
    );
    expect(filters.eligibilityBuckets).toEqual([
      'eligible',
      'location_restriction',
    ]);
  });
});

function citedProjection(
  supported: number,
  assessed = supported || 1,
  unresolved = 2,
) {
  return {
    version: 'opportunity-assessment-partial-projection/v1',
    mode: 'partial',
    sourceStatus: 'current',
    supportedCriterionCount: supported,
    criterionCount: assessed,
    unresolvedSourceClauseCount: unresolved,
    requirements: Array.from({ length: assessed }, (_, i) => ({
      id: `criterion-${i}`,
      text: 'Maintain APIs.',
      support: i < supported ? 'supported' : 'uncertain',
      postingCitations: [
        { excerpt: 'Maintain APIs.', clauseId: 'clause', start: 0, end: 13 },
      ],
      candidateCitations: [],
    })),
  };
}

describe('cited support order', () => {
  it('ranks current user questions before pagination-equivalent ties without promoting stale scores or treating unknown must-haves as conflicts', async () => {
    const current = await questionScreeningFixture();
    const conflictingAnswers = current.answers.map((answer) =>
      answer.questionId === 'authorization'
        ? {
            ...answer,
            answer: 'no' as const,
            alignment: 0 as const,
            confidence: 0.99,
            sourceCitations: [
              {
                id: 'authorization-clause',
                text: 'Authorization is not provided.',
                start: 0,
                end: 30,
              },
            ],
          }
        : answer,
    );
    const conflict = {
      ...current,
      answers: conflictingAnswers,
      aggregate: aggregateScreeningQuestionAnswers(
        current.questions,
        conflictingAnswers,
      ),
    };
    const rows = [
      {
        id: 'stale',
        status: 'found',
        questionScreeningEnabled: true,
        questionScreeningProjection: current,
        questionScreeningStatus: 'unknown',
        latestScore: 99,
        updatedAt: '2026-01-01',
      },
      {
        id: 'conflict',
        status: 'found',
        questionScreeningEnabled: true,
        questionScreeningProjection: conflict,
        updatedAt: '2026-01-01',
      },
      {
        id: 'current',
        status: 'found',
        questionScreeningEnabled: true,
        questionScreeningProjection: current,
        updatedAt: '2026-01-01',
      },
      {
        id: 'human-apply',
        status: 'apply',
        questionScreeningEnabled: true,
        updatedAt: '2026-01-01',
      },
    ];
    expect(sortOpportunities(rows, 'best').map((row) => row.id)).toEqual([
      'human-apply',
      'current',
      'stale',
      'conflict',
    ]);
    expect(
      sortOpportunities(rows, 'recommendation').map((row) => row.id),
    ).toEqual(['conflict', 'current', 'human-apply', 'stale']);
    expect(current.aggregate.mustHaveConflictIds).toEqual([]);
    expect(current.aggregate.unresolvedMustHaveIds).toHaveLength(2);
  });

  it.each([
    'score',
    'recommendation',
  ] as const)('sorts %s by badge number in both directions, putting stale and title-only last', async (sort) => {
    const mid = await questionScreeningFixture();
    const highAnswers = mid.answers.map((answer) =>
      answer.questionId === 'experience'
        ? { ...answer, answer: 'yes' as const, alignment: 4 as const }
        : answer,
    );
    const high = {
      ...mid,
      answers: highAnswers,
      aggregate: aggregateScreeningQuestionAnswers(mid.questions, highAnswers),
    };
    const rows = [
      {
        id: 'mid',
        latestScore: 99,
        questionScreeningEnabled: true,
        questionScreeningProjection: mid,
      },
      {
        id: 'high',
        latestScore: 1,
        questionScreeningEnabled: true,
        questionScreeningProjection: high,
      },
      {
        id: 'stale',
        latestScore: 100,
        questionScreeningEnabled: true,
        questionScreeningProjection: high,
        questionScreeningStatus: 'unknown',
      },
      {
        id: 'title',
        latestScore: 100,
        questionScreeningEnabled: true,
        questionScreeningProjection: {
          ...mid,
          answers: [],
          aggregate: aggregateScreeningQuestionAnswers([], []),
          rolePreScreen: {
            title: 'Accountant',
            targetRoles: ['Engineer'],
            outcome: 'unrelated',
            confidence: 0.99,
          },
        },
      },
    ];
    expect(sortOpportunities(rows, sort, 'asc').map((row) => row.id)).toEqual([
      'mid',
      'high',
      'stale',
      'title',
    ]);
    expect(sortOpportunities(rows, sort, 'desc').map((row) => row.id)).toEqual([
      'high',
      'mid',
      'stale',
      'title',
    ]);
  });

  it('orders continuous supplied-evidence relevance after strict support without inventing verified partial positives', () => {
    function advisoryReview(probability: number) {
      const fixture = completeReviewFixture({ uncertain: true });
      return {
        ...fixture,
        model: 'openai/gpt-6.1-sol',
        requirements: [
          {
            ...fixture.requirements[0],
            candidateCitations:
              completeReviewFixture().requirements[0]?.candidateCitations,
          },
        ],
        verification: {
          sourceStatus: 'current',
          version:
            'opportunity-review-strength-verification/v2-partial-relevance',
          model: 'jev-1.13.0',
          strengthClaimCount: 1,
          verifiedStrengthCount: 0,
          seniorityClaimCount: 1,
          verifiedSeniorityCount: 0,
          partialClaimCount: 1,
          verifiedPartialCount: 0,
          partialSupportedRequirementIds: [],
        },
        advisoryRelevance: {
          kind: 'supplied_evidence_relevance',
          denominator: 1,
          weightedMean: probability,
          criterionProbabilityPairs: [
            {
              requirementId: 'material:c1',
              probability,
              evidenceStatus: 'cited',
            },
          ],
        },
      };
    }
    const rows = [
      {
        id: 'less-relevant',
        status: 'found',
        resumeFitReviewProjection: advisoryReview(0.2),
      },
      {
        id: 'more-relevant',
        status: 'found',
        resumeFitReviewProjection: advisoryReview(0.6),
      },
      {
        id: 'strict',
        status: 'found',
        resumeFitReviewProjection: completeReviewFixture(),
      },
    ];
    for (const sort of ['cited_support', 'best'] as const) {
      expect(sortOpportunities(rows, sort).map((row) => row.id)).toEqual([
        'strict',
        'more-relevant',
        'less-relevant',
      ]);
    }
    expect(
      sortOpportunities(rows, 'cited_support', 'asc').map((row) => row.id),
    ).toEqual(['less-relevant', 'more-relevant', 'strict']);
  });

  it('orders advisory partial evidence only after strict native counts and ratio in cited and best order', () => {
    function partialReview(partialCount: number, considered: number) {
      const fixture = completeReviewFixture({ uncertain: true });
      const fit = {
        ...fixture.evidenceFit,
        uncertainCriterionCount: considered,
        consideredCriterionCount: considered,
      };
      const rows = Array.from({ length: considered }, (_, index) => ({
        ...fixture.requirements[0],
        id: `material:c${index}`,
        originalRequirementIds: [`r${index}`],
        candidateCitations:
          completeReviewFixture().requirements[0]?.candidateCitations,
        postingCitations: [
          {
            ...fixture.requirements[0]?.postingCitations[0],
            clauseId: `c${index}`,
          },
        ],
      }));
      return {
        ...fixture,
        model: 'openai/gpt-6.1-sol',
        evidenceFit: fit,
        requirements: rows,
        completion: {
          ...fixture.completion,
          catalogClauseCount: considered,
          reviewedMaterialClauseCount: considered,
        },
        coverage: {
          ...fixture.coverage,
          fullFit: fit,
          reviewedRequirementIds: rows.map((row) => row.id),
          reviewedMaterialClauseIds: rows.map((_, index) => `c${index}`),
          sourceClauseConsideration: rows.map((_, index) => ({
            ...fixture.coverage.sourceClauseConsideration[0],
            clauseId: `c${index}`,
            requirementIds: [`r${index}`],
            originalRequirementIds: [`r${index}`],
          })),
        },
        verification: {
          sourceStatus: 'current',
          version:
            'opportunity-review-strength-verification/v2-partial-relevance',
          model: 'jev-1.13.0',
          strengthClaimCount: considered,
          verifiedStrengthCount: 0,
          seniorityClaimCount: 0,
          verifiedSeniorityCount: 0,
          partialClaimCount: considered,
          verifiedPartialCount: partialCount,
          partialSupportedRequirementIds: rows
            .slice(0, partialCount)
            .map((row) => row.id),
        },
      };
    }
    const rows = [
      {
        id: 'one-of-two',
        status: 'found',
        resumeFitReviewProjection: partialReview(1, 2),
      },
      {
        id: 'two-of-two',
        status: 'found',
        resumeFitReviewProjection: partialReview(2, 2),
      },
      {
        id: 'one-of-one',
        status: 'found',
        resumeFitReviewProjection: partialReview(1, 1),
      },
      {
        id: 'strict',
        status: 'found',
        resumeFitReviewProjection: completeReviewFixture(),
      },
    ];
    for (const sort of ['cited_support', 'best'] as const) {
      expect(sortOpportunities(rows, sort).map((row) => row.id)).toEqual([
        'strict',
        'two-of-two',
        'one-of-one',
        'one-of-two',
      ]);
    }
    expect(
      sortOpportunities(rows, 'cited_support', 'asc').map((row) => row.id),
    ).toEqual(['one-of-two', 'one-of-one', 'two-of-two', 'strict']);
  });

  it('uses complete current counts and ratio before legacy ties and suppresses stale complete fallback', () => {
    const full = completeReviewFixture();
    const unknown = completeReviewFixture({ sourceUnknown: true });
    const fit = {
      ...full.evidenceFit,
      sourceUnknownCriterionCount: 1,
      sourceClassificationUnknownCount: 1,
      consideredCriterionCount: 2,
      supportLowerBound: 0.5,
      status: 'supported_with_uncertainties',
    };
    const mixed = {
      ...full,
      evidenceFit: fit,
      completion: {
        ...full.completion,
        catalogClauseCount: 2,
        reviewedMaterialClauseCount: 2,
        possibleRequirementCount: 1,
      },
      coverage: {
        ...full.coverage,
        fullFit: fit,
        reviewedRequirementIds: ['material:c1', 'material:c2'],
        reviewedMaterialClauseIds: ['c1', 'c2'],
        unresolvedClauseIds: ['c2'],
        requirementsCertainty: 'uncertain',
        sourceClauseConsideration: [
          ...full.coverage.sourceClauseConsideration,
          { ...unknown.coverage.sourceClauseConsideration[0], clauseId: 'c2' },
        ],
      },
      requirements: [
        ...full.requirements,
        {
          ...unknown.requirements[0],
          id: 'material:c2',
          postingCitations: [
            { ...unknown.requirements[0].postingCitations[0], clauseId: 'c2' },
          ],
        },
      ],
    };
    const records = [
      { id: 'a-half', resumeFitReviewProjection: mixed },
      { id: 'z-full', resumeFitReviewProjection: full },
      { id: 'legacy', partialAssessmentProjection: citedProjection(1) },
      {
        id: 'stale-v4',
        resumeFitReviewProjection: { ...full, sourceStatus: 'stale' },
        partialAssessmentProjection: citedProjection(99),
      },
    ];
    expect(
      sortOpportunities(records, 'cited_support').map((r) => r.id),
    ).toEqual(['z-full', 'a-half', 'legacy', 'stale-v4']);
    expect(
      sortOpportunities(records, 'cited_support', 'asc').map((r) => r.id),
    ).toEqual(['a-half', 'z-full', 'legacy', 'stale-v4']);
  });

  const rows = [
    {
      id: 'cache-only',
      latestScore: 100,
      assessmentJson: JSON.stringify(citedProjection(50)),
    },
    {
      id: 'stale',
      updatedAt: '2026-10-02',
      partialAssessmentProjection: {
        ...citedProjection(20),
        sourceStatus: 'stale',
      },
    },
    { id: 'zero', partialAssessmentProjection: citedProjection(0) },
    {
      id: 'three',
      latestScore: 1,
      partialAssessmentProjection: citedProjection(3, 23, 17),
    },
    {
      id: 'a-four',
      updatedAt: '2026-10-01',
      partialAssessmentProjection: citedProjection(4, 30, 25),
    },
    {
      id: 'z-four',
      updatedAt: '2026-10-01',
      partialAssessmentProjection: citedProjection(4, 4, 0),
    },
  ];
  it('groups current cited support ahead of unavailable proof without using scores, ratios or unresolved counts', () => {
    expect(sortOpportunities(rows, 'cited_support').map((r) => r.id)).toEqual([
      'a-four',
      'z-four',
      'three',
      'zero',
      'stale',
      'cache-only',
    ]);
    expect(rows[0]!.id).toBe('cache-only');
  });
  it('keeps unavailable proof last in ascending order and retains current zero support', () => {
    expect(
      sortOpportunities(rows, 'cited_support', 'asc').map((r) => r.id),
    ).toEqual(['zero', 'three', 'a-four', 'z-four', 'stale', 'cache-only']);
  });
  it('round-trips the independent server sort through URLs and persisted filter normalization', () => {
    const state = filters({ sort: 'cited_support', sortDirection: 'asc' });
    const params = new URLSearchParams('triage=1&skill=Rust');
    writeFilterStateSearchParams(params, state);
    expect(params.get('sort')).toBe('cited_support');
    expect(params.get('triage')).toBe('1');
    expect(filterStateFromSearchParams(params)).toMatchObject({
      sort: 'cited_support',
      sortDirection: 'asc',
    });
    expect(normalizeFilterState(state)).toMatchObject({
      sort: 'cited_support',
    });
    expect(countActiveFilters(state)).toBe(0);
  });
});
