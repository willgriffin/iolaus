import { SmrtCollection } from '@happyvertical/smrt-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bulkProcessOpportunityIntelligence,
  normalizeOpportunityScoreOutput,
  parseOpportunityReasonJson,
  processOpportunityIntelligence,
  reasonJsonForScore,
  scoringMaterialForOpportunity,
  statusForOpportunityRecommendation,
} from './opportunity-intelligence';
import { prepareOpportunityPosting } from './opportunity-posting-preparation.js';
import {
  OPPORTUNITY_SCORING_INPUT_VERSION,
  OPPORTUNITY_SCORING_PROMPT_VERSION,
} from './opportunity-scoring.js';
import { resolveSkillMatching } from './skill-matching.js';

type MockRecord = Record<string, unknown> & {
  id: string;
  save: ReturnType<typeof vi.fn>;
};

function record(data: Record<string, unknown>): MockRecord {
  let normalized = data;
  if ('descriptionRaw' in data) {
    const sourceContentFingerprint = String(
      data.sourceContentFingerprint ?? `test-${data.id ?? 'opportunity'}-v1`,
    );
    const sourceContentVersion = Number(data.sourceContentVersion ?? 1);
    const prepared = prepareOpportunityPosting({
      ...data,
      sourceContentFingerprint,
      sourceContentVersion,
    });
    normalized = {
      ...data,
      preparedPostingFingerprint: prepared.fingerprint,
      preparedPostingJson: JSON.stringify(prepared),
      preparedPostingVersion: prepared.version,
      sourceContentFingerprint,
      sourceContentVersion,
    };
  }
  return {
    id: String(normalized.id ?? 'record-1'),
    save: vi.fn(async () => {}),
    ...normalized,
  } as MockRecord;
}

function matchesWhere(
  item: MockRecord,
  where: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key.endsWith(' in') && Array.isArray(value)) {
      return value.includes(item[key.replace(/\s+in$/, '')]);
    }
    return item[key] === value;
  });
}

function collection(records: MockRecord[] = []) {
  return {
    create: vi.fn(async (payload: Record<string, unknown>) => {
      const created = record({
        id: `created-${records.length + 1}`,
        ...payload,
      });
      records.push(created);
      return created;
    }),
    get: vi.fn(
      async (id: string) => records.find((item) => item.id === id) ?? null,
    ),
    list: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
      if (!where) return records;
      return records.filter((item) => matchesWhere(item, where));
    }),
    records,
  };
}

type OrderByOptions = {
  orderBy?: string | string[];
  where?: Record<string, unknown>;
};

function strictCandidateProfileCollection(records: MockRecord[] = []) {
  const profiles = collection(records);
  const buildOrderBySql = (
    SmrtCollection.prototype as unknown as {
      buildOrderBySql(
        this: object,
        orderBy: string | string[] | undefined,
        fields: Record<string, unknown>,
      ): string;
    }
  ).buildOrderBySql;
  const parser = {
    collectQueryableFieldNames: () => ({
      readPermissionFieldNames: new Set<string>(),
      sensitiveFieldNames: new Set<string>(),
      skipFieldValidation: false,
      validFieldNames: new Set(['id', 'is_default', 'updated_at']),
    }),
    getResolvedItemClassName: () => 'CandidateProfile',
    getResolvedItemQualifiedName: () => 'CandidateProfile',
    hasCustomPrimaryKey: () => false,
    isOmittedCustomPrimaryKeySystemField: () => false,
    toDbColumnName: (field: string) => field,
  };
  profiles.list.mockImplementation(
    async ({ orderBy, where }: OrderByOptions = {}) => {
      // Exercise the installed SMRT parser instead of duplicating its
      // validation. A comma-separated string is one invalid order term.
      buildOrderBySql.call(parser, orderBy, {
        isDefault: { type: 'boolean' },
      });
      const selected = where
        ? records.filter((item) => matchesWhere(item, where))
        : [...records];
      const terms = Array.isArray(orderBy) ? orderBy : [orderBy ?? ''];
      return selected.sort((left, right) => {
        for (const term of terms) {
          const [field, direction] = term.split(/\s+/, 2);
          const key = field === 'isDefault' ? 'isDefault' : field;
          const leftValue = left[key];
          const rightValue = right[key];
          if (leftValue === rightValue) continue;
          const ascending = direction !== 'DESC';
          return (leftValue! > rightValue! ? 1 : -1) * (ascending ? 1 : -1);
        }
        return 0;
      });
    },
  );
  return profiles;
}

const mocks = vi.hoisted(() => ({
  evaluateSkillMatches: vi.fn(),
  collections: new Map<string, ReturnType<typeof collection>>(),
  cancelStaleOpportunityIntelligenceTasks: vi.fn(async () => 0),
  loadOpportunityDetails: vi.fn(async () => ({ status: 'resolved' })),
  processOpportunityWithLlm: vi.fn(async () => ({
    message: 'Extracted.',
    status: 'processed',
  })),
  recordAgentAudit: vi.fn(async () => ({ id: 'run-1' })),
  syncApplicationWorkflowTasks: vi.fn(async () => ({ created: 0 })),
  syncRecommendedOpportunityDecisionTasks: vi.fn(async () => ({ created: 0 })),
  databaseUpdate: vi.fn(
    async (
      _table: string,
      _where: Record<string, unknown>,
      _data: Record<string, unknown>,
    ) => ({ affected: 1 }),
  ),
  databaseQuery: vi.fn(async (_sql: string, params: unknown[]) => {
    const [opportunityId, sourceContentFingerprint, materialFingerprint] =
      params.map(String);
    const scores = mocks.collections.get('EvaluationScore')?.records ?? [];
    const current = scores.find(
      (score) =>
        score.opportunityId === opportunityId &&
        score.sourceContentFingerprint === sourceContentFingerprint &&
        (Boolean(score.createdByProfileId) ||
          materialFingerprint === '__legacy_current_score__' ||
          (Boolean(materialFingerprint) &&
            score.scoringMaterialFingerprint === materialFingerprint)),
    );
    return { rows: current ? [{ id: current.id }] : [] };
  }),
}));

vi.mock('@happyvertical/smrt-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@happyvertical/smrt-core')>()),
  resolveDatabase: vi.fn(async () => ({
    query: mocks.databaseQuery,
    update: mocks.databaseUpdate,
  })),
}));

vi.mock('./skill-decision-provider.js', () => ({
  evaluateSkillMatches: mocks.evaluateSkillMatches,
}));

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async (className: string) => {
    const found = mocks.collections.get(className);
    if (
      !found &&
      ['Achievement', 'CandidateProfile', 'FactCandidate'].includes(className)
    )
      return collection();
    if (!found) throw new Error(`Missing collection ${className}`);
    return found;
  }),
}));

vi.mock('./opportunity-details.js', () => ({
  loadOpportunityDetails: mocks.loadOpportunityDetails,
  processOpportunityWithLlm: mocks.processOpportunityWithLlm,
}));

vi.mock('./application-workflow.js', () => ({
  cancelStaleOpportunityIntelligenceTasks:
    mocks.cancelStaleOpportunityIntelligenceTasks,
  recordAgentAudit: mocks.recordAgentAudit,
  syncApplicationWorkflowTasks: mocks.syncApplicationWorkflowTasks,
  syncRecommendedOpportunityDecisionTasks:
    mocks.syncRecommendedOpportunityDecisionTasks,
}));

