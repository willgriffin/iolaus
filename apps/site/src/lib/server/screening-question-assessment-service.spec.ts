import type { DecisionResult } from '@happyvertical/ai';
import type { PrincipalRun } from '@happyvertical/smrt-agents';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createScreeningQuestion,
  screeningQuestionSetFingerprint,
} from '../opportunity-screening-questions.js';
import {
  OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION,
  OPPORTUNITY_QUESTION_SCREENING_V1_VERSION,
  OPPORTUNITY_QUESTION_SCREENING_V2_VERSION,
  OPPORTUNITY_QUESTION_SCREENING_V3_VERSION,
  OPPORTUNITY_QUESTION_SCREENING_V4_VERSION,
  OPPORTUNITY_QUESTION_SCREENING_VERSION,
  opportunityQuestionScreeningInputFingerprint,
  type PreparedOpportunityQuestionScreening,
  preflightOpportunityQuestionScreening,
  resolveOpportunityQuestionScreening,
} from './opportunity-question-screening.js';
import { fingerprintOpportunitySourceContent } from './opportunity-source-content.js';
import type { WorkspaceCandidateEvidence } from './resume-data.js';
import {
  backfillCurrentScreeningQuestionRecommendationRank,
  loadCurrentScreeningQuestionAssessmentProjections,
  loadCurrentScreeningQuestionRecommendationScope,
  prepareCurrentScreeningQuestionAssessment,
  readCurrentScreeningQuestionAssessment,
  runScreeningQuestionAssessment,
  type ScreeningQuestionAssessmentDependencies,
} from './screening-question-assessment-service.js';
import type { ScreeningQuestionSnapshot } from './screening-question-store.js';

