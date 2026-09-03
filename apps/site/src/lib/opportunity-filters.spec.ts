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
  parseSkillList,
  sortOpportunities,
  writeFilterStateSearchParams,
} from './opportunity-filters';

function filters(
  overrides: Partial<OpportunityFilterState> = {},
): OpportunityFilterState {
  return { ...DEFAULT_OPPORTUNITY_FILTERS, ...overrides };
}

const matchAll = { hasSkill: () => true };
const matchNone = { hasSkill: () => false };

describe('parseSkillList', () => {
  it('splits, trims, and dedupes case-insensitively', () => {
    expect(parseSkillList('TypeScript, typescript\nNode.js , ')).toEqual([
      'TypeScript',
      'Node.js',
    ]);
  });
});

describe('matchesOpportunity', () => {
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

  it('fit=have excludes records with an unmatched required skill', () => {
    const record: AdminRecord = { requiredSkills: 'Rust, Go' };
    expect(
      matchesOpportunity(record, filters({ fit: 'have' }), matchNone),
    ).toBe(false);
    expect(matchesOpportunity(record, filters({ fit: 'have' }), matchAll)).toBe(
      true,
    );
  });

  it('fit=gaps keeps only records with an unmatched required skill', () => {
    const record: AdminRecord = { requiredSkills: 'Rust' };
    expect(
      matchesOpportunity(record, filters({ fit: 'gaps' }), matchNone),
    ).toBe(true);
    expect(matchesOpportunity(record, filters({ fit: 'gaps' }), matchAll)).toBe(
      false,
    );
  });

  it('treats a posting with no required skills as having no gaps', () => {
    const record: AdminRecord = { requiredSkills: '' };
    expect(
      matchesOpportunity(record, filters({ fit: 'have' }), matchNone),
    ).toBe(true);
    expect(
      matchesOpportunity(record, filters({ fit: 'gaps' }), matchNone),
    ).toBe(false);
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

  it('best sort orders by status rank then score', () => {
    expect(sortOpportunities(records, 'best').map((r) => r.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
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
      }),
    );

    expect(params.toString()).toBe(
      'review=apply&page=3&fit=have&skill=SvelteKit&skill=TypeScript&salaryMin=100000&includeMissingComp=false&postedWithinDays=30&excludeExpired=true&employmentType=full_time&employmentType=contract&workMode=remote&workMode=hybrid&minScore=70&sort=score',
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
});