describe('opportunity intelligence normalization', () => {
  it('normalizes structured score output and serializes reasonJson', () => {
    const score = normalizeOpportunityScoreOutput({
      confidence: '82',
      dataQualityWarnings: ['Missing compensation'],
      fitReasons: 'TypeScript\nAgent workflows',
      missingInfo: ['team timezone'],
      recommendation: 'apply',
      risks: ['unclear comp'],
      score: '8.5',
      suggestedNextAction: 'Review before applying',
      summary: 'Strong fit',
    });

    expect(score).toMatchObject({
      confidence: 0.82,
      fitReasons: ['TypeScript', 'Agent workflows'],
      recommendation: 'recommend',
      score: 85,
    });
    const reason = parseOpportunityReasonJson(reasonJsonForScore(score));
    expect(reason).toMatchObject({
      confidence: 0.82,
      dataQualityWarnings: ['Missing compensation'],
      evidenceMatrix: [],
      suggestedNextAction: 'Review before applying',
    });
  });

  it('tolerates malformed stored reasonJson', () => {
    expect(parseOpportunityReasonJson('not json')).toEqual({
      confidence: 0,
      dataQualityWarnings: [],
      evidenceMatrix: [],
      fitReasons: [],
      missingInfo: [],
      risks: [],
      suggestedNextAction: '',
    });
  });

  it('does not convert explicit unknown recommendations into apply recommendations', () => {
    const score = normalizeOpportunityScoreOutput({
      confidence: 0.92,
      recommendation: 'unknown',
      score: 96,
      summary: 'Score was present, but the recommendation is unknown.',
    });

    expect(score).toMatchObject({
      recommendation: 'unknown',
      score: 96,
    });
    expect(
      statusForOpportunityRecommendation({
        confidence: score.confidence,
        currentStatus: 'found',
        recommendation: score.recommendation,
        score: score.score,
      }),
    ).toBeNull();
  });

  it('keeps maybe/reject/research outcomes out of final user statuses', () => {
    expect(
      statusForOpportunityRecommendation({
        confidence: 0.9,
        currentStatus: 'found',
        recommendation: 'recommend',
        score: 91,
      }),
    ).toBe('recommended');
    expect(
      statusForOpportunityRecommendation({
        confidence: 0.4,
        currentStatus: 'found',
        recommendation: 'recommend',
        score: 91,
      }),
    ).toBeNull();
    expect(
      statusForOpportunityRecommendation({
        confidence: 0.9,
        currentStatus: 'recommended',
        recommendation: 'reject',
        score: 20,
      }),
    ).toBe('found');
    expect(
      statusForOpportunityRecommendation({
        confidence: 0.9,
        currentStatus: 'apply',
        recommendation: 'reject',
        score: 20,
      }),
    ).toBeNull();
  });
});

