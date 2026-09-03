import { performance } from 'node:perf_hooks';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import type { AdminRecord } from '$lib/admin/dock';
import experienceData from '$lib/data/experience.json';
import skillsData from '$lib/data/skills.json';
import {
  DEFAULT_OPPORTUNITY_FILTERS,
  matchesOpportunity,
  type OpportunityFilterState,
} from '$lib/opportunity-filters';
import {
  candidateSkillTermsFromData,
  createCandidateSkillMatcher,
} from '$lib/skill-matching';
import {
  countOpportunityRecords,
  listLatestOpportunityRelatedContext,
  listOpportunityFilterOptions,
  listOpportunityPageIds,
  OPPORTUNITY_TABLE_PAGE_SIZE,
} from './admin-opportunity-query.js';
import { getDatabaseUrl, getDbConfig } from './db.js';

const runSnapshotCoverage = process.env.OPPORTUNITY_LIST_PERF === '1';

function assertLocalSnapshotDatabase(): void {
  const url = new URL(getDatabaseUrl());
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error(
      'Opportunity performance coverage requires a local restored database snapshot.',
    );
  }
}

function reviewFilterMatches(
  record: AdminRecord,
  reviewFilter: string,
): boolean {
  const status =
    typeof record.humanReviewStatus === 'string'
      ? record.humanReviewStatus.trim().toLowerCase()
      : '';
  if (!reviewFilter || reviewFilter === 'all') return true;
  if (reviewFilter === 'unsorted') {
    return !['apply', 'maybe', 'reject'].includes(status);
  }
  if (reviewFilter === 'missing_application_planning') {
    return (
      status === 'apply' &&
      (!record.applicationId ||
        !record.applicationResumeMode ||
        !record.applicationCoverLetterMode)
    );
  }
  return status === reviewFilter;
}

async function allSnapshotOpportunityRecords(): Promise<AdminRecord[]> {
  const db = await resolveDatabase(getDbConfig());
  const result = await db.query(`
    SELECT
      o.id,
      o.status,
      o.required_skills AS "requiredSkills",
      o.preferred_skills AS "preferredSkills",
      o.salary_min AS "salaryMin",
      o.salary_max AS "salaryMax",
      o.hourly_min AS "hourlyMin",
      o.hourly_max AS "hourlyMax",
      o.posted_at AS "postedAt",
      o.first_seen_at AS "firstSeenAt",
      o.expires_at AS "expiresAt",
      o.freshness,
      o.employment_type AS "employmentType",
      o.work_mode AS "workMode",
      o.seniority,
      o.relocation_supported AS "relocationSupported",
      o.visa_or_eor_possible AS "visaOrEorPossible",
      o.founder_signal AS "founderSignal",
      o.greenfield_signal AS "greenfieldSignal",
      o.human_rating AS "humanRating",
      o.human_review_status AS "humanReviewStatus",
      latest.score AS "latestScore",
      latest_application.id AS "applicationId",
      latest_application.resume_mode AS "applicationResumeMode",
      latest_application.cover_letter_mode AS "applicationCoverLetterMode"
    FROM opportunities o
    LEFT JOIN LATERAL (
      SELECT es.score
      FROM evaluation_scores es
      WHERE es.opportunity_id = o.id
        AND COALESCE(es.source_content_fingerprint, '') =
          COALESCE(o.source_content_fingerprint, '')
      ORDER BY es.updated_at DESC
      LIMIT 1
    ) latest ON TRUE
    LEFT JOIN LATERAL (
      SELECT a.id, a.resume_mode, a.cover_letter_mode
      FROM applications a
      WHERE a.opportunity_id = o.id
      ORDER BY a.updated_at DESC
      LIMIT 1
    ) latest_application ON TRUE
  `);
  return result.rows as AdminRecord[];
}

