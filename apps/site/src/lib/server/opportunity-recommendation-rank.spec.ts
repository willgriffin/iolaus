import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPPORTUNITY_RECOMMENDATION_RANK_VERSION } from '../objects/OpportunityRecommendationRank.js';
import {
  OPPORTUNITY_QUESTION_SCREENING_MODEL,
  OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION,
  OPPORTUNITY_QUESTION_SCREENING_VERSION,
} from './opportunity-question-screening.js';
import type { VerifiedOpportunityRecommendationRankPublication } from './opportunity-recommendation-rank.js';
import {
  listOwnedOpportunityRecommendationRanks,
  normalizeOpportunityRecommendationRankSkillsSnapshot,
  OpportunityRecommendationRankPublicationError,
  saveVerifiedOpportunityRecommendationRank,
} from './opportunity-recommendation-rank.js';
import './smrt.js';

describe('verified opportunity recommendation rank publication', () => {
  let database: DatabaseInterface;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'iolaus-rank-store-'));
    database = await getDatabase({
      cache: false,
      type: 'sqlite',
      url: join(directory, 'recommendation-ranks.sqlite'),
    });
    const schema = Object.values(
      ObjectRegistry.getAllSchemasAsDefinitions(),
    ).find(
      (candidate) => candidate.tableName === 'opportunity_recommendation_ranks',
    );
    if (!schema)
      throw new Error('OpportunityRecommendationRank was not registered.');
    const ddl = getDDLStrategy('sqlite');
    for (const statement of [
      ddl.generateCreateTable(schema),
      ...ddl.generateIndexes(schema),
      ...ddl.generateTriggers(schema),
    ])
      await database.query(statement);
  });

  afterEach(async () => {
    await database.close?.();
    await rm(directory, { force: true, recursive: true });
  });

  function publication(
    overrides: Partial<VerifiedOpportunityRecommendationRankPublication> = {},
  ): VerifiedOpportunityRecommendationRankPublication {
    return {
      agentRunId: 'run-1',
      assessmentCompleteness: 'title_only',
      assessmentFingerprint: 'assessment-fingerprint',
      assessmentId: 'assessment-1',
      candidateMaterialFingerprint: 'candidate-fingerprint',
      candidateProfileId: 'profile-1',
      contractVersion: OPPORTUNITY_QUESTION_SCREENING_VERSION,
      evidenceCoveragePercent: 77.7777,
      intelligenceRequestId: 'request-1',
      intelligenceResultId: 'result-1',
      model: OPPORTUNITY_QUESTION_SCREENING_MODEL,
      mustHaveConflictCount: 1,
      opportunityId: 'opportunity-1',
      ownerUserId: 'user-1',
      proofFinishedAt: new Date('2026-10-05T10:00:00.000Z'),
      questionSetFingerprint: 'questions-fingerprint',
      preferredSkillsSnapshot: 'GraphQL',
      recommendationPercent: 72.2222,
      requiredSkillsSnapshot: 'TypeScript, Svelte',
      sourceContentFingerprint: 'source-fingerprint',
      sourceContentVersion: 3,
      tenantId: 'tenant-1',
      ...overrides,
    };
  }

  it('creates, idempotently retains, then lets a same-context full assessment replace title-only evidence', async () => {
    const first = await saveVerifiedOpportunityRecommendationRank(
      database as never,
      publication(),
    );
    expect(first.status).toBe('created');
    expect(first.rank.recommendationPercent).toBe(72.2222);

    await expect(
      saveVerifiedOpportunityRecommendationRank(
        database as never,
        publication(),
      ),
    ).resolves.toMatchObject({ status: 'ignored' });
    const full = await saveVerifiedOpportunityRecommendationRank(
      database as never,
      publication({
        assessmentCompleteness: 'full',
        assessmentId: 'assessment-2',
        intelligenceRequestId: 'request-2',
        intelligenceResultId: 'result-2',
        agentRunId: 'run-2',
      }),
    );
    expect(full).toMatchObject({
      status: 'updated',
      rank: {
        assessmentCompleteness: 'full',
        intelligenceResultId: 'result-2',
      },
    });
  });

  it('never allows an older proof to overwrite a newer rank in the same semantic context', async () => {
    await saveVerifiedOpportunityRecommendationRank(
      database as never,
      publication({ proofFinishedAt: new Date('2026-10-05T12:00:00.000Z') }),
    );
    const result = await saveVerifiedOpportunityRecommendationRank(
      database as never,
      publication({
        proofFinishedAt: new Date('2026-10-05T11:00:00.000Z'),
        recommendationPercent: 12.5,
      }),
    );
    expect(result).toMatchObject({
      status: 'ignored',
      rank: {
        candidateMaterialFingerprint: 'candidate-fingerprint',
        recommendationPercent: 72.2222,
      },
    });
  });

  it('permits a verified current semantic context to repair from an older historical receipt', async () => {
    await saveVerifiedOpportunityRecommendationRank(
      database as never,
      publication({ proofFinishedAt: new Date('2026-10-05T12:00:00.000Z') }),
    );
    const result = await saveVerifiedOpportunityRecommendationRank(
      database as never,
      publication({
        candidateMaterialFingerprint: 'restored-candidate-fingerprint',
        proofFinishedAt: new Date('2026-10-05T11:00:00.000Z'),
        recommendationPercent: 12.5,
      }),
    );
    expect(result).toMatchObject({
      status: 'updated',
      rank: {
        candidateMaterialFingerprint: 'restored-candidate-fingerprint',
        recommendationPercent: 12.5,
      },
    });
  });

  it('keeps a V9 full assessment over a newer V8 title-only assessment in the same semantic capability context', async () => {
    await saveVerifiedOpportunityRecommendationRank(
      database as never,
      publication({
        assessmentCompleteness: 'full',
        contractVersion: OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION,
        proofFinishedAt: new Date('2026-10-05T10:00:00.000Z'),
      }),
    );
    const result = await saveVerifiedOpportunityRecommendationRank(
      database as never,
      publication({
        assessmentCompleteness: 'title_only',
        contractVersion: OPPORTUNITY_QUESTION_SCREENING_VERSION,
        proofFinishedAt: new Date('2026-10-05T12:00:00.000Z'),
      }),
    );
    expect(result).toMatchObject({
      status: 'ignored',
      rank: {
        assessmentCompleteness: 'full',
        contractVersion: OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION,
      },
    });
  });

  it('repairs a formatting-only raw skill snapshot change with the same immutable proof', async () => {
    await saveVerifiedOpportunityRecommendationRank(
      database as never,
      publication({ requiredSkillsSnapshot: 'TypeScript, Svelte' }),
    );
    const result = await saveVerifiedOpportunityRecommendationRank(
      database as never,
      publication({ requiredSkillsSnapshot: 'TypeScript,  Svelte' }),
    );
    expect(result).toMatchObject({
      status: 'updated',
      rank: { requiredSkillsSnapshot: 'TypeScript,  Svelte' },
    });
  });

  it('normalizes only nullish and fixture-array skill snapshots', () => {
    expect(
      normalizeOpportunityRecommendationRankSkillsSnapshot(undefined),
    ).toBe('');
    expect(normalizeOpportunityRecommendationRankSkillsSnapshot(' A ')).toBe(
      ' A ',
    );
    expect(
      normalizeOpportunityRecommendationRankSkillsSnapshot(['A', 'B']),
    ).toBe('["A","B"]');
    expect(() =>
      normalizeOpportunityRecommendationRankSkillsSnapshot(1),
    ).toThrow(OpportunityRecommendationRankPublicationError);
  });

  it('reads at most one owner-scoped page of complete rank rows', async () => {
    await saveVerifiedOpportunityRecommendationRank(
      database as never,
      publication(),
    );
    await saveVerifiedOpportunityRecommendationRank(
      database as never,
      publication({
        opportunityId: 'opportunity-2',
        intelligenceResultId: 'result-2',
      }),
    );
    const rows = await listOwnedOpportunityRecommendationRanks(
      { profileId: 'profile-1', tenantId: 'tenant-1', userId: 'user-1' },
      ['opportunity-1', 'opportunity-2'],
      { db: database as never },
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentRunId: 'run-1',
          assessmentFingerprint: 'assessment-fingerprint',
          assessmentId: 'assessment-1',
          candidateProfileId: 'profile-1',
          candidateMaterialFingerprint: 'candidate-fingerprint',
          contractVersion:
            'opportunity-question-screening/v8-named-capability-evidence',
          evidenceCoveragePercent: 77.7777,
          id: expect.any(String),
          intelligenceRequestId: 'request-1',
          intelligenceResultId: 'result-1',
          model: 'jev-1.13.0',
          mustHaveConflictCount: 1,
          ownerUserId: 'user-1',
          opportunityId: 'opportunity-1',
          preferredSkillsSnapshot: 'GraphQL',
          projectionVersion: OPPORTUNITY_RECOMMENDATION_RANK_VERSION,
          questionSetFingerprint: 'questions-fingerprint',
          recommendationPercent: 72.2222,
          requiredSkillsSnapshot: 'TypeScript, Svelte',
          assessmentCompleteness: 'title_only',
          proofFinishedAt: expect.any(Date),
          sourceContentFingerprint: 'source-fingerprint',
          sourceContentVersion: 3,
          tenantId: 'tenant-1',
        }),
      ]),
    );
    await expect(
      listOwnedOpportunityRecommendationRanks(
        { profileId: 'profile-1', tenantId: 'tenant-1', userId: 'user-1' },
        Array.from({ length: 201 }, (_, index) => `opportunity-${index}`),
        { db: database as never },
      ),
    ).rejects.toBeInstanceOf(OpportunityRecommendationRankPublicationError);
  });

  it('rejects incomplete or caller-shaped publication data before it writes', async () => {
    await expect(
      saveVerifiedOpportunityRecommendationRank(
        database as never,
        publication({ intelligenceResultId: '', recommendationPercent: 101 }),
      ),
    ).rejects.toBeInstanceOf(OpportunityRecommendationRankPublicationError);
    const count = await database.query(
      'SELECT COUNT(*) AS count FROM opportunity_recommendation_ranks',
    );
    expect(Number(count.rows[0]?.count)).toBe(0);
  });
});
