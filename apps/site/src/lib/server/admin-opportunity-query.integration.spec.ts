import { performance } from 'node:perf_hooks';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_OPPORTUNITY_FILTERS } from '$lib/opportunity-filters';
import {
  countOpportunityRecords,
  listLatestOpportunityRelatedContext,
  listOpportunityFilterOptions,
  listOpportunityPageIds,
  OPPORTUNITY_TABLE_PAGE_SIZE,
} from './admin-opportunity-query.js';
import { getDatabaseUrl, getDbConfig } from './db.js';

const runSnapshotCoverage = process.env.OPPORTUNITY_LIST_PERF === '1';
const SNAPSHOT_WORKSPACE_SUBJECT = {
  profileId: process.env.OPPORTUNITY_LIST_PROFILE_ID ?? 'snapshot-profile',
  tenantId: process.env.OPPORTUNITY_LIST_TENANT_ID ?? 'snapshot-tenant',
  userId: process.env.OPPORTUNITY_LIST_USER_ID ?? 'snapshot-user',
};

function assertLocalSnapshotDatabase(): void {
  const url = new URL(getDatabaseUrl());
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error(
      'Opportunity performance coverage requires a local restored database snapshot.',
    );
  }
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
        workspaceSubject: SNAPSHOT_WORKSPACE_SUBJECT,
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
        workspaceSubject: SNAPSHOT_WORKSPACE_SUBJECT,
      });

      expect(opportunityIds).toHaveLength(1);
      await expect(
        listLatestOpportunityRelatedContext(
          opportunityIds,
          SNAPSHOT_WORKSPACE_SUBJECT,
        ),
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
        workspaceSubject: SNAPSHOT_WORKSPACE_SUBJECT,
      };
      const [total, pageIds, facets] = await Promise.all([
        countOpportunityRecords(query),
        listOpportunityPageIds({
          ...query,
          limit: OPPORTUNITY_TABLE_PAGE_SIZE,
          offset: 0,
        }),
        listOpportunityFilterOptions(
          query.reviewFilter,
          SNAPSHOT_WORKSPACE_SUBJECT,
        ),
      ]);

      expect(total).toBeGreaterThan(0);
      expect(pageIds.length).toBeLessThanOrEqual(OPPORTUNITY_TABLE_PAGE_SIZE);
      expect(pageIds.length).toBeLessThanOrEqual(total);
      expect(facets.skills.map((skill) => skill.toLowerCase())).toContain(
        'kubernetes',
      );
    });
  },
);