describe.runIf(runSnapshotCoverage)(
  'admin opportunity query on a restored production snapshot',
  () => {
    it('returns stable, bounded score-sorted pages inside the local performance budget', async () => {
      assertLocalSnapshotDatabase();
      const query = {
        candidateSkills: [],
        filters: { ...DEFAULT_OPPORTUNITY_FILTERS, sort: 'best' as const },
        reviewFilter: 'unsorted',
      };
      const startedAt = performance.now();
      const [total, firstPage] = await Promise.all([
        countOpportunityRecords(query),
        listOpportunityPageIds({
          ...query,
          limit: OPPORTUNITY_TABLE_PAGE_SIZE,
          offset: 0,
        }),
      ]);
      const elapsedMs = performance.now() - startedAt;
      const repeatedFirstPage = await listOpportunityPageIds({
        ...query,
        limit: OPPORTUNITY_TABLE_PAGE_SIZE,
        offset: 0,
      });

      expect(total).toBeGreaterThan(OPPORTUNITY_TABLE_PAGE_SIZE);
      expect(firstPage).toHaveLength(OPPORTUNITY_TABLE_PAGE_SIZE);
      expect(new Set(firstPage)).toHaveLength(firstPage.length);
      expect(repeatedFirstPage).toEqual(firstPage);
      expect(elapsedMs).toBeLessThan(500);
    });

    it('loads related context through the type-adaptive opportunity ID query', async () => {
      assertLocalSnapshotDatabase();
      const opportunityIds = await listOpportunityPageIds({
        candidateSkills: [],
        filters: DEFAULT_OPPORTUNITY_FILTERS,
        limit: 1,
        offset: 0,
        reviewFilter: 'all',
      });

      expect(opportunityIds).toHaveLength(1);
      await expect(
        listLatestOpportunityRelatedContext(opportunityIds),
      ).resolves.toEqual(expect.any(Array));
    });

    it('lets PostgreSQL infer UUID array parameters from an uncast ID column', async () => {
      assertLocalSnapshotDatabase();
      const id = '11111111-1111-4111-8111-111111111111';
      const db = await resolveDatabase(getDbConfig());
      const result = await db.query(
        `WITH uuid_opportunities AS (
          SELECT $1::uuid AS id
        )
        SELECT o.id
        FROM uuid_opportunities o
        WHERE o.id = ANY($2)`,
        id,
        [id],
      );

      expect(result.rows).toEqual([{ id }]);
    });

    it('keeps URL skill filters and compact facets off the rendered page payload', async () => {
      assertLocalSnapshotDatabase();
      const query = {
        candidateSkills: [],
        filters: {
          ...DEFAULT_OPPORTUNITY_FILTERS,
          skills: ['Kubernetes'],
          sort: 'score' as const,
        },
        reviewFilter: 'unsorted',
      };
      const [total, pageIds, facets] = await Promise.all([
        countOpportunityRecords(query),
        listOpportunityPageIds({
          ...query,
          limit: OPPORTUNITY_TABLE_PAGE_SIZE,
          offset: 0,
        }),
        listOpportunityFilterOptions(query.reviewFilter),
      ]);

      expect(total).toBeGreaterThan(0);
      expect(pageIds.length).toBeLessThanOrEqual(OPPORTUNITY_TABLE_PAGE_SIZE);
      expect(pageIds.length).toBeLessThanOrEqual(total);
      expect(facets.skills.map((skill) => skill.toLowerCase())).toContain(
        'kubernetes',
      );
    });

    it('matches legacy filter semantics across every URL filter dimension and sort', async () => {
      assertLocalSnapshotDatabase();
      const [records, candidateSkills] = await Promise.all([
        allSnapshotOpportunityRecords(),
        Promise.resolve(
          candidateSkillTermsFromData({
            experience: experienceData,
            skills: skillsData,
          }),
        ),
      ]);
      const hasSkill = createCandidateSkillMatcher(candidateSkills);
      const cases: Array<{
        filters: OpportunityFilterState;
        label: string;
        reviewFilter: string;
      }> = [
        {
          filters: { ...DEFAULT_OPPORTUNITY_FILTERS },
          label: 'all review statuses',
          reviewFilter: 'all',
        },
        {
          filters: {
            ...DEFAULT_OPPORTUNITY_FILTERS,
            salaryMin: 100_000,
            salaryMax: 250_000,
            includeMissingComp: false,
          },
          label: 'salary range',
          reviewFilter: 'unsorted',
        },
        {
          filters: {
            ...DEFAULT_OPPORTUNITY_FILTERS,
            hourlyMin: 40,
            hourlyMax: 200,
            includeMissingComp: false,
          },
          label: 'hourly range',
          reviewFilter: 'unsorted',
        },
        {
          filters: { ...DEFAULT_OPPORTUNITY_FILTERS, skills: ['Kubernetes'] },
          label: 'skill array',
          reviewFilter: 'unsorted',
        },
        {
          filters: { ...DEFAULT_OPPORTUNITY_FILTERS, fit: 'have' },
          label: 'matching required skills',
          reviewFilter: 'unsorted',
        },
        {
          filters: { ...DEFAULT_OPPORTUNITY_FILTERS, fit: 'gaps' },
          label: 'missing required skills',
          reviewFilter: 'unsorted',
        },
        {
          filters: {
            ...DEFAULT_OPPORTUNITY_FILTERS,
            postedWithinDays: 30,
            excludeExpired: true,
          },
          label: 'posted and expiry dates',
          reviewFilter: 'unsorted',
        },
        {
          filters: {
            ...DEFAULT_OPPORTUNITY_FILTERS,
            employmentTypes: ['full time'],
            workModes: ['remote'],
            seniority: 'senior',
          },
          label: 'employment, work mode, and seniority',
          reviewFilter: 'unsorted',
        },
        {
          filters: {
            ...DEFAULT_OPPORTUNITY_FILTERS,
            founderOnly: true,
            freshOnly: true,
            freshness: 'fresh',
            greenfieldOnly: true,
            relocationOnly: true,
            visaOnly: true,
          },
          label: 'opportunity signals',
          reviewFilter: 'unsorted',
        },
        {
          filters: {
            ...DEFAULT_OPPORTUNITY_FILTERS,
            minRating: 5,
            minScore: 50,
            maxScore: 95,
          },
          label: 'rating and score bounds',
          reviewFilter: 'unsorted',
        },
        {
          filters: { ...DEFAULT_OPPORTUNITY_FILTERS },
          label: 'application planning',
          reviewFilter: 'missing_application_planning',
        },
      ];

      for (const testCase of cases) {
        const expectedIds = new Set(
          records
            .filter((record) =>
              reviewFilterMatches(record, testCase.reviewFilter),
            )
            .filter((record) =>
              matchesOpportunity(record, testCase.filters, { hasSkill }),
            )
            .map((record) => String(record.id)),
        );
        await expect(
          countOpportunityRecords({
            candidateSkills,
            filters: testCase.filters,
            reviewFilter: testCase.reviewFilter,
          }),
          testCase.label,
        ).resolves.toBe(expectedIds.size);

        for (const sort of [
          'best',
          'newest',
          'score',
          'salary',
          'rating',
        ] as const) {
          const pageIds = await listOpportunityPageIds({
            candidateSkills,
            filters: { ...testCase.filters, sort },
            limit: OPPORTUNITY_TABLE_PAGE_SIZE,
            offset: 0,
            reviewFilter: testCase.reviewFilter,
          });
          expect(pageIds, `${testCase.label}: ${sort}`).toHaveLength(
            Math.min(OPPORTUNITY_TABLE_PAGE_SIZE, expectedIds.size),
          );
          expect(new Set(pageIds).size, `${testCase.label}: ${sort}`).toBe(
            pageIds.length,
          );
          expect(
            pageIds.every((id) => expectedIds.has(id)),
            `${testCase.label}: ${sort}`,
          ).toBe(true);
        }
      }
    }, 20_000);
  },
);