const subject = { tenantId: 'tenant', userId: 'user', profileId: 'profile' };
const run: PrincipalRun = {
  context: {} as PrincipalRun['context'],
  permissions: ['workflow.assessment.execute', 'opportunities.read'],
  allowedTools: [],
  isToolAllowed: () => false,
  assertToolAllowed: () => {
    throw new Error('No tools.');
  },
  assertOperation: vi.fn(async () => undefined as never),
};
function decision(
  prepared: PreparedOpportunityQuestionScreening,
  roleChoice = 'related',
): DecisionResult {
  return {
    model: prepared.model,
    provenance: { model: prepared.model, provider: 'typesafe' },
    answers: Object.fromEntries(
      Object.entries(prepared.request.questions).map(([key, question]) => {
        if (question.type !== 'choice')
          throw new Error('This fixture is a source-only question.');
        const keys = Object.keys(question.criteria);
        const choice =
          key === 'role'
            ? roleChoice
            : key.endsWith('_answer')
              ? 'yes'
              : Object.keys(prepared.sourceWitnesses)[0]!;
        return [
          key,
          {
            type: 'choice',
            choice,
            confidence: 0.99,
            probabilities: Object.fromEntries(
              keys.map((value) => [
                value,
                value === choice ? 0.99 : 0.01 / (keys.length - 1),
              ]),
            ),
          },
        ];
      }),
    ),
  };
}
async function fixture(roleChoice = 'related') {
  const db = await getDatabase({
    type: 'sqlite',
    url: ':memory:',
    cache: false,
  });
  await db.query(
    `CREATE TABLE agent_runs (id TEXT, opportunity_id TEXT, tenant_id TEXT, owner_user_id TEXT, candidate_profile_id TEXT, status TEXT, error TEXT DEFAULT '', intelligence_reserved_calls INTEGER DEFAULT 0, intelligence_actual_calls INTEGER DEFAULT 0, intelligence_call_limit INTEGER DEFAULT 4, intelligence_reserved_input_tokens INTEGER DEFAULT 0, intelligence_actual_input_tokens INTEGER DEFAULT 0, intelligence_actual_output_tokens INTEGER DEFAULT 0, intelligence_input_token_limit INTEGER DEFAULT 80000, intelligence_reserved_spend_micros INTEGER DEFAULT 0, intelligence_actual_spend_micros INTEGER DEFAULT 0, intelligence_spend_limit_micros INTEGER DEFAULT 100000)`,
  );
  await db.query(
    `CREATE TABLE opportunity_intelligence_requests (request_id TEXT, idempotency_key TEXT, opportunity_id TEXT, agent_run_id TEXT, content_fingerprint TEXT, input_fingerprint TEXT, feature TEXT, profile TEXT, model TEXT, tenant_id TEXT, owner_user_id TEXT, candidate_profile_id TEXT, status TEXT, accounting_basis TEXT, actual_total_tokens INTEGER, reserved_input_tokens INTEGER, requested_max_output_tokens INTEGER, reserved_spend_micros INTEGER, finished_at TEXT)`,
  );
  await db.query(
    `CREATE TABLE opportunity_intelligence_results (id TEXT, owner_request_id TEXT, request_id TEXT, idempotency_key TEXT, opportunity_id TEXT, agent_run_id TEXT, content_fingerprint TEXT, input_fingerprint TEXT, feature TEXT, profile TEXT, model TEXT, tenant_id TEXT, owner_user_id TEXT, candidate_profile_id TEXT, prompt_version TEXT, output_schema_version TEXT, prepared_payload_version TEXT, status TEXT, output_json TEXT)`,
  );
  const source = {
    title: 'Engineer',
    descriptionRaw: 'Build APIs. This role supports remote work in Canada.',
    locationNotes: 'Canada',
    workMode: 'Remote',
  };
  const opportunity = {
    id: 'opportunity',
    preferredSkills: '' as string | string[],
    requiredSkills: '' as string | string[],
    sourceContentJson: JSON.stringify(source),
    sourceContentFingerprint: fingerprintOpportunitySourceContent(source),
    sourceContentVersion: 1,
  };
  const profile = {
    id: subject.profileId,
    tenantId: subject.tenantId,
    ownerUserId: subject.userId,
    active: true,
    name: '',
    title: '',
    summary: '',
    factsJson: '',
    workAuthorization: '',
    preferencesJson: '',
    targetWorkCountryJson: '',
  };
  const question = await createScreeningQuestion({
    id: 'question',
    text: 'Does the posting explicitly offer remote work?',
    kind: 'source',
    importance: 'must_have',
    desiredAnswer: 'yes',
    weight: 3,
    active: true,
  });
  const questions: ScreeningQuestionSnapshot = {
    questions: [question],
    invalidQuestions: [],
    errors: [],
    questionSetFingerprint: await screeningQuestionSetFingerprint([question]),
  };
  const loadCandidate = vi.fn(
    async (): Promise<WorkspaceCandidateEvidence> => ({
      subject,
      candidate: {
        authorizedWorkCountriesJson: '[]',
        citizenshipsJson: '[]',
        factsJson: '{}',
        location: '',
        preferencesJson: '{}',
        residenceCountryJson: '{}',
        sponsorshipRequired: 'unknown',
        summary: '',
        targetWorkCountryJson: '{}',
        title: '',
        workAuthorization: '',
      },
      evidence: [
        {
          id: 'fact',
          title: 'API work',
          text: 'Built API software.',
          kind: 'project',
        },
      ],
      fingerprint: 'candidate-fp',
    }),
  );
  const savedRows: Record<string, unknown>[] = [];
  const rankRows: Record<string, unknown>[] = [];
  let count = 0;
  const runFresh: NonNullable<
    ScreeningQuestionAssessmentDependencies['runFresh']
  > = async <T>(
    owned: typeof subject,
    _capability: Parameters<
      NonNullable<ScreeningQuestionAssessmentDependencies['runFresh']>
    >[1],
    work: (owned: typeof subject, run: PrincipalRun) => Promise<T>,
  ) => await work(owned, run);
  const startRun = vi.fn(async () => {
    const id = `run-${++count}`;
    await db.query(
      'INSERT INTO agent_runs (id, opportunity_id, tenant_id, owner_user_id, candidate_profile_id, status) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      opportunity.id,
      subject.tenantId,
      subject.userId,
      subject.profileId,
      'running',
    );
    return id;
  });
  const finishRun = vi.fn(async (id: string, status: string, error = '') => {
    await db.query(
      'UPDATE agent_runs SET status = ?, error = ? WHERE id = ?',
      status,
      error,
      id,
    );
  });
  const evaluate: NonNullable<
    ScreeningQuestionAssessmentDependencies['evaluate']
  > = vi.fn(async (prepared, options) => {
    await options.revalidateAuthority();
    await options.loadCurrent();
    const output = decision(prepared, roleChoice),
      requestId = count === 1 ? 'actual-request' : `actual-request-${count}`;
    const fp = opportunityQuestionScreeningInputFingerprint(prepared, subject),
      plan = preflightOpportunityQuestionScreening(prepared);
    const tuple = [
      prepared.opportunityId,
      options.agentRunId,
      prepared.sourceContentFingerprint,
      fp,
      'opportunity-question-screening',
      'typesafe-opportunity-question-screening',
      prepared.model,
      subject.tenantId,
      subject.userId,
      subject.profileId,
    ];
    await db.query(
      'INSERT INTO opportunity_intelligence_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      requestId,
      'key',
      ...tuple,
      'succeeded',
      'actual',
      200,
      plan.inputTokenCeiling,
      plan.maxOutputTokens,
      plan.spendMicros,
      '2026-10-05T10:00:00.000Z',
    );
    await db.query(
      'INSERT INTO opportunity_intelligence_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      `result-${requestId}`,
      requestId,
      requestId,
      'key',
      ...tuple,
      prepared.version,
      prepared.version,
      prepared.version,
      'completed',
      JSON.stringify(output),
    );
    await db.query(
      'UPDATE agent_runs SET intelligence_actual_calls = 1, intelligence_actual_input_tokens = 150, intelligence_actual_output_tokens = 50, intelligence_actual_spend_micros = ? WHERE id = ?',
      plan.spendMicros,
      options.agentRunId,
    );
    return resolveOpportunityQuestionScreening(prepared, output, {
      inputFingerprint: fp,
      agentRunId: options.agentRunId,
      requestId,
    });
  });
  const listSaved: NonNullable<
    ScreeningQuestionAssessmentDependencies['listSaved']
  > = async (_className, _owned, options) => {
    const where = options?.where as Record<string, unknown>;
    return savedRows.filter(
      (row) =>
        !where.assessmentFingerprint ||
        row.assessmentFingerprint === where.assessmentFingerprint,
    );
  };
  const save: NonNullable<ScreeningQuestionAssessmentDependencies['save']> =
    vi.fn(async (_className, owned, payload) => {
      const row = {
        id: `assessment-${savedRows.length + 1}`,
        ...payload,
        tenantId: owned.tenantId,
        ownerUserId: owned.userId,
        candidateProfileId: owned.profileId,
      };
      savedRows.push(row);
      return row;
    });
  const saveRank: NonNullable<
    ScreeningQuestionAssessmentDependencies['saveRank']
  > = vi.fn(async (_database, publication) => {
    rankRows.splice(0, rankRows.length, {
      ...publication,
      projectionVersion: 'opportunity-recommendation-rank/v2',
    });
    return { status: 'created' } as never;
  });
  const deps: ScreeningQuestionAssessmentDependencies = {
    db,
    runFresh,
    getOpportunity: async () => opportunity,
    loadFinalOpportunity: async () => opportunity,
    getProfile: async () => profile,
    listQuestions: async () => questions,
    loadCandidate,
    listSaved,
    save,
    evaluate,
    startRun,
    finishRun,
    transaction: async (work) => await work(db as never),
    saveRank,
    listRanks: async (_owned, ids) =>
      rankRows.filter((row) =>
        ids.includes(String(row.opportunityId)),
      ) as never,
    lock: async (_id, work) => await work(),
  };
  return {
    db,
    opportunity,
    profile,
    questions,
    deps,
    loadCandidate,
    savedRows,
    rankRows,
    startRun,
    finishRun,
    evaluate,
    save,
    saveRank,
  };
}
describe('native question screening service', () => {
  it('binds final rank snapshots to the transaction-loaded opportunity row', async () => {
    const f = await fixture();
    const locked = vi.fn(async (_id: string, db: unknown) => {
      expect(db).toBe(f.db);
      return { ...f.opportunity, requiredSkills: ['Locked skill'] };
    });
    f.deps.loadFinalOpportunity = locked;
    f.opportunity.requiredSkills = ['Later skill'];
    await runScreeningQuestionAssessment(
      subject,
      { opportunityId: f.opportunity.id, fullReview: true },
      f.deps,
    );
    expect(locked).toHaveBeenCalledTimes(1);
    expect(f.rankRows[0]).toMatchObject({
      requiredSkillsSnapshot: '["Locked skill"]',
    });
  });
  it('backfills one verified receipt without evaluating or starting provider work', async () => {
    const f = await fixture();
    await runScreeningQuestionAssessment(
      subject,
      { opportunityId: f.opportunity.id, fullReview: true },
      f.deps,
    );
    vi.mocked(f.evaluate).mockClear();
    f.startRun.mockClear();
    vi.mocked(f.saveRank).mockClear();

    await expect(
      backfillCurrentScreeningQuestionRecommendationRank(
        subject,
        f.opportunity.id,
        f.deps,
      ),
    ).resolves.toBe('already_current');
    expect(f.evaluate).not.toHaveBeenCalled();
    expect(f.startRun).not.toHaveBeenCalled();
    expect(f.saveRank).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.saveRank).mock.calls[0]?.[1]).toMatchObject({
      intelligenceRequestId: 'actual-request',
      intelligenceResultId: 'result-actual-request',
      proofFinishedAt: new Date('2026-10-05T10:00:00.000Z'),
    });
  });
  it('skips unrelated titles, persists an honest title-only projection, and reuses the receipt', async () => {
    const f = await fixture('unrelated');
    f.profile.preferencesJson = JSON.stringify({
      targetRoles: ['Software engineer'],
    });
    const first = await runScreeningQuestionAssessment(
      subject,
      { opportunityId: 'opportunity' },
      f.deps,
    );
    expect(first.result.rolePreScreen?.outcome).toBe('unrelated');
    expect(first.result.aggregate.recommendationPercent).toBeNull();
    expect(f.evaluate).toHaveBeenCalledTimes(1);
    const second = await runScreeningQuestionAssessment(
      subject,
      { opportunityId: 'opportunity' },
      f.deps,
    );
    expect(second.reused).toBe(true);
    expect(f.evaluate).toHaveBeenCalledTimes(1);
    const projections = await loadCurrentScreeningQuestionAssessmentProjections(
      { subject, opportunities: [f.opportunity] },
      f.deps,
    );
    expect(projections.get('opportunity')?.rolePreScreen?.outcome).toBe(
      'unrelated',
    );
    f.profile.preferencesJson = JSON.stringify({ targetRoles: ['Accountant'] });
    const stale = await loadCurrentScreeningQuestionAssessmentProjections(
      { subject, opportunities: [f.opportunity] },
      f.deps,
    );
    expect(stale.get('opportunity')).toBeUndefined();
    expect(f.evaluate).toHaveBeenCalledTimes(1);
  });
  it.each([
    'requiredSkills',
    'preferredSkills',
  ] as const)('neutralizes a detail projection when %s changes and repairs the same receipt without AI', async (field) => {
    const f = await fixture();
    try {
      f.opportunity[field] = ['TypeScript'];
      await runScreeningQuestionAssessment(
        subject,
        { opportunityId: f.opportunity.id, fullReview: true },
        f.deps,
      );
      expect(
        (
          await loadCurrentScreeningQuestionAssessmentProjections(
            { subject, opportunities: [f.opportunity] },
            f.deps,
          )
        ).get(f.opportunity.id)?.sourceStatus,
      ).toBe('current');

      f.opportunity[field] = ['TypeScript', 'Svelte'];
      const stale = await loadCurrentScreeningQuestionAssessmentProjections(
        { subject, opportunities: [f.opportunity] },
        f.deps,
      );
      expect(stale.get(f.opportunity.id)).toBeUndefined();
      expect(stale.questionScreeningStatuses.get(f.opportunity.id)).toBe(
        'unknown',
      );
      await expect(
        readCurrentScreeningQuestionAssessment(
          subject,
          f.opportunity.id,
          f.deps,
        ),
      ).resolves.toBeUndefined();
      expect(f.evaluate).toHaveBeenCalledTimes(1);

      await expect(
        runScreeningQuestionAssessment(
          subject,
          { opportunityId: f.opportunity.id, fullReview: true },
          f.deps,
        ),
      ).resolves.toMatchObject({ reused: true });
      expect(f.evaluate).toHaveBeenCalledTimes(1);
      expect(f.saveRank).toHaveBeenCalledTimes(2);
      expect(
        (
          await loadCurrentScreeningQuestionAssessmentProjections(
            { subject, opportunities: [f.opportunity] },
            f.deps,
          )
        ).get(f.opportunity.id)?.sourceStatus,
      ).toBe('current');
    } finally {
      await f.db.close?.();
    }
  });
  it.each([
    'related',
    'uncertain',
  ])('continues %s titles through full questions and reuses the full receipt', async (role) => {
    const f = await fixture(role);
    f.profile.preferencesJson = JSON.stringify({
      targetRoles: ['Software engineer'],
    });
    const first = await runScreeningQuestionAssessment(
      subject,
      { opportunityId: 'opportunity' },
      f.deps,
    );
    expect(first.result.rolePreScreen).toBeUndefined();
    expect(first.result.answers).toHaveLength(1);
    expect(f.evaluate).toHaveBeenCalledTimes(2);
    await runScreeningQuestionAssessment(
      subject,
      { opportunityId: 'opportunity' },
      f.deps,
    );
    expect(f.evaluate).toHaveBeenCalledTimes(2);
  });
  it('allows an explicit full review after a title skip without rewriting the title receipt', async () => {
    const f = await fixture('unrelated');
    f.profile.preferencesJson = JSON.stringify({
      targetRoles: ['Software engineer'],
    });
    await runScreeningQuestionAssessment(
      subject,
      { opportunityId: 'opportunity' },
      f.deps,
    );
    const result = await runScreeningQuestionAssessment(
      subject,
      { opportunityId: 'opportunity', fullReview: true },
      f.deps,
    );
    expect(result.result.rolePreScreen).toBeUndefined();
    expect(f.evaluate).toHaveBeenCalledTimes(2);
    expect(f.savedRows).toHaveLength(2);
    const projections = await loadCurrentScreeningQuestionAssessmentProjections(
      { subject, opportunities: [f.opportunity] },
      f.deps,
    );
    expect(projections.get('opportunity')?.rolePreScreen).toBeUndefined();
    expect(
      projections.get('opportunity')?.aggregate.recommendationPercent,
    ).toBe(100);
  });
  beforeEach(() => {
    vi.stubEnv(
      'OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION',
      '42000',
    );
    vi.stubEnv(
      'OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION',
      '0',
    );
  });
  afterEach(() => vi.unstubAllEnvs());
  it('projects only exact V2 career profile literals and preserves the complete other catalog while V1 remains exact', async () => {
    const f = await fixture();
    try {
      Object.assign(f.profile, {
        name: 'PRIVATE NAME',
        title: 'Engineer',
        summary: 'Builds distributed APIs.',
        workAuthorization: 'Explicit existing work rights.',
        targetWorkCountryJson: '{"code":"CA"}',
        factsJson: JSON.stringify({
          version: 1,
          facts: {
            title: { provenance: 'user_verified', value: 'Technical engineer' },
            summary: {
              provenance: 'user_verified',
              value: 'Delivered backend infrastructure.',
            },
            email: {
              provenance: 'user_verified',
              value: 'private-contact@example.test',
            },
            name: { provenance: 'user_verified', value: 'PRIVATE NAME' },
          },
          unresolvedQuestions: ['PRIVATE INTERNAL QUESTION'],
        }),
      });
      const previous = f.loadCandidate.getMockImplementation()!;
      f.loadCandidate.mockImplementation(async () => {
        const candidate = await previous();
        candidate.evidence = [
          {
            id: `profile:${subject.profileId}`,
            kind: 'candidate_profile',
            title: f.profile.name,
            text: [f.profile.title, f.profile.summary, f.profile.factsJson]
              .filter(Boolean)
              .join('\n'),
          },
          ...Array.from({ length: 155 }, (_, i) => ({
            id: `career-${i}`,
            kind: 'project' as const,
            title: `Career fact ${i}`,
            text: `Original complete career evidence ${i}.`,
          })),
        ];
        return candidate;
      });
      const current = await prepareCurrentScreeningQuestionAssessment(
        subject,
        f.opportunity.id,
        f.deps,
      );
      const wire = JSON.stringify(current.request);
      for (const privateText of [
        'private-contact@example.test',
        'PRIVATE NAME',
        'PRIVATE INTERNAL QUESTION',
        'unresolvedQuestions',
        'user_verified',
      ])
        expect(wire).not.toContain(privateText);
      const citations = Object.values(current.candidateWitnesses);
      expect(
        citations.filter((row) => row.id.startsWith('career-')),
      ).toHaveLength(155);
      expect(citations.map((row) => row.text)).toEqual(
        expect.arrayContaining([
          'Engineer',
          'Builds distributed APIs.',
          'Technical engineer',
          'Delivered backend infrastructure.',
          'Explicit existing work rights.',
          '{"code":"CA"}',
        ]),
      );
      const legacy = await prepareCurrentScreeningQuestionAssessment(
        subject,
        f.opportunity.id,
        f.deps,
        { version: OPPORTUNITY_QUESTION_SCREENING_V1_VERSION },
      );
      expect(JSON.stringify(legacy.request)).toContain(
        'private-contact@example.test',
      );
      expect(legacy.candidateMaterialFingerprint).not.toBe(
        current.candidateMaterialFingerprint,
      );
      f.profile.factsJson = f.profile.factsJson.replace(
        'private-contact@example.test',
        'changed-contact@example.test',
      );
      const changed = await prepareCurrentScreeningQuestionAssessment(
        subject,
        f.opportunity.id,
        f.deps,
      );
      expect(changed.candidateMaterialFingerprint).not.toBe(
        current.candidateMaterialFingerprint,
      );
      expect(Object.values(changed.candidateWitnesses)).toEqual(citations);
      expect(f.evaluate).not.toHaveBeenCalled();
    } finally {
      await f.db.close?.();
    }
  });
  it('includes confirmed skill depth only in current matching and excludes pending review metadata', async () => {
    const f = await fixture();
    try {
      const previous = f.loadCandidate.getMockImplementation()!;
      f.loadCandidate.mockImplementation(async () => {
        const candidate = await previous();
        candidate.evidence.push({
          id: 'confirmed-skill:confirmation-1',
          title: 'Confirmed skill: Python',
          kind: 'skill_context',
          text: 'Python: introductory exposure only. Original source: small prototype.',
        });
        return candidate;
      });
      Object.assign(f.profile, { updatedAt: '2026-10-04T01:00:00Z' });
      f.profile.preferencesJson = JSON.stringify({
        targetRoles: ['Engineer'],
        skillDiscovery: { proposals: ['SECRET PENDING CLAIM'] },
      });
      const current = await prepareCurrentScreeningQuestionAssessment(
        subject,
        f.opportunity.id,
        f.deps,
      );
      expect(Object.values(current.candidateWitnesses)).toContainEqual(
        expect.objectContaining({ id: 'confirmed-skill:confirmation-1' }),
      );
      expect(JSON.stringify(current.candidateWitnesses)).not.toContain(
        'SECRET PENDING CLAIM',
      );
      Object.assign(f.profile, { updatedAt: '2026-10-04T02:00:00Z' });
      f.profile.preferencesJson = JSON.stringify({
        targetRoles: ['Engineer'],
        skillDiscovery: { proposals: ['CHANGED PENDING CLAIM'] },
      });
      const unchanged = await prepareCurrentScreeningQuestionAssessment(
        subject,
        f.opportunity.id,
        f.deps,
      );
      expect(unchanged.candidateMaterialFingerprint).toBe(
        current.candidateMaterialFingerprint,
      );
      for (const version of [
        OPPORTUNITY_QUESTION_SCREENING_V1_VERSION,
        OPPORTUNITY_QUESTION_SCREENING_V2_VERSION,
        OPPORTUNITY_QUESTION_SCREENING_V3_VERSION,
        OPPORTUNITY_QUESTION_SCREENING_V4_VERSION,
      ] as const) {
        const old = await prepareCurrentScreeningQuestionAssessment(
          subject,
          f.opportunity.id,
          f.deps,
          { version },
        );
        expect(
          Object.values(old.candidateWitnesses).some((cite) =>
            cite.id.startsWith('confirmed-skill:'),
          ),
        ).toBe(false);
      }
    } finally {
      await f.db.close?.();
    }
  });

  it('uses exact user-verified skill depth only for v5 and invalidates freshness on edits', async () => {
    const f = await fixture();
    try {
      const note =
        '  Primary production experience is TypeScript; Java and Python were introductory.  ';
      const previous = f.loadCandidate.getMockImplementation()!;
      f.loadCandidate.mockImplementation(async () => {
        const candidate = await previous();
        candidate.evidence.push({
          id: `profile:${subject.profileId}`,
          kind: 'candidate_profile',
          title: 'Candidate profile',
          text: f.profile.factsJson,
        });
        return candidate;
      });
      const set = (value: unknown, provenance: string) => {
        f.profile.factsJson = JSON.stringify({
          version: 1,
          facts: { skillExperience: { value, provenance } },
        });
      };
      set(note, 'user_verified');
      const current = await prepareCurrentScreeningQuestionAssessment(
        subject,
        f.opportunity.id,
        f.deps,
      );
      expect(Object.values(current.candidateWitnesses)).toContainEqual(
        expect.objectContaining({
          id: 'profile-career:profile:facts.skillExperience.value',
          kind: 'candidate_profile',
          text: note,
        }),
      );
      for (const version of [
        OPPORTUNITY_QUESTION_SCREENING_V1_VERSION,
        OPPORTUNITY_QUESTION_SCREENING_V2_VERSION,
        OPPORTUNITY_QUESTION_SCREENING_V3_VERSION,
        OPPORTUNITY_QUESTION_SCREENING_V4_VERSION,
      ] as const) {
        const old = await prepareCurrentScreeningQuestionAssessment(
          subject,
          f.opportunity.id,
          f.deps,
          { version },
        );
        expect(
          Object.values(old.candidateWitnesses).some(
            (cite) =>
              cite.id === 'profile-career:profile:facts.skillExperience.value',
          ),
        ).toBe(false);
      }
      set('Primary production experience is TypeScript only.', 'user_verified');
      const changed = await prepareCurrentScreeningQuestionAssessment(
        subject,
        f.opportunity.id,
        f.deps,
      );
      expect(changed.candidateMaterialFingerprint).not.toBe(
        current.candidateMaterialFingerprint,
      );
      expect(changed.fingerprint).not.toBe(current.fingerprint);
      for (const [value, provenance] of [
        [note, 'safe_derivation'],
        [note, 'model_generated'],
        [42, 'user_verified'],
        ['  ', 'user_verified'],
      ] as const) {
        set(value, provenance);
        const rejected = await prepareCurrentScreeningQuestionAssessment(
          subject,
          f.opportunity.id,
          f.deps,
        );
        expect(
          Object.values(rejected.candidateWitnesses).some(
            (cite) =>
              cite.id === 'profile-career:profile:facts.skillExperience.value',
          ),
        ).toBe(false);
      }
      f.profile.ownerUserId = 'foreign';
      await expect(
        prepareCurrentScreeningQuestionAssessment(
          subject,
          f.opportunity.id,
          f.deps,
        ),
      ).rejects.toThrow('owned profile');
      expect(f.evaluate).not.toHaveBeenCalled();
    } finally {
      await f.db.close?.();
    }
  });
  it('anchors extracted labels to captured body literals and fingerprints only grounded skill inputs', async () => {
    const f = await fixture();
    try {
      const captured = {
        title: 'Engineer',
        descriptionRaw:
          'Build TypeScript and Node.js APIs; Python exposure helps.',
      };
      f.opportunity.sourceContentJson = JSON.stringify(captured);
      f.opportunity.sourceContentFingerprint =
        fingerprintOpportunitySourceContent(captured);
      Object.assign(f.opportunity, {
        requiredSkills: 'TypeScript, Node.js, Imaginary',
        preferredSkills: 'Python',
      });
      const current = await prepareCurrentScreeningQuestionAssessment(
        subject,
        f.opportunity.id,
        f.deps,
      );
      expect(
        current.skillBindings?.map((binding) => binding.requirement),
      ).toEqual(['TypeScript', 'Node.js', 'Python']);
      expect(
        current.skillBindings?.every(
          (binding) => binding.sourceOrigin === 'body_literal',
        ),
      ).toBe(true);
      for (const binding of current.skillBindings!)
        expect(
          captured.descriptionRaw.slice(
            binding.sourceCitation!.start,
            binding.sourceCitation!.end,
          ),
        ).toBe(binding.sourceCitation!.text);
      const previous = await prepareCurrentScreeningQuestionAssessment(
        subject,
        f.opportunity.id,
        f.deps,
        { version: OPPORTUNITY_QUESTION_SCREENING_V4_VERSION },
      );
      Object.assign(f.opportunity, {
        requiredSkills: 'TypeScript',
        preferredSkills: '',
      });
      const changed = await prepareCurrentScreeningQuestionAssessment(
        subject,
        f.opportunity.id,
        f.deps,
      );
      expect(changed.fingerprint).not.toBe(current.fingerprint);
      const oldChanged = await prepareCurrentScreeningQuestionAssessment(
        subject,
        f.opportunity.id,
        f.deps,
        { version: OPPORTUNITY_QUESTION_SCREENING_V4_VERSION },
      );
      expect(oldChanged.fingerprint).toBe(previous.fingerprint);
    } finally {
      await f.db.close?.();
    }
  });
  it('replays an actual saved V1 receipt only with its explicit historical material/version', async () => {
    const f = await fixture();
    try {
      const prepared = await prepareCurrentScreeningQuestionAssessment(
        subject,
        f.opportunity.id,
        f.deps,
        { version: OPPORTUNITY_QUESTION_SCREENING_V1_VERSION },
      );
      const agentRunId = await f.startRun();
      const actual = await f.evaluate(prepared, {
        agentRunId,
        subject,
        loadCurrent: async () => prepared,
        revalidateAuthority: async () => undefined,
      });
      f.savedRows.push({
        tenantId: subject.tenantId,
        ownerUserId: subject.userId,
        candidateProfileId: subject.profileId,
        opportunityId: f.opportunity.id,
        contractVersion: actual.contractVersion,
        model: actual.model,
        sourceContentFingerprint: actual.sourceContentFingerprint,
        sourceContentVersion: actual.sourceContentVersion,
        candidateMaterialFingerprint: actual.candidateMaterialFingerprint,
        preferencesFingerprint: actual.questionSetFingerprint,
        assessmentFingerprint: actual.inputFingerprint,
        agentRunId: actual.agentRunId,
        status: 'question_screened',
        assessmentJson: JSON.stringify(actual),
      });
      expect(
        await readCurrentScreeningQuestionAssessment(
          subject,
          f.opportunity.id,
          f.deps,
          { version: OPPORTUNITY_QUESTION_SCREENING_V1_VERSION },
        ),
      ).toEqual(actual);
      expect(
        await readCurrentScreeningQuestionAssessment(
          subject,
          f.opportunity.id,
          f.deps,
        ),
      ).toBeUndefined();
      expect(f.evaluate).toHaveBeenCalledTimes(1);
    } finally {
      await f.db.close?.();
    }
  });
  it('performs one JEV evaluation, native joined replay then save/current read, with duplicate click zero further evaluations', async () => {
    const f = await fixture();
    try {
      const first = await runScreeningQuestionAssessment(
        subject,
        { opportunityId: f.opportunity.id },
        f.deps,
      );
      expect(first.reused).toBe(false);
      expect(first.result.aggregate.recommendationPercent).toBe(100);
      expect(f.evaluate).toHaveBeenCalledTimes(1);
      expect(f.save).toHaveBeenCalledTimes(1);
      expect(
        await readCurrentScreeningQuestionAssessment(
          subject,
          f.opportunity.id,
          f.deps,
        ),
      ).toEqual(first.result);
      expect(
        (
          await runScreeningQuestionAssessment(
            subject,
            { opportunityId: f.opportunity.id },
            f.deps,
          )
        ).reused,
      ).toBe(true);
      expect(f.evaluate).toHaveBeenCalledTimes(1);
      expect(f.startRun).toHaveBeenCalledTimes(1);
      expect(f.finishRun).toHaveBeenCalledWith(
        'run-1',
        'succeeded',
        '',
        subject,
      );
    } finally {
      await f.db.close?.();
    }
  });
  it.each([
    'foreign',
    'conservative',
    'orphan',
    'duplicate',
    'overbudget',
  ])('denies native %s proof without cache JSON authority or retry', async (kind) => {
    const f = await fixture();
    try {
      await runScreeningQuestionAssessment(
        subject,
        { opportunityId: f.opportunity.id },
        f.deps,
      );
      if (kind === 'foreign')
        await f.db.query(
          'UPDATE opportunity_intelligence_results SET owner_user_id = ?',
          'foreign',
        );
      if (kind === 'conservative')
        await f.db.query(
          'UPDATE opportunity_intelligence_requests SET accounting_basis = ?',
          'conservative',
        );
      if (kind === 'orphan')
        await f.db.query('DELETE FROM opportunity_intelligence_results');
      if (kind === 'duplicate')
        await f.db.query(
          'INSERT INTO opportunity_intelligence_results SELECT * FROM opportunity_intelligence_results',
        );
      if (kind === 'overbudget')
        await f.db.query(
          'UPDATE agent_runs SET intelligence_actual_output_tokens = 80000',
        );
      expect(
        await readCurrentScreeningQuestionAssessment(
          subject,
          f.opportunity.id,
          f.deps,
        ),
      ).toBeUndefined();
      await expect(
        runScreeningQuestionAssessment(
          subject,
          { opportunityId: f.opportunity.id },
          f.deps,
        ),
      ).rejects.toThrow('already attempted');
      expect(f.evaluate).toHaveBeenCalledTimes(1);
    } finally {
      await f.db.close?.();
    }
  });
  it('does not publish stale source after an actual paid completion and never retries its failed identity', async () => {
    const f = await fixture();
    try {
      const evaluate = f.deps.evaluate!;
      f.deps.evaluate = async (...args: Parameters<typeof evaluate>) => {
        const result = await evaluate(...args);
        f.opportunity.sourceContentVersion++;
        return result;
      };
      await expect(
        runScreeningQuestionAssessment(
          subject,
          { opportunityId: f.opportunity.id },
          f.deps,
        ),
      ).rejects.toThrow('changed');
      expect(f.save).not.toHaveBeenCalled();
      expect(f.saveRank).not.toHaveBeenCalled();
      expect(f.finishRun).toHaveBeenCalledWith(
        'run-1',
        'failed',
        'question_screening_failed',
        subject,
      );
    } finally {
      await f.db.close?.();
    }
  });
  it.each([
    'revoked',
    'inactive_profile',
    'question_edit',
  ] as const)('rechecks %s after the saved locator await and never saves or repeats the paid identity', async (change) => {
    const f = await fixture();
    try {
      const previousFresh = f.deps.runFresh!;
      const previousSaved = f.deps.listSaved!;
      const originalQuestion = f.questions.questions[0]!;
      let revoked = false;
      f.deps.runFresh = async <T>(
        owned: typeof subject,
        capability: Parameters<typeof previousFresh>[1],
        work: (owned: typeof subject, run: PrincipalRun) => Promise<T>,
      ) => {
        if (revoked)
          throw new Error('Current workspace permission was revoked.');
        return await previousFresh(owned, capability, work);
      };
      f.deps.listSaved = async (...args: Parameters<typeof previousSaved>) => {
        const rows = await previousSaved(...args);
        await Promise.resolve();
        if (change === 'revoked') revoked = true;
        if (change === 'inactive_profile') f.profile.active = false;
        if (change === 'question_edit')
          f.questions.questions[0] = await createScreeningQuestion({
            ...originalQuestion,
            weight: 8,
          });
        return rows;
      };
      await expect(
        runScreeningQuestionAssessment(
          subject,
          { opportunityId: f.opportunity.id },
          f.deps,
        ),
      ).rejects.toThrow(
        change === 'revoked'
          ? 'revoked'
          : change === 'inactive_profile'
            ? 'active owned profile'
            : 'final publication fence',
      );
      expect(f.evaluate).toHaveBeenCalledTimes(1);
      expect(f.save).not.toHaveBeenCalled();
      expect(f.saveRank).not.toHaveBeenCalled();
      expect(f.savedRows).toEqual([]);
      expect(
        (
          await f.db.query(
            'SELECT status, actual_total_tokens FROM opportunity_intelligence_requests',
          )
        ).rows,
      ).toEqual([{ status: 'succeeded', actual_total_tokens: 200 }]);
      expect(f.finishRun).toHaveBeenCalledWith(
        'run-1',
        'failed',
        'question_screening_failed',
        subject,
      );
      revoked = false;
      f.profile.active = true;
      f.questions.questions[0] = originalQuestion;
      f.deps.listSaved = previousSaved;
      const recovered = await runScreeningQuestionAssessment(
        subject,
        { opportunityId: f.opportunity.id },
        f.deps,
      );
      expect(recovered.reused).toBe(true);
      expect(f.save).toHaveBeenCalledTimes(1);
      expect(
        (await f.db.query('SELECT status, error FROM agent_runs')).rows,
      ).toEqual([{ status: 'failed', error: 'question_screening_failed' }]);
      expect(f.evaluate).toHaveBeenCalledTimes(1);
      expect(f.startRun).toHaveBeenCalledTimes(1);
    } finally {
      await f.db.close?.();
    }
  });
  it.each([
    'publication',
    'provider_failed',
    'denied',
    'aborted',
    'other_request',
  ] as const)('recovers only the exact post-receipt publication failure (%s) without provider or history changes', async (kind) => {
    const f = await fixture();
    try {
      const originalSave = f.deps.save!;
      f.deps.save = async () => {
        throw new Error('Private publication failed.');
      };
      await expect(
        runScreeningQuestionAssessment(
          subject,
          { opportunityId: f.opportunity.id },
          f.deps,
        ),
      ).rejects.toThrow('Private publication failed');
      f.deps.save = originalSave;
      if (kind === 'provider_failed' || kind === 'denied' || kind === 'aborted')
        await f.db.query('UPDATE agent_runs SET error = ?', kind);
      if (kind === 'other_request')
        await f.db.query(
          "INSERT INTO opportunity_intelligence_requests SELECT 'other-request', idempotency_key, opportunity_id, agent_run_id, content_fingerprint, input_fingerprint, feature, profile, model, tenant_id, owner_user_id, candidate_profile_id, 'failed', accounting_basis, actual_total_tokens, reserved_input_tokens, requested_max_output_tokens, reserved_spend_micros, finished_at FROM opportunity_intelligence_requests",
        );
      if (kind === 'publication') {
        const recovered = await runScreeningQuestionAssessment(
          subject,
          { opportunityId: f.opportunity.id },
          f.deps,
        );
        expect(recovered.reused).toBe(true);
        expect(
          await readCurrentScreeningQuestionAssessment(
            subject,
            f.opportunity.id,
            f.deps,
          ),
        ).toEqual(recovered.result);
        expect(f.save).toHaveBeenCalledTimes(1);
      } else {
        await expect(
          runScreeningQuestionAssessment(
            subject,
            { opportunityId: f.opportunity.id },
            f.deps,
          ),
        ).rejects.toThrow('already attempted');
        expect(f.save).not.toHaveBeenCalled();
      }
      expect(f.evaluate).toHaveBeenCalledTimes(1);
      expect(f.startRun).toHaveBeenCalledTimes(1);
      expect(f.finishRun).toHaveBeenCalledTimes(1);
      expect((await f.db.query('SELECT status FROM agent_runs')).rows).toEqual([
        { status: 'failed' },
      ]);
    } finally {
      await f.db.close?.();
    }
  });
  it('rolls the assessment publication back when its rank write fails, then repairs from the receipt without a provider call', async () => {
    const f = await fixture();
    try {
      f.deps.transaction = async (work) => {
        const checkpoint = f.savedRows.length;
        try {
          return await work(f.db as never);
        } catch (cause) {
          f.savedRows.splice(checkpoint);
          throw cause;
        }
      };
      vi.mocked(f.saveRank).mockRejectedValueOnce(
        new Error('Rank write failed.'),
      );
      await expect(
        runScreeningQuestionAssessment(
          subject,
          { opportunityId: f.opportunity.id, fullReview: true },
          f.deps,
        ),
      ).rejects.toThrow('Rank write failed');
      expect(f.savedRows).toEqual([]);
      expect(f.saveRank).toHaveBeenCalledTimes(1);
      expect(f.evaluate).toHaveBeenCalledTimes(1);

      await expect(
        runScreeningQuestionAssessment(
          subject,
          { opportunityId: f.opportunity.id, fullReview: true },
          f.deps,
        ),
      ).resolves.toMatchObject({ reused: true });
      expect(f.savedRows).toHaveLength(1);
      expect(f.evaluate).toHaveBeenCalledTimes(1);
      expect(f.startRun).toHaveBeenCalledTimes(1);
    } finally {
      await f.db.close?.();
    }
  });
  it('keeps the committed receipt and rank valid when post-commit run finalization fails', async () => {
    const f = await fixture();
    try {
      const finishRun = f.deps.finishRun!;
      f.deps.finishRun = async (...args: Parameters<typeof finishRun>) => {
        if (args[1] === 'succeeded')
          throw new Error('Run finalization failed.');
        return await finishRun(...args);
      };
      await expect(
        runScreeningQuestionAssessment(
          subject,
          { opportunityId: f.opportunity.id, fullReview: true },
          f.deps,
        ),
      ).rejects.toThrow('Run finalization failed');
      expect(f.savedRows).toHaveLength(1);
      expect(f.saveRank).toHaveBeenCalledTimes(1);
      expect(f.evaluate).toHaveBeenCalledTimes(1);
      expect(
        await readCurrentScreeningQuestionAssessment(
          subject,
          f.opportunity.id,
          f.deps,
        ),
      ).toBeDefined();

      f.deps.finishRun = finishRun;
      await expect(
        runScreeningQuestionAssessment(
          subject,
          { opportunityId: f.opportunity.id, fullReview: true },
          f.deps,
        ),
      ).resolves.toMatchObject({ reused: true });
      expect(f.evaluate).toHaveBeenCalledTimes(1);
      expect(f.startRun).toHaveBeenCalledTimes(1);
    } finally {
      await f.db.close?.();
    }
  });
  it('holds malformed questions/inactive profile before run or transport, and shares one catalog snapshot across projection saved IDs', async () => {
    const f = await fixture();
    try {
      f.questions.errors.push('Too many questions');
      await expect(
        runScreeningQuestionAssessment(
          subject,
          { opportunityId: f.opportunity.id },
          f.deps,
        ),
      ).rejects.toThrow('Repair invalid');
      expect(f.startRun).not.toHaveBeenCalled();
      expect(f.evaluate).not.toHaveBeenCalled();
      f.loadCandidate.mockClear();
      const blocked = await loadCurrentScreeningQuestionAssessmentProjections(
        { opportunities: [], subject },
        f.deps,
      );
      expect(blocked.questionScreeningEnabled).toBe(true);
      expect(blocked.blockedReason).toBe('Too many questions');
      expect(f.loadCandidate).not.toHaveBeenCalled();
      f.questions.errors.length = 0;
      await runScreeningQuestionAssessment(
        subject,
        { opportunityId: f.opportunity.id },
        f.deps,
      );
      f.loadCandidate.mockClear();
      const map = await loadCurrentScreeningQuestionAssessmentProjections(
        {
          opportunities: [f.opportunity, { ...f.opportunity, id: 'unsaved' }],
          subject,
        },
        f.deps,
      );
      expect(map.get(f.opportunity.id)?.aggregate.recommendationPercent).toBe(
        100,
      );
      expect(f.loadCandidate).toHaveBeenCalledTimes(1);
      expect(map.questionScreeningStatuses.get(f.opportunity.id)).toBe(
        'current',
      );
      f.profile.active = false;
      expect(
        (
          await loadCurrentScreeningQuestionAssessmentProjections(
            { opportunities: [f.opportunity], subject },
            f.deps,
          )
        ).questionScreeningStatuses.get(f.opportunity.id),
      ).toBe('unknown');
    } finally {
      await f.db.close?.();
    }
  });
});

