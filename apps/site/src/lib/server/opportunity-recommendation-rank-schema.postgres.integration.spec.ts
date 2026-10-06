import { randomUUID } from 'node:crypto';
import { generateSchemaDiff, ObjectRegistry } from '@happyvertical/smrt-core';
import {
  createMigrationDefinition,
  MigrationTracker,
} from '@happyvertical/smrt-core/migrations';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OPPORTUNITY_QUESTION_SCREENING_MODEL,
  OPPORTUNITY_QUESTION_SCREENING_VERSION,
} from './opportunity-question-screening.js';
import type { VerifiedOpportunityRecommendationRankPublication } from './opportunity-recommendation-rank.js';
import { saveVerifiedOpportunityRecommendationRank } from './opportunity-recommendation-rank.js';
import './smrt.js';

const postgresUrl =
  process.env.OPPORTUNITY_RECOMMENDATION_RANK_POSTGRES_TEST_DATABASE_URL?.trim();

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function fixtureConfig(url: string, schema: string) {
  const fixtureUrl = new URL(url);
  fixtureUrl.searchParams.set('options', `-c search_path=${schema},public`);
  return {
    cache: false,
    max: 1,
    type: 'postgres' as const,
    url: fixtureUrl.toString(),
  };
}

async function transaction<T>(
  database: DatabaseInterface,
  action: (transaction: DatabaseInterface) => Promise<T>,
): Promise<T> {
  if (!database.transaction)
    throw new Error(
      'PostgreSQL recommendation-rank proof requires transactions.',
    );
  return await database.transaction(action);
}

describe.runIf(postgresUrl)(
  'opportunity recommendation rank native PostgreSQL schema and store',
  () => {
    let control: DatabaseInterface;
    let database: DatabaseInterface;
    let schema: string;
    let fixtureUrl: string;

    function publication(
      overrides: Partial<VerifiedOpportunityRecommendationRankPublication> = {},
    ): VerifiedOpportunityRecommendationRankPublication {
      return {
        agentRunId: `run-${randomUUID()}`,
        assessmentCompleteness: 'title_only',
        assessmentFingerprint: `assessment-fingerprint-${randomUUID()}`,
        assessmentId: `assessment-${randomUUID()}`,
        candidateMaterialFingerprint: 'candidate-fingerprint',
        candidateProfileId: '22222222-2222-4222-8222-222222222222',
        contractVersion: OPPORTUNITY_QUESTION_SCREENING_VERSION,
        evidenceCoveragePercent: 77.7777,
        intelligenceRequestId: `request-${randomUUID()}`,
        intelligenceResultId: `result-${randomUUID()}`,
        model: OPPORTUNITY_QUESTION_SCREENING_MODEL,
        mustHaveConflictCount: 1,
        opportunityId: '33333333-3333-4333-8333-333333333333',
        ownerUserId: '44444444-4444-4444-8444-444444444444',
        proofFinishedAt: new Date('2026-10-05T10:00:00.000Z'),
        questionSetFingerprint: 'questions-fingerprint',
        preferredSkillsSnapshot: 'GraphQL',
        recommendationPercent: 72.2222,
        requiredSkillsSnapshot: 'TypeScript',
        sourceContentFingerprint: 'source-fingerprint',
        sourceContentVersion: 3,
        tenantId: '55555555-5555-4555-8555-555555555555',
        ...overrides,
      };
    }

    beforeAll(async () => {
      if (!postgresUrl)
        throw new Error(
          'Recommendation-rank PostgreSQL proof requires an explicitly supplied test URL.',
        );
      fixtureUrl = postgresUrl;
      schema = `hv_opportunity_rank_${randomUUID().replaceAll('-', '')}`;
      control = await getDatabase({
        cache: false,
        max: 1,
        type: 'postgres',
        url: postgresUrl,
      });
      await control.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      database = await getDatabase(fixtureConfig(postgresUrl, schema));
    });

    afterAll(async () => {
      await database?.close?.();
      if (control && schema)
        await control.query(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`,
        );
      await control?.close?.();
    });

    it('migrates the registered schema, uses the declared current-rank index, and serializes insert-only races', async () => {
      const definition = Object.values(
        ObjectRegistry.getAllSchemasAsDefinitions(),
      ).find(
        (candidate) =>
          candidate.tableName === 'opportunity_recommendation_ranks',
      );
      if (!definition)
        throw new Error('OpportunityRecommendationRank was not registered.');
      expect(
        await generateSchemaDiff(database, {
          OpportunityRecommendationRank: definition,
        }),
      ).toEqual(expect.objectContaining({ added_tables: [expect.anything()] }));
      const ddl = getDDLStrategy('postgres');
      const statements = [
        ddl.generateCreateTable(definition),
        ...ddl.generateIndexes(definition),
        ...ddl.generateTriggers(definition),
      ];
      const tracker = new MigrationTracker({
        db: database,
        engineHint: 'postgres',
        useConcurrentIndexes: false,
      });
      await expect(
        tracker.applyAll(
          [
            createMigrationDefinition(
              `opportunity-rank-${randomUUID()}`,
              statements,
              [],
              { description: 'Create private recommendation rank projection.' },
            ),
          ],
          { atomic: true, postgresSafe: false },
        ),
      ).resolves.toEqual([expect.objectContaining({ success: true })]);

      const indexes = await database.query(
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname = current_schema()
           AND tablename = 'opportunity_recommendation_ranks'`,
      );
      const indexDefinitions = indexes.rows
        .map((row) => String((row as { indexdef?: unknown }).indexdef ?? ''))
        .join('\n');
      expect(indexDefinitions).toContain(
        'opportunity_recommendation_ranks_current_lookup',
      );
      for (const column of [
        'tenant_id',
        'owner_user_id',
        'candidate_profile_id',
        'candidate_material_fingerprint',
        'question_set_fingerprint',
        'recommendation_percent',
      ])
        expect(indexDefinitions).toContain(column);

      const first = publication();
      const other = publication();
      const left = await getDatabase(fixtureConfig(fixtureUrl, schema));
      const right = await getDatabase(fixtureConfig(fixtureUrl, schema));
      try {
        const results = await Promise.all([
          transaction(
            left,
            async (transaction) =>
              await saveVerifiedOpportunityRecommendationRank(
                transaction as never,
                first,
              ),
          ),
          transaction(
            right,
            async (transaction) =>
              await saveVerifiedOpportunityRecommendationRank(
                transaction as never,
                other,
              ),
          ),
        ]);
        expect(results.map((result) => result.status).sort()).toEqual([
          'created',
          'ignored',
        ]);
      } finally {
        await left.close?.();
        await right.close?.();
      }
      const rows = await database.query(
        'SELECT COUNT(*) AS count FROM opportunity_recommendation_ranks',
      );
      expect(Number(rows.rows[0]?.count)).toBe(1);
    });

    it('uses the supplied transaction executor and rolls rank publication back with its assessment transaction', async () => {
      await expect(
        transaction(database, async (transaction) => {
          await saveVerifiedOpportunityRecommendationRank(
            transaction as never,
            publication({
              opportunityId: '66666666-6666-4666-8666-666666666666',
            }),
          );
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');
      const rows = await database.query(
        'SELECT COUNT(*) AS count FROM opportunity_recommendation_ranks WHERE opportunity_id = ?',
        ['66666666-6666-4666-8666-666666666666'],
      );
      expect(Number(rows.rows[0]?.count)).toBe(0);
    });
  },
);