describe('processOpportunityIntelligence', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_MODEL_SCORING_ENABLED', 'true');
    mocks.collections.clear();
    mocks.evaluateSkillMatches.mockReset();
    mocks.evaluateSkillMatches.mockResolvedValue(undefined);
    mocks.cancelStaleOpportunityIntelligenceTasks.mockReset();
    mocks.cancelStaleOpportunityIntelligenceTasks.mockResolvedValue(0);
    mocks.loadOpportunityDetails.mockClear();
    mocks.processOpportunityWithLlm.mockClear();
    mocks.recordAgentAudit.mockClear();
    mocks.recordAgentAudit.mockResolvedValue({ id: 'run-1' });
    mocks.databaseUpdate.mockReset();
    mocks.databaseUpdate.mockResolvedValue({ affected: 1 });
    mocks.syncApplicationWorkflowTasks.mockClear();
    mocks.syncRecommendedOpportunityDecisionTasks.mockClear();
  });

  it('uses SMRT-supported profile order terms to retain defaults then newest profiles', async () => {
    const opportunity = record({
      descriptionRaw: 'Requires TypeScript.',
      id: 'opp-1',
      requiredSkills: 'TypeScript',
      status: 'found',
      title: 'AI Platform Engineer',
    });
    const profiles = strictCandidateProfileCollection([
      record({
        id: 'profile-default-old',
        isDefault: true,
        name: 'Default old',
        summary: 'TypeScript default profile from 2025.',
        updated_at: '2025-01-01T00:00:00.000Z',
      }),
      record({
        id: 'profile-default-new',
        isDefault: true,
        name: 'Default newest',
        summary: 'TypeScript default profile from 2026.',
        updated_at: '2026-01-01T00:00:00.000Z',
      }),
      ...[6, 5, 4, 3].map((month) =>
        record({
          id: `profile-regular-${month}`,
          isDefault: false,
          name: `Regular ${month}`,
          summary: `TypeScript regular profile ${month}.`,
          updated_at: `2026-0${month}-01T00:00:00.000Z`,
        }),
      ),
    ]);
    mocks.collections.set('Achievement', collection());
    mocks.collections.set('CandidateProfile', profiles);
    mocks.collections.set('FactCandidate', collection());
    mocks.collections.set('ResumeSkill', collection());

    const materialWithSixProfiles = await scoringMaterialForOpportunity(
      opportunity as never,
    );

    expect(profiles.list).toHaveBeenCalledWith({
      limit: 25,
      orderBy: ['isDefault DESC', 'updated_at DESC'],
    });
    const listedProfiles = (await profiles.list.mock.results[0]?.value) as
      | MockRecord[]
      | undefined;
    expect(listedProfiles?.map((profile) => profile.id)).toEqual([
      'profile-default-new',
      'profile-default-old',
      'profile-regular-6',
      'profile-regular-5',
      'profile-regular-4',
      'profile-regular-3',
    ]);

    mocks.collections.set(
      'CandidateProfile',
      strictCandidateProfileCollection(
        profiles.records.slice(0, 5) as MockRecord[],
      ),
    );
    const materialWithSelectedProfiles = await scoringMaterialForOpportunity(
      opportunity as never,
    );

    // The sixth (oldest non-default) profile cannot change scoring material:
    // loadEvidenceSources retains the default tier and only the newest
    // remaining profiles through its five-profile cap.
    expect(materialWithSixProfiles?.fingerprint).toBe(
      materialWithSelectedProfiles?.fingerprint,
    );
  });

  it('uses semantic skill evidence before scoring and preserves it through evidence refresh', async () => {
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_CLEAR_ACCEPT_MIN_REQUIRED', '2');
    mocks.collections.set(
      'Opportunity',
      collection([
        record({
          id: 'opp-1',
          title: 'Backend Engineer',
          status: 'found',
          requiredSkills: 'JavaScript\nPostgreSQL',
          descriptionRaw:
            'Qualifications\nJavaScript is required.\nPostgreSQL is required.',
        }),
      ]),
    );
    mocks.collections.set(
      'ResumeSkill',
      collection([
        record({ id: 'skill-1', label: 'Node.js' }),
        record({ id: 'skill-2', label: 'Postgres' }),
      ]),
    );
    const scores = collection();
    mocks.collections.set('EvaluationScore', scores);
    mocks.evaluateSkillMatches.mockImplementation(async (prepared) =>
      resolveSkillMatching(prepared, {
        model: 'jev-test',
        provenance: { provider: 'typesafe', model: 'jev-test' },
        answers: {
          match_0: { type: 'predicate', probability: 0.99 },
          source_0: {
            type: 'choice',
            choice: 'candidate_0',
            confidence: 0.99,
            probabilities: { candidate_0: 0.99 },
          },
        },
      }),
    );
    const aiClient = { chat: vi.fn() };
    const semanticResult = await processOpportunityIntelligence({
      aiClient,
      modes: ['score', 'evidence', 'quality'],
      opportunityId: 'opp-1',
    });
    expect(semanticResult, JSON.stringify(semanticResult)).toMatchObject({
      failed: 0,
    });
    expect(scores.records).toHaveLength(1);
    expect(scores.records[0].recommendation).toBe('recommend');
    expect(
      parseOpportunityReasonJson(scores.records[0].reasonJson).evidenceMatrix,
    ).toEqual([
      expect.objectContaining({
        requirement: 'JavaScript',
        status: 'supported',
        sources: [expect.objectContaining({ id: 'skill-1' })],
      }),
      expect.objectContaining({
        requirement: 'PostgreSQL',
        status: 'supported',
        sources: [expect.objectContaining({ id: 'skill-2' })],
      }),
    ]);
    expect(aiClient.chat).not.toHaveBeenCalled();
  });

  it('only supplies reviewed candidate facts, never employer facts, as skill evidence', async () => {
    mocks.collections.set(
      'Opportunity',
      collection([
        record({
          id: 'opp-1',
          organizationProfileId: 'employer-1',
          requiredSkills: 'Java',
          descriptionRaw: 'Qualifications\nJava is required.',
        }),
      ]),
    );
    mocks.collections.set('EvaluationScore', collection());
    mocks.collections.set(
      'FactCandidate',
      collection([
        record({
          id: 'employer-fact',
          reviewStatus: 'accepted',
          targetEntityType: 'Company',
          targetEntityId: 'employer-1',
          statement: 'Uses Java',
        }),
        record({
          id: 'candidate-fact',
          reviewStatus: 'accepted',
          targetEntityType: 'CandidateProfile',
          targetEntityId: 'candidate-1',
          statement: 'Built Rust services',
        }),
      ]),
    );
    await processOpportunityIntelligence({
      aiClient: { chat: vi.fn() },
      modes: ['score'],
      opportunityId: 'opp-1',
    });
    expect(
      mocks.evaluateSkillMatches.mock.calls[0][0].candidates.map(
        (source: { id: string }) => source.id,
      ),
    ).toEqual(['candidate-fact']);
  });

  it('does not save a score or recommendation on decision provider failure', async () => {
    mocks.collections.set(
      'Opportunity',
      collection([
        record({
          id: 'opp-1',
          requiredSkills: 'Java',
          descriptionRaw: 'Qualifications\nJava is required.',
        }),
      ]),
    );
    const scores = collection();
    mocks.collections.set('EvaluationScore', scores);
    mocks.evaluateSkillMatches.mockRejectedValue(
      new Error('Decision provider unavailable'),
    );
    const result = await processOpportunityIntelligence({
      aiClient: { chat: vi.fn() },
      modes: ['score'],
      opportunityId: 'opp-1',
    });
    expect(result.failed).toBe(1);
    expect(scores.records).toHaveLength(0);
    expect(
      mocks.syncRecommendedOpportunityDecisionTasks,
    ).not.toHaveBeenCalled();
  });

  it('bounds adversarial model output when required-skill support is partial and uncertain', async () => {
    const opportunities = collection([
      record({
        descriptionRaw: 'Requires TypeScript and PostgreSQL.',
        id: 'opp-partial',
        requiredSkills: 'TypeScript\nPostgreSQL',
        status: 'found',
        title: 'AI Platform Engineer',
      }),
    ]);
    const scores = collection();
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('EvaluationScore', scores);
    mocks.collections.set(
      'ResumeSkill',
      collection([record({ id: 'skill-typescript', label: 'TypeScript' })]),
    );
    mocks.evaluateSkillMatches.mockImplementation(async (prepared) =>
      resolveSkillMatching(prepared, {
        model: 'jev-test',
        provenance: { provider: 'typesafe', model: 'jev-test' },
        answers: {
          match_1: { type: 'predicate', probability: 0.5 },
          source_1: {
            type: 'choice',
            choice: 'uncertain',
            confidence: 0.99,
            probabilities: { uncertain: 0.99 },
          },
        },
      }),
    );
    const result = await processOpportunityIntelligence({
      aiClient: {
        chat: vi.fn(async () => ({
          content: JSON.stringify({
            confidence: 0.99,
            dataQualityWarnings: ['Candidate is an expert in PostgreSQL.'],
            fitReasons: ['Candidate is an expert in PostgreSQL.'],
            missingInfo: ['Candidate is an expert in PostgreSQL.'],
            recommendation: 'recommend',
            risks: ['No risks.'],
            score: 99,
            suggestedNextAction: 'Apply now.',
            summary: 'Candidate definitively meets every requirement.',
          }),
        })),
      },
      modes: ['score'],
      opportunityId: 'opp-partial',
    });

    expect(result).toMatchObject({ status: 'processed' });
    expect(scores.records[0]).toMatchObject({
      recommendation: 'maybe',
      summary:
        'Bounded advisory score retained attributable support while required-skill evidence remains uncertain.',
    });
    const reason = parseOpportunityReasonJson(scores.records[0]?.reasonJson);
    expect(reason.evidenceMatrix.map((entry) => entry.status)).toEqual([
      'supported',
      'uncertain',
    ]);
    expect(reason.fitReasons.join(' ')).not.toContain('PostgreSQL');
    expect(reason.dataQualityWarnings.join(' ')).not.toContain('PostgreSQL');
    expect(reason.missingInfo.join(' ')).toContain('PostgreSQL');
  });

  it('scores and stores reasonJson evidence without creating an ownerless recommendation task', async () => {
    const opportunities = collection([
      record({
        descriptionRaw: 'Build agent workflow products. Requires TypeScript.',
        id: 'opp-1',
        requiredSkills: 'TypeScript',
        status: 'found',
        title: 'AI Platform Engineer',
      }),
    ]);
    const scores = collection();
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('EvaluationScore', scores);
    mocks.collections.set(
      'ResumeSkill',
      collection([record({ id: 'skill-1', label: 'TypeScript' })]),
    );

    const aiClient = {
      chat: vi.fn(async (_messages: unknown, _options: unknown) => ({
        content: JSON.stringify({
          confidence: 0.91,
          fitReasons: ['TypeScript platform fit'],
          recommendation: 'recommend',
          score: 92,
          summary: 'Strong fit.',
        }),
      })),
    };

    const result = await processOpportunityIntelligence({
      aiClient,
      modes: ['score', 'evidence', 'quality'],
      opportunityId: 'opp-1',
    });

    expect(result).toMatchObject({ status: 'processed' });
    expect(scores.records).toHaveLength(1);
    expect(scores.records[0]).toMatchObject({
      recommendation: 'recommend',
      score: 92,
      summary: 'Strong fit.',
    });
    const storedReason = parseOpportunityReasonJson(
      scores.records[0].reasonJson,
    );
    expect(storedReason).toMatchObject({
      evidenceMatrix: [
        expect.objectContaining({
          requirement: 'TypeScript',
          status: 'supported',
        }),
      ],
      scoring: {
        input: {
          evidenceCount: expect.any(Number),
          version: OPPORTUNITY_SCORING_INPUT_VERSION,
        },
        model: 'openai/gpt-6.1-sol',
        modelInvoked: true,
        outputSchemaVersion: 'opportunity-score-output/v2',
        promptVersion: OPPORTUNITY_SCORING_PROMPT_VERSION,
      },
    });
    expect(storedReason.scoring?.inputTokenCount).toBeLessThanOrEqual(
      storedReason.scoring?.inputTokenCeiling ?? 0,
    );
    expect(JSON.stringify(aiClient.chat.mock.calls[0]?.[0])).not.toContain(
      opportunities.records[0].descriptionRaw,
    );
    expect(aiClient.chat.mock.calls[0]?.[1]).toMatchObject({
      maxTokens: 2_048,
      reasoning: { maxTokens: 1_024 },
      timeout: 105_000,
    });
    expect(opportunities.records[0].status).toBe('recommended');
    expect(
      mocks.syncRecommendedOpportunityDecisionTasks,
    ).not.toHaveBeenCalled();
  });

  it('stores score provenance for the exact queued source version', async () => {
    const opportunities = collection([
      record({
        descriptionRaw: 'Build agent workflow products.',
        id: 'opp-1',
        requiredSkills: 'TypeScript',
        sourceContentFingerprint: 'fingerprint-v1',
        sourceContentVersion: 4,
        status: 'found',
        title: 'AI Platform Engineer',
      }),
    ]);
    const scores = collection();
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('EvaluationScore', scores);
    mocks.collections.set(
      'ResumeSkill',
      collection([record({ id: 'skill-1', label: 'TypeScript' })]),
    );

    const result = await processOpportunityIntelligence({
      aiClient: {
        chat: vi.fn(async () => ({
          content: JSON.stringify({
            confidence: 0.5,
            recommendation: 'maybe',
            score: 60,
            summary: 'Needs review.',
          }),
        })),
      },
      expectedSourceContentFingerprint: 'fingerprint-v1',
      modes: ['score'],
      opportunityId: 'opp-1',
      sourceContentVersion: 4,
      sourceCrawlId: 'crawl-1',
      sourceCrawlItemId: 'crawl-item-1',
      sourceId: 'source-1',
    });

    expect(result).toMatchObject({ status: 'processed' });
    expect(scores.records[0]).toMatchObject({
      sourceContentFingerprint: 'fingerprint-v1',
      sourceContentVersion: 4,
      sourceCrawlId: 'crawl-1',
      sourceCrawlItemId: 'crawl-item-1',
      sourceId: 'source-1',
    });
    expect(mocks.recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          contentFingerprint: 'fingerprint-v1',
          contentVersion: 4,
          sourceCrawlId: 'crawl-1',
          sourceCrawlItemId: 'crawl-item-1',
          sourceId: 'source-1',
        }),
      }),
    );
  });

  it('reuses an unchanged versioned scoring input without another model call', async () => {
    const opportunities = collection([
      record({
        descriptionRaw: 'Qualifications\nTypeScript is required.',
        id: 'opp-1',
        requiredSkills: 'TypeScript',
        status: 'found',
      }),
    ]);
    const scores = collection();
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('EvaluationScore', scores);
    mocks.collections.set(
      'ResumeSkill',
      collection([record({ id: 'skill-1', label: 'TypeScript' })]),
    );
    const aiClient = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({
          confidence: 0.6,
          recommendation: 'maybe',
          score: 65,
          summary: 'Review the fit.',
        }),
      })),
    };

    await processOpportunityIntelligence({
      aiClient,
      modes: ['score'],
      opportunityId: 'opp-1',
    });
    const second = await processOpportunityIntelligence({
      aiClient,
      modes: ['score'],
      opportunityId: 'opp-1',
    });

    expect(second.results[0]).toMatchObject({
      message: 'Reused the current idempotent opportunity score.',
      status: 'processed',
    });
    expect(aiClient.chat).toHaveBeenCalledTimes(1);
    expect(scores.records).toHaveLength(1);
  });

  it.each([
    '',
    'different-material',
  ])('refreshes a score with stale material identity %j despite identical request provenance', async (storedMaterial) => {
    const opportunities = collection([
      record({
        descriptionRaw: 'Qualifications\nTypeScript is required.',
        id: 'opp-1',
        requiredSkills: 'TypeScript',
        status: 'found',
      }),
    ]);
    const scores = collection();
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('EvaluationScore', scores);
    mocks.collections.set(
      'ResumeSkill',
      collection([record({ id: 'skill-1', label: 'TypeScript' })]),
    );
    const aiClient = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({
          confidence: 0.6,
          recommendation: 'maybe',
          score: 65,
          summary: 'Review the fit.',
        }),
      })),
    };

    await processOpportunityIntelligence({
      aiClient,
      modes: ['score'],
      opportunityId: 'opp-1',
    });
    scores.records[0].scoringMaterialFingerprint = storedMaterial;
    const second = await processOpportunityIntelligence({
      aiClient,
      modes: ['score'],
      opportunityId: 'opp-1',
    });

    expect(second.results[0]).toMatchObject({
      status: 'processed',
    });
    expect(aiClient.chat).toHaveBeenCalledTimes(2);
    expect(scores.records).toHaveLength(2);
    expect(scores.records[1].scoringMaterialFingerprint).toBe(
      opportunities.records[0].scoringMaterialFingerprint,
    );
    expect(scores.records[1].scoringMaterialFingerprint).not.toBe(
      storedMaterial,
    );
  });

  it('does not overwrite a concurrent human status transition after scoring', async () => {
    const opportunity = record({
      descriptionRaw: 'Build agent workflow products.',
      id: 'opp-1',
      requiredSkills: 'TypeScript',
      sourceContentFingerprint: 'fingerprint-v1',
      status: 'found',
      title: 'AI Platform Engineer',
    });
    const opportunities = collection([opportunity]);
    const scores = collection();
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('EvaluationScore', scores);
    mocks.collections.set(
      'ResumeSkill',
      collection([record({ id: 'skill-1', label: 'TypeScript' })]),
    );
    mocks.databaseUpdate.mockImplementationOnce(async () => {
      opportunity.status = 'apply';
      return { affected: 0 };
    });

    const result = await processOpportunityIntelligence({
      aiClient: {
        chat: vi.fn(async () => ({
          content: JSON.stringify({
            confidence: 0.9,
            recommendation: 'recommend',
            score: 90,
            summary: 'Strong fit.',
          }),
        })),
      },
      expectedSourceContentFingerprint: 'fingerprint-v1',
      modes: ['score'],
      opportunityId: 'opp-1',
      sourceContentVersion: 1,
    });

    expect(result).toMatchObject({ status: 'processed' });
    expect(opportunity.status).toBe('apply');
    expect(scores.records).toHaveLength(1);
    expect(mocks.databaseUpdate).toHaveBeenCalledWith(
      'opportunities',
      expect.objectContaining({
        source_content_fingerprint: 'fingerprint-v1',
        source_content_version: 1,
        status: 'found',
      }),
      expect.objectContaining({ status: 'recommended' }),
    );
    expect(
      mocks.syncRecommendedOpportunityDecisionTasks,
    ).not.toHaveBeenCalled();
  });

  it('audits paid scoring that becomes stale without storing a score', async () => {
    const opportunity = record({
      descriptionRaw: 'Build agent workflow products.',
      id: 'opp-1',
      requiredSkills: 'TypeScript',
      sourceContentFingerprint: 'fingerprint-v1',
      status: 'found',
      title: 'AI Platform Engineer',
    });
    const opportunities = collection([opportunity]);
    const scores = collection();
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('EvaluationScore', scores);
    mocks.collections.set(
      'ResumeSkill',
      collection([record({ id: 'skill-1', label: 'TypeScript' })]),
    );

    const result = await processOpportunityIntelligence({
      aiClient: {
        chat: vi.fn(async () => {
          opportunity.sourceContentFingerprint = 'fingerprint-v2';
          return {
            content: JSON.stringify({
              confidence: 0.9,
              recommendation: 'recommend',
              score: 90,
              summary: 'Strong fit.',
            }),
          };
        }),
      },
      expectedSourceContentFingerprint: 'fingerprint-v1',
      modes: ['score'],
      opportunityId: 'opp-1',
      sourceContentVersion: 1,
    });

    expect(result).toMatchObject({
      stale: true,
      status: 'skipped',
    });
    expect(scores.records).toHaveLength(0);
    expect(mocks.recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({ discardedAsStale: true }),
        runType: 'opportunity_llm_score',
        status: 'succeeded',
      }),
    );
  });

  it('discards a queued score when candidate material changes while it runs', async () => {
    const opportunity = record({
      descriptionRaw: 'Build agent workflow products.',
      id: 'opp-1',
      requiredSkills: 'TypeScript',
      sourceContentFingerprint: 'fingerprint-v1',
      status: 'found',
      title: 'AI Platform Engineer',
    });
    const opportunities = collection([opportunity]);
    const scores = collection();
    const skill = record({ id: 'skill-1', label: 'TypeScript' });
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('EvaluationScore', scores);
    mocks.collections.set('ResumeSkill', collection([skill]));
    mocks.collections.set('FactCandidate', collection());
    mocks.collections.set('Achievement', collection());
    mocks.collections.set('CandidateProfile', collection());
    const material = await scoringMaterialForOpportunity(opportunity as never);

    const result = await processOpportunityIntelligence({
      aiClient: {
        chat: vi.fn(async () => {
          skill.label = 'Rust';
          return {
            content: JSON.stringify({
              confidence: 0.9,
              recommendation: 'recommend',
              score: 90,
              summary: 'Strong fit.',
            }),
          };
        }),
      },
      expectedScoringMaterialFingerprint: material?.fingerprint,
      modes: ['score'],
      opportunityId: 'opp-1',
    });

    expect(result).toMatchObject({ stale: true, status: 'skipped' });
    expect(scores.records).toHaveLength(0);
  });

  it('does not apply recommendation side effects after a reconciler advances the target', async () => {
    const opportunity = record({
      descriptionRaw: 'Build agent workflow products. Requires TypeScript.',
      id: 'opp-1',
      requiredSkills: 'TypeScript',
      status: 'found',
      title: 'AI Platform Engineer',
    });
    const opportunities = collection([opportunity]);
    const scores = collection();
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('EvaluationScore', scores);
    mocks.collections.set(
      'ResumeSkill',
      collection([record({ id: 'skill-1', label: 'TypeScript' })]),
    );
    const material = await scoringMaterialForOpportunity(opportunity as never);
    opportunity.scoringMaterialFingerprint = material?.fingerprint;
    mocks.databaseUpdate.mockImplementation(async (_table, where) => {
      expect(where).toMatchObject({
        scoring_material_fingerprint: material?.fingerprint,
      });
      // The reconciler advances its target after the pre-write read, before
      // the conditional update reaches the database.
      opportunity.scoringMaterialFingerprint = 'newer-material';
      return {
        affected:
          where.scoring_material_fingerprint ===
            opportunity.scoringMaterialFingerprint &&
          opportunity.scoringMaterialFingerprint === material?.fingerprint
            ? 1
            : 0,
      };
    });

    const result = await processOpportunityIntelligence({
      aiClient: {
        chat: vi.fn(async () => ({
          content: JSON.stringify({
            confidence: 0.9,
            recommendation: 'recommend',
            score: 90,
            summary: 'Strong fit.',
          }),
        })),
      },
      modes: ['score'],
      opportunityId: 'opp-1',
    });

    expect(result).toMatchObject({ stale: true, status: 'skipped' });
    expect(opportunity).toMatchObject({
      scoringMaterialFingerprint: 'newer-material',
      status: 'found',
    });
    expect(
      mocks.syncRecommendedOpportunityDecisionTasks,
    ).not.toHaveBeenCalled();
    expect(mocks.databaseUpdate).toHaveBeenCalledOnce();
  });

  it.each([
    'evidence',
    'quality',
  ] as const)('marks %s derivation stale when the source changes during persistence', async (mode) => {
    const opportunity = record({
      descriptionRaw: 'Requires TypeScript.',
      employmentType: 'full_time',
      id: 'opp-1',
      requiredSkills: 'TypeScript',
      sourceContentFingerprint: 'fingerprint-v1',
      status: 'found',
      workMode: 'remote',
    });
    const score = record({
      id: 'score-1',
      opportunityId: 'opp-1',
      reasonJson: '{}',
      recommendation: 'maybe',
      sourceContentFingerprint: 'fingerprint-v1',
    });
    score.save.mockImplementationOnce(async () => {
      opportunity.sourceContentFingerprint = 'fingerprint-v2';
    });
    mocks.collections.set('Opportunity', collection([opportunity]));
    mocks.collections.set('EvaluationScore', collection([score]));
    mocks.collections.set(
      'ResumeSkill',
      collection([record({ id: 'skill-1', label: 'TypeScript' })]),
    );

    const result = await processOpportunityIntelligence({
      expectedSourceContentFingerprint: 'fingerprint-v1',
      modes: [mode],
      opportunityId: 'opp-1',
      sourceContentVersion: 1,
      sourceCrawlId: 'crawl-1',
      sourceCrawlItemId: 'crawl-item-1',
      sourceId: 'source-1',
    });

    expect(result).toMatchObject({ stale: true, status: 'skipped' });
    expect(result.results[0]).toMatchObject({
      mode,
      skipReason: 'stale',
      status: 'skipped',
    });
    expect(mocks.recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          contentFingerprint: 'fingerprint-v1',
          contentVersion: 1,
          sourceCrawlId: 'crawl-1',
          sourceCrawlItemId: 'crawl-item-1',
          sourceId: 'source-1',
        }),
        output: expect.objectContaining({ discardedAsStale: true }),
        application: expect.objectContaining({ sourceId: 'source-1' }),
        status: 'succeeded',
      }),
    );
  });

  it('does not mutate a human-owned evaluation during derived evidence work', async () => {
    const opportunity = record({
      descriptionRaw: 'Qualifications\nTypeScript is required.',
      id: 'opp-1',
      requiredSkills: 'TypeScript',
      status: 'found',
    });
    const score = record({
      createdByProfileId: 'profile-human',
      id: 'score-human',
      opportunityId: 'opp-1',
      reasonJson: '{}',
      recommendation: 'maybe',
      sourceContentFingerprint: opportunity.sourceContentFingerprint,
    });
    mocks.collections.set('Opportunity', collection([opportunity]));
    mocks.collections.set('EvaluationScore', collection([score]));

    const result = await processOpportunityIntelligence({
      expectedSourceContentFingerprint: String(
        opportunity.sourceContentFingerprint,
      ),
      modes: ['evidence'],
      opportunityId: 'opp-1',
      sourceContentVersion: Number(opportunity.sourceContentVersion),
    });

    expect(result).toMatchObject({ status: 'skipped' });
    expect(score.save).not.toHaveBeenCalled();
  });

  it('does not save derived evidence after the source version becomes stale', async () => {
    const opportunity = record({
      descriptionRaw: 'Qualifications\nTypeScript is required.',
      id: 'opp-1',
      requiredSkills: 'TypeScript',
      sourceContentFingerprint: 'fingerprint-v1',
      sourceContentVersion: 1,
      status: 'found',
    });
    const score = record({
      createdByProfileId: '',
      id: 'score-automation',
      opportunityId: 'opp-1',
      reasonJson: '{}',
      recommendation: 'maybe',
      sourceContentFingerprint: 'fingerprint-v1',
    });
    const skills = collection([record({ id: 'skill-1', label: 'TypeScript' })]);
    const listSkills = skills.list.getMockImplementation();
    skills.list.mockImplementation(async (options) => {
      opportunity.sourceContentVersion = 2;
      return (await listSkills?.(options)) ?? [];
    });
    mocks.collections.set('Opportunity', collection([opportunity]));
    mocks.collections.set('EvaluationScore', collection([score]));
    mocks.collections.set('ResumeSkill', skills);

    const result = await processOpportunityIntelligence({
      expectedSourceContentFingerprint: 'fingerprint-v1',
      modes: ['evidence'],
      opportunityId: 'opp-1',
      sourceContentVersion: 1,
    });

    expect(result).toMatchObject({ stale: true, status: 'skipped' });
    expect(score.save).not.toHaveBeenCalled();
  });

  it('does not score over a current human-owned evaluation', async () => {
    const opportunity = record({
      descriptionRaw: 'Qualifications\nTypeScript is required.',
      id: 'opp-1',
      requiredSkills: 'TypeScript',
      status: 'found',
    });
    const score = record({
      createdByProfileId: 'profile-human',
      id: 'score-human',
      opportunityId: 'opp-1',
      reasonJson: '{}',
      recommendation: 'maybe',
      sourceContentFingerprint: opportunity.sourceContentFingerprint,
    });
    const scores = collection([score]);
    const chat = vi.fn(async () => ({ content: '{}' }));
    mocks.collections.set('Opportunity', collection([opportunity]));
    mocks.collections.set('EvaluationScore', scores);
    mocks.collections.set(
      'ResumeSkill',
      collection([record({ id: 'skill-1', label: 'TypeScript' })]),
    );

    const result = await processOpportunityIntelligence({
      aiClient: { chat },
      expectedSourceContentFingerprint: String(
        opportunity.sourceContentFingerprint,
      ),
      modes: ['score'],
      opportunityId: 'opp-1',
      sourceContentVersion: Number(opportunity.sourceContentVersion),
    });

    expect(result).toMatchObject({ status: 'skipped' });
    expect(chat).not.toHaveBeenCalled();
    expect(scores.records).toEqual([score]);
    expect(mocks.databaseUpdate).not.toHaveBeenCalled();
  });

  it('treats a required skill named only in company research as a candidate gap', async () => {
    const opportunities = collection([
      record({
        descriptionRaw: 'Backend role. Requires Python.',
        id: 'opp-1',
        organizationProfileId: 'org-1',
        requiredSkills: 'Python',
        status: 'found',
        title: 'Backend Engineer',
      }),
    ]);
    const scores = collection();
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('EvaluationScore', scores);
    // Will's reviewed background has TypeScript, not Python.
    mocks.collections.set(
      'ResumeSkill',
      collection([record({ id: 'skill-1', label: 'TypeScript' })]),
    );
    // The employer uses Python — this must NOT satisfy Will's requirement.
    mocks.collections.set(
      'CompanyResearch',
      collection([
        record({
          id: 'cr-1',
          organizationProfileId: 'org-1',
          technicalSummary: 'They build their entire platform in Python.',
        }),
      ]),
    );
    mocks.collections.set('Task', collection());

    const aiClient = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({
          confidence: 0.5,
          recommendation: 'maybe',
          score: 40,
          summary: 'Python gap.',
        }),
      })),
    };

    const result = await processOpportunityIntelligence({
      aiClient,
      modes: ['score', 'evidence'],
      opportunityId: 'opp-1',
    });

    expect(result).toMatchObject({ status: 'processed' });

    // Missing candidate evidence is a deterministic needs-research outcome;
    // company research cannot make the case model-eligible.
    expect(aiClient.chat).not.toHaveBeenCalled();

    // Fix A: company research does not mask the candidate gap.
    expect(
      parseOpportunityReasonJson(scores.records[0].reasonJson),
    ).toMatchObject({
      evidenceMatrix: [
        expect.objectContaining({ requirement: 'Python', status: 'gap' }),
      ],
      missingInfo: expect.arrayContaining(['No reviewed evidence for Python.']),
    });
  });

  it('audits invalid LLM scoring JSON without writing a score', async () => {
    const opportunities = collection([
      record({
        descriptionRaw: 'Requires TypeScript.',
        id: 'opp-1',
        requiredSkills: 'TypeScript',
        status: 'found',
      }),
    ]);
    const scores = collection();
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('EvaluationScore', scores);
    mocks.collections.set(
      'ResumeSkill',
      collection([record({ id: 'skill-1', label: 'TypeScript' })]),
    );
    const aiClient = {
      chat: vi.fn(async () => ({ content: 'not json' })),
    };

    const result = await processOpportunityIntelligence({
      aiClient,
      modes: ['score'],
      opportunityId: 'opp-1',
    });

    expect(result).toMatchObject({
      failed: 1,
      message: 'Processed 0 intelligence steps; 1 failed.',
      status: 'error',
    });
    expect(scores.records).toHaveLength(0);
    expect(opportunities.records[0].status).toBe('found');
    expect(mocks.recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'LLM scoring returned invalid JSON.',
        output: expect.objectContaining({
          rawContentLength: 'not json'.length,
          rawContentPreview: 'not json',
          rawContentTruncated: false,
        }),
        runType: 'opportunity_llm_score',
        status: 'failed',
      }),
    );
  });

  it('treats all as automatic processing without unconditional research or planning', async () => {
    const opportunities = collection([
      record({
        descriptionRaw: 'Build agent workflow products. Requires TypeScript.',
        id: 'opp-1',
        requiredSkills: 'TypeScript',
        status: 'found',
        title: 'AI Platform Engineer',
      }),
    ]);
    const scores = collection();
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('EvaluationScore', scores);
    mocks.collections.set(
      'ResumeSkill',
      collection([record({ id: 'skill-1', label: 'TypeScript' })]),
    );

    const aiClient = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({
          confidence: 0.91,
          recommendation: 'recommend',
          score: 92,
          summary: 'Strong fit.',
        }),
      })),
    };

    const result = await processOpportunityIntelligence({
      aiClient,
      modes: 'all',
      opportunityId: 'opp-1',
    });

    expect(result).toMatchObject({ failed: 0, status: 'processed' });
    expect(result.results.map((step) => step.mode)).toEqual([
      'extract',
      'score',
      'evidence',
      'quality',
    ]);
    expect(mocks.processOpportunityWithLlm).toHaveBeenCalledWith(
      'opp-1',
      expect.objectContaining({ modes: 'all' }),
    );
  });

  it('audits failed LLM scoring without discarding the opportunity', async () => {
    const opportunities = collection([
      record({
        descriptionRaw: 'Requires TypeScript.',
        id: 'opp-1',
        requiredSkills: 'TypeScript',
        status: 'found',
      }),
    ]);
    const scores = collection();
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('EvaluationScore', scores);
    mocks.collections.set(
      'ResumeSkill',
      collection([record({ id: 'skill-1', label: 'TypeScript' })]),
    );
    const aiClient = {
      chat: vi.fn(async () => {
        throw new Error('model unavailable');
      }),
    };

    const result = await processOpportunityIntelligence({
      aiClient,
      modes: ['score'],
      opportunityId: 'opp-1',
    });

    expect(result).toMatchObject({ failed: 1, status: 'error' });
    expect(scores.records).toHaveLength(0);
    expect(opportunities.records[0].status).toBe('found');
    expect(mocks.recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'model unavailable',
        runType: 'opportunity_llm_score',
        status: 'failed',
      }),
    );
  });

  it('creates and reopens needs-research tasks idempotently', async () => {
    const opportunities = collection([
      record({
        id: 'opp-1',
        organizationProfileId: 'org-1',
        sourceId: 'source-1',
        status: 'found',
        title: 'AI Engineer',
      }),
    ]);
    const scores = collection([
      record({
        id: 'score-1',
        opportunityId: 'opp-1',
        reasonJson: JSON.stringify({
          dataQualityWarnings: ['Compensation missing'],
          missingInfo: ['Company stage'],
          risks: ['Unclear scope'],
        }),
        recommendation: 'needs_research',
      }),
    ]);
    const tasks = collection([
      record({
        completedAt: new Date('2026-06-01T00:00:00.000Z'),
        externalTaskId: 'company-research:opp-1',
        id: 'task-1',
        opportunityId: 'opp-1',
        status: 'done',
        taskType: 'research_company',
      }),
    ]);
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('EvaluationScore', scores);
    mocks.collections.set('Task', tasks);

    await processOpportunityIntelligence({
      modes: ['research'],
      opportunityId: 'opp-1',
    });
    await processOpportunityIntelligence({
      modes: ['research'],
      opportunityId: 'opp-1',
    });

    expect(tasks.records).toHaveLength(2);
    expect(tasks.records[0]).toMatchObject({
      completedAt: null,
      externalTaskId: 'company-research:opp-1',
      kanbanColumn: 'researching',
      status: 'open',
    });
    expect(
      tasks.records.filter(
        (task) => task.externalTaskId === 'revise-score:opp-1',
      ),
    ).toHaveLength(1);
  });

  it('versions needs-research tasks with the queued source provenance', async () => {
    const opportunities = collection([
      record({
        id: 'opp-1',
        sourceContentFingerprint: 'fingerprint-v4',
        sourceContentVersion: 4,
        status: 'found',
        title: 'AI Engineer',
      }),
    ]);
    const scores = collection([
      record({
        id: 'score-1',
        opportunityId: 'opp-1',
        reasonJson: '{}',
        recommendation: 'needs_research',
        sourceContentFingerprint: 'fingerprint-v4',
      }),
    ]);
    const tasks = collection();
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('EvaluationScore', scores);
    mocks.collections.set('Task', tasks);

    await processOpportunityIntelligence({
      expectedSourceContentFingerprint: 'fingerprint-v4',
      modes: ['research'],
      opportunityId: 'opp-1',
      sourceContentVersion: 4,
    });

    expect(tasks.records).toHaveLength(2);
    for (const task of tasks.records) {
      expect(task.externalTaskId).toMatch(/:opp-1:fingerprint-v4$/);
      expect(JSON.parse(String(task.artifactRefsJson))).toEqual({
        opportunityIntelligence: {
          contentFingerprint: 'fingerprint-v4',
          contentVersion: 4,
        },
      });
    }
  });

  it('preserves unrelated artifact references when refreshing a versioned task', async () => {
    const opportunities = collection([
      record({
        id: 'opp-1',
        sourceContentFingerprint: 'fingerprint-v4',
        sourceContentVersion: 4,
        status: 'found',
        title: 'AI Engineer',
      }),
    ]);
    const scores = collection([
      record({
        id: 'score-1',
        opportunityId: 'opp-1',
        reasonJson: '{}',
        recommendation: 'needs_research',
        sourceContentFingerprint: 'fingerprint-v4',
      }),
    ]);
    const tasks = collection([
      record({
        artifactRefsJson: JSON.stringify({
          evidence: { documentId: 'document-1' },
          opportunityIntelligence: {
            contentFingerprint: 'fingerprint-v4',
            contentVersion: 3,
          },
        }),
        externalTaskId: 'company-research:opp-1:fingerprint-v4',
        id: 'task-1',
        opportunityId: 'opp-1',
        status: 'open',
        taskType: 'research_company',
      }),
      record({
        artifactRefsJson: '{malformed',
        externalTaskId: 'revise-score:opp-1:fingerprint-v4',
        id: 'task-2',
        opportunityId: 'opp-1',
        status: 'open',
        taskType: 'score_opportunity',
      }),
    ]);
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('EvaluationScore', scores);
    mocks.collections.set('Task', tasks);

    await processOpportunityIntelligence({
      expectedSourceContentFingerprint: 'fingerprint-v4',
      modes: ['research'],
      opportunityId: 'opp-1',
      sourceContentVersion: 4,
    });

    expect(JSON.parse(String(tasks.records[0].artifactRefsJson))).toEqual({
      evidence: { documentId: 'document-1' },
      opportunityIntelligence: {
        contentFingerprint: 'fingerprint-v4',
        contentVersion: 4,
      },
    });
    expect(JSON.parse(String(tasks.records[1].artifactRefsJson))).toEqual({
      opportunityIntelligence: {
        contentFingerprint: 'fingerprint-v4',
        contentVersion: 4,
      },
    });
  });

  it('discards research tasks when the source version changes during task writes', async () => {
    const opportunity = record({
      id: 'opp-1',
      sourceContentFingerprint: 'fingerprint-v1',
      sourceContentVersion: 1,
      status: 'found',
      title: 'AI Engineer',
    });
    const opportunities = collection([opportunity]);
    const tasks = collection();
    const originalCreate = tasks.create.getMockImplementation();
    tasks.create.mockImplementation(
      async (payload: Record<string, unknown>) => {
        const created = await originalCreate?.(payload);
        if (!created) throw new Error('Task creation failed.');
        created.save.mockImplementationOnce(async () => {
          opportunity.sourceContentVersion = 2;
        });
        return created;
      },
    );
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('EvaluationScore', collection());
    mocks.collections.set('Task', tasks);

    const result = await processOpportunityIntelligence({
      expectedSourceContentFingerprint: 'fingerprint-v1',
      modes: ['research'],
      opportunityId: 'opp-1',
      sourceContentVersion: 1,
    });

    expect(result).toMatchObject({ stale: true, status: 'skipped' });
    expect(mocks.cancelStaleOpportunityIntelligenceTasks).toHaveBeenCalledWith(
      'opp-1',
      'fingerprint-v1',
      2,
    );
    expect(mocks.recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({ discardedAsStale: true }),
        runType: 'opportunity_llm_research',
      }),
    );
  });

  it('populates default application planning fields and links the latest score', async () => {
    const opportunities = collection([
      record({
        id: 'opp-1',
        status: 'apply',
        title: 'AI Engineer',
      }),
    ]);
    const applications = collection([
      record({
        accountStatus: 'unknown',
        applyMethod: 'company_site',
        coverLetterMode: 'none',
        evaluationScoreId: '',
        id: 'app-1',
        opportunityId: 'opp-1',
        resumeMode: 'default',
        status: 'draft',
      }),
    ]);
    const scores = collection([
      record({
        id: 'score-1',
        opportunityId: 'opp-1',
        reasonJson: '{}',
        recommendation: 'recommend',
        score: 90,
      }),
    ]);
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('Application', applications);
    mocks.collections.set('EvaluationScore', scores);

    const aiClient = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({
          accountStatus: 'needs_signup',
          applicationInstructions: 'Apply through the company portal.',
          applyMethod: 'platform',
          coverLetterMode: 'generate',
          requiredAnswers: 'Portfolio examples.',
          resumeMode: 'generate_tailored',
        }),
      })),
    };
    const runLifecycleMutation = vi.fn(
      async (action) => await action({ update: mocks.databaseUpdate }),
    );

    const result = await processOpportunityIntelligence({
      aiClient,
      applicationId: 'app-1',
      modes: ['plan'],
      opportunityId: 'opp-1',
      profile: 'opportunity-intelligence-zai',
      runLifecycleMutation,
    });

    expect(result).toMatchObject({ status: 'processed' });
    expect(runLifecycleMutation).toHaveBeenCalledTimes(1);
    expect(aiClient.chat.mock.calls.at(0)?.at(1)).toMatchObject({
      maxTokens: 4_096,
      model: 'openai/gpt-5.6-terra',
      reasoning: { maxTokens: 1_024 },
      timeout: 105_000,
    });
    expect(applications.records[0]).toMatchObject({
      accountStatus: 'needs_signup',
      applicationInstructions: 'Apply through the company portal.',
      applyMethod: 'platform',
      coverLetterMode: 'generate',
      evaluationScoreId: 'score-1',
      requiredAnswers: 'Portfolio examples.',
      resumeMode: 'generate_tailored',
      status: 'application_drafting',
    });
    expect(mocks.syncApplicationWorkflowTasks).toHaveBeenCalledWith(
      applications.records[0],
    );
  });

  it('keeps a SmrtObject accessor id in the planning concurrency fence', async () => {
    const opportunity = record({
      id: 'opp-accessor-id',
      status: 'apply',
      title: 'AI Engineer',
    });
    const application = record({
      id: 'app-accessor-id',
      opportunityId: 'opp-accessor-id',
      status: 'draft',
    });
    Object.defineProperty(application, 'id', {
      configurable: true,
      enumerable: false,
      value: 'app-accessor-id',
      writable: true,
    });
    mocks.collections.set('Opportunity', collection([opportunity]));
    mocks.collections.set('Application', collection([application]));
    mocks.collections.set('EvaluationScore', collection());

    const result = await processOpportunityIntelligence({
      aiClient: {
        chat: vi.fn(async () => ({
          content: JSON.stringify({
            applicationInstructions: 'Apply through the company portal.',
          }),
        })),
      },
      applicationId: 'app-accessor-id',
      modes: ['plan'],
      opportunityId: 'opp-accessor-id',
    });

    expect(result).toMatchObject({ status: 'processed' });
    expect(mocks.databaseUpdate).toHaveBeenCalledWith(
      'applications',
      expect.objectContaining({ id: 'app-accessor-id' }),
      expect.any(Object),
    );
  });

  it('discards a stale plan instead of overwriting a concurrent application approval', async () => {
    const opportunities = collection([
      record({ id: 'opp-1', status: 'apply', title: 'AI Engineer' }),
    ]);
    const applications = collection([
      record({
        id: 'app-1',
        opportunityId: 'opp-1',
        status: 'draft',
      }),
    ]);
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('Application', applications);
    mocks.collections.set('EvaluationScore', collection());
    mocks.databaseUpdate.mockResolvedValueOnce({ affected: 0 });

    const result = await processOpportunityIntelligence({
      aiClient: {
        chat: vi.fn(async () => ({
          content: JSON.stringify({
            applicationInstructions: 'Stale plan must not persist.',
          }),
        })),
      },
      applicationId: 'app-1',
      modes: ['plan'],
      opportunityId: 'opp-1',
    });

    expect(result).toMatchObject({ stale: true, status: 'skipped' });
    expect(applications.records[0]?.applicationInstructions).toBeUndefined();
    expect(applications.records[0]).toMatchObject({ status: 'draft' });
    expect(applications.records[0].save).not.toHaveBeenCalled();
    expect(mocks.syncApplicationWorkflowTasks).not.toHaveBeenCalled();
  });

  it('abandons plan persistence when its lifecycle fence drops mid-mutation', async () => {
    const opportunities = collection([
      record({ id: 'opp-1', status: 'apply', title: 'AI Engineer' }),
    ]);
    const applications = collection([
      record({
        id: 'app-1',
        opportunityId: 'opp-1',
        status: 'draft',
      }),
    ]);
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('Application', applications);
    mocks.collections.set('EvaluationScore', collection());
    let lockActive = true;
    const assertWriteAllowed = () => {
      if (lockActive) return;
      throw new Error('lifecycle lock lost');
    };
    mocks.syncApplicationWorkflowTasks.mockImplementationOnce(async () => {
      lockActive = false;
      return { created: 0 };
    });
    const runLifecycleMutation = vi.fn(
      async (action) => await action({ update: mocks.databaseUpdate }),
    );

    await expect(
      processOpportunityIntelligence({
        aiClient: {
          chat: vi.fn(async () => ({
            content: JSON.stringify({
              applicationInstructions: 'Do not persist after lock loss.',
            }),
          })),
        },
        applicationId: 'app-1',
        assertWriteAllowed,
        modes: ['plan'],
        opportunityId: 'opp-1',
        runLifecycleMutation,
      }),
    ).rejects.toThrow('lifecycle lock lost');

    expect(runLifecycleMutation).toHaveBeenCalledTimes(1);
    expect(mocks.syncApplicationWorkflowTasks).toHaveBeenCalledTimes(1);
    expect(mocks.recordAgentAudit).not.toHaveBeenCalled();
  });

  it('skips planning when an explicit application belongs to another opportunity', async () => {
    const opportunities = collection([
      record({
        id: 'opp-1',
        status: 'apply',
        title: 'AI Engineer',
      }),
    ]);
    const applications = collection([
      record({
        id: 'app-1',
        opportunityId: 'other-opp',
        status: 'draft',
      }),
    ]);
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('Application', applications);
    mocks.collections.set('EvaluationScore', collection());
    const aiClient = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({
          applicationInstructions: 'Should not run.',
        }),
      })),
    };

    const result = await processOpportunityIntelligence({
      aiClient,
      applicationId: 'app-1',
      modes: ['plan'],
      opportunityId: 'opp-1',
    });

    expect(result.results).toEqual([
      {
        message: 'No application exists yet; planning skipped.',
        mode: 'plan',
        skipReason: 'prerequisite',
        status: 'skipped',
      },
    ]);
    expect(result).toMatchObject({
      message: 'No application exists yet; planning skipped.',
      stale: false,
      status: 'skipped',
    });
    expect(aiClient.chat).not.toHaveBeenCalled();
    expect(applications.records[0].save).not.toHaveBeenCalled();
    expect(mocks.syncApplicationWorkflowTasks).not.toHaveBeenCalled();
  });

  it('does not clear an existing application score link when planning has no score', async () => {
    const opportunities = collection([record({ id: 'opp-1' })]);
    const applications = collection([
      record({
        applicationInstructions: '',
        evaluationScoreId: 'score-existing',
        id: 'app-1',
        opportunityId: 'opp-1',
        status: 'application_drafting',
      }),
    ]);
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('Application', applications);
    mocks.collections.set('EvaluationScore', collection());

    const aiClient = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({
          applicationInstructions: 'Existing score link should remain.',
        }),
      })),
    };

    await processOpportunityIntelligence({
      aiClient,
      applicationId: 'app-1',
      modes: ['plan'],
      opportunityId: 'opp-1',
    });

    expect(applications.records[0]).toMatchObject({
      applicationInstructions: 'Existing score link should remain.',
      evaluationScoreId: 'score-existing',
    });
  });

  it('does not warn about missing compensation when only a max value is known', async () => {
    const opportunities = collection([
      record({
        descriptionRaw: 'Requires TypeScript.',
        employmentType: 'full_time',
        id: 'opp-1',
        requiredSkills: 'TypeScript',
        salaryMax: 180000,
        status: 'found',
        workMode: 'remote',
      }),
    ]);
    const scores = collection([
      record({
        id: 'score-1',
        opportunityId: 'opp-1',
        reasonJson: '{}',
        recommendation: 'maybe',
      }),
    ]);
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('EvaluationScore', scores);

    await processOpportunityIntelligence({
      modes: ['quality'],
      opportunityId: 'opp-1',
    });

    expect(
      parseOpportunityReasonJson(scores.records[0].reasonJson)
        .dataQualityWarnings,
    ).not.toContain('Compensation range is missing.');
  });

  it('reports partial failures in bulk processing', async () => {
    const opportunities = collection([
      record({
        descriptionRaw: 'Requires TypeScript.',
        id: 'opp-1',
        requiredSkills: 'TypeScript',
        status: 'found',
      }),
    ]);
    mocks.collections.set('Opportunity', opportunities);
    mocks.collections.set('EvaluationScore', collection());
    mocks.collections.set(
      'ResumeSkill',
      collection([record({ id: 'skill-1', label: 'TypeScript' })]),
    );
    const aiClient = {
      chat: vi.fn(async () => ({ content: 'not json' })),
    };

    const result = await bulkProcessOpportunityIntelligence(['opp-1'], {
      aiClient,
      modes: ['extract', 'score'],
    });

    expect(result).toMatchObject({
      count: 1,
      failed: 1,
      message: 'Processed 1 opportunities; 1 had failures.',
      status: 'processed',
    });
  });
});