it('selects overflow only for oversized full context and publishes/reuses its exact native receipt', async () => {
  vi.stubEnv(
    'OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION',
    '42000',
  );
  vi.stubEnv('OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION', '0');
  const f = await fixture();
  const normal = await prepareCurrentScreeningQuestionAssessment(
    subject,
    'opportunity',
    f.deps,
  );
  expect(normal.version).toBe(OPPORTUNITY_QUESTION_SCREENING_VERSION);
  let overflow: PreparedOpportunityQuestionScreening | undefined;
  for (let length = 58000; length <= 64000; length += 100) {
    const captured = {
      title: 'Platform engineer',
      descriptionRaw: `Remote work permitted.\n${'x'.repeat(length)}`,
    };
    f.opportunity.sourceContentJson = JSON.stringify(captured);
    f.opportunity.sourceContentFingerprint =
      fingerprintOpportunitySourceContent(captured);
    const legacy = await prepareCurrentScreeningQuestionAssessment(
      subject,
      'opportunity',
      f.deps,
      { version: OPPORTUNITY_QUESTION_SCREENING_VERSION },
    );
    const current = await prepareCurrentScreeningQuestionAssessment(
      subject,
      'opportunity',
      f.deps,
    );
    if (
      !preflightOpportunityQuestionScreening(legacy).fits &&
      preflightOpportunityQuestionScreening(current).fits
    ) {
      overflow = current;
      break;
    }
  }
  expect(overflow?.version).toBe(
    OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION,
  );
  const first = await runScreeningQuestionAssessment(
    subject,
    { opportunityId: 'opportunity', fullReview: true },
    f.deps,
  );
  expect(first.result.contractVersion).toBe(
    OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION,
  );
  const second = await runScreeningQuestionAssessment(
    subject,
    { opportunityId: 'opportunity', fullReview: true },
    f.deps,
  );
  expect(second.reused).toBe(true);
  expect(f.evaluate).toHaveBeenCalledTimes(1);
  const projections = await loadCurrentScreeningQuestionAssessmentProjections(
    { subject, opportunities: [f.opportunity] },
    f.deps,
  );
  expect(projections.get('opportunity')?.sourceStatus).toBe('current');
  f.opportunity.sourceContentFingerprint = 'changed';
  await expect(
    readCurrentScreeningQuestionAssessment(subject, 'opportunity', f.deps),
  ).rejects.toThrow();
});

it('reads current rank scope once without source/receipt hydration and excludes private review metadata', async () => {
  const f = await fixture();
  const scope = await loadCurrentScreeningQuestionRecommendationScope(
    subject,
    f.deps,
  );
  expect(scope.questionScreeningEnabled).toBe(true);
  expect(scope.candidateMaterialFingerprint).toBeTruthy();
  expect(scope.questionSetFingerprint).toBe(f.questions.questionSetFingerprint);
  expect(f.loadCandidate).toHaveBeenCalledTimes(1);
  expect(f.evaluate).not.toHaveBeenCalled();
  expect(f.save).not.toHaveBeenCalled();
  const prepared = await prepareCurrentScreeningQuestionAssessment(
    subject,
    'opportunity',
    f.deps,
  );
  expect(scope.candidateMaterialFingerprint).toBe(
    prepared.candidateMaterialFingerprint,
  );
  f.questions.questions[0]!.active = false;
  const disabled = await loadCurrentScreeningQuestionRecommendationScope(
    subject,
    f.deps,
  );
  expect(disabled).toEqual({ questionScreeningEnabled: false });
  expect(f.loadCandidate).toHaveBeenCalledTimes(2);
});
